<?php
/**
 * The price feed engine: fetch, ingest, backfill, and the locks around them.
 *
 * Split out of cron.php because two callers need it and cron.php cannot be one of
 * them twice over — it dispatches a job the moment it is included, so any endpoint
 * that required it would run a cron job as a side effect of loading a file.
 *
 * The two callers:
 *
 *   cron.php     the scheduled path, once a minute, the reliable one
 *   market.php   the fallback, from a page request, when the price has gone behind
 *                and no scheduler has refreshed it
 *
 * Everything here is safe to call from either. The work is idempotent — candles are
 * written with ON DUPLICATE KEY UPDATE, so ingesting the same minute twice changes
 * nothing — and the expensive paths take an advisory lock so that two workers
 * arriving together do the work once.
 */

declare(strict_types=1);

// require_once, not require: the endpoints that include this file have already
// loaded some of these, and a second plain require would be a redeclaration fatal.
require_once __DIR__ . '/_boot.php';
require_once __DIR__ . '/_money.php';
require_once __DIR__ . '/_match.php';
require_once __DIR__ . '/_schema.php';


/**
 * The zero-weight watchlist assets, stored in asset_candles for the dashboard
 * and the per-asset charts but never entering the index or the money path.
 *
 * BTC is deliberately absent: it is ingested and backfilled by its own dedicated
 * path (it is the one weighted basket asset, and the ARV index is computed from
 * it), so it is already written to asset_candles separately. This mirrors the
 * client's ARV_CONFIG.WATCHLIST (ETH, SOL, XRP) — display-only, weight 0.
 */
function watchlist_keys(): array
{
    return ['ETH', 'SOL', 'XRP'];
}

/** Every asset that has its own asset_candles series: the basket plus the watchlist. */
function asset_keys(): array
{
    return array_merge(['BTC'], watchlist_keys());
}


function ingest_prices(): array
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

    foreach (watchlist_keys() as $key) {
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
    // Keep the watchlist coins' larger timeframes current too, so their per-asset
    // charts have 5m/15m/1h/4h/1D/1W bars and not just raw 1m. USD-only, weight 0.
    $rolledAssets = rollup_assets();
    cron_record('ingest', 'ok', sprintf('%d candles from %s, ARV %.4f', $written, $btc['source'], $latest ?? 0));

    return [
        'source'        => $btc['source'],
        'fx'            => $fx,
        'candles'       => $written,
        'arvPrice'      => $latest,
        'watchlist'     => $watch,
        'rolledUp'      => $rolled,
        'rolledUpAssets'=> $rolledAssets,
    ];
}



/**
 * Build history back to launch.
 *
 * Tiered on purpose — daily/weekly all the way to launch (~2015, roughly ten
 * years), hourly for a quarter, 15m/5m for the recent weeks, minute for a week.
 * Ten years of minute candles would be millions of rows that no free API will
 * serve and no chart needs; deep history is honestly daily/weekly, and the
 * minute/tick view exists only for the recent window (see README).
 *
 * Requests are paced. Hammering a free endpoint earns a 429 and a half-finished
 * series, which is worse than taking two minutes.
 */
function backfill_tf(string $tf = '1D', int $days = 0): array
{
    // Depth per timeframe, in days. 1D/1W = 0 means "all the way to launch"
    // (now ~2015, roughly ten years of daily/weekly). The sub-hour frames only
    // cover the recent window a free API will actually page: five years of 1m is
    // ~2.6M rows nobody serves, so minute/tick history is recent-only by design.
    $allowed = ['5m' => 30, '15m' => 90, '1m' => 7, '1h' => 90, '4h' => 730, '1D' => 0, '1W' => 0];
    if (!isset($allowed[$tf])) {
        throw new RuntimeException('tf must be one of 5m, 15m, 1m, 1h, 4h, 1D, 1W');
    }
    if ($days <= 0) {
        $days = $allowed[$tf];
    }

    // The clamp below and this window both hang off launch_at, which is now the
    // 2015-07-20 anchor, so daily/weekly history pages back roughly ten years.
    $launch = strtotime((string)setting('launch_at', '2015-07-20 00:00:00'));
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


/**
 * Build per-asset history for a watchlist coin, in USD, into asset_candles.
 *
 * The USD twin of backfill_tf(): same tiering and the same honest-history limit
 * (daily/weekly deep, minute recent — no fabricated candles), but it writes raw
 * USD candles keyed by asset_key rather than the INR-converted index. These
 * assets carry weight 0, so there is no fx conversion and no arv_candles write;
 * the chart shows the coin in dollars exactly as the exchange reports it.
 *
 * BTC is excluded on purpose: its asset_candles are produced by the dedicated
 * ingest/backfill path, so backfilling it here would duplicate that work.
 */
function backfill_asset_tf(string $assetKey, string $tf = '1D', int $days = 0): array
{
    if (!in_array($assetKey, watchlist_keys(), true)) {
        throw new RuntimeException('backfill_asset_tf is for watchlist assets only (ETH, SOL, XRP).');
    }

    $allowed = ['5m' => 30, '15m' => 90, '1m' => 7, '1h' => 90, '4h' => 730, '1D' => 0, '1W' => 0];
    if (!isset($allowed[$tf])) {
        throw new RuntimeException('tf must be one of 5m, 15m, 1m, 1h, 4h, 1D, 1W');
    }
    if ($days <= 0) {
        $days = $allowed[$tf];
    }

    // Coins have no launch anchor of their own — the clamp exists so the chart
    // never shows a bar older than the requested window.
    $launch = strtotime((string)setting('launch_at', '2015-07-20 00:00:00'));
    $from   = $days > 0 ? max($launch, time() - $days * 86400) : $launch;

    $res = fetch_candles_range($assetKey, $tf, $from);
    if (!$res['candles']) {
        throw new RuntimeException('No exchange could page ' . $tf . ' history for ' . $assetKey
            . '. Tried: ' . implode(', ', $res['tried']));
    }

    $ins = db()->prepare(
        'INSERT INTO asset_candles (asset_key, tf, ts, open, high, low, close, volume, source)
         VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                 close=VALUES(close), volume=VALUES(volume), source=VALUES(source)'
    );

    $written = 0;
    $first = $last = null;
    foreach ($res['candles'] as $k) {
        $sec = (int)($k['t'] / 1000);
        if ($sec < $launch) {
            continue;
        }
        $ins->execute([$assetKey, $tf, $sec, $k['o'], $k['h'], $k['l'], $k['c'], $k['v'], $res['source']]);
        $first = $first ?? $k['c'];
        $last  = $k['c'];
        $written++;
    }

    cron_record('backfill.asset.' . $assetKey . '.' . $tf, 'ok',
        $written . ' candles from ' . $res['source']);

    return [
        'asset' => $assetKey, 'tf' => $tf, 'source' => $res['source'], 'written' => $written,
        'firstClose' => $first, 'lastClose' => $last, 'from' => gmdate('c', $from),
    ];
}


/**
 * Recompute the in-progress larger-timeframe bucket for each watchlist asset from
 * its 1m candles, in USD, into asset_candles.
 *
 * The USD, per-asset twin of rollup_all(): only the current bucket of each frame
 * is rewritten, because completed buckets are already correct. BTC is rolled up
 * by the dedicated path (its asset_candles are maintained alongside arv_candles),
 * so it is not re-rolled here.
 */
function rollup_assets(): array
{
    $sizes = ['5m' => 300, '15m' => 900, '1h' => 3600, '4h' => 14400, '1D' => 86400];
    $done = [];

    foreach (watchlist_keys() as $key) {
        $done[$key] = [];
        foreach ($sizes as $tf => $secs) {
            $bucket = intdiv(time(), $secs) * $secs;
            $agg = q1(
                'SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                        MAX(high) AS h, MIN(low) AS l, SUM(volume) AS v
                   FROM asset_candles
                  WHERE asset_key = ? AND tf = "1m" AND ts >= FROM_UNIXTIME(?)',
                [$key, $bucket]
            );
            if (!$agg || $agg['first_ts'] === null) {
                $done[$key][$tf] = false;
                continue;
            }
            $o = qval('SELECT open FROM asset_candles WHERE asset_key=? AND tf="1m" AND ts=?',
                [$key, $agg['first_ts']]);
            $c = qval('SELECT close FROM asset_candles WHERE asset_key=? AND tf="1m" AND ts=?',
                [$key, $agg['last_ts']]);

            q('INSERT INTO asset_candles (asset_key, tf, ts, open, high, low, close, volume, source)
               VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, "rollup")
               ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                       close=VALUES(close), volume=VALUES(volume)',
              [$key, $tf, $bucket, $o, $agg['h'], $agg['l'], $c, $agg['v'] ?? 0]);
            $done[$key][$tf] = true;
        }

        // Weekly aligns to Monday, matching the ARV rollup.
        $monday = strtotime('monday this week', time());
        $agg = q1('SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, MAX(high) AS h,
                          MIN(low) AS l, SUM(volume) AS v
                     FROM asset_candles WHERE asset_key = ? AND tf = "1D" AND ts >= FROM_UNIXTIME(?)',
            [$key, $monday]);
        if ($agg && $agg['first_ts'] !== null) {
            $o = qval('SELECT open FROM asset_candles WHERE asset_key=? AND tf="1D" AND ts=?',
                [$key, $agg['first_ts']]);
            $c = qval('SELECT close FROM asset_candles WHERE asset_key=? AND tf="1D" AND ts=?',
                [$key, $agg['last_ts']]);
            q('INSERT INTO asset_candles (asset_key, tf, ts, open, high, low, close, volume, source)
               VALUES (?, "1W", FROM_UNIXTIME(?), ?, ?, ?, ?, ?, "rollup")
               ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low),
                                       close=VALUES(close), volume=VALUES(volume)',
              [$key, $monday, $o, $agg['h'], $agg['l'], $c, $agg['v'] ?? 0]);
            $done[$key]['1W'] = true;
        }
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


function okx_bar(string $tf): string
{
    // OKX uppercases the hour/day/week bars but keeps minute bars lowercase
    // (5m, 15m, 1m), which the default passthrough already returns correctly.
    return match ($tf) {
        '1h' => '1H', '4h' => '4H', '1D' => '1D', '1W' => '1W',
        default => $tf,
    };
}


function tf_seconds(string $tf): int
{
    return match ($tf) {
        '1m' => 60, '5m' => 300, '15m' => 900,
        '1h' => 3600, '4h' => 14400, '1D' => 86400, '1W' => 604800,
        default => 60,
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


/* ================================================================== fx ==== */

function fetch_fx(): float
{
    $today = gmdate('Y-m-d');

    $cached = qval('SELECT usd_inr FROM fx_rates WHERE day = ?', [$today]);
    if ($cached !== null) {
        return (float)$cached;
    }

    // Short names, not URLs. `source` is VARCHAR(40) and a full query string
    // overflows it, which fails the whole ingest for the sake of a label.
    foreach ([
        'frankfurter' => 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR',
        'erapi'       => 'https://open.er-api.com/v6/latest/USD',
    ] as $name => $url) {
        $body = http_get($url, 10);
        if ($body === null) {
            continue;
        }
        $j = json_decode($body, true);
        $rate = $j['rates']['INR'] ?? null;
        if ($rate && $rate > 0) {
            q('INSERT INTO fx_rates (day, usd_inr, source) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE usd_inr = VALUES(usd_inr)', [$today, $rate, $name]);
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

/* ========================================================= advisory lock === */

/**
 * A lock every PHP worker can see, held for the life of the request.
 *
 * Shared hosting runs several workers, and the ingest path is now reachable from
 * two directions: the scheduled job, and a page request that finds the price
 * stale. Two workers fetching and writing the same candles is wasted upstream
 * quota; two workers backfilling five years of history at once is a self-inflicted
 * rate limit.
 *
 * A MySQL named lock is the right instrument because the database is the one thing
 * every worker already shares. A file lock would not hold across hosts, and a
 * settings row used as a flag would need its own transaction to be race-free —
 * which is precisely what GET_LOCK already is.
 *
 * Timeout zero: never queue. If another worker holds it there is nothing worth
 * waiting for, and blocking a visitor's page load to discover that would be the
 * wrong trade.
 */
function feed_lock(string $name, int $timeout = 0): bool
{
    return (bool)qval('SELECT GET_LOCK(?, ?)', ['arv_' . $name, $timeout]);
}

function feed_unlock(string $name): void
{
    qval('SELECT RELEASE_LOCK(?)', ['arv_' . $name]);
}

/* ======================================================= auto backfill ===== */

/**
 * Fill an empty chart without anybody being asked to press a button.
 *
 * One timeframe per call, in order. Doing all three in one run takes about
 * thirty-five seconds against a live exchange — fine as a one-off, a poor thing to
 * put inside a job that is supposed to finish within its minute. Spread across
 * three runs it is invisible, and a run that dies halfway costs one timeframe
 * rather than the lot.
 *
 * Progress is recorded rather than inferred from row counts, because "does 1m have
 * enough candles?" has no honest answer: the ingest adds one a minute for ever, so
 * any threshold is arbitrary and would eventually make this run again for nothing.
 * The row count is still consulted once per timeframe, so an install where an
 * operator has already backfilled by hand walks through to 'done' without
 * refetching anything.
 */
function auto_backfill_step(): ?array
{
    if (!setting_b('auto_backfill', true)) {
        return null;
    }

    $next = (string)setting('auto_backfill_next', '1D');
    if ($next === 'done' || $next === 'stalled') {
        return null;
    }

    // A step is either an ARV timeframe ("1D") or a per-asset one ("ETH:1D").
    // The asset steps run after the ARV chain finishes, giving each watchlist
    // coin the same tiered USD history in asset_candles.
    $assetKey = null;
    $tf = $next;
    if (strpos($next, ':') !== false) {
        [$assetKey, $tf] = explode(':', $next, 2);
    }

    // Schema-9 corrective rebuild. The row-count skip below is exactly what
    // stranded the old-anchor ARV candles when v8 re-queued the backfill: a
    // timeframe already above its floor was advanced past WITHOUT recompute, so
    // its old-anchor values survived while fresh ingest wrote new-anchor minutes
    // -> the end-of-chart spike. While arv_candles_rebuild_v9 is set we therefore
    // do NOT skip on row count for ARV (non-asset) timeframes: every ARV frame is
    // re-run through backfill_tf() so it is recomputed against the current anchor
    // via index_price() (ON DUPLICATE KEY UPDATE, candles only, no money). Assets
    // keep the normal row-count skip. The flag is cleared once the ARV chain has
    // been fully rebuilt (see below), so this is a one-pass corrective, not a
    // permanent re-fetch loop.
    $rebuildArv = ($assetKey === null) && setting_b('arv_candles_rebuild_v9', false);

    $have = $assetKey !== null
        ? (int)(qval('SELECT COUNT(*) FROM asset_candles WHERE asset_key = ? AND tf = ?', [$assetKey, $tf]) ?? 0)
        : (int)(qval('SELECT COUNT(*) FROM arv_candles WHERE tf = ?', [$tf]) ?? 0);
    if (!$rebuildArv && $have >= auto_backfill_floor($tf)) {
        $after = auto_backfill_after($next);
        setting_set('auto_backfill_next', $after);
        // If skipping this step lands the chain past the ARV frames (into the
        // asset chain or 'done'), the ARV rebuild is complete — clear the flag.
        if (setting_b('arv_candles_rebuild_v9', false) && (strpos($after, ':') !== false || $after === 'done')) {
            setting_set('arv_candles_rebuild_v9', '');
        }
        return ['step' => $next, 'skipped' => 'already holds ' . $have . ' candles'];
    }

    if (!feed_lock('backfill')) {
        return ['step' => $next, 'skipped' => 'another worker is backfilling'];
    }

    try {
        $r = $assetKey !== null ? backfill_asset_tf($assetKey, $tf) : backfill_tf($tf);
        $after = auto_backfill_after($next);
        setting_set('auto_backfill_next', $after);
        setting_set('auto_backfill_fails', '0');
        setting_set('auto_backfill_fail_step', '');
        // Schema-9: the moment the ARV chain finishes (the next step is an asset
        // step "ETH:1D" or 'done'), the full ARV candle rebuild is complete, so
        // clear the corrective flag and fall back to the normal row-count skip.
        if (setting_b('arv_candles_rebuild_v9', false) && (strpos($after, ':') !== false || $after === 'done')) {
            setting_set('arv_candles_rebuild_v9', '');
        }
        $r['auto'] = true;
        return $r;
    } catch (Throwable $e) {
        // An exchange that will not page history is normal and usually temporary,
        // so this retries on the next run. But not for ever, and — crucially — the
        // failure is isolated to the ONE step that failed. The fail counter is
        // scoped to the current step (recorded in auto_backfill_fail_step): the
        // moment the step changes the count starts fresh, so a coin/timeframe an
        // exchange refuses to page (e.g. a weekly a given asset will not serve)
        // can no longer burn a shared budget and strand every later coin.
        //
        // After twenty refusals of the SAME step we SKIP past it to the next step
        // in the chain rather than stalling the whole chain, so ARV -> ETH -> SOL
        // -> XRP keeps walking even when one asset/timeframe is permanently
        // unpageable. Only the final step skipping lands the chain on 'done'; it
        // never lands on 'stalled'. (An operator who wants a hard stop can still
        // set auto_backfill to false.)
        $failStep = (string)setting('auto_backfill_fail_step', '');
        $fails    = $failStep === $next ? setting_i('auto_backfill_fails', 0) + 1 : 1;
        setting_set('auto_backfill_fail_step', $next);
        setting_set('auto_backfill_fails', (string)$fails);
        if ($fails >= 20) {
            // Give up on this one step, not the chain: advance and reset so the
            // next step gets a clean budget.
            setting_set('auto_backfill_next', auto_backfill_after($next));
            setting_set('auto_backfill_fails', '0');
            setting_set('auto_backfill_fail_step', '');
            cron_record('backfill.auto', 'fail', 'skipped ' . $next . ' after ' . $fails
                . ' attempts: ' . $e->getMessage());
            return ['step' => $next, 'skipped' => 'unpageable after ' . $fails . ' attempts',
                    'failed' => $e->getMessage()];
        }
        cron_record('backfill.auto', 'fail', $e->getMessage());
        return ['step' => $next, 'failed' => $e->getMessage(), 'attempt' => $fails];
    } finally {
        feed_unlock('backfill');
    }
}

function auto_backfill_after(string $step): string
{
    // Deep history first, then progressively finer recent windows:
    //   1D -> 1W -> 1h -> 15m -> 5m -> 1m
    // 1W derives from daily data so it is cheap and comes right after 1D. The
    // sub-hour frames (15m, 5m, 1m) only cover the recent window a free API will
    // page — the chart's tick-by-tick view lives there — so they come last.
    $tfChain = [
        '1D' => '1W', '1W' => '1h', '1h' => '15m',
        '15m' => '5m', '5m' => '1m', '1m' => null,
    ];

    // Assets are backfilled after the ARV chain, each running the same tf chain.
    // Order: ARV -> ETH -> SOL -> XRP -> done.
    $assets  = watchlist_keys();
    $assetKey = null;
    $tf = $step;
    if (strpos($step, ':') !== false) {
        [$assetKey, $tf] = explode(':', $step, 2);
    }

    $nextTf = array_key_exists($tf, $tfChain) ? $tfChain[$tf] : null;
    if ($nextTf !== null) {
        return $assetKey !== null ? ($assetKey . ':' . $nextTf) : $nextTf;
    }

    // This tf chain is complete. Move to the first tf of the next asset.
    if ($assetKey === null) {
        // ARV chain just finished — start the first watchlist asset.
        return $assets ? ($assets[0] . ':1D') : 'done';
    }
    $idx = array_search($assetKey, $assets, true);
    if ($idx !== false && $idx + 1 < count($assets)) {
        return $assets[$idx + 1] . ':1D';
    }
    return 'done';
}

/**
 * Roughly how many candles a filled timeframe holds.
 *
 * A floor, not a count. The only question being asked is "is this empty or has it
 * been filled?", and an exact figure would be wrong the moment an exchange had a
 * gap in its history.
 */
function auto_backfill_floor(string $tf): int
{
    $launch = strtotime((string)setting('launch_at', '2015-07-20 00:00:00'));
    $days   = max(1, (int)floor((time() - $launch) / 86400));

    switch ($tf) {
        case '1D': return (int)($days * 0.9);
        case '1W': return (int)(($days / 7) * 0.9);
        case '1h': return 1500;
        // Recent-window frames. backfill_tf() pages 15m for ~90 days
        // (~90*96=8640 rows) and 5m for ~30 days (~30*288=8640 rows); the floor is
        // a "is it empty or filled?" check, deliberately well under the ideal so a
        // gap in an exchange's history does not wedge the chain.
        case '15m': return 3000;
        case '5m':  return 3000;
        case '1m': return 5000;
        default:   return 1;
    }
}

/* ============================================================= web tick ==== */

/**
 * Do the scheduled work from inside an ordinary page request, if nobody else has.
 *
 * The cron is what makes this platform reliable and it stays the documented way to
 * run it. But a site that is silently dead until a cron line exists is a poor first
 * hour, and it is an easy step to miss — worse, the failure it produces is every
 * order being refused, which reads as a broken exchange rather than as a missing
 * scheduler.
 *
 * So a page load that finds the price behind refreshes it. Guarded three ways:
 *
 *   the lock, so ten simultaneous visitors cause one fetch rather than ten;
 *   a floor on how often it may run at all, marked *before* the work rather than
 *     after, so a feed that keeps failing cannot put an upstream call in front of
 *     every request;
 *   a setting, so an operator with a healthy cron can switch it off completely.
 *
 * It is deliberately not as good as the cron, and the honest description is worth
 * keeping in mind: it only runs when somebody visits, so an idle site has an idle
 * chart, and the visitor who triggers it is the one who waits for it.
 */
/**
 * Apply any pending schema change.
 *
 * Deliberately not only on the cron. A deployment that needs a migration is
 * *broken* until it runs, and tying the repair to a scheduler that the operator may
 * not have configured yet means the site stays broken indefinitely — which is
 * exactly what happened: adding a column to `otps` took signup and login down on
 * every install whose cron had not yet had its turn.
 *
 * Gated on the version number, which is a memoised settings read and therefore
 * free, so the information_schema queries only happen when there is genuinely
 * something behind. Locked, so several workers arriving at once do not all try to
 * ALTER the same table.
 */
function schema_catch_up(): array
{
    if (setting_i('schema_version', 0) >= ARV_SCHEMA_VERSION) {
        return [];
    }
    if (!feed_lock('migrate')) {
        return [];
    }
    try {
        return arv_migrations(db());
    } catch (Throwable $e) {
        error_log('[arv] migration failed: ' . $e->getMessage());
        return [];
    } finally {
        feed_unlock('migrate');
    }
}

function tick_if_needed(): ?array
{
    // Before the freshness check, and before the `web_tick` switch: a database
    // behind its code needs fixing whether or not the price needs refreshing, and
    // whether or not an operator has turned the fallback off.
    $migrated = schema_catch_up();

    if (!setting_b('web_tick', true)) {
        return $migrated ? ['migrated' => $migrated] : null;
    }

    // The series is per-minute, so refreshing more often than that buys nothing —
    // but waiting for the full staleness limit would leave trading flipping on and
    // off around the boundary. A minute is both the useful and the natural period.
    $last = (int)(qval('SELECT UNIX_TIMESTAMP(ts) FROM arv_candles WHERE tf = "1m"
                         ORDER BY ts DESC LIMIT 1') ?? 0);
    if ($last > 0 && (time() - $last) < 60) {
        return null;
    }

    $floor = setting_i('web_tick_min_seconds', 45);
    if ((time() - web_tick_at()) < $floor) {
        return null;
    }

    if (!feed_lock('tick')) {
        return null;
    }

    try {
        // Read again under the lock, and from the table rather than from
        // settings() — that is memoised for the request, so the cached copy would
        // give the same answer as the check above and the second look would be
        // worthless.
        if ((time() - web_tick_at()) < $floor) {
            return null;
        }
        // Marked before the work, not after: a fetch that throws still counts as an
        // attempt, or a dead upstream would be retried on every single request.
        setting_set('web_tick_at', (string)time());

        $out = ['ingest' => ingest_prices()];

        // With no cron there is nobody else to match resting orders, and nobody to
        // let the treasury take over a sell that never found a buyer — so a holder
        // trying to exit would simply wait for ever. Both are database-only and
        // cheap; the fetch above is the expensive part of this function.
        try {
            $out['match']   = run_matching(arv_nav());
            $out['expired'] = expire_orders();
        } catch (RuntimeException $e) {
            $out['match'] = ['skipped' => $e->getMessage()];
        }

        cron_record('web_tick', 'ok', 'ran from a page request');
        return $out;
    } catch (Throwable $e) {
        // This is a side effect of somebody reading a page. It must never be the
        // reason that page fails.
        cron_record('web_tick', 'fail', $e->getMessage());
        return null;
    } finally {
        feed_unlock('tick');
    }
}

/** Uncached read of the last web tick. */
function web_tick_at(): int
{
    return (int)(qval('SELECT svalue FROM settings WHERE skey = "web_tick_at"') ?? 0);
}
