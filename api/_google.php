<?php
/**
 * Google ID token verification.
 *
 * The browser gets a signed JWT from Google and posts it here. This file decides
 * whether to believe it. Everything about "sign in with Google" reduces to that
 * one question, so it is worth being blunt about what happens if it is answered
 * carelessly: a token whose signature is not checked is a login form with the
 * password field removed. Anyone can mint `{"email":"<operator>","sub":"1"}`,
 * base64 it, and be the operator. So the signature is verified against Google's
 * published keys, locally, on every request, with no way to opt out.
 *
 * Which flow, and why this one
 * ----------------------------
 * Google Identity Services returns an ID token to JavaScript, which posts it to
 * this endpoint. The alternative — the authorization-code redirect — was rejected
 * for two concrete reasons:
 *
 *   1. It needs a client *secret*, which then has to live on the server and be
 *      kept out of the repository. The ID token flow needs only the client ID,
 *      which is public by design.
 *   2. Google redirects back with a POST, and this app's session cookie is
 *      SameSite=Lax, which is not sent on a cross-site POST. The session would be
 *      dropped precisely at the moment of signing in.
 *
 * Deliberately not using Google's tokeninfo endpoint. It would validate the token
 * for us, but it is a network round trip on the critical path of every sign-in,
 * it is rate limited, and Google's own guidance is to verify locally. A sign-in
 * that fails because a third-party HTTP call timed out is a worse failure than
 * the small amount of ASN.1 below.
 *
 * Naming note: the fetch helper here is `google_http_get`, not `http_get`.
 * `_feed.php` already defines `http_get` globally and is loaded by cron.php and
 * market.php; a second plain definition is a redeclaration fatal that returns an
 * empty response. That exact mistake has already taken this site's price feed
 * down once, and it is not worth repeating for the sake of a shorter name.
 */
declare(strict_types=1);

require_once __DIR__ . '/_boot.php';

const GOOGLE_JWKS_URL   = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS    = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_JWKS_TTL   = 21600;  // 6h. Google rotates roughly daily.
const GOOGLE_CLOCK_SKEW = 120;    // Tolerate a shared host with a drifting clock.


/**
 * Whether Google sign-in is configured at all.
 *
 * A missing client ID is not an error, it is a site that has not turned the
 * feature on. Everything downstream treats it as "the button does not exist"
 * rather than "the button is broken".
 */
function google_client_id(): string
{
    return trim((string)setting('google_client_id', ''));
}

function google_enabled(): bool
{
    return google_client_id() !== '';
}


/* ====================================================== base64url / ASN.1 === */

function google_b64url_decode(string $s): string
{
    $pad = strlen($s) % 4;
    $s = strtr($s, '-_', '+/') . ($pad ? str_repeat('=', 4 - $pad) : '');
    $out = base64_decode($s, true);
    return $out === false ? '' : $out;
}

/**
 * Build a PEM public key from a JWK's modulus and exponent.
 *
 * PHP can verify an RSA signature but cannot import a JWK, and there is no
 * extension on shared hosting that will do it either. So the key is assembled by
 * hand into the DER structure `openssl_pkey_get_public` expects:
 *
 *   SEQUENCE
 *     SEQUENCE
 *       OID  1.2.840.113549.1.1.1   (rsaEncryption)
 *       NULL
 *     BIT STRING
 *       SEQUENCE
 *         INTEGER  modulus
 *         INTEGER  exponent
 *
 * Small and fixed, but easy to get subtly wrong, so each piece is its own
 * function and the length encoding is written out rather than assumed short-form.
 */
function google_der_length(int $n): string
{
    if ($n < 0x80) {
        return chr($n);
    }
    $bytes = '';
    while ($n > 0) {
        $bytes = chr($n & 0xFF) . $bytes;
        $n >>= 8;
    }
    return chr(0x80 | strlen($bytes)) . $bytes;
}

function google_der_integer(string $raw): string
{
    $raw = ltrim($raw, "\x00");
    if ($raw === '') {
        $raw = "\x00";
    }
    // DER integers are signed. A leading bit of 1 would read as negative, so a
    // zero byte is prepended to keep the modulus positive.
    if (ord($raw[0]) & 0x80) {
        $raw = "\x00" . $raw;
    }
    return "\x02" . google_der_length(strlen($raw)) . $raw;
}

function google_der_sequence(string $body): string
{
    return "\x30" . google_der_length(strlen($body)) . $body;
}

function google_jwk_to_pem(array $jwk): ?string
{
    if (($jwk['kty'] ?? '') !== 'RSA' || empty($jwk['n']) || empty($jwk['e'])) {
        return null;
    }
    $n = google_b64url_decode((string)$jwk['n']);
    $e = google_b64url_decode((string)$jwk['e']);
    if ($n === '' || $e === '') {
        return null;
    }

    $rsaKey    = google_der_sequence(google_der_integer($n) . google_der_integer($e));
    $algorithm = google_der_sequence("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01" . "\x05\x00");
    $bitString = "\x03" . google_der_length(strlen($rsaKey) + 1) . "\x00" . $rsaKey;
    $spki      = google_der_sequence($algorithm . $bitString);

    return "-----BEGIN PUBLIC KEY-----\n"
         . chunk_split(base64_encode($spki), 64, "\n")
         . "-----END PUBLIC KEY-----\n";
}


/* ================================================================== JWKS === */

function google_http_get(string $url, int $timeout = 8): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,   // Google's key endpoint does not redirect.
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT      => 'ARV/3.0 (+auth)',
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ($body !== false && $code === 200) ? (string)$body : null;
    }

    // No cURL. Verification of the certificate is explicit here because the
    // default for this transport does not check it, and an unverified fetch of a
    // *signing key* would let whoever answers the connection choose the key that
    // validates their own forged token.
    $ctx = stream_context_create([
        'http' => ['timeout' => $timeout, 'header' => "Accept: application/json\r\n"],
        'ssl'  => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
}

/**
 * Google's signing keys, cached in the settings table.
 *
 * Cached because fetching them on every sign-in is a slow dependency on someone
 * else's uptime. Refetched on a cache miss for an unknown `kid`, because that is
 * what a key rotation looks like from here, and refusing to refetch would mean
 * every sign-in failing until the TTL expired.
 *
 * @param bool $force Bypass the cache (used once, on an unrecognised kid).
 * @return array<string,string> kid => PEM
 */
function google_signing_keys(bool $force = false): array
{
    static $memo = null;
    if ($memo !== null && !$force) {
        return $memo;
    }

    $raw = '';
    $age = time() - setting_i('google_jwks_at', 0);

    if (!$force && $age < GOOGLE_JWKS_TTL) {
        $raw = (string)setting('google_jwks', '');
    }

    if ($raw === '') {
        $fetched = google_http_get(GOOGLE_JWKS_URL);
        if ($fetched !== null && str_contains($fetched, '"keys"')) {
            $raw = $fetched;
            setting_set('google_jwks', $raw);
            setting_set('google_jwks_at', (string)time());
        } else {
            // Fetch failed. Fall back to whatever is cached even if stale — an
            // expired copy of a real key still verifies a real token, and Google
            // keeps old keys published well past rotation. Better a slightly old
            // key than a sign-in page that is down because a network call failed.
            $raw = (string)setting('google_jwks', '');
            if ($raw === '') {
                error_log('[arv] google: could not fetch signing keys and nothing is cached');
                return [];
            }
        }
    }

    $doc = json_decode($raw, true);
    if (!is_array($doc) || !is_array($doc['keys'] ?? null)) {
        return [];
    }

    $keys = [];
    foreach ($doc['keys'] as $jwk) {
        if (!is_array($jwk) || ($jwk['alg'] ?? 'RS256') !== 'RS256') {
            continue;
        }
        $pem = google_jwk_to_pem($jwk);
        if ($pem !== null && !empty($jwk['kid'])) {
            $keys[(string)$jwk['kid']] = $pem;
        }
    }

    $memo = $keys;
    return $keys;
}


/* ============================================================== verify ===== */

/**
 * Verify a Google ID token and return its claims.
 *
 * Returns null on *any* doubt. There is no partial success here and no
 * "probably fine" — the caller creates a logged-in session from the result.
 *
 * Every check below exists because skipping it is a known attack:
 *
 *   signature   Without it the token is attacker-authored. This is the whole game.
 *   alg         An `alg: none` token has a valid empty signature. Only RS256 is
 *               accepted, chosen by us and not read from the token's own header.
 *   aud         A token minted for *another* site's client ID is perfectly valid
 *               and signed by Google. Without this check, any developer with a
 *               Google client can hand us a token for their own app and log in
 *               as one of our users.
 *   iss         Same reasoning, one layer out.
 *   exp / iat   A leaked token should stop working. Google's are short-lived.
 *   nonce       Binds the token to the session that asked for it, so one captured
 *               from a network log or a compromised extension cannot be replayed
 *               from elsewhere.
 *   email_...   Google will assert an address it has not verified for some
 *               account types. Since this app links accounts by email address, an
 *               unverified one is an account takeover primitive.
 *
 * @param string      $jwt      The credential from Google Identity Services.
 * @param string      $nonce    The nonce this session issued. Required, and not
 *                              nullable on purpose: it was nullable once, meaning
 *                              "skip the check", and the effect was that a token
 *                              replayed in a session with no nonce sailed through
 *                              — which is the one thing a nonce is for. A caller
 *                              that has no nonce must refuse the request itself
 *                              rather than ask for a weaker verification.
 * @param string|null $failure  Set to a short reason, for the audit log.
 */
function google_verify_id_token(string $jwt, string $nonce, ?string &$failure = null): ?array
{
    $failure = null;
    $clientId = google_client_id();
    if ($clientId === '') {
        $failure = 'not_configured';
        return null;
    }

    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
        $failure = 'malformed';
        return null;
    }
    [$h64, $p64, $s64] = $parts;

    $header = json_decode(google_b64url_decode($h64), true);
    $claims = json_decode(google_b64url_decode($p64), true);
    $sig    = google_b64url_decode($s64);

    if (!is_array($header) || !is_array($claims) || $sig === '') {
        $failure = 'malformed';
        return null;
    }
    if (($header['alg'] ?? '') !== 'RS256') {
        $failure = 'alg';
        return null;
    }

    /* -- signature ------------------------------------------------------------ */

    $signingInput = $h64 . '.' . $p64;
    $kid  = (string)($header['kid'] ?? '');
    $keys = google_signing_keys();

    // An unknown kid is what a key rotation looks like. Refetch once.
    if ($kid !== '' && !isset($keys[$kid])) {
        $keys = google_signing_keys(true);
    }

    $verified = false;
    // Prefer the named key. Falling back to trying all of them is safe — a
    // signature either verifies against a genuine Google key or it does not, and
    // a token with a mismatched kid but a valid signature is still Google's.
    $candidates = isset($keys[$kid]) ? [$keys[$kid]] : array_values($keys);

    if (!$candidates) {
        $failure = 'no_keys';
        return null;
    }
    foreach ($candidates as $pem) {
        if (openssl_verify($signingInput, $sig, $pem, OPENSSL_ALGO_SHA256) === 1) {
            $verified = true;
            break;
        }
    }
    if (!$verified) {
        $failure = 'signature';
        return null;
    }

    /* -- claims --------------------------------------------------------------- */

    $now = time();

    if (!in_array((string)($claims['iss'] ?? ''), GOOGLE_ISSUERS, true)) {
        $failure = 'iss';
        return null;
    }
    // Constant-time, because this is a secret-ish comparison and there is no
    // reason for it not to be.
    if (!hash_equals($clientId, (string)($claims['aud'] ?? ''))) {
        $failure = 'aud';
        return null;
    }
    if ((int)($claims['exp'] ?? 0) < ($now - GOOGLE_CLOCK_SKEW)) {
        $failure = 'expired';
        return null;
    }
    if ((int)($claims['iat'] ?? 0) > ($now + GOOGLE_CLOCK_SKEW)) {
        $failure = 'future';
        return null;
    }
    if ($nonce === '' || !hash_equals($nonce, (string)($claims['nonce'] ?? ''))) {
        $failure = 'nonce';
        return null;
    }

    $email = strtolower(trim((string)($claims['email'] ?? '')));
    if ($email === '' || !is_email($email)) {
        $failure = 'email';
        return null;
    }
    // Google sends this as a real boolean or the string "true" depending on the
    // client. Anything else is treated as unverified.
    $ev = $claims['email_verified'] ?? false;
    if ($ev !== true && $ev !== 'true') {
        $failure = 'email_unverified';
        return null;
    }
    $sub = trim((string)($claims['sub'] ?? ''));
    if ($sub === '') {
        $failure = 'sub';
        return null;
    }

    return [
        'sub'      => $sub,
        'email'    => $email,
        'name'     => substr(trim((string)($claims['name'] ?? '')), 0, 120),
        'picture'  => (string)($claims['picture'] ?? ''),
        'hd'       => (string)($claims['hd'] ?? ''),
    ];
}


/**
 * A single-use nonce, held in the session.
 *
 * The browser passes it to Google, Google puts it inside the signed token, and
 * `google_verify_id_token` checks it came back. That is what stops a token
 * captured elsewhere from being posted here.
 */
function google_issue_nonce(): string
{
    session_start_hardened();
    $n = bin2hex(random_bytes(16));
    $_SESSION['gnonce']    = $n;
    $_SESSION['gnonce_at'] = time();
    return $n;
}

function google_take_nonce(): ?string
{
    session_start_hardened();
    $n  = $_SESSION['gnonce'] ?? null;
    $at = (int)($_SESSION['gnonce_at'] ?? 0);
    unset($_SESSION['gnonce'], $_SESSION['gnonce_at']);   // one use, always

    if (!is_string($n) || $n === '' || (time() - $at) > 900) {
        return null;
    }
    return $n;
}
