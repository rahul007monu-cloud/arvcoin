<?php
/**
 * Shared bootstrap for every API endpoint.
 *
 * Database, session, CSRF, rate limiting, JSON responses, and the helpers that
 * decide money. Include this first and nothing else needs to think about setup.
 *
 * The rule that shapes this file: the browser is never trusted with anything
 * that decides value. Fees, tax rates, the ARV price and every balance come from
 * the database inside a transaction. The front-end config is a convenience copy
 * for quoting, and the server recomputes before it commits.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

date_default_timezone_set('UTC');

const ARV_CONFIG_FILE = __DIR__ . '/config.local.php';

/* =========================================================== config ======== */

function cfg(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    if (!is_file(ARV_CONFIG_FILE)) {
        json_fail(503, 'Not installed. Open /install.php to set this site up.');
    }
    /** @noinspection PhpIncludeInspection */
    $config = require ARV_CONFIG_FILE;
    if (!is_array($config) || empty($config['installed'])) {
        json_fail(503, 'Installation is incomplete. Re-run /install.php.');
    }
    return $config;
}

/* =============================================================== db ======== */

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $c = cfg()['db'];
    try {
        $pdo = new PDO(
            sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                    $c['host'], (int)$c['port'], $c['name']),
            $c['user'], $c['pass'],
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                // Real prepared statements, not client-side interpolation. This
                // is the difference between a placeholder that cannot be escaped
                // out of and one that can.
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::ATTR_STRINGIFY_FETCHES  => false,
            ]
        );
    } catch (Throwable $e) {
        error_log('[arv] db connect failed: ' . $e->getMessage());
        json_fail(503, 'The database is unreachable. Try again in a moment.');
    }
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function q1(string $sql, array $params = []): ?array
{
    $row = q($sql, $params)->fetch();
    return $row === false ? null : $row;
}

function qval(string $sql, array $params = [])
{
    $v = q($sql, $params)->fetchColumn();
    return $v === false ? null : $v;
}

/**
 * Run a closure inside a transaction, retrying once on deadlock.
 *
 * The matching engine locks rows in a fixed order to avoid deadlocks, but two
 * concurrent fills touching the same wallets can still collide. InnoDB resolves
 * that by killing one — which is correct, and means the caller should simply try
 * again rather than surfacing an error to somebody's trade.
 */
function tx(callable $fn)
{
    $pdo = db();
    for ($attempt = 1; $attempt <= 2; $attempt++) {
        try {
            $pdo->beginTransaction();
            $result = $fn($pdo);
            $pdo->commit();
            return $result;
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $deadlock = str_contains($e->getMessage(), 'Deadlock')
                     || str_contains($e->getMessage(), 'Lock wait timeout');
            if ($deadlock && $attempt === 1) {
                usleep(random_int(40000, 160000));
                continue;
            }
            throw $e;
        }
    }
    throw new RuntimeException('Transaction failed after retry');
}

/* ========================================================= settings ======== */

/**
 * Server-side settings. These decide money; arv-config.js does not.
 */
function settings(bool $reload = false): array
{
    static $s = null;
    if ($s !== null && !$reload) {
        return $s;
    }
    $s = [];
    foreach (q('SELECT skey, svalue FROM settings')->fetchAll() as $row) {
        $s[$row['skey']] = $row['svalue'];
    }
    return $s;
}

function setting(string $key, $default = null)
{
    $s = settings();
    return array_key_exists($key, $s) ? $s[$key] : $default;
}

function setting_f(string $key, float $default = 0.0): float
{
    $v = setting($key);
    return $v === null || $v === '' ? $default : (float)$v;
}

function setting_i(string $key, int $default = 0): int
{
    $v = setting($key);
    return $v === null || $v === '' ? $default : (int)$v;
}

function setting_b(string $key, bool $default = false): bool
{
    $v = setting($key);
    return $v === null || $v === '' ? $default : ($v === '1' || $v === 'true');
}

function setting_set(string $key, string $value): void
{
    q('INSERT INTO settings (skey, svalue) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)', [$key, $value]);

    // Drop the memoised copy, or the rest of this request keeps reading the old
    // value. That is not theoretical: saving a setting returns the operator
    // warnings alongside it, so setting `upi_vpa` used to answer "saved" and
    // "UPI VPA is not set" in the same response — which reads as a failed save.
    // One extra SELECT of a forty-row table, only on a write, is a fair price for
    // a settings write that is actually visible to the code that follows it.
    settings(true);
}

/* ========================================================= responses ====== */

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function json_ok($data = []): void
{
    json_out(is_array($data) ? (['ok' => true] + $data) : ['ok' => true, 'data' => $data]);
}

function json_fail(int $status, string $message, array $extra = []): void
{
    // 5xx is our fault and worth a log line; 4xx is the caller's and is not.
    if ($status >= 500) {
        error_log('[arv] ' . $status . ' ' . $message);
    }
    json_out(['ok' => false, 'error' => $message] + $extra, $status);
}

/** Read and validate the JSON request body. */
function body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') {
        $body = $_POST ?: [];
        return $body;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        json_fail(400, 'Request body must be a JSON object.');
    }
    $body = $decoded;
    return $body;
}

function input(string $key, $default = null)
{
    $b = body();
    return array_key_exists($key, $b) ? $b[$key] : $default;
}

function input_str(string $key, string $default = ''): string
{
    $v = input($key, $default);
    return is_string($v) ? trim($v) : $default;
}

function input_int(string $key, int $default = 0): int
{
    $v = input($key, $default);
    return is_numeric($v) ? (int)$v : $default;
}

function input_dec(string $key, string $default = '0'): string
{
    $v = input($key, $default);
    if (!is_numeric($v)) {
        return $default;
    }
    // Kept as a string so it can go into DECIMAL columns without a float ever
    // touching it.
    return number_format((float)$v, 8, '.', '');
}

function require_method(string ...$methods): void
{
    $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($m === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if (!in_array($m, $methods, true)) {
        json_fail(405, 'Method not allowed. Use ' . implode(' or ', $methods) . '.');
    }
}

/* ========================================================== session ======= */

function session_start_hardened(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';

    session_name('arvsid');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $https,
        'httponly' => true,
        // Lax rather than Strict: the referral link and the OTP email both bring
        // people in from another origin, and Strict would drop the session on
        // that first navigation.
        'samesite' => 'Lax',
    ]);
    session_start();

    // Rotate periodically so a leaked identifier has a short useful life.
    if (!isset($_SESSION['born'])) {
        $_SESSION['born'] = time();
    } elseif (time() - $_SESSION['born'] > 1800) {
        session_regenerate_id(true);
        $_SESSION['born'] = time();
    }
}

function current_user(): ?array
{
    session_start_hardened();
    $id = $_SESSION['uid'] ?? null;
    if (!$id) {
        return null;
    }
    static $user = null;
    if ($user !== null && (int)$user['id'] === (int)$id) {
        return $user;
    }
    $user = q1('SELECT * FROM users WHERE id = ? AND status = "active"', [$id]);
    if (!$user) {
        // Suspended or deleted mid-session.
        unset($_SESSION['uid']);
        return null;
    }
    return $user;
}

function require_user(): array
{
    $u = current_user();
    if (!$u) {
        json_fail(401, 'Sign in to continue.');
    }
    if (!$u['email_verified']) {
        json_fail(403, 'Verify your email address first.', ['needs' => 'email_verification']);
    }
    return $u;
}

function require_admin(): array
{
    $u = require_user();
    if (empty($u['is_admin'])) {
        json_fail(403, 'This action is restricted to operator accounts.');
    }
    return $u;
}

function login_user(int $userId): void
{
    session_start_hardened();
    session_regenerate_id(true);
    $_SESSION['uid']  = $userId;
    $_SESSION['born'] = time();
    q('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [$userId]);
}

function logout_user(): void
{
    session_start_hardened();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

/* ============================================================= CSRF ======= */

/**
 * Double-submit token.
 *
 * Cookies are SameSite=Lax, which already blocks the cross-site POST that CSRF
 * needs. This is the second lock: the token lives in the session and must be
 * echoed in a header that a cross-origin form cannot set.
 */
function csrf_token(): string
{
    session_start_hardened();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function require_csrf(): void
{
    session_start_hardened();
    $sent = $_SERVER['HTTP_X_ARV_CSRF'] ?? ($_POST['_csrf'] ?? '');
    $held = $_SESSION['csrf'] ?? '';
    if ($held === '' || !is_string($sent) || !hash_equals($held, $sent)) {
        json_fail(419, 'Your session expired. Reload the page and try again.');
    }
}

/* ===================================================== rate limiting ====== */

/**
 * Fixed-window limiter, kept in the database.
 *
 * Shared hosting gives no shared memory cache, so this is the only place a limit
 * can live and still hold across requests. Login, OTP send and order placement
 * all need one — an unthrottled OTP endpoint is a way to send mail from someone
 * else's domain, and an unthrottled login is a password guesser.
 */
function rate_limit(string $bucket, int $max, int $windowSeconds, int $blockSeconds = 0): void
{
    $key = substr($bucket . '|' . client_ip(), 0, 120);
    $now = time();

    $row = q1('SELECT hits, UNIX_TIMESTAMP(window_start) AS ws,
                      UNIX_TIMESTAMP(blocked_until) AS bu
               FROM rate_limits WHERE bucket = ?', [$key]);

    if ($row && $row['bu'] !== null && (int)$row['bu'] > $now) {
        $wait = (int)$row['bu'] - $now;
        json_fail(429, 'Too many attempts. Try again in ' . max(1, (int)ceil($wait / 60)) . ' minute(s).');
    }

    if (!$row || ($now - (int)$row['ws']) > $windowSeconds) {
        q('INSERT INTO rate_limits (bucket, hits, window_start, blocked_until)
           VALUES (?, 1, FROM_UNIXTIME(?), NULL)
           ON DUPLICATE KEY UPDATE hits = 1, window_start = FROM_UNIXTIME(?), blocked_until = NULL',
          [$key, $now, $now]);
        return;
    }

    $hits = (int)$row['hits'] + 1;
    if ($hits > $max) {
        $until = $blockSeconds > 0 ? $now + $blockSeconds : $now + $windowSeconds;
        q('UPDATE rate_limits SET hits = ?, blocked_until = FROM_UNIXTIME(?) WHERE bucket = ?',
          [$hits, $until, $key]);
        json_fail(429, 'Too many attempts. Try again in ' . max(1, (int)ceil(($until - $now) / 60)) . ' minute(s).');
    }

    q('UPDATE rate_limits SET hits = ? WHERE bucket = ?', [$hits, $key]);
}

function client_ip(): string
{
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $h) {
        if (!empty($_SERVER[$h])) {
            $ip = trim(explode(',', $_SERVER[$h])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
    }
    return '0.0.0.0';
}

/* ============================================================ audit ======= */

function audit(string $action, array $opts = []): void
{
    try {
        $u = $_SESSION['uid'] ?? null;
        q('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)', [
            $opts['actor'] ?? $u,
            $action,
            $opts['entity'] ?? '',
            (string)($opts['entity_id'] ?? ''),
            isset($opts['detail']) ? json_encode($opts['detail'], JSON_UNESCAPED_UNICODE) : null,
            client_ip(),
            substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255),
        ]);
    } catch (Throwable $e) {
        // An audit write must never take down the action it is recording.
        error_log('[arv] audit failed: ' . $e->getMessage());
    }
}

/* ============================================================= misc ======= */

function ref(string $prefix): string
{
    return strtoupper($prefix) . '-' . strtoupper(
        base_convert((string)time(), 10, 36) . bin2hex(random_bytes(3))
    );
}

/** Indian financial year label for a timestamp — '2025-26'. April to March. */
function fy_of(?int $ts = null): string
{
    $ts = $ts ?? time();
    $y = (int)gmdate('Y', $ts);
    $m = (int)gmdate('n', $ts);
    $start = $m >= 4 ? $y : $y - 1;
    return $start . '-' . substr((string)(($start + 1) % 100), -2);
}

function now_sql(): string
{
    return gmdate('Y-m-d H:i:s');
}

function is_email(string $s): bool
{
    return (bool)filter_var($s, FILTER_VALIDATE_EMAIL);
}

/** Apply a percentage to a paise amount, returning integer paise. */
function pct_of(int $paise, float $pct): int
{
    return (int)round($paise * ($pct / 100));
}

/** Round to the canonical 8 decimal places, as a string for DECIMAL columns. */
function units8($n): string
{
    return number_format((float)$n, 8, '.', '');
}

function maintenance_guard(): void
{
    if (setting_b('maintenance_mode')) {
        $u = current_user();
        if (!$u || empty($u['is_admin'])) {
            json_fail(503, 'The platform is briefly in maintenance. Balances are unaffected.');
        }
    }
}

/* ============================================================= mail ======= */

/**
 * Send an OTP or notification.
 *
 * Uses PHP mail(), which on Hostinger hands off to the local MTA and delivers as
 * the domain — far better for the spam folder than a third-party sender that
 * has not been authorised in the domain's SPF record.
 *
 * Returns false rather than throwing: a failure to send must be reported to the
 * caller so it can say "we could not email you", not crash the request.
 */
function send_mail(string $to, string $subject, string $bodyText): bool
{
    $c = cfg();
    $from     = $c['mail']['from'] ?? ('no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $fromName = $c['mail']['from_name'] ?? 'ARV Coin';

    $headers = [
        'From'         => sprintf('%s <%s>', $fromName, $from),
        'Reply-To'     => $from,
        'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=utf-8',
        'X-Mailer'     => 'ARV',
    ];
    $h = '';
    foreach ($headers as $k => $v) {
        $h .= $k . ': ' . $v . "\r\n";
    }

    // Header injection guard: a newline in a subject line becomes a new header.
    $subject = str_replace(["\r", "\n"], ' ', $subject);

    $sent = @mail($to, $subject, $bodyText, $h, '-f' . $from);
    if (!$sent) {
        error_log('[arv] mail() failed for ' . $to);
    }
    return (bool)$sent;
}

/* ================================================== global error trap ===== */

set_exception_handler(static function (Throwable $e): void {
    error_log('[arv] uncaught: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    $debug = (bool)(cfg()['debug'] ?? false);
    json_fail(500, $debug
        ? ($e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine())
        : 'Something went wrong on our side. Nothing was charged.');
});

set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    if (!(error_reporting() & $no)) {
        return false;
    }
    throw new ErrorException($str, 0, $no, $file, $line);
});
