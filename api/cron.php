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
// The P2P escrow cores + the Phase-2 maintenance sweep. Its money movements
// reuse wallet_apply()/ledger_add() exactly as the index path does.
require __DIR__ . '/_p2p.php';
// Brings _schema.php with it, for the migration step. Requiring _schema.php here
// as well is a redeclaration fatal — a plain require does not care that
// require_once already loaded it, and the whole endpoint dies with an empty
// response, which took the price feed down with it.
require __DIR__ . '/_feed.php';

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
            $out['p2p']    = job_p2p_maintenance();
            $out['tiers']  = job_tiers();
            // Builds the chart on the first few runs after an install, then costs
            // one query a minute for ever after. Nobody should have to press a
            // button to get a chart that the launch date already determines.
            $out['backfill'] = auto_backfill_step();
            // Schema catch-up. arv_schema() is all CREATE TABLE IF NOT EXISTS, which
            // does nothing for a column added to a table that already exists — so a
            // deployed update would otherwise reference a column its own database
            // has never had. Costs one information_schema query when current.
            $migrated = schema_catch_up();
            if ($migrated) {
                $out['migrated'] = $migrated;
            }
            break;

        case 'ingest':   $out['ingest'] = job_ingest(); break;
        case 'match':    $out['match']  = job_match();  break;
        case 'backfill': $out['backfill'] = job_backfill(); break;
        case 'tiers':    $out['tiers']  = job_tiers();  break;
        case 'p2p':      $out['p2p']    = job_p2p_maintenance(); break;

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
    return ingest_prices();
}

/* ============================================================ backfill ==== */

/**
 * Operator-initiated backfill.
 *
 * The work lives in _feed.php; this is the HTTP shape of it. Kept separate because
 * the automatic path calls the same function with no request to read.
 */
function job_backfill(): array
{
    return backfill_tf(
        (string)($_GET['tf'] ?? input_str('tf', '1D')),
        (int)($_GET['days'] ?? input_int('days', 0))
    );
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


/* ==================================================== p2p maintenance ===== */

/**
 * The P2P Phase-2 timer sweep.
 *
 * Runs every tick and is idempotent: it acts only on rows whose status and age
 * qualify, each in its own transaction with the row locked FOR UPDATE. Three
 * cases (see p2p_maintenance in _p2p.php):
 *   - an unmatched P2P order past the match TTL, with no live trade → expired
 *     (a sell returns its remaining escrow to the seller);
 *   - a matched trade the buyer never paid, past the pay TTL → auto-cancelled
 *     through the Phase-1 core (escrow back to the seller) and marked expired;
 *   - a paid trade the seller never confirmed, past the confirm TTL → disputed,
 *     which moves NO money and waits for an operator.
 * No price feed is needed — everything settles on the escrow already held — so it
 * runs even when ingest is skipped on a stale feed.
 */
function job_p2p_maintenance(): array
{
    $r = p2p_maintenance();
    cron_record('p2p_maintenance', 'ok', sprintf(
        '%d orders expired, %d matched auto-cancelled (unpaid), %d sent to dispute (unconfirmed)',
        $r['ordersExpired'], $r['tradesExpired'], $r['tradesDisputed']
    ));
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
