<?php
/**
 * Account history and the tax statement.
 *
 * Both pages this serves read from the ledger, not from the wallet. The wallet is
 * a cached balance; the ledger is the book of record. If a history page were
 * assembled from orders, deposits and withdrawals separately it could disagree
 * with the balance shown next to it, and the user would have no way to tell which
 * one was lying.
 *
 * The tax figures are computed from what was actually recorded on each fill, not
 * re-derived here. `trades` already carries the FIFO cost basis, the realised
 * gain, the 30% and the cess for the row, worked out at the moment the fill
 * happened with the lots that existed then. Recomputing later would give a
 * different answer as soon as a lot had been partly consumed by a subsequent
 * sale, and the earlier answer is the correct one.
 *
 * Nothing here is tax advice, and the file says so where the numbers are
 * returned. It is a statement of what this platform recorded and withheld.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

/**
 * Ledger kinds a user may filter by, grouped the way the UI presents them.
 *
 * Declared before the dispatch below, not after it. A top-level `const` is
 * evaluated when execution reaches it, so defining this underneath the switch
 * would leave it undefined inside the handler the switch just called.
 */
const LEDGER_GROUPS = [
    'money'       => ['deposit', 'withdrawal'],
    'trading'     => ['buy', 'sell'],
    'charges'     => ['fee', 'gst', 'tds'],
    'rewards'     => ['referral_commission'],
    'corrections' => ['adjustment', 'reversal'],
];

$action = $_GET['action'] ?? 'ledger';

switch ($action) {
    case 'ledger': handle_ledger(); break;
    case 'trades': handle_trades(); break;
    case 'tax':    handle_tax();    break;
    case 'years':  handle_years();  break;
    default:
        json_fail(400, 'Unknown action.');
}

/* ============================================================== ledger ==== */

/**
 * The user's ledger, newest first, keyset-paginated.
 *
 * Paginated by id rather than OFFSET because the ledger grows while someone is
 * reading it — an OFFSET page 2 would silently skip or repeat rows as new
 * entries land on top. An id cursor cannot.
 */
function handle_ledger(): void
{
    require_method('GET');
    $u = require_user();

    $limit  = max(1, min(500, (int)($_GET['limit'] ?? 100)));
    $before = (int)($_GET['before'] ?? 0);
    $fy     = trim((string)($_GET['fy'] ?? ''));
    $group  = trim((string)($_GET['group'] ?? ''));

    $where  = ['user_id = ?'];
    $params = [$u['id']];

    if ($before > 0) {
        $where[]  = 'id < ?';
        $params[] = $before;
    }
    if ($fy !== '' && preg_match('/^\d{4}-\d{2}$/', $fy)) {
        $where[]  = 'fy = ?';
        $params[] = $fy;
    }
    if ($group !== '' && isset(LEDGER_GROUPS[$group])) {
        $kinds   = LEDGER_GROUPS[$group];
        $where[] = 'kind IN (' . implode(',', array_fill(0, count($kinds), '?')) . ')';
        $params  = array_merge($params, $kinds);
    }

    $sql = 'SELECT id, kind, inr_delta_paise, arv_delta_units, nav, ref, related_id,
                   note, fy, created_at
              FROM ledger
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY id DESC
             LIMIT ' . ($limit + 1);

    $rows = q($sql, $params)->fetchAll();

    // One extra row was requested purely to answer "is there more?" without a
    // second COUNT query. It is not returned.
    $more = count($rows) > $limit;
    if ($more) {
        array_pop($rows);
    }

    $out = array_map(static fn($r) => [
        'id'          => (int)$r['id'],
        'kind'        => $r['kind'],
        'group'       => group_of((string)$r['kind']),
        'inrPaise'    => (int)$r['inr_delta_paise'],
        'units'       => (string)$r['arv_delta_units'],
        'nav'         => $r['nav'] !== null ? (float)$r['nav'] : null,
        'ref'         => $r['ref'],
        'relatedId'   => $r['related_id'] !== null ? (int)$r['related_id'] : null,
        'note'        => $r['note'],
        'fy'          => $r['fy'],
        'at'          => $r['created_at'],
    ], $rows);

    // Totals cover everything matching the filter, not just the page on screen —
    // a total that only added up the visible rows would be worse than no total.
    $tWhere  = array_values(array_filter($where, static fn($w) => $w !== 'id < ?'));
    $tParams = [$u['id']];
    if ($fy !== '' && preg_match('/^\d{4}-\d{2}$/', $fy)) {
        $tParams[] = $fy;
    }
    if ($group !== '' && isset(LEDGER_GROUPS[$group])) {
        $tParams = array_merge($tParams, LEDGER_GROUPS[$group]);
    }

    $totals = q(
        'SELECT kind,
                COUNT(*) AS n,
                COALESCE(SUM(inr_delta_paise),0) AS inr,
                COALESCE(SUM(arv_delta_units),0) AS units
           FROM ledger
          WHERE ' . implode(' AND ', $tWhere) . '
          GROUP BY kind',
        $tParams
    )->fetchAll();

    $byKind = [];
    $inrIn = 0;
    $inrOut = 0;
    foreach ($totals as $t) {
        $byKind[$t['kind']] = [
            'count'    => (int)$t['n'],
            'inrPaise' => (int)$t['inr'],
            'units'    => (string)$t['units'],
        ];
        if ((int)$t['inr'] > 0) {
            $inrIn += (int)$t['inr'];
        } else {
            $inrOut += (int)$t['inr'];
        }
    }

    // Charges come from `trades`, not from the ledger's fee/gst/tds rows.
    //
    // Those rows carry a delta of zero on purpose: the charge is already inside the
    // net figure on the buy or sell entry next to them, and posting it twice would
    // break the rule that the ledger sums to the wallet. Adding them up would
    // therefore report ₹0.00 of charges to someone who has plainly paid some,
    // which is worse than showing nothing at all.
    $chargeParams = [$u['id'], $u['id']];
    $chargeWhere  = '(buyer_id = ? OR seller_id = ?)';
    if ($fy !== '' && preg_match('/^\d{4}-\d{2}$/', $fy)) {
        $chargeWhere .= ' AND fy = ?';
        $chargeParams[] = $fy;
    }
    $ch = q1(
        'SELECT COALESCE(SUM(CASE WHEN buyer_id = ? THEN buyer_fee_paise + buyer_gst_paise ELSE 0 END),0) AS buy_side,
                COALESCE(SUM(CASE WHEN seller_id = ? THEN seller_fee_paise + seller_gst_paise ELSE 0 END),0) AS sell_side,
                COALESCE(SUM(CASE WHEN seller_id = ? THEN seller_tds_paise ELSE 0 END),0) AS tds
           FROM trades WHERE ' . $chargeWhere,
        array_merge([$u['id'], $u['id'], $u['id']], $chargeParams)
    );
    $feesPaise = (int)$ch['buy_side'] + (int)$ch['sell_side'];
    $tdsPaise  = (int)$ch['tds'];

    json_ok([
        'rows'       => $out,
        'nextCursor' => $more && $out ? end($out)['id'] : null,
        'hasMore'    => $more,
        'totals'     => [
            'byKind'     => $byKind,
            'inInPaise'  => $inrIn,
            'inOutPaise' => $inrOut,
            'netPaise'   => $inrIn + $inrOut,
            // Kept apart: a fee is ours, TDS is the government's.
            'feesPaise'    => $feesPaise,
            'tdsPaise'     => $tdsPaise,
            'chargesPaise' => $feesPaise + $tdsPaise,
        ],
        'groups'     => array_keys(LEDGER_GROUPS),
        'note'       => 'Every rupee and every unit that moved, once each, oldest entry never '
                      . 'altered. A correction appears as its own entry rather than a change to '
                      . 'the original.',
    ]);
}

function group_of(string $kind): string
{
    foreach (LEDGER_GROUPS as $g => $kinds) {
        if (in_array($kind, $kinds, true)) {
            return $g;
        }
    }
    return 'other';
}

/* ============================================================== trades ==== */

/** The user's fills, either side, newest first. */
function handle_trades(): void
{
    require_method('GET');
    $u = require_user();

    $limit = max(1, min(200, (int)($_GET['limit'] ?? 50)));

    $rows = q(
        'SELECT id, ref, counterparty, units, nav, gross_paise,
                buyer_id, seller_id,
                buyer_fee_paise, buyer_gst_paise,
                seller_fee_paise, seller_gst_paise, seller_tds_paise, seller_net_paise,
                cost_basis_paise, realised_pnl_paise, tax_paise, cess_paise,
                fy, created_at
           FROM trades
          WHERE buyer_id = ? OR seller_id = ?
          ORDER BY id DESC
          LIMIT ' . $limit,
        [$u['id'], $u['id']]
    )->fetchAll();

    $uid = (int)$u['id'];

    json_ok(['trades' => array_map(static function ($r) use ($uid) {
        $isBuy = (int)$r['buyer_id'] === $uid;
        return [
            'ref'    => $r['ref'],
            'side'   => $isBuy ? 'buy' : 'sell',
            'units'  => (string)$r['units'],
            'nav'    => (float)$r['nav'],
            'grossPaise' => (int)$r['gross_paise'],
            'feePaise'   => $isBuy ? (int)$r['buyer_fee_paise'] : (int)$r['seller_fee_paise'],
            'gstPaise'   => $isBuy ? (int)$r['buyer_gst_paise'] : (int)$r['seller_gst_paise'],
            'tdsPaise'   => $isBuy ? 0 : (int)$r['seller_tds_paise'],
            'netPaise'   => $isBuy ? null : (int)$r['seller_net_paise'],
            // Cost basis and gain only mean anything on the sell side.
            'costBasisPaise' => $isBuy ? null : ($r['cost_basis_paise'] !== null ? (int)$r['cost_basis_paise'] : null),
            'pnlPaise'   => $isBuy ? null : ($r['realised_pnl_paise'] !== null ? (int)$r['realised_pnl_paise'] : null),
            // Who was on the other side. A treasury fill is not a worse fill —
            // the price is the same either way — but it is worth being able to see.
            'counterparty' => $r['counterparty'],
            'fy'     => $r['fy'],
            'at'     => $r['created_at'],
        ];
    }, $rows)]);
}

/* ================================================================ years === */

/** Financial years this account has any activity in, newest first. */
function handle_years(): void
{
    require_method('GET');
    $u = require_user();

    $rows = q(
        'SELECT fy FROM (
             SELECT DISTINCT fy FROM ledger WHERE user_id = ? AND fy <> \'\'
             UNION
             SELECT DISTINCT fy FROM trades WHERE (buyer_id = ? OR seller_id = ?) AND fy <> \'\'
         ) x ORDER BY fy DESC',
        [$u['id'], $u['id'], $u['id']]
    )->fetchAll();

    $years = array_map(static fn($r) => $r['fy'], $rows);
    $now   = fy_of();
    if (!in_array($now, $years, true)) {
        array_unshift($years, $now);
    }

    json_ok(['years' => $years, 'current' => $now]);
}

/* ================================================================== tax === */

/**
 * The tax statement for one financial year.
 *
 * Three separate things get reported, and conflating them is the commonest way a
 * crypto statement misleads:
 *
 *   1. TDS withheld under s.194S — already taken from the seller and payable to
 *      the government by the platform. It is a credit against the final bill,
 *      not an additional tax, and it shows in Form 26AS.
 *   2. Tax on gains under s.115BBH — 30% plus cess, the holder's own liability at
 *      filing. Never withheld here.
 *   3. Fees and GST — the platform's charge and the tax on that charge. Neither
 *      is deductible against a VDA gain, because s.115BBH allows only cost of
 *      acquisition. Reported so the user can see them, and marked as such.
 *
 * Losses are shown but never netted against gains. s.115BBH(2) forbids the
 * set-off, so a statement that netted them would understate the liability.
 */
function handle_tax(): void
{
    require_method('GET');
    $u = require_user();

    $fy = trim((string)($_GET['fy'] ?? ''));
    if ($fy === '' || !preg_match('/^\d{4}-\d{2}$/', $fy)) {
        $fy = fy_of();
    }

    /* ---------------------------------------------------------- disposals -- */

    $sales = q(
        'SELECT ref, units, nav, gross_paise, seller_fee_paise, seller_gst_paise,
                seller_tds_paise, seller_net_paise, cost_basis_paise,
                realised_pnl_paise, tax_paise, cess_paise, created_at
           FROM trades
          WHERE seller_id = ? AND fy = ?
          ORDER BY id ASC',
        [$u['id'], $fy]
    )->fetchAll();

    $grossPaise = 0;
    $costPaise  = 0;
    $gainPaise  = 0;   // positive outcomes only
    $lossPaise  = 0;   // negative outcomes only, kept unsigned
    $taxPaise   = 0;
    $cessPaise  = 0;
    $tdsPaise   = 0;
    $sellFee    = 0;
    $sellGst    = 0;

    $disposals = [];
    foreach ($sales as $s) {
        $pnl = (int)($s['realised_pnl_paise'] ?? 0);

        $grossPaise += (int)$s['gross_paise'];
        $costPaise  += (int)($s['cost_basis_paise'] ?? 0);
        $tdsPaise   += (int)$s['seller_tds_paise'];
        $sellFee    += (int)$s['seller_fee_paise'];
        $sellGst    += (int)$s['seller_gst_paise'];
        $taxPaise   += (int)($s['tax_paise'] ?? 0);
        $cessPaise  += (int)($s['cess_paise'] ?? 0);

        if ($pnl >= 0) {
            $gainPaise += $pnl;
        } else {
            $lossPaise += -$pnl;
        }

        $disposals[] = [
            'ref'        => $s['ref'],
            'units'      => (string)$s['units'],
            'nav'        => (float)$s['nav'],
            'grossPaise' => (int)$s['gross_paise'],
            'costPaise'  => (int)($s['cost_basis_paise'] ?? 0),
            'pnlPaise'   => $pnl,
            'taxPaise'   => (int)($s['tax_paise'] ?? 0),
            'cessPaise'  => (int)($s['cess_paise'] ?? 0),
            'tdsPaise'   => (int)$s['seller_tds_paise'],
            'netPaise'   => (int)$s['seller_net_paise'],
            'at'         => $s['created_at'],
        ];
    }

    /* --------------------------------------------------------- acquisitions */

    $buys = q1(
        'SELECT COUNT(*) AS n,
                COALESCE(SUM(gross_paise),0) AS gross,
                COALESCE(SUM(units),0) AS units,
                COALESCE(SUM(buyer_fee_paise),0) AS fee,
                COALESCE(SUM(buyer_gst_paise),0) AS gst
           FROM trades WHERE buyer_id = ? AND fy = ?',
        [$u['id'], $fy]
    );

    /* ------------------------------------------------------- other income -- */

    $referral = (int)(qval(
        'SELECT COALESCE(SUM(inr_delta_paise),0) FROM ledger
          WHERE user_id = ? AND fy = ? AND kind = \'referral_commission\'',
        [$u['id'], $fy]
    ) ?? 0);

    /* ------------------------------------------------------- TDS position -- */

    $kyc      = q1('SELECT pan FROM kyc WHERE user_id = ?', [$u['id']]);
    $hasPan   = !empty($kyc['pan']);
    $specified = !empty($u['is_specified_person']);
    $threshold = $specified
        ? setting_i('tds_threshold_specified_paise', 5000000)
        : setting_i('tds_threshold_paise', 1000000);
    $rate = $hasPan ? setting_f('tds_pct', 1) : setting_f('tds_pct_no_pan', 20);

    /* ------------------------------------------------ unrealised position -- */

    $lots = q(
        'SELECT id, units, units_remaining, cost_paise, nav, acquired_at
           FROM lots
          WHERE user_id = ? AND units_remaining > 0
          ORDER BY acquired_at ASC, id ASC',
        [$u['id']]
    )->fetchAll();

    $navNow = null;
    try {
        $navNow = arv_nav(true);
    } catch (Throwable $e) {
        // A missing price must not take the whole statement down. The realised
        // figures — the ones that matter for filing — do not depend on it.
        $navNow = null;
    }

    $openU8   = 0;
    $openCost = 0;
    $openLots = [];
    foreach ($lots as $l) {
        $remU8   = u8((string)$l['units_remaining']);
        $totalU8 = u8((string)$l['units']);
        $slice   = $totalU8 > 0 ? (int)round((int)$l['cost_paise'] * ($remU8 / $totalU8)) : 0;

        $openU8   += $remU8;
        $openCost += $slice;

        $openLots[] = [
            'acquiredAt' => $l['acquired_at'],
            'units'      => u8str($remU8),
            'costPaise'  => $slice,
            'nav'        => (float)$l['nav'],
            'valuePaise' => $navNow !== null ? u8_to_paise($remU8, $navNow) : null,
        ];
    }

    $openValue = $navNow !== null ? u8_to_paise($openU8, $navNow) : null;

    json_ok([
        'fy'      => $fy,
        'current' => $fy === fy_of(),
        'rates'   => [
            'gainPct'   => setting_f('vda_gain_pct', 30),
            'cessPct'   => setting_f('cess_pct', 4),
            'tdsPct'    => $rate,
            'hasPan'    => $hasPan,
            'setOffAllowed' => false,
        ],
        'disposals' => $disposals,
        'realised'  => [
            'count'      => count($disposals),
            'grossPaise' => $grossPaise,
            'costPaise'  => $costPaise,
            'gainPaise'  => $gainPaise,
            'lossPaise'  => $lossPaise,
            // Deliberately not gain - loss. The set-off is not permitted, so the
            // taxable figure is the gains alone.
            'taxablePaise' => $gainPaise,
            'taxPaise'   => $taxPaise,
            'cessPaise'  => $cessPaise,
            'totalDuePaise' => $taxPaise + $cessPaise,
            'tdsWithheldPaise' => $tdsPaise,
            // What is left to pay at filing after the credit. Negative means the
            // withholding exceeded the liability and is refundable.
            'balancePaise' => ($taxPaise + $cessPaise) - $tdsPaise,
        ],
        'charges' => [
            'sellFeePaise' => $sellFee,
            'sellGstPaise' => $sellGst,
            'buyFeePaise'  => (int)$buys['fee'],
            'buyGstPaise'  => (int)$buys['gst'],
            'totalPaise'   => $sellFee + $sellGst + (int)$buys['fee'] + (int)$buys['gst'],
            'deductible'   => false,
        ],
        'acquisitions' => [
            'count'      => (int)$buys['n'],
            'grossPaise' => (int)$buys['gross'],
            'units'      => units8($buys['units']),
        ],
        'otherIncome' => [
            'referralPaise' => $referral,
            'note' => 'Referral commission is ordinary income at your slab rate, not a capital '
                    . 'gain, and it is not part of the 30% figure above.',
        ],
        'tds' => [
            'ratePct'        => $rate,
            'hasPan'         => $hasPan,
            'section'        => $hasPan ? '194S' : '194S with 206AA',
            'thresholdPaise' => $threshold,
            'aggregatePaise' => $grossPaise,
            'headroomPaise'  => max(0, $threshold - $grossPaise),
            'withheldPaise'  => $tdsPaise,
            'crossed'        => $grossPaise > $threshold,
            'note' => 'TDS is a credit against what you owe, not an extra tax. It appears in '
                    . 'Form 26AS against your PAN. Crossing the annual threshold makes the whole '
                    . 'of a transfer liable, not only the part above it.',
        ],
        'unrealised' => [
            'units'      => u8str($openU8),
            'costPaise'  => $openCost,
            'valuePaise' => $openValue,
            'pnlPaise'   => $openValue !== null ? $openValue - $openCost : null,
            'nav'        => $navNow,
            'lots'       => $openLots,
            'note' => 'Nothing here is taxable yet. A gain becomes taxable when you sell, and '
                    . 'the cost basis used will be the oldest lot first.',
        ],
        'disclaimer' => 'A record of what this platform executed and withheld for you. It is not '
                      . 'a tax return, not a Form 16A, and not advice. Figures for your own '
                      . 'holdings elsewhere are not in it. Check it against Form 26AS and speak '
                      . 'to a chartered accountant before you file.',
    ]);
}
