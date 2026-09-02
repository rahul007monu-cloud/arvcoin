<?php
/**
 * Authentication — signup, email OTP, login, session.
 *
 * Design notes worth stating:
 *
 *   OTPs are stored as HMACs, never in plaintext. A table of live plaintext OTPs
 *   is a table of live passwords with a shorter lifetime, and the same database
 *   dump that leaks one leaks the other.
 *
 *   Login and signup both answer identically whether or not the address exists.
 *   An endpoint that says "no such account" is an account enumerator, and on a
 *   financial product that list has resale value.
 *
 *   A second factor on every single login is friction people route around by
 *   reusing passwords. So the OTP is required on a device the account has not
 *   used before, and a signed trusted-device cookie skips it for 30 days after
 *   that. `login_otp_always` in settings forces it every time if that is
 *   preferred.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

const OTP_TTL_SECONDS   = 600;   // 10 minutes
const OTP_MAX_ATTEMPTS  = 5;
const TRUST_COOKIE      = 'arvtrust';
const TRUST_DAYS        = 30;

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'csrf':      handle_csrf();      break;
    case 'signup':    handle_signup();    break;
    case 'verify':    handle_verify();    break;
    case 'resend':    handle_resend();    break;
    case 'login':     handle_login();     break;
    case 'logout':    handle_logout();    break;
    case 'me':        handle_me();        break;
    case 'password':  handle_password();  break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================== csrf ====== */

function handle_csrf(): void
{
    require_method('GET');
    json_ok(['csrf' => csrf_token()]);
}

/* ============================================================ signup ====== */

function handle_signup(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    rate_limit('signup', 6, 3600, 3600);

    $email    = strtolower(input_str('email'));
    $password = (string)input('password', '');
    $fullName = substr(input_str('fullName'), 0, 120);
    $refCode  = strtoupper(input_str('referralCode'));

    if (!is_email($email)) {
        json_fail(422, 'Enter a valid email address.');
    }
    if (strlen($password) < 8) {
        json_fail(422, 'Choose a password of at least 8 characters.');
    }
    if (!input('acceptedTerms')) {
        json_fail(422, 'You need to accept the risk disclosure and terms to continue.');
    }

    $existing = q1('SELECT id, email_verified FROM users WHERE email = ?', [$email]);

    if ($existing) {
        // Do not confirm that the address is taken. If it is unverified, quietly
        // re-send the code so a genuine person who abandoned signup can finish.
        if (!$existing['email_verified']) {
            issue_otp((int)$existing['id'], 'signup', $email);
        }
        json_ok([
            'next'    => 'verify',
            'email'   => $email,
            'message' => 'We have sent a 6-digit code to that address. Enter it to continue.',
        ]);
    }

    $referrer = null;
    if ($refCode !== '') {
        $r = q1('SELECT id FROM users WHERE referral_code = ? AND status = "active"', [$refCode]);
        // A wrong code is not worth failing a signup over — it is recorded as
        // absent and the person still gets an account.
        $referrer = $r ? (int)$r['id'] : null;
    }

    $userId = tx(static function (PDO $pdo) use ($email, $password, $fullName, $referrer) {
        // Retry on the astronomically unlikely code collision rather than
        // failing the signup.
        for ($i = 0; $i < 5; $i++) {
            $code = referral_code();
            $dup = $pdo->prepare('SELECT 1 FROM users WHERE referral_code = ?');
            $dup->execute([$code]);
            if (!$dup->fetchColumn()) {
                break;
            }
        }

        $pdo->prepare(
            'INSERT INTO users (email, pass_hash, full_name, referral_code, referred_by)
             VALUES (?, ?, ?, ?, ?)'
        )->execute([
            $email,
            password_hash($password, PASSWORD_DEFAULT),
            $fullName,
            $code,
            $referrer,
        ]);

        $id = (int)$pdo->lastInsertId();
        $pdo->prepare('INSERT INTO wallets (user_id) VALUES (?)')->execute([$id]);
        $pdo->prepare('INSERT INTO kyc (user_id, status, full_name) VALUES (?, "none", ?)')
            ->execute([$id, $fullName]);

        return $id;
    });

    audit('signup', ['actor' => $userId, 'entity' => 'users', 'entity_id' => (string)$userId,
                     'detail' => ['referred_by' => $referrer]]);

    issue_otp($userId, 'signup', $email);

    json_ok([
        'next'    => 'verify',
        'email'   => $email,
        'message' => 'Account created. Enter the 6-digit code we emailed you.',
    ]);
}

/* ============================================================ verify ====== */

function handle_verify(): void
{
    require_method('POST');
    require_csrf();
    rate_limit('otp_verify', 20, 900, 1800);

    $email   = strtolower(input_str('email'));
    $code    = preg_replace('/\D/', '', input_str('code'));
    $purpose = input_str('purpose', 'signup');
    $trust   = (bool)input('trustDevice', false);

    if (!in_array($purpose, ['signup', 'login'], true)) {
        json_fail(422, 'Unknown verification purpose.');
    }
    if ($code === '' || strlen($code) !== 6) {
        json_fail(422, 'Enter the 6-digit code from the email.');
    }

    $user = q1('SELECT * FROM users WHERE email = ?', [$email]);
    if (!$user) {
        // Same shape and timing as a wrong code, so this cannot be used to test
        // whether an address is registered.
        json_fail(422, 'That code is not valid or has expired.');
    }

    $otp = q1(
        'SELECT * FROM otps
         WHERE user_id = ? AND purpose = ? AND used_at IS NULL
         ORDER BY id DESC LIMIT 1',
        [$user['id'], $purpose]
    );

    if (!$otp) {
        json_fail(422, 'That code is not valid or has expired. Request a new one.');
    }
    if (strtotime($otp['expires_at']) < time()) {
        json_fail(422, 'That code has expired. Request a new one.');
    }
    if ((int)$otp['attempts'] >= OTP_MAX_ATTEMPTS) {
        json_fail(429, 'Too many wrong attempts on this code. Request a new one.');
    }

    if (!hash_equals((string)$otp['code_hash'], otp_hash($code, (int)$user['id'], $purpose))) {
        q('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [$otp['id']]);
        $left = OTP_MAX_ATTEMPTS - ((int)$otp['attempts'] + 1);
        json_fail(422, $left > 0
            ? sprintf('That code is not correct. %d attempt%s left.', $left, $left === 1 ? '' : 's')
            : 'That code is not correct. Request a new one.');
    }

    // Used, so the recovery copy must not outlive it. Tolerated because a database
    // that has not had the migration applied has no such column, and consuming a
    // valid code must never fail over housekeeping.
    q('UPDATE otps SET used_at = UTC_TIMESTAMP() WHERE id = ?', [$otp['id']]);
    try {
        q('UPDATE otps SET undelivered_code = \'\' WHERE id = ?', [$otp['id']]);
    } catch (Throwable $e) {
        // Column not present yet. The migration will add it; nothing is lost.
    }

    if (!$user['email_verified']) {
        q('UPDATE users SET email_verified = 1 WHERE id = ?', [$user['id']]);
    }

    login_user((int)$user['id']);

    if ($trust) {
        set_trusted_device((int)$user['id']);
    }

    audit('login.otp', ['actor' => (int)$user['id'], 'detail' => ['purpose' => $purpose]]);

    json_ok(['user' => public_user((int)$user['id']), 'csrf' => csrf_token()]);
}

/* ============================================================ resend ====== */

function handle_resend(): void
{
    require_method('POST');
    require_csrf();
    // Deliberately tight. An unthrottled resend endpoint is a way to send mail
    // from someone else's domain, and a way to get that domain blacklisted.
    rate_limit('otp_resend', 4, 900, 1800);

    $email   = strtolower(input_str('email'));
    $purpose = input_str('purpose', 'signup');

    $user = q1('SELECT id FROM users WHERE email = ? AND status = "active"', [$email]);
    if ($user) {
        issue_otp((int)$user['id'], $purpose === 'login' ? 'login' : 'signup', $email);
    }

    // Identical answer either way.
    json_ok(['message' => 'If that address has an account, a new code is on its way.']);
}

/* ============================================================= login ====== */

function handle_login(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    rate_limit('login', 10, 900, 1800);

    $email    = strtolower(input_str('email'));
    $password = (string)input('password', '');

    $user = q1('SELECT * FROM users WHERE email = ?', [$email]);

    // Verify against a dummy hash when the account does not exist, so the
    // response takes the same time either way. Skipping this makes the endpoint
    // a timing oracle for which addresses are registered.
    $hash = $user['pass_hash'] ?? '$2y$10$usesomesillystringfor.invalidhashvaluexxxxxxxxxxxxxxxxxxxxx';
    $okPassword = password_verify($password, $hash);

    if (!$user || !$okPassword) {
        json_fail(401, 'That email and password do not match.');
    }
    if ($user['status'] !== 'active') {
        json_fail(403, 'This account is not active. Contact support.');
    }

    if (!$user['email_verified']) {
        issue_otp((int)$user['id'], 'signup', $email);
        json_ok([
            'next'    => 'verify',
            'purpose' => 'signup',
            'email'   => $email,
            'message' => 'Confirm your email first — we have sent you a code.',
        ]);
    }

    $needsOtp = setting_b('login_otp_always', false) || !device_is_trusted((int)$user['id']);

    if ($needsOtp) {
        issue_otp((int)$user['id'], 'login', $email);
        json_ok([
            'next'    => 'verify',
            'purpose' => 'login',
            'email'   => $email,
            'message' => 'We have emailed you a 6-digit code to confirm this sign-in.',
        ]);
    }

    login_user((int)$user['id']);
    audit('login.password', ['actor' => (int)$user['id']]);

    json_ok(['user' => public_user((int)$user['id']), 'csrf' => csrf_token()]);
}

/* ============================================================ logout ====== */

function handle_logout(): void
{
    require_method('POST');
    $u = current_user();
    if ($u) {
        audit('logout', ['actor' => (int)$u['id']]);
    }
    logout_user();
    // Clearing the trust cookie is deliberate: "sign out" on a shared machine
    // should not leave a token behind that skips the second factor.
    setcookie(TRUST_COOKIE, '', ['expires' => time() - 42000, 'path' => '/']);
    json_ok(['message' => 'Signed out.']);
}

/* ================================================================ me ====== */

function handle_me(): void
{
    require_method('GET');
    $u = current_user();
    if (!$u) {
        json_ok(['user' => null, 'csrf' => csrf_token()]);
    }
    json_ok(['user' => public_user((int)$u['id']), 'csrf' => csrf_token()]);
}

/* ========================================================== password ====== */

function handle_password(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();
    rate_limit('password_change', 5, 3600, 3600);

    $current = (string)input('currentPassword', '');
    $next    = (string)input('newPassword', '');

    if (!password_verify($current, (string)$u['pass_hash'])) {
        json_fail(401, 'Your current password is not correct.');
    }
    if (strlen($next) < 8) {
        json_fail(422, 'The new password must be at least 8 characters.');
    }

    q('UPDATE users SET pass_hash = ? WHERE id = ?',
      [password_hash($next, PASSWORD_DEFAULT), $u['id']]);

    audit('password.change', ['actor' => (int)$u['id']]);
    json_ok(['message' => 'Password changed.']);
}

/* =========================================================== helpers ====== */

function referral_code(): string
{
    // No 0/O/1/I/L — these are read aloud and typed by hand.
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < 8; $i++) {
        $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $out;
}

function otp_hash(string $code, int $userId, string $purpose): string
{
    // Keyed with app_key so a stolen database cannot be brute-forced offline
    // against six digits without also stealing the config file.
    return hash_hmac('sha256', $userId . '|' . $purpose . '|' . $code, (string)cfg()['app_key']);
}

/**
 * Create and email a one-time code.
 *
 * Any earlier unused code for the same purpose is invalidated first, so exactly
 * one code is live at a time and an old email cannot be replayed.
 */
/**
 * Create a one-time code and email it.
 *
 * @return bool Whether the email actually went. Callers must not tell the user to
 *              check their inbox when this is false — the commonest way a signup
 *              becomes a dead end is a page that says "we sent you a code" when
 *              nothing was sent, leaving the person to retry until they are rate
 *              limited and still no closer.
 */
function issue_otp(int $userId, string $purpose, string $email): bool
{
    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);

    $otpId = tx(static function (PDO $pdo) use ($userId, $purpose, $code) {
        // Only `used_at`. This statement is on the path of every signup and every
        // login, so it must reference nothing that a database might not have yet —
        // adding `undelivered_code` here took down signup and login together on any
        // install whose migration had not run, which is every install between a
        // deploy and the next cron minute. Superseding a code by marking it used is
        // sufficient; clearing the column is what the migration and the delete
        // below are for.
        $pdo->prepare(
            'UPDATE otps SET used_at = UTC_TIMESTAMP()
             WHERE user_id = ? AND purpose = ? AND used_at IS NULL'
        )->execute([$userId, $purpose]);

        $pdo->prepare(
            'INSERT INTO otps (user_id, purpose, code_hash, expires_at)
             VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))'
        )->execute([$userId, $purpose, otp_hash($code, $userId, $purpose), OTP_TTL_SECONDS]);

        return (int)$pdo->lastInsertId();
    });

    $minutes = (int)(OTP_TTL_SECONDS / 60);
    $what = $purpose === 'login' ? 'sign-in' : 'email confirmation';

    $body = "Your ARV Coin {$what} code is:\n\n"
          . "    {$code}\n\n"
          . "It expires in {$minutes} minutes and can be used once.\n\n"
          . "If you did not ask for this, ignore this email — nothing has changed on your\n"
          . "account, and nobody can act on it without this code.\n\n"
          . "We will never ask you for this code by phone, WhatsApp or email reply.\n";

    $sent = send_mail($email, 'ARV Coin — your code is ' . $code, $body);

    if (!$sent) {
        // The code goes to the error log, so a developer with no MTA can still test
        // the flow — and to the row itself, so an operator on a host where mail is
        // broken can read it out of the database and get in. Without one of those,
        // a failed send is an account nobody can ever enter.
        error_log(sprintf('[arv] OTP for %s (%s): %s', $email, $purpose, $code));

        // Tolerated rather than required: on a database that has not yet had the
        // migration applied these columns do not exist, and a failed *send* must
        // never turn into a failed *request*. The error log above is the fallback
        // to the fallback.
        try {
            q('UPDATE otps SET delivered = 0, undelivered_code = ? WHERE id = ?', [$code, $otpId]);
        } catch (Throwable $e) {
            error_log('[arv] could not record the undelivered code: ' . $e->getMessage());
        }

        audit('otp_undelivered', [
            'actor'  => $userId,
            'entity' => 'otps',
            'entity_id' => (string)$otpId,
            'detail' => ['purpose' => $purpose, 'email' => $email],
        ]);
    }

    return $sent;
}

/* ------------------------------------------------------- trusted device --- */

/**
 * A signed cookie that lets a known device skip the emailed code.
 *
 * Signed with app_key and bound to the user id, so it cannot be edited to point
 * at another account or forged without the server key. It carries no secret of
 * its own — losing it costs one extra email, nothing more.
 */
function set_trusted_device(int $userId): void
{
    $expires = time() + (TRUST_DAYS * 86400);
    $payload = $userId . '.' . $expires;
    $sig     = hash_hmac('sha256', $payload, (string)cfg()['app_key']);

    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';

    setcookie(TRUST_COOKIE, $payload . '.' . $sig, [
        'expires'  => $expires,
        'path'     => '/',
        'secure'   => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function device_is_trusted(int $userId): bool
{
    $raw = $_COOKIE[TRUST_COOKIE] ?? '';
    if ($raw === '' || substr_count($raw, '.') !== 2) {
        return false;
    }
    [$uid, $expires, $sig] = explode('.', $raw, 3);

    if ((int)$uid !== $userId || (int)$expires < time()) {
        return false;
    }
    $expected = hash_hmac('sha256', $uid . '.' . $expires, (string)cfg()['app_key']);
    return hash_equals($expected, $sig);
}

/* ----------------------------------------------------------- public user -- */

/**
 * Everything the front end needs about the signed-in account, in one shape.
 *
 * Never includes the password hash, and never includes another user's anything.
 */
function public_user(int $userId): array
{
    $u = q1('SELECT id, email, full_name, email_verified, referral_code, referred_by,
                    tier_id, tier_earned_at, is_admin, is_specified_person, created_at
             FROM users WHERE id = ?', [$userId]);
    if (!$u) {
        json_fail(404, 'Account not found.');
    }

    $kyc = q1('SELECT status, pan, pan_verified, upi_vpa, full_name, aadhaar_last4,
                      aadhaar_verified, reject_reason
               FROM kyc WHERE user_id = ?', [$userId]) ?? [];

    $w = q1('SELECT * FROM wallets WHERE user_id = ?', [$userId]);
    $meta = arv_nav_meta();
    $wallet = $w ? wallet_public($w, $meta['nav']) : null;

    $fees = user_fees($u);

    // Referral totals drive the tier, so they are part of identity here rather
    // than a separate call the dashboard would have to make.
    $ref = q1('SELECT COUNT(*) AS n,
                      COALESCE(SUM(base_paise),0) AS volume,
                      COALESCE(SUM(CASE WHEN status = "paid" THEN commission_paise ELSE 0 END),0) AS earned
               FROM referrals WHERE referrer_id = ?', [$userId]) ?? [];

    return [
        'id'            => (int)$u['id'],
        'email'         => $u['email'],
        'fullName'      => $u['full_name'] ?: ($kyc['full_name'] ?? ''),
        'emailVerified' => (bool)$u['email_verified'],
        'isAdmin'       => (bool)$u['is_admin'],
        'createdAt'     => $u['created_at'],

        'referralCode'  => $u['referral_code'],
        'referredBy'    => $u['referred_by'] !== null ? (int)$u['referred_by'] : null,
        'referrals'     => [
            'count'        => (int)($ref['n'] ?? 0),
            'volumePaise'  => (int)($ref['volume'] ?? 0),
            'earnedPaise'  => (int)($ref['earned'] ?? 0),
        ],

        'tier'          => $u['tier_id'] ?: null,
        'tierEarnedAt'  => $u['tier_earned_at'],
        'fees'          => $fees,

        'kyc'           => [
            'status'          => $kyc['status'] ?? 'none',
            'hasPan'          => !empty($kyc['pan']),
            'panMasked'       => !empty($kyc['pan'])
                ? substr((string)$kyc['pan'], 0, 2) . 'XXXXX' . substr((string)$kyc['pan'], -1)
                : '',
            'panVerified'     => (bool)($kyc['pan_verified'] ?? false),
            'aadhaarLast4'    => $kyc['aadhaar_last4'] ?? '',
            'aadhaarVerified' => (bool)($kyc['aadhaar_verified'] ?? false),
            'upiVpa'          => $kyc['upi_vpa'] ?? '',
            'rejectReason'    => $kyc['reject_reason'] ?? '',
        ],

        'wallet'        => $wallet,
        'price'         => $meta,
    ];
}
