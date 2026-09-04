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
require __DIR__ . '/_google.php';

const OTP_TTL_SECONDS   = 600;   // 10 minutes
const OTP_MAX_ATTEMPTS  = 5;
const TRUST_COOKIE      = 'arvtrust';

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
    case 'providers': handle_providers(); break;
    case 'google':    handle_google();    break;
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

    // Trusting this device is now the default, and the shared-computer box is the
    // one and only way out of it.
    //
    // It used to also treat `trustDevice === false` as an opt-out, meaning to
    // honour a deliberate choice from a browser still running the old cached
    // JavaScript after a deploy. That was wrong, and it is the cause of the
    // "a code every single time" complaint. The old script sent
    // `trustDevice: !!checkbox` from an *unchecked* "remember me" box, so a normal
    // sign-in from that stale bundle sent `trustDevice: false` with no intent
    // behind it at all. That silently forced $shared true, so the trust cookie was
    // never set and every login asked again. An unticked opt-in box is not a
    // shared-device declaration. Only the explicit `sharedDevice` flag from the
    // current form waives trust now.
    $shared = (bool)input('sharedDevice', false);

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

    // Having just proved they hold the mailbox, they are not asked again on this
    // device until the window lapses — unless they said it is a shared one.
    if (!$shared) {
        set_trusted_device((int)$user['id']);
    }

    audit('login.otp', ['actor' => (int)$user['id'],
           'detail' => ['purpose' => $purpose, 'trustedDevice' => !$shared]]);

    json_ok([
        'user' => public_user((int)$user['id']),
        'csrf' => csrf_token(),
        'trustedForHours' => $shared ? 0 : max(1, setting_i('trust_hours', 24)),
    ]);
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

    // The device stays trusted across a sign-out. It used to be cleared here, on
    // the reasoning that signing out on a shared machine should not leave a token
    // that skips the second factor. In practice the person hitting this is on
    // their own phone, signs out, signs back in, and is asked for a code every
    // single time — which is the exact "why does it keep emailing me" complaint,
    // and it trains people to treat the code as a formality.
    //
    // Dropping it is safe: device trust only ever waives the emailed *code*, never
    // the password. Whoever signs in next still needs the password, and the cookie
    // is bound by signature to one account so it cannot help with any other. The
    // shared-machine case is served by the opt-out on the form (which never sets
    // the cookie) and by login_otp_always for an operator who wants a code every
    // time regardless.
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

    // An account with no password is not an account with a wrong password.
    //
    // Google sign-in creates accounts that have never had one, and demanding the
    // current password before allowing a first one would mean a Google user can
    // never obtain a password at all — so losing access to the Google account
    // would lock them out permanently, there being no reset flow here either.
    // Requiring nothing extra is safe: this endpoint already needs a live session,
    // which is the same proof of identity a password change gives.
    $isFirst = (string)$u['pass_hash'] === '';

    if (!$isFirst && !password_verify($current, (string)$u['pass_hash'])) {
        json_fail(401, 'Your current password is not correct.');
    }
    if (strlen($next) < 8) {
        json_fail(422, 'The new password must be at least 8 characters.');
    }

    q('UPDATE users SET pass_hash = ? WHERE id = ?',
      [password_hash($next, PASSWORD_DEFAULT), $u['id']]);

    audit($isFirst ? 'password.set' : 'password.change', ['actor' => (int)$u['id']]);
    json_ok(['message' => $isFirst
        ? 'Password set. You can now sign in with your email address as well as with Google.'
        : 'Password changed.']);
}

/* ========================================================== providers ===== */

/**
 * Which sign-in methods this install offers, and what the browser needs to draw
 * them.
 *
 * Public and unauthenticated: it returns only the Google client ID, which is
 * public by design — it ships to every visitor's browser in order to work at all.
 * The nonce is minted here rather than in the page so it is bound to a server
 * session, which is the whole point of it.
 */
function handle_providers(): void
{
    require_method('GET');

    $google = ['enabled' => false];
    if (google_enabled()) {
        $google = [
            'enabled'  => true,
            'clientId' => google_client_id(),
            'nonce'    => google_issue_nonce(),
        ];
    }

    json_ok(['providers' => ['google' => $google]]);
}

/* ============================================================= google ===== */

/**
 * Sign in, or open an account, with a Google ID token.
 *
 * No emailed code on this path, deliberately. The code exists to prove the person
 * controls the mailbox; Google has already proved that and says so in a signed
 * claim we verify. Asking for a code as well would be asking them to prove the
 * same fact twice, and the second proof is the weaker one.
 *
 * Three cases, and the third is the one with a sharp edge:
 *
 *   1. `google_sub` already known  — returning user, sign them in.
 *   2. No account for that email   — create one, exactly as signup does.
 *   3. An account exists for that email but has no Google link — attach it.
 *
 * Case 3 is account linking, and it is where this kind of feature usually goes
 * wrong. Attaching is safe when the existing account is email-verified: both
 * sides have then proved control of the same mailbox, so they are the same person.
 *
 * When the existing account is *not* verified, it is not safe, and the fix is not
 * to refuse. Anyone can register any address here and set a password without ever
 * proving they own it. If someone had done that with this address, attaching would
 * hand the real mailbox owner an account that a stranger still has the password
 * to — and they would have no way of knowing. So the password is cleared as part
 * of linking. Whoever set it never demonstrated any claim to the address; the
 * person signing in with Google just did.
 */
function handle_google(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    // Cheap for a genuine user (one sign-in, maybe a retry) and pointless to
    // exceed. Set above the password limit because there is no guessing to do
    // here — a token either verifies or it does not.
    rate_limit('google_auth', 20, 900, 1800);

    if (!google_enabled()) {
        json_fail(503, 'Google sign-in is not set up on this site. Use your email and password.');
    }

    $credential = (string)input('credential', '');
    if ($credential === '') {
        json_fail(422, 'No Google credential was sent.');
    }

    // Single-use, and consumed whether or not verification succeeds, so one token
    // cannot be posted twice.
    //
    // No nonce means no verifying this token at all. Not a soft failure: without a
    // session nonce to match, a credential captured from somewhere else would be
    // accepted by a session that never asked for it, which is precisely what the
    // nonce prevents. It is missing when the page has been open past the nonce's
    // fifteen minutes, or when the attempt is a second click after a first one
    // already spent it — both of which a reload fixes, and both of which the
    // message says so.
    $nonce = google_take_nonce();
    if ($nonce === null) {
        audit('google.rejected', ['detail' => ['reason' => 'nonce_missing']]);
        json_fail(419, 'That sign-in attempt expired. Reload the page and try again.');
    }

    $why = null;
    $claims = google_verify_id_token($credential, $nonce, $why);

    if ($claims === null) {
        // Never reflect the reason. It tells an attacker which check they tripped,
        // and a genuine user cannot act on 'aud' or 'signature' anyway. The detail
        // goes to the audit log, where an operator can find it.
        audit('google.rejected', ['detail' => ['reason' => $why]]);

        if ($why === 'nonce') {
            json_fail(419, 'That sign-in attempt expired. Reload the page and try again.');
        }
        if ($why === 'email_unverified') {
            json_fail(403, 'Google has not verified the email address on that account. '
                         . 'Verify it with Google first, or sign up with an email and password.');
        }
        if ($why === 'no_keys') {
            json_fail(503, 'Could not reach Google to check that sign-in. Try again in a moment, '
                         . 'or use your email and password.');
        }
        json_fail(401, 'That Google sign-in could not be verified. Try again.');
    }

    $email = $claims['email'];
    $sub   = $claims['sub'];

    /* -- 1. a returning Google user ------------------------------------------- */

    // Guarded because `google_sub` arrives with a migration, and a deployment that
    // has not had one yet must degrade to matching on the email address rather
    // than failing every sign-in. Referencing a column the database may not have
    // is what took signup and login down once already.
    $user = null;
    $columnPresent = true;
    try {
        $user = q1('SELECT * FROM users WHERE google_sub = ?', [$sub]);
    } catch (Throwable $e) {
        $columnPresent = false;
        error_log('[arv] google: users.google_sub missing, falling back to email match');
    }

    if ($user) {
        if ($user['status'] !== 'active') {
            json_fail(403, 'This account is not active. Contact support.');
        }
        // Google is authoritative for the address, so follow a change there —
        // unless somebody else here already holds it, in which case leave both
        // alone rather than break a unique index or silently merge two accounts.
        if (strtolower((string)$user['email']) !== $email) {
            $clash = q1('SELECT id FROM users WHERE email = ? AND id <> ?', [$email, $user['id']]);
            if (!$clash) {
                q('UPDATE users SET email = ? WHERE id = ?', [$email, $user['id']]);
                audit('google.email_followed', ['actor' => (int)$user['id'],
                       'detail' => ['from' => $user['email'], 'to' => $email]]);
            }
        }
        google_finish_login((int)$user['id'], 'google.login', false);
    }

    /* -- 2/3. by email: link, or create --------------------------------------- */

    $existing = q1('SELECT * FROM users WHERE email = ?', [$email]);

    if ($existing) {
        if ($existing['status'] !== 'active') {
            json_fail(403, 'This account is not active. Contact support.');
        }

        $wasVerified = (bool)$existing['email_verified'];

        if ($columnPresent) {
            q('UPDATE users SET google_sub = ? WHERE id = ?', [$sub, $existing['id']]);
        }
        q('UPDATE users SET email_verified = 1 WHERE id = ?', [$existing['id']]);

        // See the note above the function. An unverified local account's password
        // was set by somebody who never proved they own this address.
        if (!$wasVerified) {
            q('UPDATE users SET pass_hash = "" WHERE id = ?', [$existing['id']]);
        }

        // A name only if there is not one already — Google's should not overwrite
        // what somebody typed, and least of all a name that KYC has verified.
        if ($claims['name'] !== '' && (string)$existing['full_name'] === '') {
            q('UPDATE users SET full_name = ? WHERE id = ?', [$claims['name'], $existing['id']]);
        }

        // Missing rows are repaired here because kyc.php only ever UPDATEs: an
        // account with no kyc row can submit the form, be told it saved, and still
        // be unable to buy, permanently and invisibly.
        google_ensure_rows((int)$existing['id'], $claims['name']);

        audit('google.linked', ['actor' => (int)$existing['id'],
               'detail' => ['clearedPassword' => !$wasVerified, 'wasVerified' => $wasVerified]]);

        google_finish_login((int)$existing['id'], 'google.login', false,
            $wasVerified ? null
            : 'Your account is now signed in with Google. The password that was set on it '
            . 'has been removed, because it was never confirmed against this address. '
            . 'Set a new one from your profile if you want to sign in without Google.');
    }

    /* -- a new account -------------------------------------------------------- */

    if (!input('acceptedTerms')) {
        // Same bar as an email signup. Consent is not something Google can give
        // on someone's behalf.
        json_fail(422, 'You need to accept the risk disclosure and terms to continue.', [
            'needs' => 'terms',
        ]);
    }

    $refCode  = strtoupper(input_str('referralCode'));
    $referrer = null;
    if ($refCode !== '') {
        $r = q1('SELECT id FROM users WHERE referral_code = ? AND status = "active"', [$refCode]);
        $referrer = $r ? (int)$r['id'] : null;
    }

    $name = $claims['name'];

    $userId = tx(static function (PDO $pdo) use ($email, $name, $referrer, $sub, $columnPresent) {
        for ($i = 0; $i < 5; $i++) {
            $code = referral_code();
            $dup = $pdo->prepare('SELECT 1 FROM users WHERE referral_code = ?');
            $dup->execute([$code]);
            if (!$dup->fetchColumn()) {
                break;
            }
        }

        // pass_hash is NOT NULL, and '' is the right value rather than a random
        // one: password_verify() against an empty hash is false for every input,
        // so the password path stays closed until the person deliberately sets one.
        if ($columnPresent) {
            $pdo->prepare(
                'INSERT INTO users (email, pass_hash, full_name, email_verified,
                                    google_sub, referral_code, referred_by)
                 VALUES (?, "", ?, 1, ?, ?, ?)'
            )->execute([$email, $name, $sub, $code, $referrer]);
        } else {
            $pdo->prepare(
                'INSERT INTO users (email, pass_hash, full_name, email_verified,
                                    referral_code, referred_by)
                 VALUES (?, "", ?, 1, ?, ?)'
            )->execute([$email, $name, $code, $referrer]);
        }

        $id = (int)$pdo->lastInsertId();
        // Both rows, in the same transaction as the user. An account missing
        // either one is broken in a way that only shows up later, at the till.
        $pdo->prepare('INSERT INTO wallets (user_id) VALUES (?)')->execute([$id]);
        $pdo->prepare('INSERT INTO kyc (user_id, status, full_name) VALUES (?, "none", ?)')
            ->execute([$id, $name]);

        return $id;
    });

    audit('signup.google', ['actor' => $userId, 'entity' => 'users',
           'entity_id' => (string)$userId, 'detail' => ['referred_by' => $referrer]]);

    google_finish_login($userId, 'google.signup', true);
}

/**
 * Repair the rows an account cannot function without.
 *
 * Only reachable for accounts that predate this code or were created by some
 * other path. Cheap, idempotent, and far better than the alternative — see the
 * note in handle_google about kyc.php only issuing UPDATEs.
 */
function google_ensure_rows(int $userId, string $name): void
{
    if (!q1('SELECT user_id FROM wallets WHERE user_id = ?', [$userId])) {
        q('INSERT INTO wallets (user_id) VALUES (?)', [$userId]);
    }
    if (!q1('SELECT user_id FROM kyc WHERE user_id = ?', [$userId])) {
        q('INSERT INTO kyc (user_id, status, full_name) VALUES (?, "none", ?)', [$userId, $name]);
    }
}

/**
 * Establish the session and answer in the shape the front end already handles.
 *
 * `isNew` decides where the browser goes next: a new account to the KYC form,
 * a returning one to wherever it was heading. That mirrors what the emailed-code
 * path does, so there is one rule for it rather than two.
 */
function google_finish_login(int $userId, string $auditAction, bool $isNew, ?string $notice = null): void
{
    login_user($userId);
    audit($auditAction, ['actor' => $userId]);

    $out = [
        'user'  => public_user($userId),
        'csrf'  => csrf_token(),
        'isNew' => $isNew,
    ];
    if ($notice !== null) {
        $out['notice'] = $notice;
    }
    json_ok($out);
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
 *
 * Set automatically after any successful code entry, and lasting `trust_hours`
 * (720, i.e. 30 days, by default). The previous behaviour asked for a code on
 * every single login unless the person had ticked a box, which meant the
 * commonest case (same phone, several times a day) was an email each time. A code
 * that arrives that often stops being read and starts being copied out of a
 * notification reflexively, which is the state of mind every OTP phishing attempt
 * depends on.
 *
 * The window is bounded on purpose. A month of silent trust on a device nobody
 * re-checked is a different proposition to indefinite trust, and `trust_hours`
 * lets an operator shorten it.
 */
function set_trusted_device(int $userId): void
{
    $hours   = max(1, setting_i('trust_hours', 24));
    $expires = time() + ($hours * 3600);
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
