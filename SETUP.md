# Setup

PHP 8 and MySQL. Nothing to build, nothing to compile, no node_modules on the
server — the files in this repo are the deployment.

Two ways to run it: on a Hostinger plan (or any cPanel-style host), or locally
against a MySQL you already have.

---

## 1. On Hostinger — about fifteen minutes

### 1.1 Create the database

hPanel → **Databases → MySQL Databases**. Create a database and a user, and give
the user all privileges on it. Note down four things:

- database name (Hostinger prefixes it, e.g. `u123456789_arv`)
- username (also prefixed)
- password
- host — `localhost` on shared plans

### 1.2 Get the files onto the server

If the domain is already connected to this repo through hPanel →
**Advanced → Git**, merging into `main` deploys it. Otherwise upload the contents
of the repo into `public_html`.

Either way, `public_html` should contain `index.html`, `install.php`, `api/`,
`css/`, `js/`, `icons/`, `manifest.json`, `sw.js` and `.htaccess` at the top level.

### 1.3 Run the installer

Open `https://yourdomain.com/install.php`.

It checks the server first — PHP version, `pdo_mysql`, `curl`, whether `api/` and
`uploads/` are writable — and refuses to go on if something is missing, saying
which. Then it asks for:

| Field | Notes |
|---|---|
| Database host / port / name / user / password | from step 1.1 |
| Operator name, email, password | this becomes the admin account; minimum 10 characters |
| Site URL | used in emails and referral links; changeable later |
| From address for mail | OTPs are sent from here |
| UPI VPA | where deposits are paid; leave blank and the QR shows a clearly-marked placeholder |

Pressing install creates 18 tables, 8 append-only triggers and the default
settings, then writes `api/config.local.php` containing the database password and
a freshly generated app key.

**Then it deletes itself.** It already refuses to run twice once the tables exist,
but an installer left on a live host is a standing invitation and removing it is the
step people forget. If the unlink fails — usually file permissions — the success page
says so and asks you to delete it by hand; it does not pretend.

> **`api/config.local.php` must never be committed.** It is in `.gitignore`
> already. The app key signs sessions and hashes OTPs, so a leaked one is a way
> into every account — if it ever reaches the repo, rotate both the key and the
> database password.

### 1.4 Add the cron job

hPanel → **Advanced → Cron Jobs**. Every minute:

```
curl -s https://yourdomain.com/api/cron.php?job=all
```

This ingests the price, appends candles, builds the chart on its first few runs,
matches resting orders, expires stale ones and recalculates reward tiers.

**The site works before you do this**, because a page load that finds the price
behind refreshes it itself. But that only happens while somebody is looking, so an
idle site has an idle chart and a resting sell order waits for a visitor rather than
for the clock. Add the cron.

If your plan's minimum interval is five minutes, raise `price_max_age_seconds` in
Operations → Settings to match, or the price will read as stale between runs and
trading will keep pausing.

To turn the fallback off once the scheduler is known good — so no visitor ever pays
for a price fetch — set `web_tick` to `0` in Operations → Settings.

### 1.5 The chart builds itself

Nothing to do. The cron notices an empty chart and fills it, one timeframe per run:
daily since launch, then hourly, then minute — roughly 1,827 / 2,160 / 10,080
candles, complete about three minutes after the scheduler starts.

One timeframe per run rather than all three, because all three take about
thirty-five seconds and a scheduled job should finish inside its own minute. Progress
is kept in `auto_backfill_next`, which walks `1D → 1h → 1m → done`.

If an exchange refuses to page history it retries on the next run, and after twenty
refusals it stops and records `stalled` rather than hammering a free endpoint all
day. **Operations → Backfill history** is still there to run it by hand.

### 1.6 Set the UPI VPA

Only if you left it blank in the installer. Operations → **Settings** → `upi_vpa`.
Until it is set the deposit page shows a placeholder saying so, rather than a QR
code that scans to nothing.

### 1.7 Check it

- `https://yourdomain.com/api/market.php?action=snapshot` returns a price with
  `stale: false`
- Operations → **Reconcile** reports the ledger and the wallets agreeing exactly
- Sign up as a normal user, deposit ₹100, confirm it as the operator, buy, sell

---

## 2. Locally

Needs PHP 8 with `pdo_mysql`, and a MySQL or MariaDB you can create a database in.

```bash
mysql -u root -e "CREATE DATABASE arv CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
php -S localhost:8080
```

Open `http://localhost:8080/install.php` and fill in the same form, with
`localhost` as the host and your local credentials.

There is nothing else to run. Loading any page refreshes the price when it has gone
behind, and the chart builds itself. To force it along:

```bash
curl -s "http://localhost:8080/api/cron.php?job=all"
```

Four of those calls take an install from empty to a full five-year chart.

`php -S` is single-threaded, so a request that fires several API calls will feel
slower than the real thing. Use `php -S localhost:8080 -t . &` plus a second
worker, or just accept it — it is a development server.

### Mail locally

Without a working `mail()`, OTPs cannot be delivered. `send_mail()` logs the whole
message when delivery fails, so the code is in your PHP error log:

```bash
tail -f /path/to/php-error.log | grep -i otp
```

That is a development convenience and nothing more — on the server, mail must
actually work, because the OTP is the only thing standing between an email address
and an account.

---

## 3. Settings worth knowing

All of these live in the `settings` table and are editable in Operations →
Settings. No deploy needed.

| Key | Default | What it does |
|---|---|---|
| `price_max_age_seconds` | 600 | Refuse to trade on a feed older than this |
| `entry_fee_pct` / `exit_fee_pct` | 0.5 / 0.5 | Platform fee |
| `gst_pct` | 18 | GST on the fee, not on the trade |
| `slippage_pct` | 0.05 | Spread applied to the execution price |
| `sell_fallback_minutes` | 60 | When the treasury takes an unmatched sell |
| `order_expiry_hours` | 168 | Resting orders expire after a week |
| `min_order_paise` | 10000 | ₹100 |
| `deposit_max_minutes` | 15 | The window quoted to the user |
| `withdraw_max_minutes` | 60 | Same, for withdrawals |
| `referral_pct` | 5 | Commission on a referee's first deposit |
| `kyc_required` | 1 | Verification before the first buy |
| `maintenance_mode` | 0 | Everyone but operators sees a notice |
| `tds_pct` / `tds_pct_no_pan` | 1 / 20 | s.194S and s.206AA |
| `web_tick` | 1 | Let a page load refresh a stale price. Set to 0 once the cron is trusted |
| `web_tick_min_seconds` | 45 | Floor between fallback fetches, so a dead feed cannot be retried on every request |
| `auto_backfill` | 1 | Let the cron build an empty chart |
| `auto_backfill_next` | 1D | Progress: `1D → 1h → 1m → done`. Set back to `1D` to rebuild |

The launch reference — `launch_at`, `base_btc_usd`, `base_fx_usd_inr` — is also in
`settings`, but **changing it after anyone has traded rewrites the entire price
history**, and every holder's chart with it. It is set once, at install.

---

## 4. Regenerating the icons

Only needed after editing `favicon.svg`. The PNGs are committed, so a deploy needs
no build step.

```bash
npm i -D playwright && npx playwright install chromium
node tools/build-icons.mjs
```

---

## 5. Going live properly

- **HTTPS.** hPanel → SSL, then force it. `.htaccess` already redirects, but the
  certificate has to exist first. A session cookie over plain HTTP is a session
  anyone on the network can take.
- **Back up the database.** hPanel → Backups, and take one manually before any
  schema change. The ledger is the record; losing it loses everything.
- **Watch the cron.** `cron_runs` records every execution with its status. If
  ingest starts failing, trading pauses — you want to know before a user tells you.
- **Reconcile regularly.** Operations → Reconcile compares the ledger against every
  wallet. It should always be exact. If it is not, do not adjust a wallet — find
  the missing entry.
- **Mail deliverability.** Set SPF and DKIM for the domain, or OTP emails land in
  spam and nobody can finish signing up.
- **`uploads/` is data, never code.** `deposit.php` writes an `.htaccess` there
  that switches the PHP engine off. Confirm it exists after the first upload — a
  file called `shot.png` that is really PHP is otherwise a shell.

---

## 6. When something is wrong

**Every page says the price feed is not running.**
Both the cron and the page-load fallback are failing, which almost always means
`curl` is disabled or the host blocks outbound HTTPS. Run
`curl -s https://yourdomain.com/api/cron.php?job=all` by hand and read the JSON it
returns — it names every exchange it tried.

**The chart is empty and stays empty.**
Check `auto_backfill_next` in Operations → Settings. If it says `stalled`, twenty
consecutive attempts were refused by every exchange; `cron_runs` will have the
reason. Set it back to `1D` to retry.

**"The server returned something unexpected."**
PHP died and printed a warning before the JSON. Check the error log; it is almost
always a missing `api/config.local.php` or a database that refused the connection.

**Orders are refused with a 503.**
Working as intended: the feed is stale. Check `cron_runs` and the `arv_candles`
timestamp.

**Reconciliation is off by a few paise.**
Look for a fill that wrote a ledger entry but not its fee, or the reverse. Correct
it with an `adjustment` entry — never by editing a wallet, and never by editing the
original row. The triggers will refuse the edit anyway.

**A deposit was credited twice.**
The same UTR reached two deposits. `deposits.utr` is indexed for exactly this;
find both rows, and reverse one with a compensating ledger entry.
