<?php
/**
 * Scheduled work: price ingest, order matching, expiry, and history backfill.
 *
 * Called once a minute from hPanel → Cron Jobs:
 *   curl -s https://yourdomain.com/api/cron.php?job=all
 *
 * ---------------------------------------------------------------------------
 * Why candles are stored here rather than computed in the browser
 * ---------------------------------------------------------------------------
 * Public exchange APIs return a few hundred candles per request and none will
 * serve five years of minute data. Computing the chart client-side would cap
 * ARV's minute history at whatever one call returns, for ever.
 *
 * Appending a candle a minute means the series accumulates: after a month of
 * uptime there is a real month of minute history that no third party can
 * rate-limit or withdraw. It also means a trade prices from the database rather
 * than depending on an exchange being reachable at the instant somebody presses
 * confirm — and if this job stops, trading pauses rather than filling at a stale
 * number.
 *
 * ---------------------------------------------------------------------------
 * Why several exchanges
 * ---------------------------------------------------------------------------
 * Exchange APIs are geo-restricted and which ones are blocked depends on where
 * the server sits. Measured from a US egress point: Binance and Bybit refuse
 * outright, while OKX, Coinbase and Kraken answer. A single hardcoded exchange
 * means this job silently stops producing candles the day that exchange decides
 * it does not like the hosting region.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';
require __DIR__ . '/_match.php';

@set_time_limit(300);
ignore_user_abort(true);

$job = $_GET['job'] ?? 'all';

// Backfill is heavy and operator-initiated, so it needs a signed-in operator.
// Everything else runs unauthenticated because a scheduler cannot log in — and
// none of it accepts input or reveals anything.
if ($job === 'backfill') {
    require_csrf();
    require_admin();
}

$started = microtime(true);
$out = [];

try {
    switch ($job) {
        case 'all':
            $out['ingest'] = job_ingest();
            $out['match']  = job_match();
            $out['expire'] = ['expired' => expire_orders()];
            $out['tiers']  = job_tiers();
            break;

        case 'ingest':   $out['ingest'] = job_ingest(); break;
        case 'match':    $out['match']  = job_match();  break;
        case 'backfill': $out['backfill'] = job_backfill(); break;
        case 'tiers':    $out['tiers']  = job_tiers();  break;

        default:
            json_fail(400, 'Unknown job.');
    }

    $out['elapsedMs'] = (int)round((microtime(true) - $started) * 1000);
    json_ok($out);

} catch (Throwable $e) {
    cron_record($job, 'fail', $e->getMessage());
    json_fail(500, $e->getMessage());
}

/* ============================================================== ingest ==== */

function job_ingest(): array
{
    $fx  = fetch_fx();
    $btc = fetch_candles_1m('BTC');

    if (!$btc['candles']) {
        cron_record('ingest', 'fail', 'no source served BTC');
        throw new RuntimeException('No exchange served Bitcoin candles. Tried: ' . implode(', ', $btc['tried']));
    }

    // Raw USD candles are kept as well as the computed index. If the index
    // definition ever changes, history can be recomputed from these rather than
    // being lost.
    $ins = db()->prepare(
        'INSERT INTO asset_candles (asset_key, tf, ts, open, high, low, close, volume, source)
         VALUES ("BTC", "1m", FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                 close=VALUES(close), volume=VALUES(volume), source=VALUES(source)'
    );
    foreach ($btc['candles'] as $k) {
        $ins->execute([(int)($k['t'] / 1000), $k['o'], $k['h'], $k['l'], $k['c'], $k['v'], $btc['source']]);
    }

    // The index itself.
    $arvIns = db()->prepare(
        'INSERT INTO arv_candles (tf, ts, open, high, low, close, volume, fx_rate, is_final, source)
         VALUES ("1m", FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                 close=VALUES(close), volume=VALUES(volume),
                                 fx_rate=VALUES(fx_rate), source=VALUES(source)'
    );

    $written = 0;
    $latest = null;
    foreach ($btc['candles'] as $k) {
        $row = [
            'o' => index_price($k['o'], $fx),
            'h' => index_price($k['h'], $fx),
            'l' => index_price($k['l'], $fx),
            'c' => index_price($k['c'], $fx),
        ];
        $arvIns->execute([
            (int)($k['t'] / 1000), $row['o'], $row['h'], $row['l'], $row['c'],
            $k['v'], $fx, $btc['source'],
        ]);
        $written++;
        $latest = $row['c'];
    }

    // Watchlist assets are stored for the dashboard but never enter the index.
    // Note the separate statement: the one above hardcodes "BTC" as the asset
    // key, so reusing it here would file Ethereum and Solana prices as Bitcoin
    // and corrupt the series the index is computed from.
    $watch = [];
    $wIns = db()->prepare(
        'INSERT INTO asset_candles (asset_key, tf, ts, open, high, low, close, volume, source)
         VALUES (?, "1m", FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high),
                                 low=VALUES(low), close=VALUES(close),
                                 volume=VALUES(volume), source=VALUES(source)'
    );

    foreach (['ETH', 'SOL'] as $key) {
        $w = fetch_candles_1m($key);
        if (!$w['candles']) {
            $watch[$key] = 'unavailable';
            continue;
        }
        foreach ($w['candles'] as $k) {
            $wIns->execute([$key, (int)($k['t'] / 1000), $k['o'], $k['h'], $k['l'], $k['c'], $k['v'], $w['source']]);
        }
        $watch[$key] = $w['source'];
    }

    $rolled = rollup_all();
    cron_record('ingest', 'ok', sprintf('%d candles from %s, ARV %.4f', $written, $btc['source'], $latest ?? 0));

    return [
        'source'    => $btc['source'],
        'fx'        => $fx,
        'candles'   => $written,
        'arvPrice'  => $latest,
        'watchlist' => $watch,
        'rolledUp'  => $rolled,
    ];
}

/* ============================================================ matching ==== */

function job_match(): array
{
    try {
        $nav = arv_nav();
    } catch (RuntimeException $e) {
        // Refusing to match on a stale price is the same decision as refusing to
        // fill an order on one.
        return ['skipped' => $e->getMessage()];
    }
    $r = run_matching($nav);
    cron_record('match', 'ok', sprintf('%d fills, %d triggered', $r['fills'], $r['triggered']));
    return $r;
}

/* =============================================================== tiers ==== */

/**
 * Recompute referral reward tiers.
 *
 * Tiers are earned on referred volume — the rupees a referrer's referrals have
 * actually deposited — measured against what the referrer put in themselves for
 * the ratio tiers. Only ever upgrades: a tier already earned is not taken away
 * because someone's own deposits later grew and moved the ratio.
 */
function job_tiers(): array
{
    $rows = q(
        'SELECT u.id, u.tier_id,
                COALESCE(SUM(r.base_paise), 0) AS referred_paise,
                (SELECT COALESCE(SUM(d.amount_paise),0) FROM deposits d
                  WHERE d.user_id = u.id AND d.status = "confirmed") AS own_paise
           FROM users u
           JOIN referrals r ON r.referrer_id = u.id AND r.status = "paid"
          GROUP BY u.id'
    )->fetchAll();

    $tiers   = arv_reward_tiers();
    $changed = 0;

    foreach ($rows as $r) {
        $referred = (int)$r['referred_paise'];
        $own      = (int)$r['own_paise'];
        $best     = null;

        foreach ($tiers as $t) {
            $qualifies = $t['metric'] === 'paise'
                ? $referred >= (int)$t['threshold']
                : ($own > 0 && ($referred / $own) >= (float)$t['threshold']);
            if ($qualifies) {
                $best = $t['id'];
            }
        }

        if ($best !== null && $best !== $r['tier_id']) {
            $currentIdx = array_search($r['tier_id'], array_column($tiers, 'id'), true);
            $bestIdx    = array_search($best, array_column($tiers, 'id'), true);
            if ($currentIdx === false || $bestIdx > $currentIdx) {
                q('UPDATE users SET tier_id = ?, tier_earned_at = UTC_TIMESTAMP() WHERE id = ?',
                  [$best, $r['id']]);
                $changed++;
            }
        }
    }

    return ['evaluated' => count($rows), 'upgraded' => $changed];
}

/* ============================================================ backfill ==== */

/**
 * Build history back to launch.
 *
 * Tiered on purpose — daily since launch, hourly for a quarter, minute for a
 * week. Five years of minute candles would be 2.6 million rows that no API will
 * serve and no chart needs.
 *
 * Requests are paced. Hammering a free endpoint earns a 429 and a half-finished
 * series, which is worse than taking two minutes.
 */
function job_backfill(): array
{
    $tf   = (string)($_GET['tf'] ?? input_str('tf', '1D'));
    $days = (int)($_GET['days'] ?? input_int('days', 0));

    $allowed = ['1m' => 7, '1h' => 90, '4h' => 730, '1D' => 0, '1W' => 0];
    if (!isset($allowed[$tf])) {
        throw new RuntimeException('tf must be one of 1m, 1h, 4h, 1D, 1W');
    }
    if ($days <= 0) {
        $days = $allowed[$tf];
    }

    $launch = strtotime((string)setting('launch_at', '2021-09-01 00:00:00'));
    $from   = $days > 0 ? max($launch, time() - $days * 86400) : $launch;

    $curve = fetch_fx_curve($from, time());
    $btc   = fetch_candles_range('BTC', $tf, $from);

    if (!$btc['candles']) {
        throw new RuntimeException('No exchange could page ' . $tf . ' history. Tried: ' . implode(', ', $btc['tried']));
    }

    $ins = db()->prepare(
        'INSERT INTO arv_candles (tf, ts, open, high, low, close, volume, fx_rate, is_final, source)
         VALUES (?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                 close=VALUES(close), volume=VALUES(volume), fx_rate=VALUES(fx_rate)'
    );

    $written = 0;
    $first = $last = null;
    foreach ($btc['candles'] as $k) {
        $sec = (int)($k['t'] / 1000);
        if ($sec < $launch) {
            continue;   // never a candle from before the index existed
        }
        $fx = fx_at($curve, $k['t']);
        $c  = index_price($k['c'], $fx);
        $ins->execute([
            $tf, $sec,
            index_price($k['o'], $fx), index_price($k['h'], $fx),
            index_price($k['l'], $fx), $c,
            $k['v'], $fx, $btc['source'],
        ]);
        $first = $first ?? $c;
        $last  = $c;
        $written++;
    }

    audit('backfill', ['entity' => 'arv_candles', 'entity_id' => $tf,
                       'detail' => ['written' => $written, 'source' => $btc['source']]]);
    cron_record('backfill.' . $tf, 'ok', $written . ' candles from ' . $btc['source']);

    return [
        'tf' => $tf, 'source' => $btc['source'], 'written' => $written,
        'firstClose' => $first, 'lastClose' => $last,
        'from' => gmdate('c', $from),
    ];
}

/* ============================================================== rollup ==== */

/**
 * Recompute the in-progress bucket of each larger timeframe from 1m candles.
 *
 * Only the current bucket is touched. Completed buckets are already correct, and
 * rewriting five years of them every minute would be pointless load.
 */
function rollup_all(): array
{
    $sizes = ['5m' => 300, '15m' => 900, '1h' => 3600, '4h' => 14400, '1D' => 86400];
    $done = [];

    foreach ($sizes as $tf => $secs) {
        $bucket = intdiv(time(), $secs) * $secs;
        $agg = q1(
            'SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                    MAX(high) AS h, MIN(low) AS l, SUM(volume) AS v
               FROM arv_candles
              WHERE tf = "1m" AND ts >= FROM_UNIXTIME(?)', [$bucket]
        );
        if (!$agg || $agg['first_ts'] === null) {
            $done[$tf] = false;
            continue;
        }
        $o = qval('SELECT open FROM arv_candles WHERE tf="1m" AND ts=?', [$agg['first_ts']]);
        $c = qval('SELECT close FROM arv_candles WHERE tf="1m" AND ts=?', [$agg['last_ts']]);

        q('INSERT INTO arv_candles (tf, ts, open, high, low, close, volume, is_final, source)
           VALUES (?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, 0, "rollup")
           ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                   close=VALUES(close), volume=VALUES(volume), is_final=0',
          [$tf, $bucket, $o, $agg['h'], $agg['l'], $c, $agg['v'] ?? 0]);
        $done[$tf] = true;
    }

    // Weekly aligns to Monday, not to the epoch — the epoch fell on a Thursday
    // and a chart with Thursday-opening weeks looks broken.
    $monday = strtotime('monday this week', time());
    $agg = q1('SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, MAX(high) AS h,
                      MIN(low) AS l, SUM(volume) AS v
                 FROM arv_candles WHERE tf = "1D" AND ts >= FROM_UNIXTIME(?)', [$monday]);
    if ($agg && $agg['first_ts'] !== null) {
        $o = qval('SELECT open FROM arv_candles WHERE tf="1D" AND ts=?', [$agg['first_ts']]);
        $c = qval('SELECT close FROM arv_candles WHERE tf="1D" AND ts=?', [$agg['last_ts']]);
        q('INSERT INTO arv_candles (tf, ts, open, high, low, close, volume, is_final, source)
           VALUES ("1W", FROM_UNIXTIME(?), ?, ?, ?, ?, ?, 0, "rollup")
           ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                   close=VALUES(close), volume=VALUES(volume)',
          [$monday, $o, $agg['h'], $agg['l'], $c, $agg['v'] ?? 0]);
        $done['1W'] = true;
    }

    return $done;
}

/* ============================================================ fetching ==== */

function http_get(string $url, int $timeout = 12): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_USERAGENT      => 'ARV/3.0 (+price-ingest)',
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ($body !== false && $code >= 200 && $code < 300) ? (string)$body : null;
    }

    $ctx = stream_context_create(['http' => ['timeout' => $timeout, 'header' => "Accept: application/json\r\n"]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
}

/** Per-source symbol names. Kraken spells Bitcoin XBT. */
function symbol_for(string $source, string $key): string
{
    return match ($source) {
        'binance'  => $key . 'USDT',
        'okx'      => $key . '-USDT',
        'coinbase' => $key . '-USD',
        'kraken'   => ($key === 'BTC' ? 'XBTUSD' : $key . 'USD'),
        default    => $key,
    };
}

function fetch_candles_1m(string $key): array
{
    $tried = [];

    foreach (['binance', 'okx', 'coinbase', 'kraken'] as $src) {
        $sym = symbol_for($src, $key);
        $url = match ($src) {
            'binance'  => "https://api.binance.com/api/v3/klines?symbol={$sym}&interval=1m&limit=60",
            'okx'      => "https://www.okx.com/api/v5/market/candles?instId={$sym}&bar=1m&limit=60",
            'coinbase' => "https://api.exchange.coinbase.com/products/{$sym}/candles?granularity=60",
            'kraken'   => "https://api.kraken.com/0/public/OHLC?pair={$sym}&interval=1",
        };

        $body = http_get($url);
        if ($body === null) {
            $tried[] = "$src(unreachable)";
            continue;
        }
        $candles = parse_candles($src, $body);
        if ($candles) {
            return ['candles' => $candles, 'source' => $src, 'tried' => $tried];
        }
        $tried[] = "$src(no data)";
    }

    return ['candles' => [], 'source' => null, 'tried' => $tried];
}

/**
 * Page backwards to assemble history.
 *
 * Only sources that can page are useful. OKX exposes `after`, which despite the
 * name means "older than this timestamp". Coinbase takes an explicit window.
 * Kraken is omitted: it only offers `since` as a lower bound and always returns
 * the most recent window from there, so it cannot walk into deep history.
 */
function fetch_candles_range(string $key, string $tf, int $fromTs): array
{
    $tried = [];

    // Coinbase first for history: 300 candles a call beats OKX's 100, so five
    // years of daily takes 7 requests instead of 19.
    foreach (['coinbase', 'okx'] as $src) {
        $sym  = symbol_for($src, $key);
        $acc  = [];
        $end  = time() * 1000;
        $ok   = false;
        $step = $src === 'coinbase' ? 300 : 100;
        $secs = tf_seconds($tf);

        for ($i = 0; $i < 400 && $end > $fromTs * 1000; $i++) {
            if ($src === 'coinbase') {
                $gran = $secs;
                if (!in_array($gran, [60, 300, 900, 3600, 21600, 86400], true)) {
                    $tried[] = 'coinbase(tf unsupported)';
                    break;
                }
                $start = max($fromTs * 1000, $end - $step * $gran * 1000);
                $url = "https://api.exchange.coinbase.com/products/{$sym}/candles"
                     . "?granularity={$gran}"
                     . '&start=' . gmdate('c', (int)($start / 1000))
                     . '&end=' . gmdate('c', (int)($end / 1000));
            } else {
                $bar = okx_bar($tf);
                $url = "https://www.okx.com/api/v5/market/history-candles"
                     . "?instId={$sym}&bar={$bar}&after={$end}&limit={$step}";
            }

            $body = http_get($url, 15);
            if ($body === null) {
                break;
            }
            $batch = parse_candles($src, $body);
            if (!$batch) {
                break;
            }

            $oldest = PHP_INT_MAX;
            foreach ($batch as $k) {
                if ($k['t'] >= $fromTs * 1000) {
                    $acc[$k['t']] = $k;
                }
                $oldest = min($oldest, $k['t']);
            }
            if ($oldest >= $end) {
                break;   // no progress — stop rather than spin
            }
            $end = $oldest - 1;
            $ok  = true;
            usleep(260000);
        }

        if ($ok && $acc) {
            ksort($acc);
            return ['candles' => array_values($acc), 'source' => $src, 'tried' => $tried];
        }
        $tried[] = "$src(could not page)";
    }

    // Weekly is not offered natively everywhere; roll it up from daily instead.
    if ($tf === '1W') {
        $daily = fetch_candles_range($key, '1D', $fromTs);
        if ($daily['candles']) {
            return [
                'candles' => rollup_weekly($daily['candles']),
                'source'  => $daily['source'] . '+rollup',
                'tried'   => $tried,
            ];
        }
    }

    return ['candles' => [], 'source' => null, 'tried' => $tried];
}

function rollup_weekly(array $daily): array
{
    $out = [];
    $cur = null;
    foreach ($daily as $k) {
        $monday = strtotime('monday this week', (int)($k['t'] / 1000)) * 1000;
        if ($cur === null || $cur['t'] !== $monday) {
            if ($cur !== null) {
                $out[] = $cur;
            }
            $cur = ['t' => $monday, 'o' => $k['o'], 'h' => $k['h'], 'l' => $k['l'], 'c' => $k['c'], 'v' => $k['v']];
        } else {
            $cur['h'] = max($cur['h'], $k['h']);
            $cur['l'] = min($cur['l'], $k['l']);
            $cur['c'] = $k['c'];
            $cur['v'] += $k['v'];
        }
    }
    if ($cur !== null) {
        $out[] = $cur;
    }
    return $out;
}

function tf_seconds(string $tf): int
{
    return match ($tf) {
        '1m' => 60, '5m' => 300, '15m' => 900,
        '1h' => 3600, '4h' => 14400, '1D' => 86400, '1W' => 604800,
        default => 60,
    };
}

function okx_bar(string $tf): string
{
    return match ($tf) {
        '1h' => '1H', '4h' => '4H', '1D' => '1D', '1W' => '1W',
        default => $tf,
    };
}

/**
 * Normalise an exchange payload.
 *
 * Coinbase is the trap here: its rows are [time, LOW, HIGH, OPEN, CLOSE, volume].
 * Every other exchange puts open before high. Reading it in the usual order
 * silently produces candles with the wick and body swapped.
 */
function parse_candles(string $src, string $body): array
{
    $j = json_decode($body, true);
    if (!is_array($j)) {
        return [];
    }
    $out = [];

    switch ($src) {
        case 'binance':
            // A geo-block arrives as a 200 carrying {code, msg}, not as an error
            // status — so a successful HTTP code is not enough to trust it.
            if (!isset($j[0]) || !is_array($j[0])) {
                return [];
            }
            foreach ($j as $k) {
                $out[] = ['t' => (int)$k[0], 'o' => (float)$k[1], 'h' => (float)$k[2],
                          'l' => (float)$k[3], 'c' => (float)$k[4], 'v' => (float)$k[5]];
            }
            break;

        case 'okx':
            if (($j['code'] ?? '') !== '0' || empty($j['data'])) {
                return [];
            }
            foreach ($j['data'] as $k) {
                $out[] = ['t' => (int)$k[0], 'o' => (float)$k[1], 'h' => (float)$k[2],
                          'l' => (float)$k[3], 'c' => (float)$k[4], 'v' => (float)$k[5]];
            }
            break;

        case 'coinbase':
            if (!isset($j[0]) || !is_array($j[0])) {
                return [];
            }
            foreach ($j as $k) {
                $out[] = ['t' => (int)$k[0] * 1000, 'o' => (float)$k[3], 'h' => (float)$k[2],
                          'l' => (float)$k[1], 'c' => (float)$k[4], 'v' => (float)$k[5]];
            }
            break;

        case 'kraken':
            if (!empty($j['error']) || empty($j['result'])) {
                return [];
            }
            foreach ($j['result'] as $pair => $rows) {
                if ($pair === 'last' || !is_array($rows)) {
                    continue;
                }
                foreach ($rows as $k) {
                    $out[] = ['t' => (int)$k[0] * 1000, 'o' => (float)$k[1], 'h' => (float)$k[2],
                              'l' => (float)$k[3], 'c' => (float)$k[4], 'v' => (float)$k[6]];
                }
                break;
            }
            break;
    }

    usort($out, static fn($a, $b) => $a['t'] <=> $b['t']);
    return $out;
}

/* ================================================================== fx ==== */

function fetch_fx(): float
{
    $today = gmdate('Y-m-d');

    $cached = qval('SELECT usd_inr FROM fx_rates WHERE day = ?', [$today]);
    if ($cached !== null) {
        return (float)$cached;
    }

    foreach ([
        'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR',
        'https://open.er-api.com/v6/latest/USD',
    ] as $url) {
        $body = http_get($url, 10);
        if ($body === null) {
            continue;
        }
        $j = json_decode($body, true);
        $rate = $j['rates']['INR'] ?? null;
        if ($rate && $rate > 0) {
            q('INSERT INTO fx_rates (day, usd_inr, source) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE usd_inr = VALUES(usd_inr)', [$today, $rate, $url]);
            return (float)$rate;
        }
    }

    // The most recent stored rate beats inventing one.
    $last = qval('SELECT usd_inr FROM fx_rates ORDER BY day DESC LIMIT 1');
    if ($last !== null) {
        return (float)$last;
    }
    throw new RuntimeException('No USD/INR rate available from any source or from cache.');
}

/**
 * Daily USD/INR across a range, in one request.
 *
 * Historical candles must be valued at the rate of their own day. Applying
 * today's rate across five years would fold the entire currency move of the
 * period into the chart as though it were a Bitcoin move — and the further back
 * you look, the more wrong the number gets.
 *
 * Frankfurter publishes business days only, so the curve is forward-filled.
 */
function fetch_fx_curve(int $fromTs, int $toTs): array
{
    $from = gmdate('Y-m-d', $fromTs);
    $to   = gmdate('Y-m-d', $toTs);

    $body = http_get("https://api.frankfurter.dev/v1/{$from}..{$to}?base=USD&symbols=INR", 25);
    $series = [];

    if ($body !== null) {
        $j = json_decode($body, true);
        foreach (($j['rates'] ?? []) as $day => $r) {
            if (!empty($r['INR'])) {
                $series[] = ['ms' => strtotime($day . ' 00:00:00 UTC') * 1000, 'rate' => (float)$r['INR']];
            }
        }
        if ($series) {
            $ins = db()->prepare('INSERT INTO fx_rates (day, usd_inr, source) VALUES (?, ?, "frankfurter")
                                  ON DUPLICATE KEY UPDATE usd_inr = VALUES(usd_inr)');
            foreach ($series as $s) {
                $ins->execute([gmdate('Y-m-d', (int)($s['ms'] / 1000)), $s['rate']]);
            }
        }
    }

    if (!$series) {
        foreach (q('SELECT day, usd_inr FROM fx_rates WHERE day BETWEEN ? AND ? ORDER BY day',
                   [$from, $to])->fetchAll() as $r) {
            $series[] = ['ms' => strtotime($r['day'] . ' 00:00:00 UTC') * 1000, 'rate' => (float)$r['usd_inr']];
        }
    }
    if (!$series) {
        throw new RuntimeException('No USD/INR history available for that range.');
    }

    usort($series, static fn($a, $b) => $a['ms'] <=> $b['ms']);
    return $series;
}

/** Rate in effect at a timestamp — the latest quote at or before it. */
function fx_at(array $curve, int $ms): float
{
    if ($ms <= $curve[0]['ms']) {
        return $curve[0]['rate'];
    }
    $lo = 0;
    $hi = count($curve) - 1;
    while ($lo < $hi) {
        $mid = intdiv($lo + $hi + 1, 2);
        if ($curve[$mid]['ms'] <= $ms) {
            $lo = $mid;
        } else {
            $hi = $mid - 1;
        }
    }
    return $curve[$lo]['rate'];
}

/* ============================================================ bookkeeping = */

function cron_record(string $job, string $status, string $message): void
{
    try {
        q('INSERT INTO cron_runs (job, last_run_at, last_ok_at, last_status, last_message, run_count, fail_count)
           VALUES (?, UTC_TIMESTAMP(), IF(? = "ok", UTC_TIMESTAMP(), NULL), ?, ?, 1, IF(? = "ok", 0, 1))
           ON DUPLICATE KEY UPDATE
             last_run_at = UTC_TIMESTAMP(),
             last_ok_at  = IF(VALUES(last_status) = "ok", UTC_TIMESTAMP(), last_ok_at),
             last_status = VALUES(last_status),
             last_message = VALUES(last_message),
             run_count = run_count + 1,
             fail_count = fail_count + IF(VALUES(last_status) = "ok", 0, 1)',
          [$job, $status, $status, substr($message, 0, 255), $status]);
    } catch (Throwable $e) {
        error_log('[arv] cron_record failed: ' . $e->getMessage());
    }
}
