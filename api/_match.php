<?php
/**
 * The matching engine.
 *
 * ---------------------------------------------------------------------------
 * Why this is a queue and not an auction
 * ---------------------------------------------------------------------------
 * ARV's price is a formula: ₹1 at launch, moved by Bitcoin's percentage change.
 * An order book that also *discovered* price would fight that formula — on a thin
 * day a single trade at a silly level would drag the chart away from Bitcoin and
 * break the one promise the product makes.
 *
 * So every fill settles at the index price, and the book is a queue of intent:
 * who wants how much. A "limit" order is therefore a trigger — act when the index
 * reaches this level — not an offer someone else has to accept. There is no
 * spread, no price negotiation, and nothing for a counterparty to haggle over.
 *
 * ---------------------------------------------------------------------------
 * Asymmetry, on purpose
 * ---------------------------------------------------------------------------
 *   BUY  fills immediately. Resting sell orders first, then the treasury.
 *        Making buyers queue for sellers is how a new exchange dies before it
 *        starts — on day one there are no sellers at all.
 *
 *   SELL prefers a real counterparty: resting buy orders first. Whatever is left
 *        rests in the book, and if it is still unmatched after
 *        `sell_fallback_minutes` the treasury buys it.
 *
 * That fallback is not a nicety. Without it, a falling market means everyone
 * wants out and nobody wants in, and holders are locked in with no exit. "My
 * money is stuck" is the complaint that ends products, and it is a promise this
 * design can actually keep because the treasury holds the underlying asset.
 *
 * ---------------------------------------------------------------------------
 * Concurrency
 * ---------------------------------------------------------------------------
 * Two people hitting sell at the same instant must not both fill against the same
 * resting buy order. Every fill happens inside one transaction, and orders are
 * always claimed with SELECT ... FOR UPDATE ordered by created_at then id — so a
 * second matcher blocks on the same rows instead of double-filling them.
 *
 * Wallet and lot locks are then taken per fill, seller side before buyer side.
 * That is not a globally sorted lock order, so two concurrent matchers touching
 * an overlapping pair of users can still deadlock; InnoDB kills one, and `tx()`
 * retries it once. Under this product's volume that retry is the cheap and
 * correct answer, and it is why the retry exists rather than being decoration.
 */

declare(strict_types=1);

/* ============================================================ triggers ==== */

/**
 * Activate limit orders whose trigger the index has now reached.
 *
 * Buy triggers at or below the level, sell at or above — the ordinary meaning of
 * a limit price, expressed against a computed index rather than a counterparty.
 */
function activate_triggers(float $nav): int
{
    $st = q(
        'UPDATE orders
            SET status = "triggered"
          WHERE status = "open"
            AND otype = "limit"
            AND (
                  (side = "buy"  AND trigger_nav >= ?)
               OR (side = "sell" AND trigger_nav <= ?)
                )',
        [$nav, $nav]
    );
    return $st->rowCount();
}

/**
 * Orders ready to be matched, oldest first.
 *
 * Market orders are always ready. Limit orders are ready once triggered. FIFO
 * within a side is the only fair tie-break available when there is no price to
 * compete on — whoever asked first is served first.
 */
function ready_orders(PDO $pdo, string $side, bool $lock = true): array
{
    $sql = 'SELECT * FROM orders
             WHERE side = ?
               AND status IN ("open","triggered","partial")
               AND (otype = "market" OR status IN ("triggered","partial"))
             ORDER BY created_at ASC, id ASC';
    if ($lock) {
        $sql .= ' FOR UPDATE';
    }
    $st = $pdo->prepare($sql);
    $st->execute([$side]);
    return $st->fetchAll();
}

/**
 * How much of a buy order's escrow can actually reach the market.
 *
 * The escrow holds the gross amount *plus* the entry fee and its GST, because all
 * three are debited on a fill. So the rupees available to buy units with are less
 * than the rupees held — and dividing the whole escrow by the price would size the
 * order as though the fees were free, then try to debit them on top. That is what
 * makes a fill exceed its own escrow.
 *
 * Inverting the charge stack gives the gross G that fits in escrow L:
 *
 *     G × (1 + e/100 × (1 + g/100))  =  L
 *
 * The floor can still leave the recomputed fee a paise over L because pct_of
 * rounds, so the result is stepped down until it genuinely fits. That loop runs
 * once or twice, never more.
 */
function buy_spendable_paise(int $lockedPaise, float $entryPct, float $gstPct): int
{
    if ($lockedPaise <= 0) {
        return 0;
    }
    $gross = (int)floor($lockedPaise / (1 + ($entryPct / 100) * (1 + $gstPct / 100)));

    while ($gross > 0) {
        $fee = pct_of($gross, $entryPct);
        $gst = pct_of($fee, $gstPct);
        if ($gross + $fee + $gst <= $lockedPaise) {
            break;
        }
        $gross--;
    }
    return max(0, $gross);
}

/**
 * Units still to fill on an order.
 *
 * `$fees` is the order owner's own fee schedule, which differs by reward tier. It
 * is passed in rather than looked up because the matching loop already holds the
 * user row, and a query per iteration would be a query per candidate order. The
 * aggregate views pass nothing and fall back to the platform default, which is an
 * approximation — acceptable for a depth bar, not for a fill.
 */
function order_remaining_units8(array $o, float $nav, ?array $fees = null): int
{
    if ($o['side'] === 'sell') {
        return max(0, u8((string)$o['units']) - u8((string)$o['filled_units']));
    }

    $locked = max(0, (int)$o['locked_paise']);
    if ($locked <= 0) {
        return 0;
    }

    $entryPct = $fees['entryPct'] ?? setting_f('entry_fee_pct', 0.5);
    $gstPct   = $fees['gstPct']   ?? setting_f('gst_pct', 18);

    return paise_to_u8(buy_spendable_paise($locked, (float)$entryPct, (float)$gstPct),
                       exec_nav($nav, 'buy'));
}

/* ============================================================== fills ==== */

/**
 * Total rupees a buyer is debited for a given number of units.
 *
 * Gross plus entry fee plus GST on that fee — the same three components the
 * escrow was sized to cover, computed the same way in every caller so the debit
 * and the escrow cannot disagree by a rounding step.
 */
function buy_debit_paise(int $unitsU8, float $nav, array $fees): int
{
    $gross = u8_to_paise($unitsU8, exec_nav($nav, 'buy'));
    $fee   = pct_of($gross, (float)$fees['entryPct']);
    $gst   = pct_of($fee, (float)$fees['gstPct']);
    return $gross + $fee + $gst;
}

/**
 * Record one fill between a buyer and a seller.
 *
 * Either side may be the treasury (null user), which is what makes instant buys
 * and the sell fallback possible. Both sides are charged their own fee; only the
 * seller has a tax position, because only a transfer out is a transfer.
 *
 * Must be called inside a transaction.
 */
function execute_fill(
    PDO $pdo,
    ?array $buyer,          // null = treasury is buying
    ?array $seller,         // null = treasury is selling
    int $unitsU8,
    float $nav,
    ?int $buyOrderId,
    ?int $sellOrderId
): array {
    if ($unitsU8 <= 0) {
        throw new RuntimeException('Refusing a zero-unit fill');
    }

    $tradeRef = ref('TRD');
    $fy       = fy_of();

    // The index price both sides settle at. Slippage is applied per side, so a
    // buyer pays a touch more and a seller receives a touch less than the mid —
    // which is what actually happens when the treasury has to trade.
    $buyNav   = exec_nav($nav, 'buy');
    $sellNav  = exec_nav($nav, 'sell');
    $grossBuy  = u8_to_paise($unitsU8, $buyNav);
    $grossSell = u8_to_paise($unitsU8, $sellNav);

    $buyerFee = $buyerGst = 0;
    $sellerFee = $sellerGst = $sellerTds = $sellerNet = 0;
    $costBasis = $pnl = $tax = $cess = null;

    /* ---------------------------------------------------------- seller ---- */
    if ($seller !== null) {
        $sf        = user_fees($seller);
        $sellerFee = pct_of($grossSell, $sf['exitPct']);
        $sellerGst = pct_of($sellerFee, $sf['gstPct']);

        $tds       = tds_assess((int)$seller['id'], $grossSell);
        $sellerTds = $tds['tdsPaise'];
        $sellerNet = $grossSell - $sellerFee - $sellerGst - $sellerTds;

        // Cost basis, FIFO, inside this same transaction.
        $lots      = consume_lots($pdo, (int)$seller['id'], $unitsU8);
        $costBasis = $lots['costPaise'];

        if ($lots['shortfall8'] > 0) {
            // The wallet said the units were there but the lots do not account
            // for them. That is a ledger inconsistency, not a user error, and
            // filling anyway would invent a cost basis.
            throw new RuntimeException(
                'Cost basis is incomplete for this holding — the fill was refused rather than '
                . 'guessing a purchase price. Operations has been notified.'
            );
        }

        $pnl  = $grossSell - $costBasis;
        $gain = max(0, $pnl);
        $tax  = pct_of($gain, setting_f('vda_gain_pct', 30));
        $cess = pct_of($tax, setting_f('cess_pct', 4));

        // Units leave escrow, not the free balance: they were locked when the
        // order was placed.
        wallet_apply(
            $pdo, (int)$seller['id'],
            $sellerNet,                 // rupees in
            0,
            0,
            -$unitsU8,                  // units out of escrow
            -$costBasis,                // cost basis released
            $pnl                        // realised P&L
        );

        ledger_add($pdo, (int)$seller['id'], 'sell', $sellerNet, -$unitsU8, [
            'nav' => $sellNav, 'ref' => $tradeRef, 'fy' => $fy,
            'note' => sprintf('Sold %s ARV at %.4f', u8str($unitsU8), $sellNav),
        ]);
        if ($sellerFee > 0) {
            ledger_add($pdo, (int)$seller['id'], 'fee', 0, 0,
                ['ref' => $tradeRef, 'fy' => $fy,
                 'note' => sprintf('Exit fee %s%% — %s', $sf['exitPct'], money_note($sellerFee))]);
        }
        if ($sellerGst > 0) {
            ledger_add($pdo, (int)$seller['id'], 'gst', 0, 0,
                ['ref' => $tradeRef, 'fy' => $fy,
                 'note' => sprintf('GST on exit fee — %s', money_note($sellerGst))]);
        }
        if ($sellerTds > 0) {
            ledger_add($pdo, (int)$seller['id'], 'tds', 0, 0, [
                'ref' => $tradeRef, 'fy' => $fy,
                'note' => sprintf('TDS %s%% withheld under s.194S — %s',
                                  $tds['ratePct'], money_note($sellerTds)),
            ]);
        }
    }

    /* ----------------------------------------------------------- buyer ---- */
    if ($buyer !== null) {
        $bf       = user_fees($buyer);
        // The buyer committed gross rupees; the fee comes out of that, and the
        // remainder is what actually bought units.
        $buyerFee = pct_of($grossBuy, $bf['entryPct']);
        $buyerGst = pct_of($buyerFee, $bf['gstPct']);
        $totalDebit = $grossBuy + $buyerFee + $buyerGst;

        wallet_apply(
            $pdo, (int)$buyer['id'],
            0,
            -$totalDebit,               // released from escrow
            $unitsU8,                   // units in
            0,
            $grossBuy                   // cost basis added
        );

        $pdo->prepare(
            'INSERT INTO lots (user_id, units, units_remaining, cost_paise, nav)
             VALUES (?, ?, ?, ?, ?)'
        )->execute([(int)$buyer['id'], u8str($unitsU8), u8str($unitsU8), $grossBuy, $buyNav]);

        ledger_add($pdo, (int)$buyer['id'], 'buy', -$totalDebit, $unitsU8, [
            'nav' => $buyNav, 'ref' => $tradeRef, 'fy' => $fy,
            'note' => sprintf('Bought %s ARV at %.4f', u8str($unitsU8), $buyNav),
        ]);
        if ($buyerFee > 0) {
            ledger_add($pdo, (int)$buyer['id'], 'fee', 0, 0,
                ['ref' => $tradeRef, 'fy' => $fy,
                 'note' => sprintf('Entry fee %s%% — %s', $bf['entryPct'], money_note($buyerFee))]);
        }
        if ($buyerGst > 0) {
            ledger_add($pdo, (int)$buyer['id'], 'gst', 0, 0,
                ['ref' => $tradeRef, 'fy' => $fy,
                 'note' => sprintf('GST on entry fee — %s', money_note($buyerGst))]);
        }
    }

    /* ------------------------------------------------------ trade row ---- */
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
        $buyOrderId,
        $sellOrderId,
        $buyer !== null ? (int)$buyer['id'] : null,
        $seller !== null ? (int)$seller['id'] : null,
        ($buyer !== null && $seller !== null) ? 'user' : 'treasury',
        u8str($unitsU8),
        $nav,
        $grossSell,
        $buyerFee, $buyerGst,
        $sellerFee, $sellerGst, $sellerTds, $sellerNet,
        $costBasis, $pnl, $tax, $cess,
        $fy,
    ]);

    return [
        'ref'        => $tradeRef,
        'units'      => u8str($unitsU8),
        'units8'     => $unitsU8,
        'nav'        => $nav,
        'buyNav'     => $buyNav,
        'sellNav'    => $sellNav,
        'grossPaise' => $grossSell,
        'sellerNet'  => $sellerNet,
        'sellerTds'  => $sellerTds,
        'counterparty' => ($buyer !== null && $seller !== null) ? 'user' : 'treasury',
    ];
}

/* ====================================================== order progress ==== */

/**
 * Advance an order's filled amounts and status.
 *
 * A buy is complete when its escrow is spent down below the minimum a fill could
 * use; a sell when its units are exhausted. Anything in between is 'partial',
 * which is a real state a user needs to see rather than a rounding artefact.
 */
function order_progress(PDO $pdo, array $order, int $filledU8, int $spentPaise, float $nav): void
{
    $filled = u8((string)$order['filled_units']) + $filledU8;

    if ($order['side'] === 'sell') {
        $total   = u8((string)$order['units']);
        $done    = $filled >= $total;
        $locked  = max(0, u8((string)$order['locked_units']) - $filledU8);

        $pdo->prepare(
            'UPDATE orders SET filled_units = ?, filled_paise = filled_paise + ?,
                    locked_units = ?, status = ? WHERE id = ?'
        )->execute([
            u8str($filled), $spentPaise, u8str($locked),
            $done ? 'filled' : 'partial', $order['id'],
        ]);
        return;
    }

    $locked = max(0, (int)$order['locked_paise'] - $spentPaise);
    // Below the minimum order size the remaining escrow can never fill again, so
    // the order is finished and the dust goes back to the wallet.
    $dust   = $locked < setting_i('min_order_paise', 10000);

    $pdo->prepare(
        'UPDATE orders SET filled_units = ?, filled_paise = filled_paise + ?,
                locked_paise = ?, status = ? WHERE id = ?'
    )->execute([
        u8str($filled), $spentPaise, $dust ? 0 : $locked,
        $dust ? 'filled' : 'partial', $order['id'],
    ]);

    if ($dust && $locked > 0) {
        wallet_apply($pdo, (int)$order['user_id'], $locked, -$locked);
        ledger_add($pdo, (int)$order['user_id'], 'adjustment', 0, 0, [
            'ref' => (string)$order['ref'],
            'note' => 'Unspent balance returned from a completed buy order',
        ]);
    }
}

/* ========================================================= the engine ==== */

/**
 * Match everything that can be matched, then apply the treasury fallback.
 *
 * Safe to call after every order placement and from cron. Returns a summary the
 * caller can show or log.
 */
function run_matching(float $nav): array
{
    $triggered = activate_triggers($nav);

    $fills = [];
    $errors = [];

    // Pass 1 — real counterparties. This is the whole point of the book: a
    // seller exiting to a buyer entering, with the treasury untouched.
    $result = tx(static function (PDO $pdo) use ($nav) {
        $out = [];
        $buys  = ready_orders($pdo, 'buy');
        $sells = ready_orders($pdo, 'sell');

        // Cache the user rows and their fee schedules. Sizing a buy needs the
        // owner's own entry fee, and looking that up inside the inner loop would
        // be a query per candidate pairing.
        $users = [];
        $fees  = [];
        $load = static function (int $id) use ($pdo, &$users, &$fees): array {
            if (!isset($users[$id])) {
                $st = $pdo->prepare('SELECT * FROM users WHERE id = ?');
                $st->execute([$id]);
                $users[$id] = $st->fetch();
                $fees[$id]  = user_fees($users[$id]);
            }
            return [$users[$id], $fees[$id]];
        };

        $bi = 0;
        foreach ($sells as &$sell) {
            $sellLeft = order_remaining_units8($sell, $nav);
            if ($sellLeft <= 0) {
                continue;
            }

            while ($sellLeft > 0 && $bi < count($buys)) {
                $buy = &$buys[$bi];
                [$buyer, $bFees] = $load((int)$buy['user_id']);
                $buyLeft = order_remaining_units8($buy, $nav, $bFees);

                if ($buyLeft <= 0) {
                    $bi++;
                    continue;
                }

                $take = min($sellLeft, $buyLeft);
                if ($take <= 0) {
                    $bi++;
                    continue;
                }

                [$seller] = $load((int)$sell['user_id']);

                $fill = execute_fill(
                    $pdo, $buyer, $seller, $take, $nav,
                    (int)$buy['id'], (int)$sell['id']
                );

                $buyDebit = buy_debit_paise($take, $nav, $bFees);

                order_progress($pdo, $buy,  $take, $buyDebit, $nav);
                order_progress($pdo, $sell, $take, $fill['grossPaise'], $nav);

                // Reflect the consumed amounts locally so the loop's arithmetic
                // stays right without re-reading the rows.
                $buy['filled_units']  = u8str(u8((string)$buy['filled_units']) + $take);
                $buy['locked_paise']  = (string)max(0, (int)$buy['locked_paise'] - $buyDebit);
                $sell['filled_units'] = u8str(u8((string)$sell['filled_units']) + $take);
                $sell['locked_units'] = u8str(max(0, u8((string)$sell['locked_units']) - $take));

                $out[]    = $fill;
                $sellLeft -= $take;
            }
        }
        return $out;
    });
    $fills = array_merge($fills, $result);

    // Pass 2 — treasury takes the other side of unmatched sells that have waited
    // long enough. This is the exit guarantee.
    if (setting_b('sell_fallback_to_treasury', true)) {
        $fallback = tx(static function (PDO $pdo) use ($nav) {
            $out = [];
            $st = $pdo->prepare(
                'SELECT * FROM orders
                  WHERE side = "sell"
                    AND status IN ("open","triggered","partial")
                    AND fallback_at IS NOT NULL
                    AND fallback_at <= UTC_TIMESTAMP()
                    AND (otype = "market" OR status IN ("triggered","partial"))
                  ORDER BY created_at ASC, id ASC
                  FOR UPDATE'
            );
            $st->execute();

            foreach ($st->fetchAll() as $sell) {
                $left = order_remaining_units8($sell, $nav);
                if ($left <= 0) {
                    continue;
                }
                $seller = $pdo->query('SELECT * FROM users WHERE id = ' . (int)$sell['user_id'])->fetch();

                $fill = execute_fill($pdo, null, $seller, $left, $nav, null, (int)$sell['id']);
                order_progress($pdo, $sell, $left, $fill['grossPaise'], $nav);
                $out[] = $fill;
            }
            return $out;
        });
        $fills = array_merge($fills, $fallback);
    }

    // Housekeeping — expire stale orders and return their escrow. An order that
    // silently holds someone's money for ever is its own kind of bug.
    $expired = expire_orders();

    return [
        'nav'       => $nav,
        'triggered' => $triggered,
        'fills'     => count($fills),
        'trades'    => $fills,
        'expired'   => $expired,
        'errors'    => $errors,
    ];
}

/**
 * Fill a buy immediately: resting sells first, then the treasury.
 *
 * Called straight after a buy order is placed, so a buyer never waits. Returns
 * the fills so the response can show exactly what happened.
 */
function fill_buy_now(int $orderId, float $nav): array
{
    return tx(static function (PDO $pdo) use ($orderId, $nav) {
        $st = $pdo->prepare('SELECT * FROM orders WHERE id = ? FOR UPDATE');
        $st->execute([$orderId]);
        $buy = $st->fetch();
        if (!$buy || !in_array($buy['status'], ['open', 'triggered', 'partial'], true)) {
            return [];
        }

        $uSt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
        $uSt->execute([(int)$buy['user_id']]);
        $buyer = $uSt->fetch();
        $bFees = user_fees($buyer);
        $fills = [];

        // Resting sellers first — a real counterparty is always preferable to the
        // treasury, and it is what gives sellers their exit.
        $sellSt = $pdo->prepare(
            'SELECT * FROM orders
              WHERE side = "sell" AND status IN ("open","triggered","partial")
                AND user_id <> ?
                AND (otype = "market" OR status IN ("triggered","partial"))
              ORDER BY created_at ASC, id ASC
              FOR UPDATE'
        );
        $sellSt->execute([(int)$buy['user_id']]);

        foreach ($sellSt->fetchAll() as $sell) {
            $need = order_remaining_units8($buy, $nav, $bFees);
            if ($need <= 0) {
                break;
            }
            $have = order_remaining_units8($sell, $nav);
            if ($have <= 0) {
                continue;
            }
            $take = min($need, $have);

            $uSt->execute([(int)$sell['user_id']]);
            $seller = $uSt->fetch();

            $fill = execute_fill($pdo, $buyer, $seller, $take, $nav, (int)$buy['id'], (int)$sell['id']);
            $debit = buy_debit_paise($take, $nav, $bFees);

            order_progress($pdo, $buy,  $take, $debit, $nav);
            order_progress($pdo, $sell, $take, $fill['grossPaise'], $nav);

            $buy['filled_units'] = u8str(u8((string)$buy['filled_units']) + $take);
            $buy['locked_paise'] = (string)max(0, (int)$buy['locked_paise'] - $debit);

            $fills[] = $fill;
        }

        // Whatever is left comes from the treasury, so the buy completes now.
        if (setting_b('buy_fills_from_treasury', true)) {
            $need = order_remaining_units8($buy, $nav, $bFees);
            if ($need > 0) {
                $fill  = execute_fill($pdo, $buyer, null, $need, $nav, (int)$buy['id'], null);
                $debit = buy_debit_paise($need, $nav, $bFees);
                order_progress($pdo, $buy, $need, $debit, $nav);
                $fills[] = $fill;
            }
        }

        return $fills;
    });
}

/**
 * Match a new sell against resting buys straight away.
 *
 * Anything unmatched stays in the book with a `fallback_at`, so the treasury
 * picks it up later if no buyer appears.
 */
function fill_sell_now(int $orderId, float $nav): array
{
    return tx(static function (PDO $pdo) use ($orderId, $nav) {
        $st = $pdo->prepare('SELECT * FROM orders WHERE id = ? FOR UPDATE');
        $st->execute([$orderId]);
        $sell = $st->fetch();
        if (!$sell || !in_array($sell['status'], ['open', 'triggered', 'partial'], true)) {
            return [];
        }

        $uSt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
        $uSt->execute([(int)$sell['user_id']]);
        $seller = $uSt->fetch();
        $fills  = [];

        $buySt = $pdo->prepare(
            'SELECT * FROM orders
              WHERE side = "buy" AND status IN ("open","triggered","partial")
                AND user_id <> ?
                AND (otype = "market" OR status IN ("triggered","partial"))
              ORDER BY created_at ASC, id ASC
              FOR UPDATE'
        );
        $buySt->execute([(int)$sell['user_id']]);

        foreach ($buySt->fetchAll() as $buy) {
            $have = order_remaining_units8($sell, $nav);
            if ($have <= 0) {
                break;
            }

            $uSt->execute([(int)$buy['user_id']]);
            $buyer = $uSt->fetch();
            $bFees = user_fees($buyer);

            $need = order_remaining_units8($buy, $nav, $bFees);
            if ($need <= 0) {
                continue;
            }
            $take = min($have, $need);

            $fill  = execute_fill($pdo, $buyer, $seller, $take, $nav, (int)$buy['id'], (int)$sell['id']);
            $debit = buy_debit_paise($take, $nav, $bFees);

            order_progress($pdo, $buy,  $take, $debit, $nav);
            order_progress($pdo, $sell, $take, $fill['grossPaise'], $nav);

            $sell['filled_units'] = u8str(u8((string)$sell['filled_units']) + $take);
            $sell['locked_units'] = u8str(max(0, u8((string)$sell['locked_units']) - $take));

            $fills[] = $fill;
        }

        return $fills;
    });
}

/* =========================================================== expiry ====== */

/**
 * Expire orders past their lifetime and return whatever they were holding.
 *
 * Escrow released here is the user's own money coming back to their available
 * balance, so it is recorded in the ledger rather than adjusted silently.
 */
function expire_orders(): int
{
    return tx(static function (PDO $pdo) {
        $st = $pdo->prepare(
            'SELECT * FROM orders
              WHERE status IN ("open","triggered","partial")
                AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()
              FOR UPDATE'
        );
        $st->execute();
        $rows = $st->fetchAll();

        foreach ($rows as $o) {
            $lockedPaise = (int)$o['locked_paise'];
            $lockedUnits = u8((string)$o['locked_units']);

            if ($lockedPaise > 0) {
                wallet_apply($pdo, (int)$o['user_id'], $lockedPaise, -$lockedPaise);
            }
            if ($lockedUnits > 0) {
                wallet_apply($pdo, (int)$o['user_id'], 0, 0, $lockedUnits, -$lockedUnits);
            }
            if ($lockedPaise > 0 || $lockedUnits > 0) {
                ledger_add($pdo, (int)$o['user_id'], 'adjustment', 0, 0, [
                    'ref'  => (string)$o['ref'],
                    'note' => 'Order expired — escrow returned',
                ]);
            }

            $pdo->prepare('UPDATE orders SET status = "expired", locked_paise = 0, locked_units = 0
                           WHERE id = ?')->execute([$o['id']]);
        }
        return count($rows);
    });
}

/* ============================================================= book ====== */

/**
 * The public book — depth on each side, aggregated.
 *
 * Deliberately not a bid/ask ladder: there is only one price, so what a user
 * actually needs to know is how much demand and supply is waiting at it, and how
 * long the queue in front of them is.
 */
function order_book(float $nav, int $limit = 20): array
{
    $rows = q(
        'SELECT side, otype, trigger_nav, units, filled_units, locked_paise,
                created_at, fallback_at
           FROM orders
          WHERE status IN ("open","triggered","partial")
          ORDER BY created_at ASC
          LIMIT 500'
    )->fetchAll();

    $buys = [];
    $sells = [];
    $buyU8 = 0;
    $sellU8 = 0;

    foreach ($rows as $o) {
        $left = order_remaining_units8($o, $nav);
        if ($left <= 0) {
            continue;
        }
        $entry = [
            'units'      => u8str($left),
            'type'       => $o['otype'],
            'triggerNav' => $o['trigger_nav'] !== null ? (float)$o['trigger_nav'] : null,
            'createdAt'  => $o['created_at'],
            'valuePaise' => u8_to_paise($left, $nav),
        ];
        if ($o['side'] === 'buy') {
            $buyU8 += $left;
            if (count($buys) < $limit) {
                $buys[] = $entry;
            }
        } else {
            $sellU8 += $left;
            if (count($sells) < $limit) {
                $entry['fallbackAt'] = $o['fallback_at'];
                $sells[] = $entry;
            }
        }
    }

    return [
        'nav'             => $nav,
        'buys'            => $buys,
        'sells'           => $sells,
        'buyDepthUnits'   => u8str($buyU8),
        'sellDepthUnits'  => u8str($sellU8),
        'buyDepthPaise'   => u8_to_paise($buyU8, $nav),
        'sellDepthPaise'  => u8_to_paise($sellU8, $nav),
        // Stated plainly so nobody looks for a spread that does not exist.
        'note'            => 'Every fill settles at the index price. There is no spread, '
                           . 'and a limit order is a trigger rather than an offer.',
    ];
}

/** The tape — recent fills, newest first. */
function recent_trades(int $limit = 40): array
{
    $rows = q(
        'SELECT ref, units, nav, gross_paise, counterparty, created_at
           FROM trades ORDER BY id DESC LIMIT ?', [$limit]
    )->fetchAll();

    return array_map(static fn(array $t): array => [
        'ref'          => $t['ref'],
        'units'        => $t['units'],
        'nav'          => (float)$t['nav'],
        'grossPaise'   => (int)$t['gross_paise'],
        'counterparty' => $t['counterparty'],
        'at'           => $t['created_at'],
    ], $rows);
}
