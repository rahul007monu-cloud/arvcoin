<?php
/**
 * Public market data — price, candles, watchlist.
 *
 * No authentication: the chart and the ticker are visible before anyone signs in,
 * because a product that hides its price until you register is asking for trust it
 * has not earned.
 *
 * Candles are served from this database rather than proxied from an exchange. That
 * is what makes the five-year history possible — no public API will hand over
 * that range on demand, so the ingest worker accumulates it here.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';
require __DIR__ . '/_feed.php';

$action = $_GET['action'] ?? 'snapshot';

switch ($action) {
    case 'snapshot':      handle_snapshot();      break;
    case 'candles':       handle_candles();       break;
    case 'asset_candles': handle_asset_candles(); break;
    case 'watchlist':     handle_watchlist();     break;
    case 'stats':         handle_stats();         break;
    default:
        json_fail(400, 'Unknown action.');
}

/* =========================================================== snapshot ===== */

function handle_snapshot(): void
{
    require_method('GET');

    // Every page asks for this on load, which makes it the one place where a stale
    // price can be noticed and fixed before anybody is affected by it. If a
    // scheduler is running, this is a single comparison and returns immediately;
    // if there is none, this is what keeps the platform working. See
    // tick_if_needed() for the guards.
    tick_if_needed();

    $meta   = arv_nav_meta();
    $launch = strtotime((string)setting('launch_at', '2015-07-20 00:00:00'));
    $base   = setting_f('arv_base_inr', 1.78);

    $stats = $meta['nav'] !== null ? window_stats((float)$meta['nav']) : null;

    // The identity the whole product rests on, returned so the UI can display
    // both sides and let a reader check it rather than take it on trust.
    $btc = q1('SELECT close FROM asset_candles WHERE asset_key = "BTC" AND tf = "1m"
                ORDER BY ts DESC LIMIT 1');
    $fx  = qval('SELECT usd_inr FROM fx_rates ORDER BY day DESC LIMIT 1');

    $baseUsd = setting_f('base_btc_usd', 47110.33);
    $baseFx  = setting_f('base_fx_usd_inr', 73.073);
    $baseInr = $baseUsd * $baseFx;
    $btcInr  = ($btc && $fx) ? (float)$btc['close'] * (float)$fx : null;

    json_ok([
        'price'  => $meta,
        'stats'  => $stats,
        'index'  => [
            'base'        => $base,
            'launchAt'    => gmdate('c', $launch),
            'baseBtcUsd'  => $baseUsd,
            'baseFxUsdInr'=> $baseFx,
            'baseBtcInr'  => $baseInr,
            'btcUsd'      => $btc ? (float)$btc['close'] : null,
            'btcInr'      => $btcInr,
            'fxUsdInr'    => $fx !== null ? (float)$fx : null,
            'btcChangePct'=> $btcInr !== null ? (($btcInr - $baseInr) / $baseInr) * 100 : null,
            'arvChangePct'=> $meta['nav'] !== null ? ((($meta['nav'] - $base) / $base) * 100) : null,
            'formula'     => 'ARV = ₹1 × ( BTC now ÷ BTC at launch ), both in rupees',
        ],
        'feed'   => feed_health(),
    ]);
}

/** 24h and since-launch statistics from stored candles. */
function window_stats(float $nav): array
{
    $base = setting_f('arv_base_inr', 1.0);

    $day = q1(
        'SELECT MAX(high) AS h, MIN(low) AS l, SUM(volume) AS v
           FROM arv_candles
          WHERE tf = "1m" AND ts >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)'
    );
    $open24 = qval(
        'SELECT open FROM arv_candles
          WHERE tf = "1m" AND ts >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
          ORDER BY ts ASC LIMIT 1'
    );

    $allTime = q1('SELECT MAX(high) AS h, MIN(low) AS l FROM arv_candles WHERE tf = "1D"');

    $o = $open24 !== null ? (float)$open24 : $nav;

    return [
        'price'          => $nav,
        'open24h'        => $o,
        'change24hPct'   => $o > 0 ? (($nav - $o) / $o) * 100 : 0,
        'high24h'        => $day && $day['h'] !== null ? (float)$day['h'] : $nav,
        'low24h'         => $day && $day['l'] !== null ? (float)$day['l'] : $nav,
        'volume24h'      => $day && $day['v'] !== null ? (float)$day['v'] : 0,
        'allTimeHigh'    => $allTime && $allTime['h'] !== null ? (float)$allTime['h'] : $nav,
        'allTimeLow'     => $allTime && $allTime['l'] !== null ? (float)$allTime['l'] : $nav,
        'sinceLaunchPct' => $base > 0 ? (($nav - $base) / $base) * 100 : 0,
    ];
}

/**
 * Whether the price feed is healthy.
 *
 * Worth exposing rather than hiding: when a chart looks wrong the first useful
 * question is which source answered and how long ago, and trading pauses on a
 * stale feed so a user deserves to see why.
 */
function feed_health(): array
{
    $run = q1('SELECT * FROM cron_runs WHERE job = "ingest"');
    $meta = arv_nav_meta();

    return [
        'lastRunAt'   => $run['last_run_at'] ?? null,
        'lastOkAt'    => $run['last_ok_at'] ?? null,
        'status'      => $run['last_status'] ?? 'never run',
        'message'     => $run['last_message'] ?? '',
        'source'      => $meta['source'],
        'ageSeconds'  => $meta['ageSeconds'],
        'stale'       => $meta['stale'],
        'tradingOpen' => $meta['nav'] !== null && !$meta['stale'],
        'note'        => $meta['nav'] === null
            ? 'The price cron has not run yet. Trading is closed until it does.'
            : ($meta['stale']
                ? 'The feed is behind, so trading is paused rather than filling at a stale price.'
                : 'Live.'),
    ];
}

/* ============================================================ candles ===== */

function handle_candles(): void
{
    require_method('GET');

    $tf    = (string)($_GET['tf'] ?? '15m');
    $days  = isset($_GET['days']) && $_GET['days'] !== '' ? (int)$_GET['days'] : null;
    $limit = max(10, min(3000, (int)($_GET['limit'] ?? 2600)));

    if (!in_array($tf, ['1m', '5m', '15m', '1h', '4h', '1D', '1W'], true)) {
        json_fail(422, 'Unknown timeframe.');
    }

    $launch = strtotime((string)setting('launch_at', '2015-07-20 00:00:00'));
    $from   = $days !== null ? max($launch, time() - $days * 86400) : $launch;

    $rows = q(
        'SELECT UNIX_TIMESTAMP(ts) AS t, open, high, low, close, volume
           FROM arv_candles
          WHERE tf = ? AND ts >= FROM_UNIXTIME(?)
          ORDER BY ts ASC
          LIMIT ?',
        [$tf, $from, $limit]
    )->fetchAll();

    // An empty series is usually "backfill has not run", which is worth saying
    // rather than rendering a blank chart.
    if (!$rows) {
        json_ok([
            'tf' => $tf, 'candles' => [], 'count' => 0,
            'hint' => 'No candles stored for this timeframe yet. An operator needs to run the '
                    . 'history backfill from the Operations page.',
        ]);
    }

    json_ok([
        'tf'      => $tf,
        'count'   => count($rows),
        'from'    => gmdate('c', (int)$rows[0]['t']),
        'to'      => gmdate('c', (int)$rows[count($rows) - 1]['t']),
        'candles' => array_map(static fn($r) => [
            't' => (int)$r['t'] * 1000,
            'o' => (float)$r['open'],
            'h' => (float)$r['high'],
            'l' => (float)$r['low'],
            'c' => (float)$r['close'],
            'v' => (float)$r['volume'],
        ], $rows),
    ]);
}

/* ====================================================== asset candles ===== */

/**
 * Per-asset candles, in USD, from asset_candles.
 *
 * The dollar twin of handle_candles(): same request shape and same response
 * shape, but keyed by an asset (BTC, ETH, SOL, XRP) and quoted in dollars exactly
 * as the exchange reported it. asset_candles carries no fx_rate — these assets
 * are display-only, weight 0, and never converted to rupees or fed into the
 * index. It powers the clickable coin charts on the trade screen.
 *
 * The key is allowlisted so this can never be turned into an arbitrary read of
 * whatever asset_key a caller invents.
 */
function handle_asset_candles(): void
{
    require_method('GET');

    $key   = strtoupper((string)($_GET['key'] ?? ''));
    $tf    = (string)($_GET['tf'] ?? '1m');
    $days  = isset($_GET['days']) && $_GET['days'] !== '' ? (int)$_GET['days'] : null;
    $limit = max(10, min(3000, (int)($_GET['limit'] ?? 2600)));

    if (!in_array($key, ['BTC', 'ETH', 'SOL', 'XRP'], true)) {
        json_fail(422, 'Unknown asset.');
    }
    if (!in_array($tf, ['1m', '5m', '15m', '1h', '4h', '1D', '1W'], true)) {
        json_fail(422, 'Unknown timeframe.');
    }

    // Coins have no launch anchor of their own, so the window is simply the
    // requested lookback; without one, everything stored.
    $from = $days !== null ? max(0, time() - $days * 86400) : 0;

    $rows = q(
        'SELECT UNIX_TIMESTAMP(ts) AS t, open, high, low, close, volume
           FROM asset_candles
          WHERE asset_key = ? AND tf = ? AND ts >= FROM_UNIXTIME(?)
          ORDER BY ts ASC
          LIMIT ?',
        [$key, $tf, $from, $limit]
    )->fetchAll();

    if (!$rows) {
        json_ok([
            'key' => $key, 'tf' => $tf, 'candles' => [], 'count' => 0,
            'hint' => 'No candles stored for ' . $key . ' at this timeframe yet. An operator '
                    . 'needs to run the history backfill from the Operations page.',
        ]);
    }

    json_ok([
        'key'     => $key,
        'tf'      => $tf,
        'count'   => count($rows),
        'from'    => gmdate('c', (int)$rows[0]['t']),
        'to'      => gmdate('c', (int)$rows[count($rows) - 1]['t']),
        'candles' => array_map(static fn($r) => [
            't' => (int)$r['t'] * 1000,
            'o' => (float)$r['open'],
            'h' => (float)$r['high'],
            'l' => (float)$r['low'],
            'c' => (float)$r['close'],
            'v' => (float)$r['volume'],
        ], $rows),
    ]);
}

/* ========================================================== watchlist ===== */

function handle_watchlist(): void
{
    require_method('GET');

    $out = [];
    foreach (['BTC' => 'Bitcoin', 'ETH' => 'Ethereum', 'SOL' => 'Solana', 'XRP' => 'XRP'] as $key => $name) {
        $last = q1('SELECT close, UNIX_TIMESTAMP(ts) AS t FROM asset_candles
                     WHERE asset_key = ? AND tf = "1m" ORDER BY ts DESC LIMIT 1', [$key]);
        $open = qval('SELECT open FROM asset_candles
                       WHERE asset_key = ? AND tf = "1m"
                         AND ts >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
                       ORDER BY ts ASC LIMIT 1', [$key]);

        $price = $last ? (float)$last['close'] : null;
        $o     = $open !== null ? (float)$open : $price;

        $out[] = [
            'key'       => $key,
            'name'      => $name,
            'priceUsd'  => $price,
            'change24h' => ($price !== null && $o) ? (($price - $o) / $o) * 100 : null,
            'asOf'      => $last ? gmdate('c', (int)$last['t']) : null,
            // Stated per row so nobody assumes Ethereum or Solana moves ARV.
            'inIndex'   => $key === 'BTC',
            'weight'    => $key === 'BTC' ? 1.0 : 0.0,
        ];
    }

    $fx = qval('SELECT usd_inr FROM fx_rates ORDER BY day DESC LIMIT 1');
    json_ok(['assets' => $out, 'fxUsdInr' => $fx !== null ? (float)$fx : null]);
}

/* ============================================================== stats ===== */

function handle_stats(): void
{
    require_method('GET');
    $meta = arv_nav_meta();
    json_ok([
        'price' => $meta,
        'stats' => $meta['nav'] !== null ? window_stats((float)$meta['nav']) : null,
        'coverage' => q(
            'SELECT tf, COUNT(*) AS candles, MIN(ts) AS first_ts, MAX(ts) AS last_ts
               FROM arv_candles GROUP BY tf ORDER BY FIELD(tf,"1m","5m","15m","1h","4h","1D","1W")'
        )->fetchAll(),
    ]);
}
