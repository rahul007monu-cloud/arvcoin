<?php
/**
 * Money, pricing, cost basis and tax — server side.
 *
 * This is the authority. `js/ledger.js` quotes the same arithmetic in the browser
 * so a user sees the numbers before committing, but nothing here trusts that:
 * every figure is recomputed from the database before a balance changes.
 *
 * ---------------------------------------------------------------------------
 * Precision
 * ---------------------------------------------------------------------------
 * Rupees are integer paise. Units are handled as integer "u8" — units × 10^8 —
 * and only converted to a DECIMAL(28,8) string at the database boundary.
 *
 * That choice matters. PHP floats carry ~15-16 significant digits; a holding of
 * 10,000.12345678 units already uses 13. Multiply two of those, or accumulate a
 * few hundred partial fills, and the last decimal starts drifting. Integers
 * cannot drift. At 10^8 scale a 64-bit int holds ~90 million units, which is far
 * beyond anything this product will issue.
 *
 * ---------------------------------------------------------------------------
 * Tax
 * ---------------------------------------------------------------------------
 * Two separate things, never merged:
 *
 *   TDS (s.194S)    1% of gross consideration, WITHHELD from the seller at the
 *                   moment of a fill. 20% where no PAN is on record (s.206AA).
 *                   Only once the year's transfers cross the threshold — and
 *                   crossing it makes the whole transfer liable, not the excess.
 *
 *   Tax (s.115BBH)  30% + 4% cess = 31.2% of the gain. NOT withheld. The
 *                   holder's own liability at filing. Recorded and reported so
 *                   there is no surprise in July; never collected here.
 *
 * Only cost of acquisition is deductible — platform fees are not. Losses cannot
 * be set off against anything, or carried forward.
 */

declare(strict_types=1);

const U8 = 100000000;   // 10^8

/* ======================================================= unit helpers ====== */

function u8(string $decimal): int
{
    return (int)round((float)$decimal * U8);
}

function u8str(int $u): string
{
    $neg  = $u < 0;
    $u    = abs($u);
    $whole = intdiv($u, U8);
    $frac  = $u % U8;
    return ($neg ? '-' : '') . $whole . '.' . str_pad((string)$frac, 8, '0', STR_PAD_LEFT);
}

/** Paise realised by selling u8 units at a NAV. Floored — never over-pay. */
function u8_to_paise(int $units8, float $nav): int
{
    return (int)floor(($units8 / U8) * $nav * 100);
}

/** Units bought by a paise amount at a NAV. Floored — never over-issue. */
function paise_to_u8(int $paise, float $nav): int
{
    if ($nav <= 0) {
        return 0;
    }
    return (int)floor((($paise / 100) / $nav) * U8);
}

/* ============================================================ pricing ===== */

/**
 * Current ARV price in rupees.
 *
 * Read from the stored candle series, not from an exchange call. A trade must not
 * depend on a third party being reachable at the instant somebody presses
 * confirm — and it must not be priceable from a stale number either, so anything
 * older than `price_max_age_seconds` refuses rather than guessing.
 *
 * @throws RuntimeException when no fresh price exists
 */
function arv_nav(bool $allowStale = false): float
{
    $row = q1('SELECT close, UNIX_TIMESTAMP(ts) AS ts
               FROM arv_candles WHERE tf = "1m" ORDER BY ts DESC LIMIT 1');

    if (!$row) {
        throw new RuntimeException(
            'No price has been recorded yet. The price cron has not run — see SETUP.md.'
        );
    }

    $age = time() - (int)$row['ts'];
    $max = setting_i('price_max_age_seconds', 600);

    if (!$allowStale && $age > $max) {
        throw new RuntimeException(sprintf(
            'The latest price is %d minutes old, so trading is paused. This is deliberate — '
            . 'nothing will be filled at a stale number. Balances are unaffected.',
            (int)ceil($age / 60)
        ));
    }

    return (float)$row['close'];
}

function arv_nav_meta(): array
{
    $row = q1('SELECT close, ts, UNIX_TIMESTAMP(ts) AS uts, source
               FROM arv_candles WHERE tf = "1m" ORDER BY ts DESC LIMIT 1');
    if (!$row) {
        return ['nav' => null, 'ageSeconds' => null, 'stale' => true, 'source' => null];
    }
    $age = time() - (int)$row['uts'];
    return [
        'nav'        => (float)$row['close'],
        'asOf'       => $row['ts'],
        'ageSeconds' => $age,
        'stale'      => $age > setting_i('price_max_age_seconds', 600),
        'source'     => $row['source'],
    ];
}

/**
 * The index formula, applied to a Bitcoin price.
 *
 *   ARV = ARV_BASE × ( BTC_now_in_quote / BTC_launch_in_quote )
 *
 * Kept here as well as in the cron so the admin panel can verify that the stored
 * series matches the definition rather than taking it on trust.
 */
function index_price(float $btcUsd, float $fxUsdInr): float
{
    $base    = setting_f('arv_base_inr', 21.08);
    $baseUsd = setting_f('base_btc_usd', 277.89);
    $baseFx  = setting_f('base_fx_usd_inr', 63.50);
    $quote   = (string)setting('quote', 'INR');

    if ($baseUsd <= 0) {
        throw new RuntimeException('base_btc_usd is not configured');
    }

    if ($quote === 'INR') {
        $nowQuote  = $btcUsd * $fxUsdInr;
        $baseQuote = $baseUsd * $baseFx;
    } else {
        $nowQuote  = $btcUsd;
        $baseQuote = $baseUsd;
    }

    return $base * ($nowQuote / $baseQuote);
}

/** Execution price. A real order does not fill at the mid. */
function exec_nav(float $nav, string $side): float
{
    $slip = setting_f('slippage_pct', 0.05);
    if ($slip <= 0) {
        return $nav;
    }
    return $side === 'buy' ? $nav * (1 + $slip / 100) : $nav * (1 - $slip / 100);
}

/* =============================================================== fees ===== */

/**
 * Fees for a specific user, after any reward tier they have earned.
 *
 * Tiers are a discount on the platform's own margin — real value, funded from
 * revenue. Deliberately not a cash bonus scaled to referred volume, which would
 * read as a promised return and be a promise the treasury cannot keep.
 */
function user_fees(array $user): array
{
    $entry = setting_f('entry_fee_pct', 0.5);
    $exit  = setting_f('exit_fee_pct', 0.5);
    $gst   = setting_f('gst_pct', 18);

    $tier = (string)($user['tier_id'] ?? '');
    if ($tier !== '') {
        foreach (arv_reward_tiers() as $t) {
            if ($t['id'] !== $tier) {
                continue;
            }
            if ($t['entryFeePct'] !== null) {
                $entry = (float)$t['entryFeePct'];
            }
            if ($t['exitFeePct'] !== null) {
                $exit = (float)$t['exitFeePct'];
            }
            // A time-limited perk expires on its own rather than needing a job to
            // take it away.
            if (!empty($t['days']) && !empty($user['tier_earned_at'])) {
                $until = strtotime($user['tier_earned_at']) + ((int)$t['days'] * 86400);
                if (time() > $until) {
                    $entry = setting_f('entry_fee_pct', 0.5);
                    $exit  = setting_f('exit_fee_pct', 0.5);
                    $tier  = '';
                }
            }
            break;
        }
    }

    return ['entryPct' => $entry, 'exitPct' => $exit, 'gstPct' => $gst, 'tier' => $tier];
}

/** Mirrors REWARD_TIERS in arv-config.js. Kept server-side because it decides fees. */
function arv_reward_tiers(): array
{
    return [
        ['id' => 'bronze',   'label' => 'Bronze',   'metric' => 'ratio', 'threshold' => 1,         'entryFeePct' => 0,    'exitFeePct' => null, 'days' => 30,   'perk' => 'Entry fee waived for 30 days'],
        ['id' => 'silver',   'label' => 'Silver',   'metric' => 'ratio', 'threshold' => 5,         'entryFeePct' => 0.25, 'exitFeePct' => null, 'days' => null, 'perk' => 'Entry fee 0.25%, permanently'],
        ['id' => 'gold',     'label' => 'Gold',     'metric' => 'ratio', 'threshold' => 10,        'entryFeePct' => 0.25, 'exitFeePct' => 0.25, 'days' => null, 'perk' => 'Entry and exit fee 0.25%'],
        ['id' => 'platinum', 'label' => 'Platinum', 'metric' => 'ratio', 'threshold' => 100,       'entryFeePct' => 0,    'exitFeePct' => 0.25, 'days' => null, 'perk' => 'No entry fee, exit 0.25%'],
        ['id' => 'sterling', 'label' => 'Sterling', 'metric' => 'paise', 'threshold' => 10000000,  'entryFeePct' => 0,    'exitFeePct' => 0.25, 'days' => null, 'perk' => 'Priority withdrawal'],
        ['id' => 'obsidian', 'label' => 'Obsidian', 'metric' => 'paise', 'threshold' => 100000000, 'entryFeePct' => 0,    'exitFeePct' => 0,    'days' => null, 'perk' => 'Zero fees and a dedicated line'],
    ];
}

/* ================================================================ TDS ===== */

/**
 * Whether TDS applies to a transfer, and at what rate.
 *
 * The threshold is an annual aggregate on gross consideration. Crossing it makes
 * the entire transfer liable, not merely the amount above it.
 */
function tds_assess(int $userId, int $grossPaise, ?array $kyc = null): array
{
    $kyc = $kyc ?? q1('SELECT pan FROM kyc WHERE user_id = ?', [$userId]);
    $hasPan = !empty($kyc['pan']);

    $user = q1('SELECT is_specified_person FROM users WHERE id = ?', [$userId]);
    $specified = !empty($user['is_specified_person']);

    $threshold = $specified
        ? setting_i('tds_threshold_specified_paise', 5000000)
        : setting_i('tds_threshold_paise', 1000000);

    $rate = $hasPan
        ? setting_f('tds_pct', 1)
        : setting_f('tds_pct_no_pan', 20);

    $fy    = fy_of();
    $prior = (int)(qval(
        'SELECT COALESCE(SUM(gross_paise),0) FROM trades WHERE seller_id = ? AND fy = ?',
        [$userId, $fy]
    ) ?? 0);

    $aggregate = $prior + $grossPaise;
    $applies   = $aggregate > $threshold;

    return [
        'applies'        => $applies,
        'ratePct'        => $rate,
        'hasPan'         => $hasPan,
        'thresholdPaise' => $threshold,
        'priorPaise'     => $prior,
        'aggregatePaise' => $aggregate,
        'headroomPaise'  => max(0, $threshold - $prior),
        'tdsPaise'       => $applies ? pct_of($grossPaise, $rate) : 0,
        'reason'         => !$applies
            ? sprintf('Below the ₹%s annual threshold for %s', number_format($threshold / 100), $fy)
            : ($hasPan
                ? sprintf('Section 194S, %s%% of gross consideration', rtrim(rtrim(number_format($rate, 2, '.', ''), '0'), '.'))
                : sprintf('No PAN on record — section 206AA applies %s%%', rtrim(rtrim(number_format($rate, 2, '.', ''), '0'), '.'))),
    ];
}

/* ========================================================== FIFO lots ===== */

/**
 * Consume the oldest lots first, inside the caller's transaction.
 *
 * Rows are locked FOR UPDATE and read in acquisition order, which is both the
 * accounting requirement and a fixed lock order — two concurrent sells for the
 * same user take the same locks in the same sequence and therefore queue rather
 * than deadlock.
 *
 * Partial consumption pro-rates the lot's original cost. Rounding is applied per
 * slice so that repeatedly splitting a lot still sums back to its full cost
 * instead of leaking a paise each time.
 *
 * @return array{consumed:array,costPaise:int,shortfall8:int}
 */
function consume_lots(PDO $pdo, int $userId, int $needU8): array
{
    $st = $pdo->prepare(
        'SELECT id, units, units_remaining, cost_paise, nav, acquired_at
         FROM lots
         WHERE user_id = ? AND units_remaining > 0
         ORDER BY acquired_at ASC, id ASC
         FOR UPDATE'
    );
    $st->execute([$userId]);

    $consumed = [];
    $cost     = 0;
    $need     = $needU8;

    foreach ($st->fetchAll() as $lot) {
        if ($need <= 0) {
            break;
        }
        $availU8 = u8((string)$lot['units_remaining']);
        if ($availU8 <= 0) {
            continue;
        }
        $totalU8 = u8((string)$lot['units']);
        $take    = min($availU8, $need);

        // Pro-rate by the fraction of the original lot being taken.
        $slice = $totalU8 > 0
            ? (int)round((int)$lot['cost_paise'] * ($take / $totalU8))
            : 0;

        $pdo->prepare('UPDATE lots SET units_remaining = ? WHERE id = ?')
            ->execute([u8str($availU8 - $take), $lot['id']]);

        $consumed[] = [
            'lotId'      => (int)$lot['id'],
            'units'      => u8str($take),
            'costPaise'  => $slice,
            'nav'        => (float)$lot['nav'],
            'acquiredAt' => $lot['acquired_at'],
        ];
        $cost += $slice;
        $need -= $take;
    }

    return ['consumed' => $consumed, 'costPaise' => $cost, 'shortfall8' => max(0, $need)];
}

/* ============================================================= quotes ===== */

/**
 * Price a buy.
 *
 * Charges come off the top, so the rupees that actually buy units are less than
 * the rupees committed. `effectiveNav` is what the buyer really paid per unit —
 * the level ARV must reach before this purchase is in profit.
 */
function quote_buy(array $user, int $grossPaise, float $nav): array
{
    $f    = user_fees($user);
    $fee  = pct_of($grossPaise, $f['entryPct']);
    $gst  = pct_of($fee, $f['gstPct']);
    $net  = $grossPaise - $fee - $gst;
    $xnav = exec_nav($nav, 'buy');
    $u    = paise_to_u8($net, $xnav);

    return [
        'side'            => 'buy',
        'grossPaise'      => $grossPaise,
        'feePaise'        => $fee,
        'gstPaise'        => $gst,
        'netInvestPaise'  => $net,
        'nav'             => $nav,
        'execNav'         => $xnav,
        'units8'          => $u,
        'units'           => u8str($u),
        'effectiveNav'    => $u > 0 ? ($grossPaise / 100) / ($u / U8) : 0.0,
        'entryFeePct'     => $f['entryPct'],
        'gstPct'          => $f['gstPct'],
        'tier'            => $f['tier'],
    ];
}

/**
 * Price a sell, including the tax position.
 *
 * Withheld now: exit fee, GST, and TDS. Not withheld: the 30% + cess, which is
 * reported so the holder knows what they will owe at filing.
 *
 * The taxable gain is gross minus cost of acquisition. Fees are deliberately not
 * subtracted — s.115BBH allows no deduction beyond cost, so paying ₹50 in exit
 * fee does not reduce the taxable gain by ₹50.
 */
function quote_sell(array $user, int $unitsU8, float $nav, int $costBasisPaise, ?array $tds = null): array
{
    $f     = user_fees($user);
    $xnav  = exec_nav($nav, 'sell');
    $gross = u8_to_paise($unitsU8, $xnav);
    $fee   = pct_of($gross, $f['exitPct']);
    $gst   = pct_of($fee, $f['gstPct']);

    $tds = $tds ?? tds_assess((int)$user['id'], $gross);

    $pnl  = $gross - $costBasisPaise;
    $gain = max(0, $pnl);
    $loss = max(0, -$pnl);

    $taxPct  = setting_f('vda_gain_pct', 30);
    $cessPct = setting_f('cess_pct', 4);
    $tax     = pct_of($gain, $taxPct);
    $cess    = pct_of($tax, $cessPct);

    $net = $gross - $fee - $gst - $tds['tdsPaise'];

    return [
        'side'              => 'sell',
        'units8'            => $unitsU8,
        'units'             => u8str($unitsU8),
        'nav'               => $nav,
        'execNav'           => $xnav,
        'grossPaise'        => $gross,
        'feePaise'          => $fee,
        'gstPaise'          => $gst,
        'tdsPaise'          => $tds['tdsPaise'],
        'tds'               => $tds,
        'netPayoutPaise'    => $net,
        'costBasisPaise'    => $costBasisPaise,
        'pnlPaise'          => $pnl,
        'realisedGainPaise' => $gain,
        'realisedLossPaise' => $loss,
        'taxPaise'          => $tax,
        'cessPaise'         => $cess,
        'totalTaxPaise'     => $tax + $cess,
        'balanceTaxPaise'   => max(0, ($tax + $cess) - $tds['tdsPaise']),
        'effectiveTaxPct'   => $taxPct * (1 + $cessPct / 100),
        'lossNotSetOff'     => $loss > 0,
        'exitFeePct'        => $f['exitPct'],
        'gstPct'            => $f['gstPct'],
        'tier'              => $f['tier'],
    ];
}

/* ============================================================= ledger ===== */

/**
 * A rupee amount for a ledger note.
 *
 * Fee, GST and TDS entries carry a delta of zero, because the charge is already
 * inside the net figure on the buy or sell entry beside them — posting it again as
 * its own movement would double-count it and break the rule that the ledger sums
 * to the wallet.
 *
 * But an entry that says only "Entry fee 0.5%" leaves the holder to work out what
 * they were actually charged, from a percentage of a number that is not on the
 * row. So the amount goes in the note: it is a statement of fact rather than a
 * movement, which is exactly what these rows are.
 */
function money_note(int $paise): string
{
    return '₹' . number_format($paise / 100, 2);
}

/**
 * Append a ledger entry.
 *
 * The ledger is the book of record; wallet rows are a cached balance that must
 * add up to it. Nothing edits an entry — a correction is a new compensating one,
 * and a database trigger enforces that.
 */
function ledger_add(
    PDO $pdo,
    ?int $userId,
    string $kind,
    int $inrDeltaPaise = 0,
    int $arvDeltaU8 = 0,
    array $opts = []
): int {
    $st = $pdo->prepare(
        'INSERT INTO ledger (user_id, kind, inr_delta_paise, arv_delta_units, nav, ref, related_id, note, fy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([
        $userId,
        $kind,
        $inrDeltaPaise,
        u8str($arvDeltaU8),
        $opts['nav'] ?? null,
        (string)($opts['ref'] ?? ''),
        $opts['relatedId'] ?? null,
        substr((string)($opts['note'] ?? ''), 0, 255),
        (string)($opts['fy'] ?? fy_of()),
    ]);
    return (int)$pdo->lastInsertId();
}

/* ============================================================ wallets ===== */

/** Lock and read a wallet row. Every balance change must go through this. */
function wallet_for_update(PDO $pdo, int $userId): array
{
    $st = $pdo->prepare('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE');
    $st->execute([$userId]);
    $w = $st->fetch();
    if (!$w) {
        $pdo->prepare('INSERT INTO wallets (user_id) VALUES (?)')->execute([$userId]);
        $st->execute([$userId]);
        $w = $st->fetch();
    }
    return $w;
}

/**
 * Apply deltas to a wallet.
 *
 * Refuses rather than allowing any balance to go negative. That check is the last
 * line before money is invented: if an earlier calculation was wrong, this is
 * where it surfaces as a failed transaction instead of a treasury shortfall
 * nobody notices for a month.
 */
function wallet_apply(
    PDO $pdo,
    int $userId,
    int $inrDelta = 0,
    int $inrLockedDelta = 0,
    int $arvDeltaU8 = 0,
    int $arvLockedDeltaU8 = 0,
    int $investedDelta = 0,
    int $realisedDelta = 0
): array {
    $w = wallet_for_update($pdo, $userId);

    $inr       = (int)$w['inr_paise'] + $inrDelta;
    $inrLocked = (int)$w['inr_locked_paise'] + $inrLockedDelta;
    $arv       = u8((string)$w['arv_units']) + $arvDeltaU8;
    $arvLocked = u8((string)$w['arv_locked_units']) + $arvLockedDeltaU8;
    $invested  = (int)$w['invested_paise'] + $investedDelta;
    $realised  = (int)$w['realised_pnl_paise'] + $realisedDelta;

    if ($inr < 0 || $inrLocked < 0 || $arv < 0 || $arvLocked < 0) {
        throw new RuntimeException(
            'Wallet update refused: it would make a balance negative. Nothing was changed.'
        );
    }

    $pdo->prepare(
        'UPDATE wallets SET inr_paise = ?, inr_locked_paise = ?, arv_units = ?,
                arv_locked_units = ?, invested_paise = ?, realised_pnl_paise = ?
         WHERE user_id = ?'
    )->execute([$inr, $inrLocked, u8str($arv), u8str($arvLocked), max(0, $invested), $realised, $userId]);

    return [
        'inr_paise'          => $inr,
        'inr_locked_paise'   => $inrLocked,
        'arv_units'          => u8str($arv),
        'arv_locked_units'   => u8str($arvLocked),
        'invested_paise'     => max(0, $invested),
        'realised_pnl_paise' => $realised,
    ];
}

function wallet_public(array $w, ?float $nav): array
{
    $arvU8    = u8((string)$w['arv_units']);
    $lockedU8 = u8((string)$w['arv_locked_units']);
    $totalU8  = $arvU8 + $lockedU8;
    $invested = (int)$w['invested_paise'];
    $value    = $nav !== null ? u8_to_paise($totalU8, $nav) : 0;

    // First buy date — the earliest open lot. Used by the UI to show
    // "profit since you first bought" rather than a context-free percentage.
    $firstBuyAt = null;
    if ($totalU8 > 0) {
        $fb = qval(
            'SELECT MIN(acquired_at) FROM lots WHERE user_id = ? AND units_remaining > 0',
            [(int)$w['user_id']]
        );
        $firstBuyAt = $fb ?: null;
    }

    return [
        'inrPaise'         => (int)$w['inr_paise'],
        'inrLockedPaise'   => (int)$w['inr_locked_paise'],
        'arvUnits'         => u8str($arvU8),
        'arvLockedUnits'   => u8str($lockedU8),
        'arvTotalUnits'    => u8str($totalU8),
        'investedPaise'    => $invested,
        'valuePaise'       => $value,
        'unrealisedPaise'  => $nav !== null ? $value - $invested : 0,
        'unrealisedPct'    => $invested > 0 && $nav !== null
            ? round((($value - $invested) / $invested) * 100, 4) : 0,
        'realisedPaise'    => (int)$w['realised_pnl_paise'],
        'avgCostNav'       => $totalU8 > 0 ? round(($invested / 100) / ($totalU8 / U8), 8) : 0,
        'firstBuyAt'       => $firstBuyAt,
    ];
}
