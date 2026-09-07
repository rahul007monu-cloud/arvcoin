<?php
/**
 * Peer-to-peer (P2P) escrow — shared money and matching logic.
 *
 * This is Phase 1 of converting the platform from a deposit-then-index model
 * (buy/sell at the index price against a treasury, INR held on-platform) into a
 * Binance/WazirX-style P2P escrow exchange where the rupees move directly
 * between a buyer and a seller off-platform and this server only escrows the
 * ARV and records the settlement.
 *
 * ---------------------------------------------------------------------------
 * Why a separate file
 * ---------------------------------------------------------------------------
 * The money movements here reuse the SAME primitives the index engine uses —
 * wallet_apply(), ledger_add(), consume_lots(), integer paise, u8 units — so the
 * ledger stays the single book of record and the admin reconcile view keeps
 * balancing. What differs is the choreography, and both p2p.php (the user
 * endpoints) and admin.php (operator overrides) need it, so it lives here.
 *
 * ---------------------------------------------------------------------------
 * The escrow invariant
 * ---------------------------------------------------------------------------
 * A P2P sell order escrows the seller's units at placement time (arv_units ->
 * arv_locked_units) and records `orders.locked_units` = the units this order
 * still holds in escrow. A trade RESERVES a slice of that escrow but does not
 * move any units: the units stay in arv_locked_units until the trade releases
 * (they move to the buyer) or is cancelled (they return to the seller's free
 * balance). For any sell order, at all times:
 *
 *     locked_units (u8)  ==  Σ arv_locked_units this order is responsible for
 *     matchable    (u8)  ==  locked_units − Σ units of its still-active trades
 *
 * where "active" is a trade in 'matched' or 'paid'. locked_units is decremented
 * only by a release or a cancel, never by a match — which is exactly why the
 * same units can never be sold twice.
 *
 * Every rupee/unit change goes through wallet_apply()/ledger_add() inside a
 * caller-supplied tx(); NOTHING here writes a wallet column directly.
 */

declare(strict_types=1);

/* ================================================= payment methods ======== */

/**
 * The seller's payment method to use for a match.
 *
 * The one flagged default, else the most recently added. Returns null only when
 * the seller has none — which sell-placement forbids, so a match should never
 * see it.
 */
function p2p_default_payment_method(PDO $pdo, int $userId): ?array
{
    $st = $pdo->prepare(
        'SELECT * FROM payment_methods WHERE user_id = ?
          ORDER BY is_default DESC, id DESC LIMIT 1'
    );
    $st->execute([$userId]);
    $row = $st->fetch();
    return $row ?: null;
}

/**
 * A frozen copy of a payment method, stored on the trade at match time.
 *
 * Copied rather than referenced so that a seller later editing or deleting the
 * method never rewrites the details of a trade already in flight — the buyer
 * must always see the account they were told to pay.
 */
function p2p_payment_snapshot(array $m): string
{
    return (string)json_encode([
        'type'          => $m['type'],
        'label'         => $m['label'] ?? '',
        'upiVpa'        => $m['upi_vpa'] ?? '',
        'accountName'   => $m['account_name'] ?? '',
        'bankAccountNo' => $m['bank_account_no'] ?? '',
        'bankIfsc'      => $m['bank_ifsc'] ?? '',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** Shape a payment method for the API. Own rows and operators see it in full. */
function p2p_payment_method_public(array $m): array
{
    return [
        'id'            => (int)$m['id'],
        'type'          => $m['type'],
        'label'         => $m['label'] ?? '',
        'upiVpa'        => $m['upi_vpa'] ?? '',
        'accountName'   => $m['account_name'] ?? '',
        'bankAccountNo' => $m['bank_account_no'] ?? '',
        'bankIfsc'      => $m['bank_ifsc'] ?? '',
        'isDefault'     => (bool)$m['is_default'],
        'createdAt'     => $m['created_at'] ?? null,
    ];
}

/* ================================================= treasury / fee account = */

/**
 * The platform "treasury" user, or null when it is not usable.
 *
 * The treasury is NOT a special kind of account — it is an ordinary, operator-run
 * user row that happens to hold ARV and a payment method (the company UPI/bank a
 * buyer pays). Making it a real user is the whole point: its escrow and
 * settlement then run through the SAME wallet_apply()/ledger_add()/release/cancel
 * cores as anyone else, with no special-case money math.
 *
 * Returns null — treasury simply unavailable, never an error — when the feature
 * is off, the email is blank or does not resolve, the account is not active, not
 * KYC-verified, or has no payment method. The "enough ARV" test is left to the
 * caller because it depends on the units being matched; everything invariant
 * about the account is checked here.
 *
 * The caller must already be inside a tx() (it passes its $pdo) because the units
 * check and the escrow that follows must see a consistent, locked view.
 */
function p2p_treasury_user(PDO $pdo): ?array
{
    if (!setting_b('p2p_treasury_enabled', false)) {
        return null;
    }
    $email = trim((string)setting('p2p_treasury_email', ''));
    if ($email === '') {
        return null;
    }
    return p2p_treasury_user_by_email($pdo, $email);
}

/**
 * Resolve a treasury account by email and return it only if it is USABLE, i.e.
 * an active, KYC-verified user with a saved payment method. Null otherwise.
 *
 * Split out from p2p_treasury_user() so the admin "enable treasury" toggle can
 * validate a specific email regardless of the (about-to-change) enabled flag,
 * while the matching path resolves the currently-configured, enabled treasury.
 * The "enough ARV" test is deliberately NOT here — it depends on the units being
 * matched and is applied by p2p_treasury_fill_buy().
 */
function p2p_treasury_user_by_email(PDO $pdo, string $email): ?array
{
    $email = trim($email);
    if ($email === '') {
        return null;
    }
    $st = $pdo->prepare(
        'SELECT u.*, k.status AS kyc_status
           FROM users u
           LEFT JOIN kyc k ON k.user_id = u.id
          WHERE u.email = ? LIMIT 1'
    );
    $st->execute([$email]);
    $u = $st->fetch();
    if (!$u) {
        return null;
    }
    if (($u['status'] ?? '') !== 'active') {
        return null;
    }
    if (($u['kyc_status'] ?? 'none') !== 'verified') {
        return null;
    }
    // A buyer must have somewhere to pay — no payment method, no treasury.
    if (!p2p_default_payment_method($pdo, (int)$u['id'])) {
        return null;
    }
    return $u;
}

/**
 * The fee account user, or null when fee collection is not configured.
 *
 * Where the platform fee + P2P TDS accrue, in ARV. Falls back to the treasury
 * email when its own setting is blank; if BOTH are blank it returns null and the
 * release path collects no fee (divert = 0) rather than failing. The account only
 * needs to exist and be active — it merely receives ARV, so it needs neither KYC
 * nor a payment method here.
 *
 * Caller must already be inside a tx() (it passes its $pdo), because the credit
 * that follows locks this wallet.
 */
function p2p_fee_account_user(PDO $pdo): ?array
{
    $email = trim((string)setting('p2p_fee_account_email', ''));
    if ($email === '') {
        $email = trim((string)setting('p2p_treasury_email', ''));
    }
    if ($email === '') {
        return null;
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE email = ? AND status = "active" LIMIT 1');
    $st->execute([$email]);
    $u = $st->fetch();
    return $u ?: null;
}

/* ==================================================== escrow accounting ==== */

/** Units of a sell order still reserved by a live (matched/paid) trade, u8. */
function p2p_reserved_sell_u8(PDO $pdo, int $sellOrderId): int
{
    $v = qval(
        "SELECT COALESCE(SUM(units),0) FROM p2p_trades
          WHERE seller_order_id = ? AND status IN ('matched','paid')",
        [$sellOrderId]
    );
    return u8((string)($v ?? '0'));
}

/**
 * Units of a buy order already committed, u8.
 *
 * A buy has no escrow, so its intent is consumed by any trade that is not
 * cancelled — matched, paid, or released all count against it.
 */
function p2p_consumed_buy_u8(PDO $pdo, int $buyOrderId): int
{
    $v = qval(
        "SELECT COALESCE(SUM(units),0) FROM p2p_trades
          WHERE buyer_order_id = ? AND status IN ('matched','paid','released')",
        [$buyOrderId]
    );
    return u8((string)($v ?? '0'));
}

/** Units a sell order can still match, u8. */
function p2p_sell_matchable_u8(PDO $pdo, array $sellOrder): int
{
    return max(0, u8((string)$sellOrder['locked_units'])
                  - p2p_reserved_sell_u8($pdo, (int)$sellOrder['id']));
}

/** Units a buy order can still match, u8. */
function p2p_buy_matchable_u8(PDO $pdo, array $buyOrder): int
{
    return max(0, u8((string)$buyOrder['units'])
                  - p2p_consumed_buy_u8($pdo, (int)$buyOrder['id']));
}

/**
 * Is an order allowed to match at the current index price?
 *
 * Order TYPE only decides WHEN a match may occur — the price is always the live
 * index. A market order is always ready; a limit order is ready only when the
 * index has reached its level: a buy at or below its trigger, a sell at or above.
 * (Stop-loss / target are Phase 3.)
 */
function p2p_order_ready(array $o, float $nav): bool
{
    if ($o['otype'] === 'market') {
        return true;
    }
    $trigger = (float)$o['trigger_nav'];
    if ($trigger <= 0) {
        return false;
    }
    // The type sets the trigger DIRECTION:
    //   limit / target : buy fires at/below trigger, sell fires at/above.
    //   stop           : buy fires at/above trigger, sell fires at/below.
    $isStop = ($o['otype'] === 'stop');
    return $o['side'] === 'buy'
        ? ($isStop ? ($nav >= $trigger) : ($nav <= $trigger))
        : ($isStop ? ($nav <= $trigger) : ($nav >= $trigger));
}

/* ================================================= order status sync ======= */

/**
 * Recompute a sell order's status and filled_units from its trades.
 *
 * filled_units on a P2P order means "units that actually released" — the same
 * "completed" meaning it carries on the index book. Terminal orders are left
 * alone so a cancel is not silently un-cancelled by a later sync.
 */
function p2p_sync_sell_order(PDO $pdo, int $orderId): void
{
    $o = $pdo->query('SELECT status, locked_units FROM orders WHERE id = ' . (int)$orderId)->fetch();
    if (!$o || in_array($o['status'], ['cancelled', 'expired'], true)) {
        return;
    }

    $lockedU8   = u8((string)$o['locked_units']);
    $reserved   = p2p_reserved_sell_u8($pdo, $orderId);
    $releasedU8 = u8((string)(qval(
        "SELECT COALESCE(SUM(units),0) FROM p2p_trades
          WHERE seller_order_id = ? AND status = 'released'", [$orderId]
    ) ?? '0'));

    if ($lockedU8 <= 0) {
        $status = $releasedU8 > 0 ? 'filled' : 'cancelled';
    } elseif ($reserved > 0 || $releasedU8 > 0) {
        $status = 'partial';
    } else {
        $status = 'open';
    }

    $pdo->prepare('UPDATE orders SET status = ?, filled_units = ? WHERE id = ?')
        ->execute([$status, u8str($releasedU8), $orderId]);
}

/** Recompute a buy order's status and filled_units from its trades. */
function p2p_sync_buy_order(PDO $pdo, int $orderId): void
{
    $o = $pdo->query('SELECT status, units FROM orders WHERE id = ' . (int)$orderId)->fetch();
    if (!$o || in_array($o['status'], ['cancelled', 'expired'], true)) {
        return;
    }

    $wantU8     = u8((string)$o['units']);
    $consumed   = p2p_consumed_buy_u8($pdo, $orderId);
    $releasedU8 = u8((string)(qval(
        "SELECT COALESCE(SUM(units),0) FROM p2p_trades
          WHERE buyer_order_id = ? AND status = 'released'", [$orderId]
    ) ?? '0'));

    if ($releasedU8 >= $wantU8 && $wantU8 > 0) {
        $status = 'filled';
    } elseif ($consumed > 0) {
        $status = 'partial';
    } else {
        $status = 'open';
    }

    $pdo->prepare('UPDATE orders SET status = ?, filled_units = ? WHERE id = ?')
        ->execute([$status, u8str($releasedU8), $orderId]);
}

/* ========================================================= matching ======= */

/**
 * Pair a freshly placed P2P order against compatible resting orders.
 *
 * Settlement is at the LIVE index price passed in; the order's own type only
 * gates whether it may act now. No wallet moves happen here — the seller's units
 * are already escrowed, and a trade only reserves a slice of that escrow — so
 * this takes no wallet locks and cannot deadlock against a release/cancel; it
 * locks the order rows FOR UPDATE in FIFO order, which is enough to stop two
 * matchers reserving the same units.
 *
 * @return array<int,array> summaries of the trades created
 */
function p2p_try_match(int $orderId, float $nav): array
{
    return tx(static function (PDO $pdo) use ($orderId, $nav) {
        $st = $pdo->prepare("SELECT * FROM orders WHERE id = ? AND channel = 'p2p' FOR UPDATE");
        $st->execute([$orderId]);
        $o = $st->fetch();
        if (!$o || !in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
            return [];
        }
        if (!p2p_order_ready($o, $nav)) {
            return [];   // a limit trigger the index has not reached yet
        }

        $side    = $o['side'];
        $myMatch = $side === 'sell'
            ? p2p_sell_matchable_u8($pdo, $o)
            : p2p_buy_matchable_u8($pdo, $o);
        if ($myMatch <= 0) {
            return [];
        }

        $opp   = $side === 'sell' ? 'buy' : 'sell';
        $cSt   = $pdo->prepare(
            "SELECT * FROM orders
               WHERE channel = 'p2p' AND side = ?
                 AND status IN ('open','triggered','partial')
                 AND user_id <> ?
               ORDER BY created_at ASC, id ASC
               FOR UPDATE"
        );
        $cSt->execute([$opp, (int)$o['user_id']]);

        $out     = [];
        $minPaise = setting_i('min_order_paise', 10000);

        foreach ($cSt->fetchAll() as $c) {
            if ($myMatch <= 0) {
                break;
            }
            if (!p2p_order_ready($c, $nav)) {
                continue;
            }

            $cMatch = $c['side'] === 'sell'
                ? p2p_sell_matchable_u8($pdo, $c)
                : p2p_buy_matchable_u8($pdo, $c);
            if ($cMatch <= 0) {
                continue;
            }

            $take = min($myMatch, $cMatch);
            if ($take <= 0) {
                continue;
            }

            // Which side is the seller (the escrow holder) and which the buyer.
            $sellOrder = $side === 'sell' ? $o : $c;
            $buyOrder  = $side === 'sell' ? $c : $o;
            $sellerId  = (int)$sellOrder['user_id'];
            $buyerId   = (int)$buyOrder['user_id'];

            // Snapshot the seller's payment details now. If somehow they have
            // none, skip the pairing rather than create a trade with no way for
            // the buyer to pay.
            $pm = p2p_default_payment_method($pdo, $sellerId);
            if (!$pm) {
                continue;
            }

            $amount = u8_to_paise($take, $nav);
            if ($amount < $minPaise) {
                // Too small to be a real transfer; leave both orders resting.
                continue;
            }

            $ref = ref('P2P');
            $pdo->prepare(
                "INSERT INTO p2p_trades
                   (ref, buyer_id, seller_id, buyer_order_id, seller_order_id,
                    units, price_nav, amount_paise,
                    seller_payment_method_id, seller_payment_snapshot,
                    status, matched_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,'matched',UTC_TIMESTAMP())"
            )->execute([
                $ref, $buyerId, $sellerId,
                (int)$buyOrder['id'], (int)$sellOrder['id'],
                u8str($take), $nav, $amount,
                (int)$pm['id'], p2p_payment_snapshot($pm),
            ]);
            $tradeId = (int)$pdo->lastInsertId();

            $myMatch -= $take;

            // The just-inserted 'matched' row is visible to these recomputes on
            // the same connection, so the reserved/consumed totals are current.
            p2p_sync_sell_order($pdo, (int)$sellOrder['id']);
            p2p_sync_buy_order($pdo, (int)$buyOrder['id']);

            $out[] = [
                'id'          => $tradeId,
                'ref'         => $ref,
                'units'       => u8str($take),
                'priceNav'    => $nav,
                'amountPaise' => $amount,
                'buyerId'     => $buyerId,
                'sellerId'    => $sellerId,
            ];
        }

        // Treasury default-liquidity (Phase 2b). If this is a BUY that no real
        // seller could fully satisfy, and the treasury is enabled/available, let
        // the remainder fill against the treasury as the seller. Only the BUY
        // direction is supported here; treasury-as-BUYER is a deliberate TODO
        // (see p2p_treasury_fill_buy() below).
        if ($side === 'buy' && $myMatch > 0) {
            $tt = p2p_treasury_fill_buy($pdo, $o, $myMatch, $nav, $minPaise);
            if ($tt !== null) {
                $myMatch -= u8((string)$tt['units']);
                $out[]    = $tt;
            }
        }

        return $out;
    });
}

/**
 * Fill the unmatched remainder of a P2P BUY against the treasury account.
 *
 * Called from inside p2p_try_match's tx() when no (or not enough) real seller
 * order was available. The treasury is an ordinary user, so this creates a
 * completely normal escrow trade — the ONLY differences from a user-to-user
 * match are that the seller side has no resting sell order (seller_order_id is
 * NULL) and its ARV is escrowed HERE, at trade-creation time, instead of at
 * sell-placement time. That escrow is the exact same wallet move a sell order
 * makes (arv_units -> arv_locked_units, a zero-delta 'adjustment' ledger note),
 * so p2p_release_core()/p2p_cancel_core() then settle it with no special casing:
 *   • release → the treasury's locked units move to the buyer (its lots supply
 *     the cost basis, its realised P&L is booked) exactly like any seller;
 *   • cancel  → wallet_apply(seller, +U free, -U locked) returns the escrow, and
 *     the seller_order_id-NULL guard in the core simply skips the order sync.
 *
 * These treasury trades are confirmed by an OPERATOR from the admin P2P list
 * once the company account has actually received the buyer's rupees — they are
 * never auto-confirmed. The buyer pays and uploads proof exactly as normal.
 *
 * @return array|null the trade summary, or null if the treasury cannot fill.
 */
function p2p_treasury_fill_buy(PDO $pdo, array $buyOrder, int $wantU8, float $nav, int $minPaise): ?array
{
    if ($wantU8 <= 0) {
        return null;
    }

    $treasury = p2p_treasury_user($pdo);
    if ($treasury === null) {
        return null;
    }
    $treasuryId = (int)$treasury['id'];
    $buyerId    = (int)$buyOrder['user_id'];

    // The treasury never trades with itself.
    if ($treasuryId === $buyerId) {
        return null;
    }

    // Lock the treasury wallet and see how much free ARV it actually has. Take
    // the smaller of what the buyer wants and what the treasury can back; the
    // rest of the buy simply stays resting.
    $tw   = wallet_for_update($pdo, $treasuryId);
    $free = u8((string)$tw['arv_units']);
    $take = min($wantU8, $free);
    if ($take <= 0) {
        return null;   // treasury holds nothing free — unavailable, not an error
    }

    $amount = u8_to_paise($take, $nav);
    if ($amount < $minPaise) {
        // Too small to be a real transfer; leave the buy resting.
        return null;
    }

    // The buyer pays the treasury's default payment method (the company UPI/bank).
    $pm = p2p_default_payment_method($pdo, $treasuryId);
    if (!$pm) {
        return null;   // guarded by p2p_treasury_user(), but re-checked defensively
    }

    // Escrow the treasury's units EXACTLY as a sell order would: arv_units ->
    // arv_locked_units, with a zero-delta 'adjustment' note so the lock is
    // visible in the ledger without double-counting units. This must happen
    // BEFORE the trade row exists so the release/cancel cores find the units
    // already locked, just like a normal seller's.
    wallet_apply($pdo, $treasuryId, 0, 0, -$take, $take);
    ledger_add($pdo, $treasuryId, 'adjustment', 0, 0, [
        'ref'  => (string)$buyOrder['ref'], 'relatedId' => (int)$buyOrder['id'],
        'note' => sprintf('%s ARV escrowed for a P2P treasury sell', u8str($take)),
    ]);

    $ref = ref('P2P');
    $pdo->prepare(
        "INSERT INTO p2p_trades
           (ref, buyer_id, seller_id, buyer_order_id, seller_order_id,
            units, price_nav, amount_paise,
            seller_payment_method_id, seller_payment_snapshot,
            status, matched_at)
         VALUES (?,?,?,?,NULL,?,?,?,?,?,'matched',UTC_TIMESTAMP())"
    )->execute([
        $ref, $buyerId, $treasuryId,
        (int)$buyOrder['id'],
        u8str($take), $nav, $amount,
        (int)$pm['id'], p2p_payment_snapshot($pm),
    ]);
    $tradeId = (int)$pdo->lastInsertId();

    // The buy order has consumed this slice (the just-inserted 'matched' row is
    // visible to the recompute on this connection). There is no sell order to
    // sync — the treasury has none.
    p2p_sync_buy_order($pdo, (int)$buyOrder['id']);

    return [
        'id'          => $tradeId,
        'ref'         => $ref,
        'units'       => u8str($take),
        'priceNav'    => $nav,
        'amountPaise' => $amount,
        'buyerId'     => $buyerId,
        'sellerId'    => $treasuryId,
        'treasury'    => true,
    ];
}

/**
 * TODO (Phase 2b, deferred): treasury-as-BUYER for an unmatched SELL.
 *
 * The mirror direction — a seller with no real buyer selling to the treasury,
 * with the operator paying the seller from the company account and then
 * releasing — was intentionally NOT built here. It is more than a mirror: the
 * "buyer" is an operator-controlled account that would have to pay the seller
 * off-platform and then either upload proof as the buyer or admin-release, and
 * getting that choreography wrong risks releasing a seller's escrow before the
 * company has actually paid them. Rather than implement it half-correctly, it is
 * left as a documented gap. Treasury-as-SELLER (above) is complete and solid.
 * When this is built it MUST, like everything else, escrow and settle only
 * through wallet_apply()/ledger_add()/p2p_release_core()/p2p_cancel_core().
 */

/* ==================================================== release / cancel ==== */

/**
 * Release a P2P trade: move the escrowed units from seller to buyer.
 *
 * Called with the p2p_trades row ALREADY locked FOR UPDATE inside the caller's
 * transaction, and only when status is 'paid'. Mirrors execute_fill()'s money
 * discipline: FIFO cost basis for the seller, a fresh lot for the buyer, a
 * ledger entry on each side, and one immutable `trades` row for tax/history —
 * but NO rupees move on-platform, because the buyer paid the seller directly.
 *
 * @return array a summary for the response and audit log
 */
function p2p_release_core(PDO $pdo, array $t): array
{
    $units8 = u8((string)$t['units']);
    if ($units8 <= 0) {
        throw new RuntimeException('Refusing to release a zero-unit trade.');
    }

    $amount   = (int)$t['amount_paise'];
    $nav      = (float)$t['price_nav'];
    $sellerId = (int)$t['seller_id'];
    $buyerId  = (int)$t['buyer_id'];
    $fy       = fy_of();
    $tradeRef = ref('TRD');

    /* ---------------------------------------------------------- seller ---- */
    // FIFO cost basis, inside this transaction. A shortfall means the lots do
    // not account for the escrowed units — refuse rather than invent a basis,
    // exactly as the index fill does.
    $lots = consume_lots($pdo, $sellerId, $units8);
    if ($lots['shortfall8'] > 0) {
        throw new RuntimeException(
            'Cost basis is incomplete for this holding — the release was refused rather '
            . 'than guessing a purchase price. Operations has been notified.'
        );
    }
    $costBasis = $lots['costPaise'];
    $pnl       = $amount - $costBasis;
    $gain      = max(0, $pnl);
    $tax       = pct_of($gain, setting_f('vda_gain_pct', 30));
    $cess      = pct_of($tax, setting_f('cess_pct', 4));

    /* --------------------------------------------- platform fee + TDS (ARV) */
    // Phase 2b fee model — collected in ARV, one-sided, units-neutral.
    //
    //   feeUnits = round8(U * p2p_fee_pct/100)   (basis-point integer math)
    //   tdsUnits = round8(U * p2p_tds_pct/100)
    //   divert   = feeUnits + tdsUnits            (capped so divert < U)
    //
    // The BUYER receives U - divert units (they already paid the seller the full
    // ₹ for U off-platform; the platform's fee + TDS is taken from the ARV they
    // receive, never from the rupees). The SELLER side is unchanged — they still
    // release U units, keep their full ₹, and their cost basis / P&L are on U.
    // The `divert` units are credited to the fee account with their own lot, so
    // net units balance to zero:  seller −U ; buyer +(U−divert) ; fee +divert.
    // If no fee account resolves, divert = 0 and the buyer receives the full U.
    //
    // Integer u8 throughout: the percentages become integer basis points, so the
    // only rounding is the final round-to-nearest-u8 of each slice — no float
    // ever touches a stored unit balance.
    $feeAcct  = p2p_fee_account_user($pdo);
    $feeUnits = 0;
    $tdsUnits = 0;
    if ($feeAcct !== null) {
        $feeBps   = (int)round(setting_f('p2p_fee_pct', 1) * 100);   // 1% -> 100 bps
        $tdsBps   = (int)round(setting_f('p2p_tds_pct', 0) * 100);   // 0% -> 0 bps
        $feeUnits = $feeBps > 0 ? (int)round($units8 * $feeBps / 10000) : 0;
        $tdsUnits = $tdsBps > 0 ? (int)round($units8 * $tdsBps / 10000) : 0;
    }
    $divert = $feeUnits + $tdsUnits;
    // Never divert the whole (or more than the whole) trade — the buyer must
    // receive something. With the 0–5 / 0–30 guardrails this can never trigger
    // (max 35%), but guard defensively rather than trust the settings.
    if ($divert >= $units8 || $divert < 0) {
        $feeUnits = 0;
        $tdsUnits = 0;
        $divert   = 0;
    }
    $buyerUnits8 = $units8 - $divert;

    // Units leave escrow; cost basis released; realised P&L booked. No INR — the
    // rupees were paid off-platform, so nothing on-platform is credited or
    // withheld on the seller side. The seller always releases the full U.
    wallet_apply($pdo, $sellerId, 0, 0, 0, -$units8, -$costBasis, $pnl);
    ledger_add($pdo, $sellerId, 'sell', 0, -$units8, [
        'nav' => $nav, 'ref' => $tradeRef, 'fy' => $fy, 'relatedId' => (int)$t['id'],
        'note' => sprintf('Sold %s ARV P2P at %.4f (paid off-platform)', u8str($units8), $nav),
    ]);

    /* ----------------------------------------------------------- buyer ---- */
    // Units in (U - divert); cost basis = the full rupees actually paid to the
    // seller. The buyer paid for U but receives U-divert, so their effective
    // cost per unit is a little above nav — which is exactly the fee, borne in
    // ARV, made visible in their own holding.
    wallet_apply($pdo, $buyerId, 0, 0, $buyerUnits8, 0, $amount, 0);
    ledger_add($pdo, $buyerId, 'buy', 0, $buyerUnits8, [
        'nav' => $nav, 'ref' => $tradeRef, 'fy' => $fy, 'relatedId' => (int)$t['id'],
        'note' => $divert > 0
            ? sprintf('Bought %s ARV P2P at %.4f (paid off-platform; %s ARV platform fee+TDS)',
                      u8str($buyerUnits8), $nav, u8str($divert))
            : sprintf('Bought %s ARV P2P at %.4f (paid off-platform)', u8str($buyerUnits8), $nav),
    ]);

    /* ------------------------------------------------- fee account (ARV) -- */
    // The diverted units accrue to the operator's fee account as a real holding:
    // arv_units += divert, with its own lot at cost = the ₹ value of those units
    // at nav (so the account shows coherent, zero-unrealised holdings it can
    // later sell). Locked LAST — after seller and buyer — so the single fee
    // account row is a consistent tail lock across concurrent releases.
    $divertPaise = 0;
    if ($divert > 0 && $feeAcct !== null) {
        $feeAcctId   = (int)$feeAcct['id'];
        $divertPaise = u8_to_paise($divert, $nav);
        wallet_apply($pdo, $feeAcctId, 0, 0, $divert, 0, $divertPaise, 0);
        ledger_add($pdo, $feeAcctId, 'buy', 0, $divert, [
            'nav' => $nav, 'ref' => $tradeRef, 'fy' => $fy, 'relatedId' => (int)$t['id'],
            'note' => sprintf('P2P platform fee+TDS: %s ARV (fee %s + TDS %s)',
                              u8str($divert), u8str($feeUnits), u8str($tdsUnits)),
        ]);
    }

    /* ------------------------------------------------------ trade row ---- */
    // One immutable fill row so the tax statement and history read the same as
    // an index fill. This row is the SELLER's transfer of the full U units for
    // `amount` — its tax fields (cost basis, realised P&L, 30%+cess) are all the
    // seller's, unchanged by the fee model. The paise fee/GST/TDS columns stay
    // zero: the P2P platform fee + TDS are collected in ARV (see the fee account
    // credit above), not as on-platform rupees. gross_paise = the full amount so
    // the seller's 194S threshold aggregation (tds_assess) is unaffected.
    $pdo->prepare(
        'INSERT INTO trades
           (ref, buy_order_id, sell_order_id, buyer_id, seller_id, counterparty,
            units, nav, gross_paise,
            buyer_fee_paise, buyer_gst_paise,
            seller_fee_paise, seller_gst_paise, seller_tds_paise, seller_net_paise,
            cost_basis_paise, realised_pnl_paise, tax_paise, cess_paise, fy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )->execute([
        $tradeRef,
        $t['buyer_order_id'] !== null ? (int)$t['buyer_order_id'] : null,
        $t['seller_order_id'] !== null ? (int)$t['seller_order_id'] : null,
        $buyerId, $sellerId, 'user',
        u8str($units8), $nav, $amount,
        0, 0,
        0, 0, 0, $amount,
        $costBasis, $pnl, $tax, $cess,
        $fy,
    ]);
    $tradesId = (int)$pdo->lastInsertId();

    // The buyer's lot, linked to that fill — the units they actually received
    // (U - divert) at the full rupees they paid.
    $pdo->prepare(
        'INSERT INTO lots (user_id, units, units_remaining, cost_paise, nav, trade_id)
         VALUES (?, ?, ?, ?, ?, ?)'
    )->execute([$buyerId, u8str($buyerUnits8), u8str($buyerUnits8), $amount, $nav, $tradesId]);

    // The fee account's lot for the diverted units, at their nav value — so its
    // holding is coherent (value == cost at receipt) and later sellable through
    // the ordinary sell/consume_lots path.
    if ($divert > 0 && $feeAcct !== null) {
        $pdo->prepare(
            'INSERT INTO lots (user_id, units, units_remaining, cost_paise, nav, trade_id)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([(int)$feeAcct['id'], u8str($divert), u8str($divert), $divertPaise, $nav, $tradesId]);
    }

    /* -------------------------------------------------- state transitions - */
    // Record the diverted split on the p2p_trades row so the buyer's view can
    // show it. This is a convenience mirror of the fee account's ledger/lot,
    // which remain the book of record.
    $pdo->prepare(
        "UPDATE p2p_trades SET status = 'released', released_at = UTC_TIMESTAMP(),
                trade_id = ?, fee_units = ?, tds_units = ?
          WHERE id = ?"
    )->execute([$tradesId, u8str($feeUnits), u8str($tdsUnits), (int)$t['id']]);

    // The escrowed units have left the sell order.
    if ($t['seller_order_id'] !== null) {
        $soId = (int)$t['seller_order_id'];
        $so = $pdo->query('SELECT locked_units FROM orders WHERE id = ' . $soId . ' FOR UPDATE')->fetch();
        if ($so) {
            $newLocked = max(0, u8((string)$so['locked_units']) - $units8);
            $pdo->prepare('UPDATE orders SET locked_units = ? WHERE id = ?')
                ->execute([u8str($newLocked), $soId]);
            p2p_sync_sell_order($pdo, $soId);
        }
    }
    if ($t['buyer_order_id'] !== null) {
        p2p_sync_buy_order($pdo, (int)$t['buyer_order_id']);
    }

    return [
        'ref'            => (string)$t['ref'],
        'tradeRef'       => $tradeRef,
        'units'          => u8str($units8),
        'buyerUnits'     => u8str($buyerUnits8),
        'feeUnits'       => u8str($feeUnits),
        'tdsUnits'       => u8str($tdsUnits),
        'divertUnits'    => u8str($divert),
        'feeAccountId'   => $feeAcct !== null && $divert > 0 ? (int)$feeAcct['id'] : null,
        'amountPaise'    => $amount,
        'priceNav'       => $nav,
        'costBasisPaise' => $costBasis,
        'realisedPaise'  => $pnl,
        'buyerId'        => $buyerId,
        'sellerId'       => $sellerId,
    ];
}

/**
 * Cancel a P2P trade before payment: return the escrowed units to the seller.
 *
 * Called with the p2p_trades row ALREADY locked FOR UPDATE, and only when status
 * is 'matched'. Mirrors orders.php handle_cancel exactly: locked units go back to
 * the available balance (a net-zero move), a zero-delta 'adjustment' note records
 * it, and no rupees or realised P&L are touched because nothing was ever sold.
 */
function p2p_cancel_core(PDO $pdo, array $t, string $reason = ''): array
{
    $units8   = u8((string)$t['units']);
    $sellerId = (int)$t['seller_id'];

    if ($units8 > 0) {
        // arv_locked_units -> arv_units, exactly as an index order cancel.
        wallet_apply($pdo, $sellerId, 0, 0, $units8, -$units8);
        ledger_add($pdo, $sellerId, 'adjustment', 0, 0, [
            'ref' => (string)$t['ref'], 'relatedId' => (int)$t['id'],
            'note' => 'P2P trade cancelled — escrow returned'
                    . ($reason !== '' ? ' (' . substr($reason, 0, 180) . ')' : ''),
        ]);
    }

    if ($t['seller_order_id'] !== null) {
        $soId = (int)$t['seller_order_id'];
        $so = $pdo->query('SELECT locked_units FROM orders WHERE id = ' . $soId . ' FOR UPDATE')->fetch();
        if ($so) {
            $newLocked = max(0, u8((string)$so['locked_units']) - $units8);
            $pdo->prepare('UPDATE orders SET locked_units = ? WHERE id = ?')
                ->execute([u8str($newLocked), $soId]);
            p2p_sync_sell_order($pdo, $soId);
        }
    }
    if ($t['buyer_order_id'] !== null) {
        p2p_sync_buy_order($pdo, (int)$t['buyer_order_id']);
    }

    $pdo->prepare(
        "UPDATE p2p_trades SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancel_reason = ?
          WHERE id = ?"
    )->execute([substr($reason, 0, 255), (int)$t['id']]);

    return [
        'ref'           => (string)$t['ref'],
        'returnedUnits' => u8str($units8),
        'sellerId'      => $sellerId,
    ];
}

/* ========================================================== shaping ======= */

/**
 * Shape a p2p_trades row for the API.
 *
 * The seller's payment snapshot is only ever exposed to the trade's own buyer
 * (who must pay it) or an operator (who may need it for a dispute). A seller
 * never needs to be shown their own snapshot back, and no third party sees it.
 */
function p2p_trade_public(array $t, int $viewerId, bool $isAdmin = false): array
{
    $isBuyer  = (int)$t['buyer_id'] === $viewerId;
    $isSeller = (int)$t['seller_id'] === $viewerId;
    $role     = $isAdmin && !$isBuyer && !$isSeller ? 'admin'
              : ($isBuyer ? 'buyer' : ($isSeller ? 'seller' : 'other'));

    // Phase-2 deadlines, computed from the same TTL settings the maintenance cron
    // enforces so the UI counts down to the exact instant an auto-action fires.
    // A 'matched' trade shows the buyer's pay deadline; a 'paid' one shows the
    // seller's confirm deadline (after which it goes to dispute). Everything else
    // has no live deadline.
    $payDeadline = $t['status'] === 'matched'
        ? p2p_deadline_iso($t['matched_at'] ?? null, setting_i('p2p_pay_ttl_minutes', 60) * 60)
        : null;
    $confirmDeadline = $t['status'] === 'paid'
        ? p2p_deadline_iso($t['paid_at'] ?? null, setting_i('p2p_confirm_ttl_hours', 4) * 3600)
        : null;

    $out = [
        'id'          => (int)$t['id'],
        'ref'         => $t['ref'],
        'role'        => $role,
        'status'      => $t['status'],
        'units'       => (string)$t['units'],
        // Phase 2b: the platform fee + TDS diverted (in ARV) on release, and the
        // units the buyer actually received (units - fee - tds). Zero/units until
        // released; populated from the p2p_trades row. Shown so the buyer sees
        // exactly what the platform took.
        'feeUnits'    => u8str(u8((string)($t['fee_units'] ?? '0'))),
        'tdsUnits'    => u8str(u8((string)($t['tds_units'] ?? '0'))),
        'netUnits'    => u8str(max(0, u8((string)$t['units'])
                          - u8((string)($t['fee_units'] ?? '0'))
                          - u8((string)($t['tds_units'] ?? '0')))),
        'priceNav'    => (float)$t['price_nav'],
        'amountPaise' => (int)$t['amount_paise'],
        'buyerId'     => (int)$t['buyer_id'],
        'sellerId'    => (int)$t['seller_id'],
        'proofUtr'    => $t['proof_utr'] !== '' ? $t['proof_utr'] : null,
        'hasProofImage' => ($t['proof_image_path'] ?? '') !== '',
        'matchedAt'   => $t['matched_at'] ?? null,
        'paidAt'      => $t['paid_at'] ?? null,
        'releasedAt'  => $t['released_at'] ?? null,
        'cancelledAt' => $t['cancelled_at'] ?? null,
        'disputeAt'   => $t['dispute_at'] ?? null,
        'resolvedAt'  => $t['resolved_at'] ?? null,
        'resolution'  => ($t['resolution'] ?? '') !== '' ? $t['resolution'] : null,
        'createdAt'   => $t['created_at'] ?? null,
        // ISO-8601 UTC deadlines (with a trailing Z) so the browser can count
        // down correctly regardless of the viewer's timezone.
        'payDeadline'     => $payDeadline,
        'confirmDeadline' => $confirmDeadline,
        // What each viewer may do next, so the UI does not have to re-derive the
        // rules the endpoints already enforce. A 'disputed' trade is operator-only
        // — neither party may act, so all three stay false.
        'canUploadProof' => $isBuyer && $t['status'] === 'matched',
        'canConfirm'     => $isSeller && $t['status'] === 'paid',
        'canCancel'      => ($isBuyer || $isSeller) && $t['status'] === 'matched',
    ];

    if ($isBuyer || $isAdmin) {
        $snap = null;
        if (($t['seller_payment_snapshot'] ?? '') !== '') {
            $decoded = json_decode((string)$t['seller_payment_snapshot'], true);
            if (is_array($decoded)) {
                $snap = $decoded;
            }
        }
        $out['sellerPayment'] = $snap;
    }

    return $out;
}


/* ================================================= phase-2 maintenance ==== */

/**
 * A UTC ISO-8601 deadline = a stored UTC datetime + N seconds, or null.
 *
 * The p2p_trades timestamps are written with UTC_TIMESTAMP(), so they are parsed
 * as UTC here (the ' UTC' suffix) and re-emitted with a trailing Z. That lets the
 * browser count down to the exact instant the maintenance cron will act, no
 * matter the viewer's timezone.
 */
function p2p_deadline_iso(?string $baseUtc, int $addSeconds): ?string
{
    if ($baseUtc === null || $baseUtc === '') {
        return null;
    }
    $ts = strtotime($baseUtc . ' UTC');
    if ($ts === false) {
        return null;
    }
    return gmdate('Y-m-d\TH:i:s\Z', $ts + $addSeconds);
}

/**
 * P2P Phase-2 timer sweep — run every cron tick, idempotent.
 *
 * Three independent cases, each row handled in its OWN tx() with the row locked
 * FOR UPDATE and its status/age re-checked under that lock before anything moves.
 * Every escrow movement goes through the SAME Phase-1 cores the user and admin
 * paths use (p2p_cancel_core) or the same unlock code as handle_cancel_order —
 * nothing here invents balance math, and nothing writes a wallet column directly.
 *
 * The re-check under FOR UPDATE is the guard against double-refund/double-release:
 * if a user confirm/cancel or an operator override raced this sweep, the status
 * will no longer qualify and the row is skipped. Candidate ids are gathered with
 * an unlocked read first, then re-validated inside each tx, so a long tick never
 * holds a wide lock.
 *
 * @return array{ordersExpired:int,tradesExpired:int,tradesDisputed:int}
 */
function p2p_maintenance(): array
{
    // Same guardrails as admin.php handle_save_setting, applied defensively in
    // case a value was ever written out of band.
    $matchTtlH   = max(1, min(168,  setting_i('p2p_match_ttl_hours', 24)));
    $payTtlMin   = max(5, min(1440, setting_i('p2p_pay_ttl_minutes', 60)));
    $confirmTtlH = max(1, min(72,   setting_i('p2p_confirm_ttl_hours', 4)));

    $ordersExpired  = 0;   // unmatched P2P orders past the match TTL
    $tradesExpired  = 0;   // matched, buyer never paid → auto-cancel + expired
    $tradesDisputed = 0;   // paid, seller never confirmed → disputed (no money move)

    /* -- Case A: unmatched P2P orders past the match TTL, with no active trade. */
    // A resting P2P order older than the TTL with nothing live hanging off it is
    // abandoned. For a sell we return its remaining escrow exactly as
    // handle_cancel_order / p2p_cancel_core do (arv_locked_units -> arv_units,
    // locked_units -> 0, a zero-delta 'adjustment' ledger note); a buy holds no
    // escrow so it merely stops matching.
    $orderIds = array_map('intval', array_column(q(
        "SELECT id FROM orders
          WHERE channel = 'p2p'
            AND status IN ('open','triggered','partial')
            AND created_at <= (UTC_TIMESTAMP() - INTERVAL ? HOUR)",
        [$matchTtlH]
    )->fetchAll(), 'id'));

    foreach ($orderIds as $oid) {
        $ordersExpired += tx(static function (PDO $pdo) use ($oid, $matchTtlH) {
            $st = $pdo->prepare("SELECT * FROM orders WHERE id = ? AND channel = 'p2p' FOR UPDATE");
            $st->execute([$oid]);
            $o = $st->fetch();
            if (!$o || !in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
                return 0;   // already terminal, or a racing cancel won
            }
            // Re-check the age under the lock, in the DB's own clock.
            $tooOld = (bool)qval(
                "SELECT created_at <= (UTC_TIMESTAMP() - INTERVAL ? HOUR) FROM orders WHERE id = ?",
                [$matchTtlH, $oid]
            );
            if (!$tooOld) {
                return 0;
            }

            if ($o['side'] === 'sell') {
                // If any live trade still reserves this order's escrow, it is not
                // abandoned — leave it to the trade timers (Case B/C).
                $reserved = p2p_reserved_sell_u8($pdo, (int)$o['id']);
                if ($reserved > 0) {
                    return 0;
                }
                $lockedUnits = u8((string)$o['locked_units']);
                if ($lockedUnits > 0) {
                    // reserved == 0 here, so the whole locked balance is unreserved
                    // escrow and returns to available. Net-zero move, same as a
                    // user order-cancel.
                    wallet_apply($pdo, (int)$o['user_id'], 0, 0, $lockedUnits, -$lockedUnits);
                    $pdo->prepare('UPDATE orders SET locked_units = 0 WHERE id = ?')->execute([$oid]);
                    ledger_add($pdo, (int)$o['user_id'], 'adjustment', 0, 0, [
                        'ref' => (string)$o['ref'], 'relatedId' => (int)$o['id'],
                        'note' => 'P2P sell order expired — escrow returned',
                    ]);
                }
            } else {
                // Buy: no escrow, but refuse to expire it out from under a live
                // trade (matched/paid) still resolving against it.
                $active = u8((string)(qval(
                    "SELECT COALESCE(SUM(units),0) FROM p2p_trades
                      WHERE buyer_order_id = ? AND status IN ('matched','paid')", [$oid]
                ) ?? '0'));
                if ($active > 0) {
                    return 0;
                }
            }

            $pdo->prepare("UPDATE orders SET status = 'expired' WHERE id = ?")->execute([$oid]);
            return 1;
        });
    }

    /* -- Case B: matched trades the buyer never paid, past the pay TTL. */
    // Auto-cancel through the Phase-1 core (escrow returns to the seller), then
    // mark 'expired' to distinguish an automatic timeout from a manual cancel.
    // Both are terminal and excluded from the reserved/released sums, so the
    // status rewrite does not disturb the order sync the core already ran.
    $matchedIds = array_map('intval', array_column(q(
        "SELECT id FROM p2p_trades
          WHERE status = 'matched'
            AND matched_at IS NOT NULL
            AND matched_at <= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)",
        [$payTtlMin]
    )->fetchAll(), 'id'));

    foreach ($matchedIds as $tid) {
        $tradesExpired += tx(static function (PDO $pdo) use ($tid, $payTtlMin) {
            $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
            $st->execute([$tid]);
            $t = $st->fetch();
            if (!$t || $t['status'] !== 'matched') {
                return 0;   // buyer paid, or someone cancelled, in the meantime
            }
            $tooOld = (bool)qval(
                "SELECT matched_at <= (UTC_TIMESTAMP() - INTERVAL ? MINUTE) FROM p2p_trades WHERE id = ?",
                [$payTtlMin, $tid]
            );
            if (!$tooOld) {
                return 0;
            }
            // Returns the escrow to the seller and sets status='cancelled'.
            p2p_cancel_core($pdo, $t, 'auto-expired: buyer did not pay within the payment window');
            // Relabel to 'expired' so the auto path is distinguishable from a
            // human cancel. cancelled_at + cancel_reason set by the core stay.
            $pdo->prepare("UPDATE p2p_trades SET status = 'expired' WHERE id = ?")->execute([$tid]);
            return 1;
        });
    }

    /* -- Case C: paid trades the seller never confirmed, past the confirm TTL. */
    // The buyer paid and uploaded proof; the seller went quiet. This must NOT
    // auto-release (the seller may genuinely not have been paid) and must NOT
    // auto-return the escrow (the buyer may genuinely have paid) — it goes to an
    // operator. No money moves; only the status and dispute_at change.
    $paidIds = array_map('intval', array_column(q(
        "SELECT id FROM p2p_trades
          WHERE status = 'paid'
            AND paid_at IS NOT NULL
            AND paid_at <= (UTC_TIMESTAMP() - INTERVAL ? HOUR)",
        [$confirmTtlH]
    )->fetchAll(), 'id'));

    foreach ($paidIds as $tid) {
        $tradesDisputed += tx(static function (PDO $pdo) use ($tid, $confirmTtlH) {
            $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
            $st->execute([$tid]);
            $t = $st->fetch();
            if (!$t || $t['status'] !== 'paid') {
                return 0;   // seller confirmed (released) or it was cancelled
            }
            $tooOld = (bool)qval(
                "SELECT paid_at <= (UTC_TIMESTAMP() - INTERVAL ? HOUR) FROM p2p_trades WHERE id = ?",
                [$confirmTtlH, $tid]
            );
            if (!$tooOld) {
                return 0;
            }
            $pdo->prepare(
                "UPDATE p2p_trades SET status = 'disputed', dispute_at = UTC_TIMESTAMP() WHERE id = ?"
            )->execute([$tid]);
            return 1;
        });
    }

    /* -- Case D: price triggers. A resting limit/stop/target P2P order fires when
       the live index price reaches its trigger (direction per p2p_order_ready).
       This is also what lets two resting orders pair on pure price movement. */
    // Never fire on a missing/stale price — nominate nothing if the feed is down.
    $navNow = null;
    try {
        $navNow = arv_nav();
    } catch (\Throwable $e) {
        $navNow = null;
    }
    $triggersFired = 0;
    if ($navNow !== null && $navNow > 0) {
        $candidates = q(
            "SELECT id, side, otype, trigger_nav FROM orders
              WHERE channel = 'p2p'
                AND otype IN ('limit','stop','target')
                AND status IN ('open','triggered','partial')
              ORDER BY created_at ASC, id ASC
              LIMIT 500"
        )->fetchAll();
        foreach ($candidates as $c) {
            if (!p2p_order_ready($c, $navNow)) {
                continue;   // trigger not reached yet
            }
            // p2p_try_match locks the order FOR UPDATE and re-checks readiness +
            // status before creating any trade, so a racing tick, cancel or
            // placement can never double-fire the same units.
            $made = p2p_try_match((int)$c['id'], $navNow);
            if ($made) {
                $triggersFired += count($made);
            }
        }
    }

    return [
        'ordersExpired'  => $ordersExpired,
        'tradesExpired'  => $tradesExpired,
        'tradesDisputed' => $tradesDisputed,
        'triggersFired'  => $triggersFired,
    ];
}
