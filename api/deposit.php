<?php
/**
 * Deposits — rupees in, via UPI.
 *
 * The shape of this flow is dictated by one fact: a UPI QR carries a request in
 * one direction and returns nothing. There is no callback, no signature, nothing
 * to verify. Displaying a QR tells this server absolutely nothing about whether
 * money arrived.
 *
 * So:
 *
 *   1. `create`  — records intent, returns a reference and a QR payload. Credits
 *                  nothing.
 *   2. user pays, then `submit` — attaches a UTR or a screenshot.
 *   3. an operator matches it against the bank statement and confirms.
 *   4. only then is the wallet credited, and the referral commission paid.
 *
 * Wiring step 4 to a client-side "payment done" callback is the single most
 * reliable way to have a balance drained by somebody who never paid.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'create': handle_create(); break;
    case 'submit': handle_submit(); break;
    case 'mine':   handle_mine();   break;
    case 'get':    handle_get();    break;
    case 'cancel': handle_cancel(); break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================= create ===== */

function handle_create(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    $u = require_user();
    rate_limit('deposit_create', 12, 3600, 1800);

    $paise = input_int('amountPaise');
    $min   = setting_i('min_order_paise', 10000);

    if ($paise < $min) {
        json_fail(422, sprintf('The minimum deposit is ₹%s.', number_format($min / 100)));
    }
    if ($paise > 100000000000) {
        json_fail(422, 'That amount is beyond what this platform handles. Contact operations.');
    }

    // One open request at a time. Several live QRs with the same UPI note make
    // the operator's job guesswork, and guesswork about which deposit a bank
    // credit belongs to is how the wrong person gets credited.
    $open = q1(
        'SELECT ref FROM deposits
          WHERE user_id = ? AND status IN ("awaiting_payment","submitted")
          ORDER BY id DESC LIMIT 1',
        [$u['id']]
    );
    if ($open) {
        json_fail(409, 'You already have a deposit in progress. Finish or cancel it first.', [
            'existingRef' => $open['ref'],
        ]);
    }

    $ref     = ref('DEP');
    $expiry  = setting_i('deposit_request_expiry_minutes', 30);
    $vpa     = (string)setting('upi_vpa', '');
    $payee   = (string)setting('payee_name', 'ARV Coin');
    $payload = $vpa !== '' ? upi_uri($vpa, $payee, $paise, $ref) : null;

    $id = tx(static function (PDO $pdo) use ($u, $paise, $ref, $payload, $expiry) {
        $pdo->prepare(
            'INSERT INTO deposits (ref, user_id, amount_paise, status, qr_payload, expires_at)
             VALUES (?, ?, ?, "awaiting_payment", ?,
                     DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))'
        )->execute([$ref, (int)$u['id'], $paise, $payload, $expiry]);
        return (int)$pdo->lastInsertId();
    });

    audit('deposit.create', ['entity' => 'deposits', 'entity_id' => $ref,
                             'detail' => ['paise' => $paise]]);

    json_ok([
        'deposit' => deposit_public($id, (int)$u['id']),
        'upi'     => [
            'vpa'        => $vpa,
            'payeeName'  => $payee,
            'uri'        => $payload,
            'configured' => $vpa !== '',
            'note'       => $vpa === ''
                ? 'No UPI ID is configured yet, so the QR is a placeholder. Operations must set it before real deposits.'
                : 'Put the reference in the payment note so the credit can be matched.',
        ],
        'window'  => [
            'minMinutes' => setting_i('deposit_min_minutes', 2),
            'maxMinutes' => setting_i('deposit_max_minutes', 15),
        ],
        'message' => 'Pay the exact amount, then submit your UTR or a screenshot.',
    ]);
}

/**
 * Build a UPI intent URI.
 *
 * Amount is rendered with exactly two decimals — UPI apps reject malformed
 * amounts, and "100" versus "100.00" fails on some apps and works on others,
 * which is the worst kind of bug to debug from a support ticket.
 */
function upi_uri(string $vpa, string $payee, int $paise, string $ref): string
{
    $params = [
        'pa' => $vpa,
        'pn' => $payee,
        'am' => number_format($paise / 100, 2, '.', ''),
        'cu' => 'INR',
        'tr' => $ref,
        'tn' => preg_replace('/[^\w\s\-]/', '', $ref),
    ];
    return 'upi://pay?' . http_build_query($params);
}

/* ============================================================= submit ===== */

/**
 * Attach proof of payment.
 *
 * Accepts a UTR, a screenshot, or both. A UTR is far better — it is a bank
 * reference an operator can search for, whereas a screenshot has to be read by a
 * human and can be fabricated in a minute.
 */
function handle_submit(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();
    rate_limit('deposit_submit', 20, 3600);

    // Multipart when a screenshot is attached, JSON otherwise.
    $ref = isset($_POST['ref']) ? trim((string)$_POST['ref']) : input_str('ref');
    $utr = isset($_POST['utr']) ? trim((string)$_POST['utr']) : input_str('utr');
    $utr = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $utr));

    if ($ref === '') {
        json_fail(422, 'Which deposit? Reference missing.');
    }

    $dep = q1('SELECT * FROM deposits WHERE ref = ? AND user_id = ?', [$ref, $u['id']]);
    if (!$dep) {
        json_fail(404, 'Deposit not found.');
    }
    if ($dep['status'] === 'confirmed') {
        json_fail(409, 'That deposit is already confirmed and credited.');
    }
    if (in_array($dep['status'], ['rejected', 'expired'], true)) {
        json_fail(409, 'That deposit is ' . $dep['status'] . '. Start a new one.');
    }

    $screenshot = save_screenshot($u, $ref);

    if ($utr === '' && $screenshot === null) {
        json_fail(422, 'Enter the UTR from your payment app, or attach a screenshot.');
    }
    if ($utr !== '' && (strlen($utr) < 6 || strlen($utr) > 40)) {
        json_fail(422, 'That does not look like a UTR. It is the 12-digit reference in your payment app.');
    }

    // A UTR identifies exactly one bank transfer, so the same one must never back
    // two deposits. Catching it here saves an operator from crediting twice.
    if ($utr !== '') {
        $dup = q1('SELECT ref FROM deposits WHERE utr = ? AND ref <> ? AND status <> "rejected"',
                  [$utr, $ref]);
        if ($dup) {
            json_fail(409, 'That UTR has already been submitted against another deposit.');
        }
    }

    q('UPDATE deposits SET status = "submitted", utr = ?, screenshot_path = ?,
              submitted_at = UTC_TIMESTAMP()
       WHERE id = ?',
      [$utr, $screenshot ?? (string)$dep['screenshot_path'], $dep['id']]);

    audit('deposit.submit', ['entity' => 'deposits', 'entity_id' => $ref,
                             'detail' => ['utr' => $utr !== '' ? substr($utr, -4) : null,
                                          'screenshot' => $screenshot !== null]]);

    json_ok([
        'deposit' => deposit_public((int)$dep['id'], (int)$u['id']),
        'message' => sprintf(
            'Submitted. Operations verifies against the bank account and credits your wallet — '
            . 'usually %d to %d minutes.',
            setting_i('deposit_min_minutes', 2),
            setting_i('deposit_max_minutes', 15)
        ),
    ]);
}

/**
 * Store an uploaded screenshot.
 *
 * The extension is taken from the detected MIME type, never from the filename —
 * a file called `shot.png` that is actually PHP would otherwise be saved as
 * something the web server will happily execute. The upload directory also gets
 * an .htaccess that refuses to run anything in it.
 */
function save_screenshot(array $u, string $ref): ?string
{
    if (empty($_FILES['screenshot']) || ($_FILES['screenshot']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    $f = $_FILES['screenshot'];

    if ($f['error'] !== UPLOAD_ERR_OK) {
        json_fail(422, 'The upload did not complete. Try a smaller image.');
    }
    $maxBytes = 4 * 1024 * 1024;
    if ($f['size'] > $maxBytes) {
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

    // Confirm it is genuinely a decodable image, not just something with the
    // right magic bytes.
    if (@getimagesize($f['tmp_name']) === false) {
        json_fail(422, 'That file is not a readable image.');
    }

    $dir = dirname(__DIR__) . '/uploads/deposits';
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

    return 'uploads/deposits/' . $name;
}

/* =============================================================== list ===== */

function handle_mine(): void
{
    require_method('GET');
    $u = require_user();

    $rows = q('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 100',
              [$u['id']])->fetchAll();

    json_ok(['deposits' => array_map(
        static fn($d) => deposit_row_public($d),
        $rows
    )]);
}

function handle_get(): void
{
    require_method('GET');
    $u = require_user();
    $ref = (string)($_GET['ref'] ?? '');

    $d = q1('SELECT * FROM deposits WHERE ref = ? AND user_id = ?', [$ref, $u['id']]);
    if (!$d) {
        json_fail(404, 'Deposit not found.');
    }
    json_ok(['deposit' => deposit_row_public($d)]);
}

/* ============================================================= cancel ===== */

function handle_cancel(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $ref = input_str('ref');
    $d = q1('SELECT * FROM deposits WHERE ref = ? AND user_id = ?', [$ref, $u['id']]);
    if (!$d) {
        json_fail(404, 'Deposit not found.');
    }
    if ($d['status'] === 'confirmed') {
        json_fail(409, 'That deposit is already credited and cannot be cancelled.');
    }

    q('UPDATE deposits SET status = "rejected", reject_reason = "Cancelled by the user"
       WHERE id = ?', [$d['id']]);

    audit('deposit.cancel', ['entity' => 'deposits', 'entity_id' => $ref]);
    json_ok(['message' => 'Deposit request cancelled.']);
}

/* ============================================================ shaping ===== */

function deposit_public(int $id, int $userId): array
{
    $d = q1('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [$id, $userId]);
    if (!$d) {
        json_fail(404, 'Deposit not found.');
    }
    return deposit_row_public($d);
}

function deposit_row_public(array $d): array
{
    $min = setting_i('deposit_min_minutes', 2);
    $max = setting_i('deposit_max_minutes', 15);

    // Elapsed time against the promised window, so the UI can run an honest
    // countdown instead of a spinner that means nothing.
    $since = $d['submitted_at'] !== null ? (time() - strtotime($d['submitted_at'])) : null;

    return [
        'ref'          => $d['ref'],
        'amountPaise'  => (int)$d['amount_paise'],
        'status'       => $d['status'],
        'utr'          => $d['utr'] !== '' ? substr((string)$d['utr'], 0, 2) . '…' . substr((string)$d['utr'], -4) : '',
        'hasScreenshot'=> $d['screenshot_path'] !== '',
        'qrPayload'    => $d['qr_payload'],
        'createdAt'    => $d['created_at'],
        'submittedAt'  => $d['submitted_at'],
        'confirmedAt'  => $d['confirmed_at'],
        'expiresAt'    => $d['expires_at'],
        'rejectReason' => $d['reject_reason'],
        'window'       => ['minMinutes' => $min, 'maxMinutes' => $max],
        'elapsedSeconds' => $since,
        'overdue'      => $since !== null && $since > $max * 60 && $d['status'] === 'submitted',
    ];
}
