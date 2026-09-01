<?php
/**
 * One-time installer.
 *
 * Git deployment copies files; it cannot create a MySQL database, and a database
 * password must never live in a repository. So this page collects the three
 * values from the Hostinger control panel, writes them to `api/config.local.php`
 * (which git ignores), creates the schema, and makes the first operator account.
 *
 * It refuses to run once installation has completed. Delete it afterwards
 * anyway — an installer left reachable on a live site is an invitation.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');

const CONFIG_PATH = __DIR__ . '/api/config.local.php';
const SCHEMA_PATH = __DIR__ . '/api/_schema.php';

header('X-Robots-Tag: noindex, nofollow');
header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'");

/* ------------------------------------------------------------ already done -- */

$alreadyInstalled = false;
if (is_file(CONFIG_PATH)) {
    /** @noinspection PhpIncludeInspection */
    $existing = @include CONFIG_PATH;
    if (is_array($existing) && !empty($existing['installed'])) {
        $alreadyInstalled = true;
    }
}

/* ----------------------------------------------------------------- helpers -- */

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function post(string $k, string $default = ''): string
{
    return isset($_POST[$k]) && is_string($_POST[$k]) ? trim($_POST[$k]) : $default;
}

function requirements(): array
{
    $checks = [];

    $checks[] = [
        'label' => 'PHP 8.0 or newer',
        'ok'    => PHP_VERSION_ID >= 80000,
        'detail' => 'running ' . PHP_VERSION,
    ];
    $checks[] = [
        'label' => 'PDO MySQL driver',
        'ok'    => extension_loaded('pdo_mysql'),
        'detail' => extension_loaded('pdo_mysql') ? 'available' : 'missing — enable it in hPanel',
    ];
    $checks[] = [
        'label' => 'OpenSSL (for hashing and OTP secrets)',
        'ok'    => function_exists('random_bytes'),
        'detail' => function_exists('random_bytes') ? 'available' : 'missing',
    ];
    $checks[] = [
        'label' => 'cURL (for exchange price feed)',
        'ok'    => function_exists('curl_init'),
        'detail' => function_exists('curl_init') ? 'available' : 'missing — the price cron needs it',
    ];

    $apiDir = __DIR__ . '/api';
    $checks[] = [
        'label' => 'api/ directory writable',
        'ok'    => is_dir($apiDir) && is_writable($apiDir),
        'detail' => is_dir($apiDir)
            ? (is_writable($apiDir) ? 'writable' : 'not writable — set it to 755 in File Manager')
            : 'api/ folder is missing from the deployment',
    ];

    $uploads = __DIR__ . '/uploads';
    $uploadsOk = is_dir($uploads) ? is_writable($uploads) : @mkdir($uploads, 0755, true);
    $checks[] = [
        'label' => 'uploads/ directory (payment screenshots)',
        'ok'    => (bool)$uploadsOk,
        'detail' => $uploadsOk ? 'ready' : 'could not create — make an uploads/ folder, 755',
    ];

    $checks[] = [
        'label' => 'Schema file present',
        'ok'    => is_file(SCHEMA_PATH),
        'detail' => is_file(SCHEMA_PATH) ? 'found' : 'api/_schema.php missing',
    ];

    return $checks;
}

/* -------------------------------------------------------------------- run --- */

$errors  = [];
$notices = [];
$done    = false;
$step    = 'form';

if (!$alreadyInstalled && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {

    $dbHost = post('db_host', 'localhost');
    $dbName = post('db_name');
    $dbUser = post('db_user');
    $dbPass = $_POST['db_pass'] ?? '';
    $dbPort = (int)(post('db_port', '3306') ?: 3306);

    $adminEmail = strtolower(post('admin_email'));
    $adminName  = post('admin_name');
    $adminPass  = $_POST['admin_pass'] ?? '';
    $adminPass2 = $_POST['admin_pass2'] ?? '';

    $siteUrl   = rtrim(post('site_url'), '/');
    $mailFrom  = post('mail_from');
    $upiVpa    = post('upi_vpa');

    if ($dbName === '' || $dbUser === '') {
        $errors[] = 'Database name and user are required.';
    }
    if (!filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
        $errors[] = 'Enter a valid email for the operator account.';
    }
    if (strlen($adminPass) < 10) {
        $errors[] = 'The operator password must be at least 10 characters. This account can confirm deposits and approve withdrawals — treat it accordingly.';
    }
    if ($adminPass !== $adminPass2) {
        $errors[] = 'The two passwords do not match.';
    }
    if ($mailFrom !== '' && !filter_var($mailFrom, FILTER_VALIDATE_EMAIL)) {
        $errors[] = 'The "from" address is not a valid email.';
    }

    $pdo = null;
    if (!$errors) {
        try {
            $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $dbHost, $dbPort, $dbName);
            $pdo = new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (Throwable $e) {
            // The driver's message names the actual cause — wrong password,
            // unknown database, host refusing — and hiding it just makes this
            // step guesswork.
            $errors[] = 'Could not connect: ' . $e->getMessage();
        }
    }

    if (!$errors && $pdo instanceof PDO) {
        try {
            require SCHEMA_PATH;

            foreach (arv_schema() as $sql) {
                $pdo->exec($sql);
            }

            // Triggers are what make the ledger append-only in the database
            // rather than only in application code. Some shared hosts withhold
            // TRIGGER privilege, so a failure here is reported, not fatal.
            $triggerWarning = null;
            try {
                foreach (arv_triggers() as $sql) {
                    $pdo->exec($sql);
                }
            } catch (Throwable $e) {
                $triggerWarning = $e->getMessage();
            }

            // Settings, without overwriting anything already tuned.
            $ins = $pdo->prepare(
                'INSERT INTO settings (skey, svalue) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE skey = skey'
            );
            foreach (arv_default_settings() as $k => $v) {
                $ins->execute([$k, (string)$v]);
            }
            if ($upiVpa !== '') {
                $pdo->prepare('UPDATE settings SET svalue = ? WHERE skey = ?')
                    ->execute([$upiVpa, 'upi_vpa']);
            }

            // The operator account. Also the referral root.
            $pdo->beginTransaction();

            $existing = $pdo->prepare('SELECT id FROM users WHERE email = ?');
            $existing->execute([$adminEmail]);
            $userId = $existing->fetchColumn();

            if ($userId) {
                $pdo->prepare(
                    'UPDATE users SET is_admin = 1, pass_hash = ?, full_name = ?, email_verified = 1 WHERE id = ?'
                )->execute([password_hash($adminPass, PASSWORD_DEFAULT), $adminName, $userId]);
                $notices[] = 'An account with that email already existed — it has been promoted to operator and its password reset.';
            } else {
                $code = strtoupper(substr(bin2hex(random_bytes(8)), 0, 8));
                $pdo->prepare(
                    'INSERT INTO users (email, pass_hash, full_name, email_verified, referral_code, is_admin)
                     VALUES (?, ?, ?, 1, ?, 1)'
                )->execute([$adminEmail, password_hash($adminPass, PASSWORD_DEFAULT), $adminName, $code]);
                $userId = (int)$pdo->lastInsertId();
            }

            $pdo->prepare('INSERT INTO wallets (user_id) VALUES (?)
                           ON DUPLICATE KEY UPDATE user_id = user_id')->execute([$userId]);
            $pdo->prepare('INSERT INTO kyc (user_id, status) VALUES (?, "none")
                           ON DUPLICATE KEY UPDATE user_id = user_id')->execute([$userId]);

            $pdo->commit();

            // Only now write the config, so a failed install leaves nothing that
            // would make the installer refuse to run again.
            $appKey = bin2hex(random_bytes(32));

            $config = "<?php\n"
                . "/**\n"
                . " * Local configuration — written by install.php.\n"
                . " *\n"
                . " * NOT in version control. If this file is lost, the site cannot reach its\n"
                . " * database; re-run install.php with the same credentials to recreate it.\n"
                . " *\n"
                . " * app_key signs sessions and hashes OTPs. Changing it invalidates every\n"
                . " * active session and every unused OTP.\n"
                . " */\n"
                . "return " . var_export([
                    'installed'   => true,
                    'installed_at'=> gmdate('c'),
                    'db' => [
                        'host' => $dbHost,
                        'port' => $dbPort,
                        'name' => $dbName,
                        'user' => $dbUser,
                        'pass' => $dbPass,
                    ],
                    'app_key'   => $appKey,
                    'site_url'  => $siteUrl !== '' ? $siteUrl : null,
                    'mail' => [
                        'from'      => $mailFrom !== '' ? $mailFrom : ('no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost')),
                        'from_name' => 'ARV Coin',
                    ],
                    'debug' => false,
                ], true) . ";\n";

            if (@file_put_contents(CONFIG_PATH, $config, LOCK_EX) === false) {
                $errors[] = 'Everything else succeeded, but api/config.local.php could not be written. '
                          . 'Set the api/ folder to 755 in File Manager and submit again.';
            } else {
                @chmod(CONFIG_PATH, 0640);
                $done = true;
                $step = 'done';
                if ($triggerWarning) {
                    $notices[] = 'Tables created, but the append-only triggers on the ledger could not be '
                               . 'installed: ' . $triggerWarning . ' — the application still never edits the '
                               . 'ledger, but the database will not stop someone doing it by hand in phpMyAdmin.';
                }
            }
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $errors[] = 'Setup failed: ' . $e->getMessage();
        }
    }
}

$checks = requirements();
$allOk  = array_reduce($checks, static fn($c, $x) => $c && $x['ok'], true);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>ARV Coin — setup</title>
<style>
  :root{
    --bg:#08080a; --bg2:#0e0e11; --bg3:#16161b; --bg4:#1e1e25;
    --tx:#f2f3f6; --tx2:#a8adba; --tx3:#6d7280;
    --silver:#d6d9e0; --line:rgba(255,255,255,.09);
    --ok:#4ec98f; --bad:#e8636e; --warn:#e2b04a;
    --mono:'SF Mono',ui-monospace,Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0;padding:48px 20px;background:var(--bg);color:var(--tx);
    font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background-image:radial-gradient(ellipse 70% 50% at 50% -10%,rgba(214,217,224,.07),transparent 70%);
  }
  .wrap{max-width:660px;margin:0 auto}
  h1{
    font-size:1.9rem;margin:0 0 6px;letter-spacing:-.03em;font-weight:600;
    background:linear-gradient(135deg,#fff,#b9bdc8 60%,#8a8f9c);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  }
  .sub{color:var(--tx3);margin:0 0 32px;font-size:.92rem}
  .card{
    background:var(--bg2);border:1px solid var(--line);border-radius:14px;
    padding:26px;margin-bottom:18px;
  }
  h2{font-size:.95rem;margin:0 0 16px;letter-spacing:.02em;text-transform:uppercase;color:var(--tx2);font-weight:600}
  .chk{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.88rem}
  .chk:last-child{border-bottom:0}
  .chk .d{color:var(--tx3);font-family:var(--mono);font-size:.8rem;text-align:right}
  .y{color:var(--ok)} .n{color:var(--bad)}
  label{display:block;font-size:.82rem;font-weight:600;color:var(--tx2);margin:14px 0 6px}
  input{
    width:100%;padding:11px 13px;background:var(--bg);border:1px solid var(--line);
    border-radius:8px;color:var(--tx);font:inherit;
  }
  input:focus{outline:0;border-color:var(--silver);box-shadow:0 0 0 3px rgba(214,217,224,.1)}
  .hint{font-size:.76rem;color:var(--tx3);margin-top:5px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  button{
    width:100%;margin-top:26px;padding:14px;border:0;border-radius:9px;cursor:pointer;
    background:linear-gradient(135deg,#eceef2,#b9bdc8);color:#0a0a0c;
    font:600 1rem/1 inherit;letter-spacing:.01em;
  }
  button:disabled{opacity:.4;cursor:not-allowed}
  .msg{padding:13px 15px;border-radius:9px;margin-bottom:14px;font-size:.88rem;border-left:3px solid}
  .msg.bad{background:rgba(232,99,110,.1);border-color:var(--bad)}
  .msg.warn{background:rgba(226,176,74,.1);border-color:var(--warn)}
  .msg.ok{background:rgba(78,201,143,.1);border-color:var(--ok)}
  code{font-family:var(--mono);font-size:.85em;background:var(--bg3);padding:2px 6px;border-radius:4px}
  ol{padding-left:1.2rem;color:var(--tx2);font-size:.9rem}
  li{margin-bottom:9px}
  a{color:var(--silver)}
  .done{text-align:center;padding:12px 0 4px}
  .done .tick{font-size:2.4rem;color:var(--ok);line-height:1}
</style>
</head>
<body>
<div class="wrap">

  <h1>ARV Coin</h1>
  <p class="sub">One-time setup</p>

<?php if ($alreadyInstalled): ?>

  <div class="card">
    <div class="msg ok"><strong>Already installed.</strong></div>
    <p>This site is configured and running. The installer will not run again.</p>
    <p><strong>Delete <code>install.php</code> now.</strong> hPanel → File Manager → select it →
       Delete. An installer left reachable on a live site is a way in.</p>
    <p><a href="index.html">Open the site →</a> &nbsp;·&nbsp; <a href="admin.html">Operations →</a></p>
  </div>

<?php elseif ($done): ?>

  <div class="card">
    <div class="done"><div class="tick">✓</div></div>
    <div class="msg ok"><strong>Setup complete.</strong> Tables created, operator account ready.</div>

    <?php foreach ($notices as $n): ?>
      <div class="msg warn"><?= h($n) ?></div>
    <?php endforeach; ?>

    <h2>Three things left</h2>
    <ol>
      <li><strong>Delete <code>install.php</code></strong> — hPanel → File Manager → select → Delete.</li>
      <li><strong>Set up the price cron.</strong> hPanel → Advanced → Cron Jobs → every minute:
          <br><code>curl -s https://<?= h($_SERVER['HTTP_HOST'] ?? 'yourdomain.com') ?>/api/cron.php?job=all</code>
          <br><span class="hint">Nothing can be bought or sold until this runs — trading refuses to
          price from a stale feed, which is deliberate.</span></li>
      <li><strong>Backfill the chart.</strong> Sign in as the operator, open Operations, press
          “Backfill history”. Takes a couple of minutes.</li>
    </ol>

    <p style="margin-top:22px"><a href="login.html">Sign in as operator →</a></p>
  </div>

<?php else: ?>

  <?php foreach ($errors as $e): ?>
    <div class="msg bad"><?= h($e) ?></div>
  <?php endforeach; ?>
  <?php foreach ($notices as $n): ?>
    <div class="msg warn"><?= h($n) ?></div>
  <?php endforeach; ?>

  <div class="card">
    <h2>Server check</h2>
    <?php foreach ($checks as $c): ?>
      <div class="chk">
        <span><span class="<?= $c['ok'] ? 'y' : 'n' ?>"><?= $c['ok'] ? '✓' : '✕' ?></span>
              &nbsp;<?= h($c['label']) ?></span>
        <span class="d"><?= h($c['detail']) ?></span>
      </div>
    <?php endforeach; ?>
    <?php if (!$allOk): ?>
      <div class="msg bad" style="margin:16px 0 0">Fix the items marked ✕ before continuing.</div>
    <?php endif; ?>
  </div>

  <form method="post" autocomplete="off">
    <div class="card">
      <h2>Database</h2>
      <p class="hint" style="margin:-8px 0 6px">
        hPanel → Databases → MySQL Databases → create one, then copy the three values here.
        Hostinger prefixes the name and user, so paste them exactly as shown there.
      </p>

      <div class="row">
        <div>
          <label for="db_host">Host</label>
          <input id="db_host" name="db_host" value="<?= h(post('db_host', 'localhost')) ?>">
          <div class="hint">Usually <code>localhost</code></div>
        </div>
        <div>
          <label for="db_port">Port</label>
          <input id="db_port" name="db_port" value="<?= h(post('db_port', '3306')) ?>">
        </div>
      </div>

      <label for="db_name">Database name</label>
      <input id="db_name" name="db_name" required value="<?= h(post('db_name')) ?>"
             placeholder="u123456789_arvcoin">

      <label for="db_user">Database user</label>
      <input id="db_user" name="db_user" required value="<?= h(post('db_user')) ?>"
             placeholder="u123456789_arv">

      <label for="db_pass">Database password</label>
      <input id="db_pass" name="db_pass" type="password" required>
      <div class="hint">Stored only in <code>api/config.local.php</code> on this server. Never in git.</div>
    </div>

    <div class="card">
      <h2>Operator account</h2>
      <p class="hint" style="margin:-8px 0 6px">
        This account confirms deposits and approves withdrawals. It moves real money.
      </p>

      <label for="admin_name">Name</label>
      <input id="admin_name" name="admin_name" value="<?= h(post('admin_name')) ?>">

      <label for="admin_email">Email</label>
      <input id="admin_email" name="admin_email" type="email" required value="<?= h(post('admin_email')) ?>">

      <div class="row">
        <div>
          <label for="admin_pass">Password</label>
          <input id="admin_pass" name="admin_pass" type="password" required minlength="10">
        </div>
        <div>
          <label for="admin_pass2">Repeat</label>
          <input id="admin_pass2" name="admin_pass2" type="password" required minlength="10">
        </div>
      </div>
      <div class="hint">At least 10 characters.</div>
    </div>

    <div class="card">
      <h2>Site <span style="color:var(--tx3);font-weight:400;text-transform:none">— optional, changeable later</span></h2>

      <label for="site_url">Site URL</label>
      <input id="site_url" name="site_url"
             value="<?= h(post('site_url', (isset($_SERVER['HTTPS']) ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? ''))) ?>">
      <div class="hint">Used in OTP emails and referral links.</div>

      <label for="mail_from">“From” address for OTP emails</label>
      <input id="mail_from" name="mail_from" type="email"
             value="<?= h(post('mail_from')) ?>"
             placeholder="no-reply@<?= h($_SERVER['HTTP_HOST'] ?? 'yourdomain.com') ?>">
      <div class="hint">Create it in hPanel → Emails. An address on your own domain is far less
        likely to land in spam than a generic one.</div>

      <label for="upi_vpa">UPI ID for deposits</label>
      <input id="upi_vpa" name="upi_vpa" value="<?= h(post('upi_vpa')) ?>" placeholder="yourname@okhdfcbank">
      <div class="hint">Leave blank for now and the deposit QR shows a clearly-marked placeholder.</div>
    </div>

    <button type="submit" <?= $allOk ? '' : 'disabled' ?>>Install</button>
  </form>

<?php endif; ?>

</div>
</body>
</html>
