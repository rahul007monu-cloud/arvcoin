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
    return $o['side'] === 'buy' ? ($nav <= $trigger) : ($nav >= $trigger);
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

        return $out;
    });
}

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

    // Units leave escrow; cost basis released; realised P&L booked. No INR — the
    // rupees were paid off-platform, so nothing on-platform is credited or
    // withheld (TDS/fee handling in the P2P model is a Phase 2 decision).
    wallet_apply($pdo, $sellerId, 0, 0, 0, -$units8, -$costBasis, $pnl);
    ledger_add($pdo, $sellerId, 'sell', 0, -$units8, [
        'nav' => $nav, 'ref' => $tradeRef, 'fy' => $fy, 'relatedId' => (int)$t['id'],
        'note' => sprintf('Sold %s ARV P2P at %.4f (paid off-platform)', u8str($units8), $nav),
    ]);

    /* ----------------------------------------------------------- buyer ---- */
    // Units in; cost basis = the rupees actually paid to the seller.
    wallet_apply($pdo, $buyerId, 0, 0, $units8, 0, $amount, 0);
    ledger_add($pdo, $buyerId, 'buy', 0, $units8, [
        'nav' => $nav, 'ref' => $tradeRef, 'fy' => $fy, 'relatedId' => (int)$t['id'],
        'note' => sprintf('Bought %s ARV P2P at %.4f (paid off-platform)', u8str($units8), $nav),
    ]);

    /* ------------------------------------------------------ trade row ---- */
    // One immutable fill row so the tax statement and history read the same as
    // an index fill. Fees/GST/TDS are zero in Phase 1 P2P (no on-platform INR);
    // the seller's 30%+cess is REPORTED, never withheld, exactly as elsewhere.
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

    // The buyer's lot, linked to that fill.
    $pdo->prepare(
        'INSERT INTO lots (user_id, units, units_remaining, cost_paise, nav, trade_id)
         VALUES (?, ?, ?, ?, ?, ?)'
    )->execute([$buyerId, u8str($units8), u8str($units8), $amount, $nav, $tradesId]);

    /* -------------------------------------------------- state transitions - */
    $pdo->prepare(
        "UPDATE p2p_trades SET status = 'released', released_at = UTC_TIMESTAMP(), trade_id = ?
          WHERE id = ?"
    )->execute([$tradesId, (int)$t['id']]);

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

    return [
        'ordersExpired'  => $ordersExpired,
        'tradesExpired'  => $tradesExpired,
        'tradesDisputed' => $tradesDisputed,
    ];
}
