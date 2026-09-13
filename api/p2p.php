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
    if (!in_array($otype, ['market', 'limit', 'stop', 'target'], true)) {
        json_fail(422, 'Order type must be market, limit, stop or target.');
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
    // limit/stop/target all trigger on the live index price; the type only sets
    // the DIRECTION of the trigger (see p2p_order_ready):
    //   limit / target  → buy fires at/below trigger, sell fires at/above.
    //   stop            → buy fires at/above trigger, sell fires at/below.
    // A trigger already satisfied now is just a market order — say so rather than
    // firing instantly.
    $trigger = null;
    if ($otype !== 'market') {
        $trigger = (float)input_dec('triggerNav', '0');
        if ($trigger <= 0) {
            json_fail(422, 'Enter the price you want the order to trigger at.');
        }
        $isStop   = ($otype === 'stop');
        $readyNow = $side === 'buy'
            ? ($isStop ? $nav >= $trigger : $nav <= $trigger)
            : ($isStop ? $nav <= $trigger : $nav >= $trigger);
        if ($readyNow) {
            json_fail(422, sprintf(
                'ARV is already at ₹%.4f, which already meets your ₹%.4f trigger. Place a market %s instead.',
                $nav, $trigger, $side));
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

        $orderId = tx_or_fail(static function (PDO $pdo) use ($u, $orderRef, $otype, $trigger, $units8) {
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

    $orderId = tx_or_fail(static function (PDO $pdo) use ($u, $orderRef, $otype, $trigger, $units8) {
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

    tx_or_fail(static function (PDO $pdo) use ($id, $u, $utr, $image, $t) {
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
 * Hardened the way the old deposit upload was: the extension comes from
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

    $result = tx_or_fail(static function (PDO $pdo) use ($id, $u) {
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

    $result = tx_or_fail(static function (PDO $pdo) use ($id, $u, $reason, $who) {
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

    $result = tx_or_fail(static function (PDO $pdo) use ($id, $u) {
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
/**
 * The market: who is waiting, and what has been trading.
 *
 * This used to return two aggregate numbers and nothing else, which is why the
 * trade page could only say "waiting to sell: 0 ARV" — factually true and
 * completely useless. Somebody who places an order and sees an empty screen has no
 * way to tell a quiet market from a broken one, and assumes the second.
 *
 * So it now returns three things a real venue shows:
 *
 *   - `book`      — every resting order on both sides, anonymised. A seller can see
 *                   that somebody is waiting to buy and how much; a buyer can see
 *                   the supply they are about to take. This IS the "let sellers see
 *                   there is a buyer at this rate" signal.
 *   - `activity`  — recent trades platform-wide, read from `p2p_trades` rather than
 *                   `trades`, so a match shows up the moment it happens instead of
 *                   waiting for the whole pay-and-confirm cycle to finish. This is
 *                   the running feed that shows the market is alive.
 *   - `liquidity` — whether a market order placed right now would fill instantly,
 *                   and from where. Told before they commit, not after.
 *
 * Everything is anonymous: units, price, rupees, age and status. No identities, no
 * order references, nothing that ties a row to a person.
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

    // The book, built as we total the depth so each row's matchable units are
    // computed exactly once. FIFO order is preserved because that is genuinely the
    // queue: p2p_try_match() takes resting orders by created_at ASC, so position in
    // this list is position in line.
    $sellU8 = 0;
    $sellBook = [];
    foreach ($sells as $o) {
        $m = p2p_sell_matchable_u8($pdo, $o);
        $sellU8 += $m;
        if ($m > 0) {
            $sellBook[] = p2p_book_row($o, $m, $nav);
        }
    }
    $buyU8 = 0;
    $buyBook = [];
    foreach ($buys as $o) {
        $m = p2p_buy_matchable_u8($pdo, $o);
        $buyU8 += $m;
        if ($m > 0) {
            $buyBook[] = p2p_book_row($o, $m, $nav);
        }
    }

    // Phase 2b transparency: the platform fee + TDS a buyer will pay (in ARV,
    // out of the units they receive) on release, and whether the treasury can
    // supply liquidity when no real seller is resting. `feeCollected` reflects
    // whether a fee account actually resolves — if not, no fee is taken.
    $feeAcct  = p2p_fee_account_user($pdo);
    $feePct   = $feeAcct !== null ? setting_f('p2p_fee_pct', 1) : 0.0;
    $tdsPct   = $feeAcct !== null ? setting_f('p2p_tds_pct', 0) : 0.0;
    $treasury = p2p_treasury_user($pdo);

    // How much the treasury could actually supply right now. p2p_treasury_user()
    // already applied the strict test (enabled, active, KYC-verified, has a payment
    // method), so the only thing left to read is its free ARV — the same figure
    // p2p_treasury_fill_buy() will draw against.
    $treasuryUnits8 = 0;
    if ($treasury !== null) {
        $tw = q1('SELECT arv_units FROM wallets WHERE user_id = ?', [(int)$treasury['id']]);
        $treasuryUnits8 = $tw ? u8((string)$tw['arv_units']) : 0;
    }

    json_ok([
        'price'          => $meta,
        'sellDepthUnits' => u8str(max(0, $sellU8)),
        'buyDepthUnits'  => u8str(max(0, $buyU8)),
        'sellDepthPaise' => $nav !== null ? u8_to_paise(max(0, $sellU8), (float)$nav) : null,
        'buyDepthPaise'  => $nav !== null ? u8_to_paise(max(0, $buyU8), (float)$nav) : null,
        'sellOrders'     => count($sellBook),
        'buyOrders'      => count($buyBook),

        // The book. Sells are what a buyer can take; buys are the demand a seller
        // can fill. Capped at 25 a side — beyond that it is noise, and the totals
        // above already carry the whole depth.
        'book'           => [
            'sells' => array_slice($sellBook, 0, 25),
            'buys'  => array_slice($buyBook, 0, 25),
        ],

        'activity'  => p2p_recent_activity(),
        'stats24h'  => p2p_activity_stats(),

        // Said plainly, before they commit: would a market order fill now?
        'liquidity' => [
            'buyFillsNow'     => $sellU8 > 0 || $treasuryUnits8 > 0,
            'sellFillsNow'    => $buyU8 > 0,
            'treasuryUnits'   => u8str($treasuryUnits8),
            'instantForBuyer' => u8str(max(0, $sellU8) + $treasuryUnits8),
        ],

        'fee'            => [
            'collected'    => $feeAcct !== null && ($feePct > 0 || $tdsPct > 0),
            'feePct'       => $feePct,
            'tdsPct'       => $tdsPct,
            'totalPct'     => $feePct + $tdsPct,
        ],
        'treasuryAvailable' => $treasury !== null,
        'note'           => 'Every P2P trade settles at the live index price. A limit order acts '
                          . 'when the index reaches its level; there is no spread to negotiate.',
    ]);
}

/**
 * One anonymous row of the public book.
 *
 * Deliberately carries no identity and no order reference — only size, kind, and
 * how long it has been waiting. Age is the useful part: it tells a seller that
 * somebody has been waiting twenty minutes, which is a far stronger reason to fill
 * them than a bare number.
 */
function p2p_book_row(array $o, int $matchable8, ?float $nav): array
{
    $created = $o['created_at'] ?? null;
    return [
        'units'      => u8str($matchable8),
        'paise'      => $nav !== null ? u8_to_paise($matchable8, $nav) : null,
        'type'       => $o['otype'],
        // A market order takes the index price; a trigger order names its level, so
        // a viewer can tell "waiting for a counterparty" from "waiting for a price".
        'triggerNav' => $o['trigger_nav'] !== null ? (float)$o['trigger_nav'] : null,
        'waitingSeconds' => $created !== null
            ? max(0, time() - strtotime($created . ' UTC'))
            : null,
    ];
}

/**
 * Recent trades, platform-wide and anonymous.
 *
 * Read from `p2p_trades`, not `trades`. The `trades` row is only written when a
 * trade RELEASES — after the buyer has paid and the seller has confirmed — so a
 * tape built on it lags real activity by the whole pay-and-confirm cycle and can
 * look empty while several trades are in flight. `p2p_trades` has a row from the
 * instant of the match, which is what "the market is alive" actually means.
 *
 * Cancelled and expired trades are excluded: a match nobody paid for is not
 * activity, and showing it would overstate the venue.
 */
function p2p_recent_activity(int $limit = 30): array
{
    $rows = q(
        'SELECT units, price_nav, amount_paise, status,
                matched_at, paid_at, released_at
           FROM p2p_trades
          WHERE status IN ("matched","paid","released","disputed")
          ORDER BY id DESC LIMIT ' . max(1, min(100, $limit))
    )->fetchAll();

    return array_map(static function ($t) {
        // The most recent thing that happened to it, which is what a tape should be
        // ordered and stamped by.
        $at = $t['released_at'] ?? ($t['paid_at'] ?? $t['matched_at']);
        return [
            'units'  => (string)$t['units'],
            'nav'    => (float)$t['price_nav'],
            'paise'  => (int)$t['amount_paise'],
            // 'released' is a completed trade; 'matched'/'paid' are in flight. Shown
            // so the feed reads as a live market rather than a settled archive.
            'status' => $t['status'],
            'at'     => $at,
        ];
    }, $rows);
}

/** Traded volume over the last 24 hours — the headline that says "this venue works". */
function p2p_activity_stats(): array
{
    $r = q1(
        'SELECT COUNT(*) AS n,
                COALESCE(SUM(units),0)        AS units,
                COALESCE(SUM(amount_paise),0) AS paise
           FROM p2p_trades
          WHERE status IN ("paid","released")
            AND matched_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)'
    );

    return [
        'trades' => (int)($r['n'] ?? 0),
        'units'  => (string)($r['units'] ?? '0'),
        'paise'  => (int)($r['paise'] ?? 0),
    ];
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
        // When this resting order will be swept. Case A of p2p_sweep_timers()
        // expires an unmatched P2P order once created_at is older than
        // p2p_match_ttl_hours, but that instant was never exposed, so a client
        // could only guess at it. Built exactly like the trade deadlines in
        // p2p_trade_public() (p2p_deadline_iso -> ISO-8601 UTC with a trailing
        // Z), so a browser countdown lands on the same second the cron acts.
        'expiresAt'      => p2p_deadline_iso(
            $o['created_at'] ?? null,
            setting_i('p2p_match_ttl_hours', 24) * 3600
        ),
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
