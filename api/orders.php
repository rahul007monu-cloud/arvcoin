<?php
/**
 * Orders — place, cancel, list, and the public book.
 *
 * The escrow rule is the whole safety story here. Placing an order moves value
 * from the available balance into a locked balance *in the same transaction* that
 * writes the order row. Without that, a user could place ten sell orders for the
 * same units, or ten buys against the same rupees, and the matching engine would
 * honour all of them.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';
require __DIR__ . '/_match.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'quote':   handle_quote();   break;
    case 'place':   handle_place();   break;
    case 'cancel':  handle_cancel();  break;
    case 'mine':    handle_mine();    break;
    case 'book':    handle_book();    break;
    case 'tape':    handle_tape();    break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================== quote ===== */

/**
 * Price an order without placing it.
 *
 * The same functions the fill will use, so the confirmation screen and the ledger
 * cannot disagree. Read-only — nothing is reserved.
 */
function handle_quote(): void
{
    require_method('POST', 'GET');
    $u = require_user();

    $side = input_str('side', $_GET['side'] ?? 'buy');
    if (!in_array($side, ['buy', 'sell'], true)) {
        json_fail(422, 'Side must be buy or sell.');
    }

    try {
        $nav = arv_nav();
    } catch (RuntimeException $e) {
        json_fail(503, $e->getMessage());
    }

    if ($side === 'buy') {
        $paise = input_int('amountPaise', (int)($_GET['amountPaise'] ?? 0));
        if ($paise <= 0) {
            json_fail(422, 'Enter an amount to invest.');
        }
        $q = quote_buy($u, $paise, $nav);

        $w = q1('SELECT * FROM wallets WHERE user_id = ?', [$u['id']]);
        $available = (int)($w['inr_paise'] ?? 0);
        $needed    = $paise + $q['feePaise'] + $q['gstPaise'];

        $q['totalDebitPaise'] = $needed;
        $q['availablePaise']  = $available;
        $q['sufficient']      = $available >= $needed;
        $q['shortfallPaise']  = max(0, $needed - $available);
        json_ok(['quote' => $q, 'nav' => $nav]);
    }

    $units8 = u8(input_dec('units', (string)($_GET['units'] ?? '0')));
    if ($units8 <= 0) {
        json_fail(422, 'Enter the number of units to sell.');
    }

    $w = q1('SELECT * FROM wallets WHERE user_id = ?', [$u['id']]);
    $free = u8((string)($w['arv_units'] ?? '0'));
    if ($units8 > $free) {
        json_fail(422, sprintf('You have %s ARV available. Units already committed to an open order are held separately.', u8str($free)));
    }

    // Cost basis is read without consuming, so the quote can show the tax
    // position before anything is committed.
    $basis = preview_cost_basis((int)$u['id'], $units8);
    $q = quote_sell($u, $units8, $nav, $basis['costPaise']);
    $q['lotsPreview'] = $basis['consumed'];

    json_ok(['quote' => $q, 'nav' => $nav]);
}

/** Read FIFO cost basis without mutating lots. */
function preview_cost_basis(int $userId, int $needU8): array
{
    $rows = q(
        'SELECT id, units, units_remaining, cost_paise, nav, acquired_at
           FROM lots WHERE user_id = ? AND units_remaining > 0
          ORDER BY acquired_at ASC, id ASC', [$userId]
    )->fetchAll();

    $cost = 0;
    $need = $needU8;
    $consumed = [];

    foreach ($rows as $lot) {
        if ($need <= 0) {
            break;
        }
        $avail = u8((string)$lot['units_remaining']);
        $total = u8((string)$lot['units']);
        if ($avail <= 0) {
            continue;
        }
        $take  = min($avail, $need);
        $slice = $total > 0 ? (int)round((int)$lot['cost_paise'] * ($take / $total)) : 0;

        $consumed[] = [
            'units'      => u8str($take),
            'costPaise'  => $slice,
            'nav'        => (float)$lot['nav'],
            'acquiredAt' => $lot['acquired_at'],
        ];
        $cost += $slice;
        $need -= $take;
    }

    return ['costPaise' => $cost, 'consumed' => $consumed, 'shortfall8' => max(0, $need)];
}

/* ============================================================== place ===== */

function handle_place(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    $u = require_user();
    rate_limit('order_place', 40, 300, 600);

    $side  = input_str('side');
    $otype = input_str('type', 'market');

    if (!in_array($side, ['buy', 'sell'], true)) {
        json_fail(422, 'Side must be buy or sell.');
    }
    if (!in_array($otype, ['market', 'limit'], true)) {
        json_fail(422, 'Order type must be market or limit.');
    }

    // KYC gates the first purchase, not browsing. Selling is deliberately never
    // gated: someone who already holds units must always be able to get out, and
    // an incomplete KYC form is not a reason to trap their money.
    if ($side === 'buy' && setting_b('kyc_required', true)) {
        $kyc = q1('SELECT status FROM kyc WHERE user_id = ?', [$u['id']]);
        if (($kyc['status'] ?? 'none') !== 'verified') {
            json_fail(403, 'Complete KYC before your first purchase.', [
                'needs'     => 'kyc',
                'kycStatus' => $kyc['status'] ?? 'none',
            ]);
        }
    }

    try {
        $nav = arv_nav();
    } catch (RuntimeException $e) {
        json_fail(503, $e->getMessage());
    }

    $trigger = null;
    if ($otype === 'limit') {
        $trigger = (float)input_dec('triggerNav', '0');
        if ($trigger <= 0) {
            json_fail(422, 'Enter the price you want the order to act at.');
        }
        // A limit that is already satisfied is a market order wearing a hat.
        // Saying so is clearer than silently converting it.
        if ($side === 'buy' && $trigger >= $nav) {
            json_fail(422, sprintf(
                'ARV is already at ₹%.4f, which is at or below your ₹%.4f trigger. Place a market buy instead.',
                $nav, $trigger
            ));
        }
        if ($side === 'sell' && $trigger <= $nav) {
            json_fail(422, sprintf(
                'ARV is already at ₹%.4f, which is at or above your ₹%.4f trigger. Place a market sell instead.',
                $nav, $trigger
            ));
        }
    }

    $expiryHours    = setting_i('order_expiry_hours', 168);
    $fallbackMins   = setting_i('sell_fallback_minutes', 60);
    $orderRef       = ref($side === 'buy' ? 'BUY' : 'SEL');

    /* ---------------------------------------------------------- buy ------- */
    if ($side === 'buy') {
        $paise = input_int('amountPaise');
        $min   = setting_i('min_order_paise', 10000);
        if ($paise < $min) {
            json_fail(422, sprintf('The minimum order is ₹%s.', number_format($min / 100)));
        }

        $q      = quote_buy($u, $paise, $nav);
        $needed = $paise + $q['feePaise'] + $q['gstPaise'];

        $orderId = tx(static function (PDO $pdo) use ($u, $needed, $orderRef, $otype, $trigger, $paise, $expiryHours) {
            $w = wallet_for_update($pdo, (int)$u['id']);
            if ((int)$w['inr_paise'] < $needed) {
                throw new RuntimeException(sprintf(
                    'Not enough balance. You have ₹%s available and this order needs ₹%s including fees. Add funds first.',
                    number_format((int)$w['inr_paise'] / 100, 2),
                    number_format($needed / 100, 2)
                ));
            }

            // Escrow in the same transaction as the order row. This is what stops
            // the same rupees backing two orders.
            wallet_apply($pdo, (int)$u['id'], -$needed, $needed);

            $pdo->prepare(
                'INSERT INTO orders (ref, user_id, side, otype, amount_paise, trigger_nav,
                                     locked_paise, status, expires_at)
                 VALUES (?, ?, "buy", ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))'
            )->execute([
                $orderRef, (int)$u['id'], $otype, $paise, $trigger, $needed,
                $otype === 'market' ? 'open' : 'open', $expiryHours,
            ]);

            $id = (int)$pdo->lastInsertId();
            ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
                'ref' => $orderRef, 'relatedId' => $id,
                'note' => sprintf('₹%s held for a %s buy order', number_format($needed / 100, 2), $otype),
            ]);
            return $id;
        });

        // A market buy fills now — resting sellers first, treasury for the rest.
        $fills = $otype === 'market' ? fill_buy_now($orderId, $nav) : [];

        audit('order.place', ['entity' => 'orders', 'entity_id' => (string)$orderId,
                              'detail' => ['side' => 'buy', 'type' => $otype, 'paise' => $paise]]);

        json_ok([
            'order' => order_public($orderId),
            'fills' => $fills,
            'nav'   => $nav,
            'message' => $otype === 'market'
                ? 'Filled.'
                : sprintf('Order placed. It will act when ARV reaches ₹%.4f.', $trigger),
        ]);
    }

    /* --------------------------------------------------------- sell ------- */
    $units8 = u8(input_dec('units'));
    if ($units8 <= 0) {
        json_fail(422, 'Enter the number of units to sell.');
    }

    $orderId = tx(static function (PDO $pdo) use ($u, $units8, $orderRef, $otype, $trigger, $expiryHours, $fallbackMins) {
        $w = wallet_for_update($pdo, (int)$u['id']);
        $free = u8((string)$w['arv_units']);
        if ($units8 > $free) {
            throw new RuntimeException(sprintf(
                'You have %s ARV available. Units already committed to an open order are held separately — cancel that order to free them.',
                u8str($free)
            ));
        }

        wallet_apply($pdo, (int)$u['id'], 0, 0, -$units8, $units8);

        $pdo->prepare(
            'INSERT INTO orders (ref, user_id, side, otype, units, trigger_nav,
                                 locked_units, status, expires_at, fallback_at)
             VALUES (?, ?, "sell", ?, ?, ?, ?, "open",
                     DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR),
                     DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))'
        )->execute([
            $orderRef, (int)$u['id'], $otype, u8str($units8), $trigger,
            u8str($units8), $expiryHours, $fallbackMins,
        ]);

        $id = (int)$pdo->lastInsertId();
        ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
            'ref' => $orderRef, 'relatedId' => $id,
            'note' => sprintf('%s ARV held for a %s sell order', u8str($units8), $otype),
        ]);
        return $id;
    });

    // Try a real counterparty immediately; the treasury waits its turn.
    $fills = $otype === 'market' ? fill_sell_now($orderId, $nav) : [];
    $order = order_public($orderId);

    audit('order.place', ['entity' => 'orders', 'entity_id' => (string)$orderId,
                          'detail' => ['side' => 'sell', 'type' => $otype, 'units' => u8str($units8)]]);

    $message = $order['status'] === 'filled'
        ? 'Filled against a buyer.'
        : sprintf(
            'Order placed. It fills as soon as a buyer arrives — and if none does within %d minutes, '
            . 'the treasury buys it at the index price, so you are never left unable to exit.',
            $fallbackMins
        );

    json_ok(['order' => $order, 'fills' => $fills, 'nav' => $nav, 'message' => $message]);
}

/* ============================================================= cancel ===== */

function handle_cancel(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id = input_int('orderId');
    if ($id <= 0) {
        json_fail(422, 'Which order?');
    }

    $result = tx(static function (PDO $pdo) use ($u, $id) {
        $st = $pdo->prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? FOR UPDATE');
        $st->execute([$id, (int)$u['id']]);
        $o = $st->fetch();

        if (!$o) {
            throw new RuntimeException('Order not found.');
        }
        if (!in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
            throw new RuntimeException('That order is already ' . $o['status'] . '.');
        }

        // Only the unfilled remainder comes back. Anything already filled is a
        // completed trade and is not reversible.
        $lockedPaise = (int)$o['locked_paise'];
        $lockedUnits = u8((string)$o['locked_units']);

        if ($lockedPaise > 0) {
            wallet_apply($pdo, (int)$u['id'], $lockedPaise, -$lockedPaise);
        }
        if ($lockedUnits > 0) {
            wallet_apply($pdo, (int)$u['id'], 0, 0, $lockedUnits, -$lockedUnits);
        }

        $pdo->prepare('UPDATE orders SET status = "cancelled", locked_paise = 0, locked_units = 0
                       WHERE id = ?')->execute([$id]);

        ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
            'ref' => (string)$o['ref'], 'relatedId' => $id,
            'note' => 'Order cancelled — unfilled portion returned',
        ]);

        return [
            'returnedPaise' => $lockedPaise,
            'returnedUnits' => u8str($lockedUnits),
            'filledUnits'   => (string)$o['filled_units'],
        ];
    });

    audit('order.cancel', ['entity' => 'orders', 'entity_id' => (string)$id]);
    json_ok($result + ['message' => 'Order cancelled.']);
}

/* =============================================================== mine ===== */

function handle_mine(): void
{
    require_method('GET');
    $u = require_user();

    $status = $_GET['status'] ?? 'open';
    $where  = $status === 'open'
        ? 'AND status IN ("open","triggered","partial")'
        : ($status === 'all' ? '' : 'AND status = ' . db()->quote($status));

    $rows = q(
        "SELECT * FROM orders WHERE user_id = ? {$where} ORDER BY created_at DESC LIMIT 200",
        [$u['id']]
    )->fetchAll();

    $meta = arv_nav_meta();
    json_ok([
        'orders' => array_map(static fn($o) => order_row_public($o, $meta['nav']), $rows),
        'nav'    => $meta['nav'],
    ]);
}

/* =============================================================== book ===== */

function handle_book(): void
{
    require_method('GET');
    $meta = arv_nav_meta();
    if ($meta['nav'] === null) {
        json_ok(['book' => null, 'price' => $meta]);
    }
    json_ok(['book' => order_book((float)$meta['nav']), 'price' => $meta]);
}

function handle_tape(): void
{
    require_method('GET');
    $limit = max(1, min(100, (int)($_GET['limit'] ?? 40)));
    json_ok(['trades' => recent_trades($limit), 'price' => arv_nav_meta()]);
}

/* ============================================================ shaping ===== */

function order_public(int $id): array
{
    $o = q1('SELECT * FROM orders WHERE id = ?', [$id]);
    if (!$o) {
        json_fail(404, 'Order not found.');
    }
    $meta = arv_nav_meta();
    return order_row_public($o, $meta['nav']);
}

function order_row_public(array $o, ?float $nav): array
{
    $remaining = $nav !== null ? order_remaining_units8($o, $nav) : 0;

    return [
        'id'            => (int)$o['id'],
        'ref'           => $o['ref'],
        'side'          => $o['side'],
        'type'          => $o['otype'],
        'status'        => $o['status'],
        'amountPaise'   => $o['amount_paise'] !== null ? (int)$o['amount_paise'] : null,
        'units'         => $o['units'],
        'triggerNav'    => $o['trigger_nav'] !== null ? (float)$o['trigger_nav'] : null,
        'filledUnits'   => $o['filled_units'],
        'filledPaise'   => (int)$o['filled_paise'],
        'lockedPaise'   => (int)$o['locked_paise'],
        'lockedUnits'   => $o['locked_units'],
        'remainingUnits'=> u8str($remaining),
        'createdAt'     => $o['created_at'],
        'expiresAt'     => $o['expires_at'],
        'fallbackAt'    => $o['fallback_at'],
        // Sellers need to know when the exit guarantee kicks in, in plain minutes
        // rather than as a timestamp they have to work out.
        'fallbackInMinutes' => ($o['side'] === 'sell' && $o['fallback_at'] !== null
                                && in_array($o['status'], ['open','triggered','partial'], true))
            ? max(0, (int)ceil((strtotime($o['fallback_at']) - time()) / 60))
            : null,
    ];
}
