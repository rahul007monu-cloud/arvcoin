<?php
/**
 * Peer-to-peer (P2P) escrow trading — user endpoints.
 *
 * The lifecycle of one trade:
 *
 *   1. A seller places a P2P sell — their ARV is escrowed (arv_units ->
 *      arv_locked_units) at that moment, and they must have a saved payment
 *      method to receive rupees.
 *   2. A buyer (KYC-verified) places a P2P buy — no rupees on-platform; a buyer
 *      no longer needs an INR balance to buy, because they pay the seller
 *      directly. A market order matches now; a limit order matches when the
 *      index reaches its trigger.
 *   3. On a match, a `p2p_trades` row is written at the LIVE index price, the
 *      seller's payment details are snapshotted, and the escrowed units are
 *      reserved.
 *   4. The buyer pays the seller off-platform and uploads proof (UTR /
 *      screenshot) — status 'paid'.
 *   5. The seller confirms receipt — the escrowed units move to the buyer and a
 *      `trades` row is recorded for tax/history — status 'released'.
 *   6. Either side may cancel before payment; the escrow returns to the seller.
 *
 * Every money movement is in _p2p.php and runs through wallet_apply()/
 * ledger_add()/consume_lots() inside a tx(). This file is the HTTP surface:
 * method, CSRF, ownership, validation, and audit.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';
require __DIR__ . '/_p2p.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'place':        handle_place();        break;
    case 'mine':         handle_mine();         break;
    case 'proof':        handle_proof();        break;
    case 'confirm':      handle_confirm();      break;
    case 'cancel':       handle_cancel();       break;
    case 'cancel_order': handle_cancel_order(); break;
    case 'offers':       handle_offers();       break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================== place ===== */

function handle_place(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    $u = require_user();
    rate_limit('p2p_place', 40, 300, 600);

    $side  = input_str('side');
    $otype = input_str('type', 'market');

    if (!in_array($side, ['buy', 'sell'], true)) {
        json_fail(422, 'Side must be buy or sell.');
    }
    if (!in_array($otype, ['market', 'limit'], true)) {
        json_fail(422, 'Order type must be market or limit.');
    }

    try {
        $nav = arv_nav();
    } catch (RuntimeException $e) {
        json_fail(503, $e->getMessage());
    }

    $units8 = u8(input_dec('units'));
    if ($units8 <= 0) {
        json_fail(422, 'Enter the number of units.');
    }

    $min    = setting_i('min_order_paise', 10000);
    $amount = u8_to_paise($units8, $nav);
    if ($amount < $min) {
        json_fail(422, sprintf('That is below the minimum order of ₹%s at the current price.',
                               number_format($min / 100)));
    }

    // A limit order's trigger decides WHEN it may match; the price is always the
    // live index. An already-satisfied trigger is a market order in disguise —
    // say so rather than converting it silently, exactly as the index book does.
    $trigger = null;
    if ($otype === 'limit') {
        $trigger = (float)input_dec('triggerNav', '0');
        if ($trigger <= 0) {
            json_fail(422, 'Enter the price you want the order to act at.');
        }
        if ($side === 'buy' && $trigger >= $nav) {
            json_fail(422, sprintf(
                'ARV is already at ₹%.4f, at or below your ₹%.4f trigger. Place a market buy instead.',
                $nav, $trigger));
        }
        if ($side === 'sell' && $trigger <= $nav) {
            json_fail(422, sprintf(
                'ARV is already at ₹%.4f, at or above your ₹%.4f trigger. Place a market sell instead.',
                $nav, $trigger));
        }
    }

    $orderRef = ref($side === 'buy' ? 'PBY' : 'PSL');

    /* ---------------------------------------------------------- buy ------- */
    if ($side === 'buy') {
        // Buying requires a KYC-verified profile — always, regardless of the
        // index book's kyc_required toggle. A buyer no longer needs an INR
        // balance (they pay the seller directly), so KYC is the only gate.
        $kyc = q1('SELECT status FROM kyc WHERE user_id = ?', [$u['id']]);
        if (($kyc['status'] ?? 'none') !== 'verified') {
            json_fail(403, 'Complete KYC before buying. A P2P purchase settles to a verified profile.', [
                'needs'     => 'kyc',
                'kycStatus' => $kyc['status'] ?? 'none',
            ]);
        }

        $orderId = tx(static function (PDO $pdo) use ($u, $orderRef, $otype, $trigger, $units8) {
            $pdo->prepare(
                "INSERT INTO orders (ref, user_id, side, otype, channel, units, trigger_nav, status)
                 VALUES (?, ?, 'buy', ?, 'p2p', ?, ?, 'open')"
            )->execute([$orderRef, (int)$u['id'], $otype, u8str($units8), $trigger]);
            return (int)$pdo->lastInsertId();
        });

        audit('p2p.place', ['entity' => 'orders', 'entity_id' => (string)$orderId,
                            'detail' => ['side' => 'buy', 'type' => $otype, 'units' => u8str($units8)]]);

        $trades = p2p_try_match($orderId, $nav);

        json_ok([
            'order'   => p2p_order_public($orderId),
            'trades'  => p2p_trades_for_order($orderId, (int)$u['id']),
            'matched' => count($trades),
            'nav'     => $nav,
            'message' => $trades
                ? 'Matched. Pay the seller, then upload proof.'
                : ($otype === 'market'
                    ? 'No seller available right now. Your order waits and matches as soon as one appears.'
                    : sprintf('Order placed. It matches when ARV reaches ₹%.4f.', $trigger)),
        ]);
    }

    /* --------------------------------------------------------- sell ------- */
    // A seller must have somewhere to receive the rupees.
    $pm = q1('SELECT id FROM payment_methods WHERE user_id = ? LIMIT 1', [$u['id']]);
    if (!$pm) {
        json_fail(422, 'Add a payment method first — a P2P buyer pays you there directly.',
                  ['needs' => 'payment_method']);
    }

    $orderId = tx(static function (PDO $pdo) use ($u, $orderRef, $otype, $trigger, $units8) {
        $w = wallet_for_update($pdo, (int)$u['id']);
        $free = u8((string)$w['arv_units']);
        if ($units8 > $free) {
            throw new RuntimeException(sprintf(
                'You have %s ARV available. Units already committed to an order are held separately.',
                u8str($free)));
        }

        // Escrow the units in the same transaction as the order row — the same
        // discipline the index sell uses. arv_units -> arv_locked_units.
        wallet_apply($pdo, (int)$u['id'], 0, 0, -$units8, $units8);

        $pdo->prepare(
            "INSERT INTO orders (ref, user_id, side, otype, channel, units, trigger_nav,
                                 locked_units, status)
             VALUES (?, ?, 'sell', ?, 'p2p', ?, ?, ?, 'open')"
        )->execute([$orderRef, (int)$u['id'], $otype, u8str($units8), $trigger, u8str($units8)]);

        $id = (int)$pdo->lastInsertId();
        // A zero-delta note, so the escrow lock is visible in the ledger without
        // double-counting units (the units did not leave the wallet, only moved
        // from available to locked).
        ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
            'ref' => $orderRef, 'relatedId' => $id,
            'note' => sprintf('%s ARV escrowed for a P2P %s sell order', u8str($units8), $otype),
        ]);
        return $id;
    });

    audit('p2p.place', ['entity' => 'orders', 'entity_id' => (string)$orderId,
                        'detail' => ['side' => 'sell', 'type' => $otype, 'units' => u8str($units8)]]);

    $trades = p2p_try_match($orderId, $nav);

    json_ok([
        'order'   => p2p_order_public($orderId),
        'trades'  => p2p_trades_for_order($orderId, (int)$u['id']),
        'matched' => count($trades),
        'nav'     => $nav,
        'message' => $trades
            ? 'Matched with a buyer. They pay you and upload proof; you then confirm receipt.'
            : ($otype === 'market'
                ? 'Listed. Your ARV is held in escrow and sells as soon as a buyer takes it.'
                : sprintf('Listed. It matches when ARV reaches ₹%.4f. Your ARV is held in escrow.', $trigger)),
    ]);
}

/* =============================================================== mine ===== */

function handle_mine(): void
{
    require_method('GET');
    $u = require_user();
    $uid = (int)$u['id'];

    $rows = q(
        'SELECT p.*, bu.email AS buyer_email, su.email AS seller_email
           FROM p2p_trades p
           JOIN users bu ON bu.id = p.buyer_id
           JOIN users su ON su.id = p.seller_id
          WHERE p.buyer_id = ? OR p.seller_id = ?
          ORDER BY p.id DESC LIMIT 100',
        [$uid, $uid]
    )->fetchAll();

    $trades = array_map(static function ($t) use ($uid) {
        $pub = p2p_trade_public($t, $uid, false);
        $pub['counterparty'] = ((int)$t['buyer_id'] === $uid)
            ? mask_email((string)$t['seller_email'])
            : mask_email((string)$t['buyer_email']);
        return $pub;
    }, $rows);

    $orderRows = q(
        "SELECT * FROM orders
          WHERE user_id = ? AND channel = 'p2p'
            AND status IN ('open','triggered','partial')
          ORDER BY created_at DESC LIMIT 100",
        [$uid]
    )->fetchAll();

    $orders = array_map('p2p_order_row_public', $orderRows);

    json_ok(['trades' => $trades, 'orders' => $orders, 'nav' => arv_nav_meta()['nav']]);
}

/* ============================================================== proof ===== */

/**
 * The buyer attaches proof that they paid the seller off-platform.
 *
 * Multipart when a screenshot is attached, JSON otherwise — the same shape as a
 * deposit submission. Only the trade's own buyer, and only while it is still
 * 'matched', may do this.
 */
function handle_proof(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();
    rate_limit('p2p_proof', 30, 3600);

    $id  = isset($_POST['id']) ? (int)$_POST['id'] : input_int('id');
    $utr = isset($_POST['utr']) ? trim((string)$_POST['utr']) : input_str('utr');
    $utr = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $utr));

    if ($id <= 0) {
        json_fail(422, 'Which trade?');
    }

    $t = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    if (!$t || (int)$t['buyer_id'] !== (int)$u['id']) {
        json_fail(404, 'Trade not found.');
    }
    if ($t['status'] !== 'matched') {
        json_fail(409, 'This trade is ' . $t['status'] . ' — proof can only be added before it is confirmed.');
    }

    $image = p2p_save_proof_image((string)$t['ref']);

    if ($utr === '' && $image === null) {
        json_fail(422, 'Enter the UTR of your payment, or attach a screenshot.');
    }
    if ($utr !== '' && (strlen($utr) < 6 || strlen($utr) > 40)) {
        json_fail(422, 'That does not look like a UTR. It is the reference in your payment app.');
    }

    tx(static function (PDO $pdo) use ($id, $u, $utr, $image, $t) {
        $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $row = $st->fetch();
        if (!$row || (int)$row['buyer_id'] !== (int)$u['id'] || $row['status'] !== 'matched') {
            throw new RuntimeException('That trade can no longer be updated.');
        }
        $pdo->prepare(
            "UPDATE p2p_trades SET status = 'paid', paid_at = UTC_TIMESTAMP(),
                    proof_utr = ?, proof_image_path = ? WHERE id = ?"
        )->execute([$utr, $image ?? (string)$row['proof_image_path'], $id]);
    });

    audit('p2p.proof', ['entity' => 'p2p_trades', 'entity_id' => (string)$id,
                        'detail' => ['utr' => $utr !== '' ? substr($utr, -4) : null,
                                     'image' => $image !== null]]);

    $fresh = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    json_ok([
        'trade'   => p2p_trade_public($fresh, (int)$u['id'], false),
        'message' => 'Proof submitted. The seller confirms receipt and your ARV is released.',
    ]);
}

/**
 * Store a proof screenshot.
 *
 * The same hardening as deposit.php save_screenshot(): the extension comes from
 * the detected MIME type (never the filename), the file must be a decodable
 * image, and the uploads directory carries an .htaccess that refuses to execute
 * anything. Files live under uploads/p2p.
 */
function p2p_save_proof_image(string $ref): ?string
{
    if (empty($_FILES['screenshot']) || ($_FILES['screenshot']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    $f = $_FILES['screenshot'];

    if ($f['error'] !== UPLOAD_ERR_OK) {
        json_fail(422, 'The upload did not complete. Try a smaller image.');
    }
    if ($f['size'] > 4 * 1024 * 1024) {
        json_fail(422, 'That image is over 4 MB. A screenshot should be well under that.');
    }

    $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    $mime = null;
    if (function_exists('finfo_open')) {
        $fi = finfo_open(FILEINFO_MIME_TYPE);
        $mime = finfo_file($fi, $f['tmp_name']);
        finfo_close($fi);
    }
    if (!$mime || !isset($allowed[$mime])) {
        json_fail(422, 'Attach a JPG, PNG or WebP image.');
    }
    if (@getimagesize($f['tmp_name']) === false) {
        json_fail(422, 'That file is not a readable image.');
    }

    $dir = dirname(__DIR__) . '/uploads/p2p';
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        error_log('[arv] cannot create upload dir ' . $dir);
        json_fail(500, 'Could not store the screenshot. Submit the UTR instead.');
    }

    $guard = dirname(__DIR__) . '/uploads/.htaccess';
    if (!is_file($guard)) {
        @file_put_contents(
            $guard,
            "# Uploaded files are data, never code.\n"
            . "php_flag engine off\n"
            . "RemoveHandler .php .phtml .php3 .php4 .php5 .php7 .phar\n"
            . "RemoveType .php .phtml .phar\n"
            . "<FilesMatch \"\\.(?i:php|phtml|phar|cgi|pl|py|sh)$\">\n"
            . "  Require all denied\n"
            . "</FilesMatch>\n"
            . "Options -Indexes -ExecCGI\n"
        );
    }

    $name = $ref . '-' . bin2hex(random_bytes(4)) . '.' . $allowed[$mime];
    $dest = $dir . '/' . $name;

    if (!@move_uploaded_file($f['tmp_name'], $dest)) {
        json_fail(500, 'Could not store the screenshot. Submit the UTR instead.');
    }
    @chmod($dest, 0644);

    return 'uploads/p2p/' . $name;
}

/* ============================================================ confirm ===== */

/**
 * The seller confirms they received the rupees — the escrow releases to buyer.
 *
 * Seller-only, and only for a 'paid' trade. The money move is p2p_release_core().
 */
function handle_confirm(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id = input_int('id');
    if ($id <= 0) {
        json_fail(422, 'Which trade?');
    }

    // Friendly pre-checks; the tx re-checks under a row lock as the race guard.
    $t = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    if (!$t || (int)$t['seller_id'] !== (int)$u['id']) {
        json_fail(404, 'Trade not found.');
    }
    if ($t['status'] !== 'paid') {
        json_fail(409, $t['status'] === 'matched'
            ? 'The buyer has not uploaded proof of payment yet. Do not release until you have received the rupees.'
            : 'This trade is ' . $t['status'] . ' and cannot be confirmed.');
    }

    $result = tx(static function (PDO $pdo) use ($id, $u) {
        $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $row = $st->fetch();
        if (!$row || (int)$row['seller_id'] !== (int)$u['id']) {
            throw new RuntimeException('Trade not found.');
        }
        if ($row['status'] !== 'paid') {
            throw new RuntimeException('This trade is ' . $row['status'] . ' and cannot be confirmed.');
        }
        return p2p_release_core($pdo, $row);
    });

    audit('p2p.confirm', ['entity' => 'p2p_trades', 'entity_id' => (string)$id, 'detail' => $result]);

    $fresh = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    json_ok([
        'trade'   => p2p_trade_public($fresh, (int)$u['id'], false),
        'result'  => $result,
        'message' => sprintf('Released %s ARV to the buyer. Recorded for your tax statement.', $result['units']),
    ]);
}

/* ============================================================= cancel ===== */

/** Cancel a matched trade before payment. Buyer or seller; escrow returns to seller. */
function handle_cancel(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id     = input_int('id');
    $reason = substr(input_str('reason'), 0, 200);
    if ($id <= 0) {
        json_fail(422, 'Which trade?');
    }

    $t = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    if (!$t || ((int)$t['buyer_id'] !== (int)$u['id'] && (int)$t['seller_id'] !== (int)$u['id'])) {
        json_fail(404, 'Trade not found.');
    }
    if ($t['status'] !== 'matched') {
        json_fail(409, $t['status'] === 'paid'
            ? 'Payment has already been submitted. Cancelling now needs an operator.'
            : 'This trade is ' . $t['status'] . '.');
    }

    $who = (int)$t['buyer_id'] === (int)$u['id'] ? 'buyer' : 'seller';

    $result = tx(static function (PDO $pdo) use ($id, $u, $reason, $who) {
        $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $row = $st->fetch();
        if (!$row || ((int)$row['buyer_id'] !== (int)$u['id'] && (int)$row['seller_id'] !== (int)$u['id'])) {
            throw new RuntimeException('Trade not found.');
        }
        if ($row['status'] !== 'matched') {
            throw new RuntimeException('This trade is ' . $row['status'] . ' and can no longer be cancelled.');
        }
        return p2p_cancel_core($pdo, $row, 'cancelled by ' . $who . ($reason !== '' ? ': ' . $reason : ''));
    });

    audit('p2p.cancel', ['entity' => 'p2p_trades', 'entity_id' => (string)$id,
                         'detail' => ['by' => $who] + $result]);

    $fresh = q1('SELECT * FROM p2p_trades WHERE id = ?', [$id]);
    json_ok([
        'trade'   => p2p_trade_public($fresh, (int)$u['id'], false),
        'message' => 'Trade cancelled. The escrowed ARV is back with the seller.',
    ]);
}

/* ======================================================= cancel order ===== */

/**
 * Cancel a resting P2P order and reclaim any escrow it still holds.
 *
 * For a sell, the UNRESERVED escrow (locked minus what active trades reserve)
 * returns to the seller's available balance; if trades are still live the order
 * stays 'partial' so it keeps backing them, otherwise it is cancelled. A buy
 * simply stops matching — but only if it has no live trade to resolve first.
 */
function handle_cancel_order(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id = input_int('orderId');
    if ($id <= 0) {
        json_fail(422, 'Which order?');
    }

    $o = q1("SELECT * FROM orders WHERE id = ? AND user_id = ? AND channel = 'p2p'", [$id, $u['id']]);
    if (!$o) {
        json_fail(404, 'Order not found.');
    }
    if (!in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
        json_fail(409, 'That order is already ' . $o['status'] . '.');
    }

    $result = tx(static function (PDO $pdo) use ($id, $u) {
        $st = $pdo->prepare('SELECT * FROM orders WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $o = $st->fetch();
        if (!$o || ($o['channel'] ?? '') !== 'p2p' || (int)$o['user_id'] !== (int)$u['id']) {
            throw new RuntimeException('Order not found.');
        }
        if (!in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
            throw new RuntimeException('That order is already ' . $o['status'] . '.');
        }

        if ($o['side'] === 'sell') {
            $reserved  = p2p_reserved_sell_u8($pdo, $id);
            $matchable = max(0, u8((string)$o['locked_units']) - $reserved);

            if ($matchable > 0) {
                // Unreserved escrow returns to available. Net-zero move.
                wallet_apply($pdo, (int)$u['id'], 0, 0, $matchable, -$matchable);
                $newLocked = max(0, u8((string)$o['locked_units']) - $matchable);
                $pdo->prepare('UPDATE orders SET locked_units = ? WHERE id = ?')
                    ->execute([u8str($newLocked), $id]);
                ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
                    'ref' => (string)$o['ref'], 'relatedId' => $id,
                    'note' => 'P2P sell order cancelled — unreserved escrow returned',
                ]);
            }

            // Live trades keep the order alive; otherwise it is done.
            $status = $reserved > 0 ? 'partial' : 'cancelled';
            $pdo->prepare('UPDATE orders SET status = ? WHERE id = ?')->execute([$status, $id]);

            return ['returnedUnits' => u8str($matchable), 'status' => $status];
        }

        // Buy: no escrow. Refuse if a live trade still hangs off it.
        $active = u8((string)(qval(
            "SELECT COALESCE(SUM(units),0) FROM p2p_trades
              WHERE buyer_order_id = ? AND status IN ('matched','paid')", [$id]
        ) ?? '0'));
        if ($active > 0) {
            throw new RuntimeException('Resolve the trade(s) on this order before cancelling it.');
        }
        $pdo->prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?")->execute([$id]);
        return ['returnedUnits' => '0.00000000', 'status' => 'cancelled'];
    });

    audit('p2p.cancel_order', ['entity' => 'orders', 'entity_id' => (string)$id, 'detail' => $result]);
    json_ok($result + ['message' => 'Order cancelled.']);
}

/* ============================================================= offers ===== */

/**
 * The public P2P book — how much is waiting to buy and to sell.
 *
 * There is no bid/ask; every trade settles at the index price. This is a depth
 * readout so a trader can see whether a counterparty is likely to be waiting.
 */
function handle_offers(): void
{
    require_method('GET');
    require_user();

    $meta = arv_nav_meta();
    $nav  = $meta['nav'];

    $pdo = db();
    $sells = q("SELECT * FROM orders WHERE channel = 'p2p' AND side = 'sell'
                  AND status IN ('open','triggered','partial')
                ORDER BY created_at ASC LIMIT 200")->fetchAll();
    $buys  = q("SELECT * FROM orders WHERE channel = 'p2p' AND side = 'buy'
                  AND status IN ('open','triggered','partial')
                ORDER BY created_at ASC LIMIT 200")->fetchAll();

    $sellU8 = 0;
    foreach ($sells as $o) {
        $sellU8 += p2p_sell_matchable_u8($pdo, $o);
    }
    $buyU8 = 0;
    foreach ($buys as $o) {
        $buyU8 += p2p_buy_matchable_u8($pdo, $o);
    }

    json_ok([
        'price'          => $meta,
        'sellDepthUnits' => u8str(max(0, $sellU8)),
        'buyDepthUnits'  => u8str(max(0, $buyU8)),
        'sellDepthPaise' => $nav !== null ? u8_to_paise(max(0, $sellU8), (float)$nav) : null,
        'buyDepthPaise'  => $nav !== null ? u8_to_paise(max(0, $buyU8), (float)$nav) : null,
        'sellOrders'     => count($sells),
        'buyOrders'      => count($buys),
        'note'           => 'Every P2P trade settles at the live index price. A limit order acts '
                          . 'when the index reaches its level; there is no spread to negotiate.',
    ]);
}

/* ============================================================ shaping ===== */

function p2p_order_public(int $id): array
{
    $o = q1('SELECT * FROM orders WHERE id = ?', [$id]);
    if (!$o) {
        json_fail(404, 'Order not found.');
    }
    return p2p_order_row_public($o);
}

function p2p_order_row_public(array $o): array
{
    $pdo       = db();
    $matchable = $o['side'] === 'sell'
        ? p2p_sell_matchable_u8($pdo, $o)
        : p2p_buy_matchable_u8($pdo, $o);

    return [
        'id'             => (int)$o['id'],
        'ref'            => $o['ref'],
        'side'           => $o['side'],
        'type'           => $o['otype'],
        'status'         => $o['status'],
        'units'          => (string)$o['units'],
        'lockedUnits'    => (string)$o['locked_units'],
        'filledUnits'    => (string)$o['filled_units'],
        'matchableUnits' => u8str($matchable),
        'triggerNav'     => $o['trigger_nav'] !== null ? (float)$o['trigger_nav'] : null,
        'createdAt'      => $o['created_at'],
    ];
}

/** The P2P trades attached to one order, for the placement response. */
function p2p_trades_for_order(int $orderId, int $viewerId): array
{
    $rows = q(
        'SELECT * FROM p2p_trades WHERE buyer_order_id = ? OR seller_order_id = ?
          ORDER BY id DESC',
        [$orderId, $orderId]
    )->fetchAll();

    return array_map(static fn($t) => p2p_trade_public($t, $viewerId, false), $rows);
}

/** name@bank -> n***@bank ; a@b.com -> a***@b.com. Enough to recognise, not to expose. */
function mask_email(string $email): string
{
    $at = strpos($email, '@');
    if ($at === false || $at < 1) {
        return '***';
    }
    $name = substr($email, 0, $at);
    $dom  = substr($email, $at);
    $head = substr($name, 0, 1);
    return $head . '***' . $dom;
}
