<?php
/**
 * Referrals and reward tiers.
 *
 * The commission is 5% of a referred user's first deposit, once, paid into the
 * referrer's rupee wallet by `admin.php` at the moment that deposit is confirmed.
 * Nothing here pays anything — this endpoint only reports.
 *
 * Tiers are earned on referred volume and pay out as a fee discount rather than
 * cash. That is deliberate: a cash reward that scales with how much money other
 * people put in reads as a promised return, and it is a promise funded by
 * deposits rather than by revenue. A fee discount comes out of the platform's own
 * margin, which it can actually afford.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

$action = $_GET['action'] ?? 'summary';

switch ($action) {
    case 'summary': handle_summary(); break;
    case 'tiers':   handle_tiers();   break;
    default:
        json_fail(400, 'Unknown action.');
}

function handle_summary(): void
{
    require_method('GET');
    $u = require_user();

    if (!setting_b('referral_enabled', true)) {
        json_ok([
            'enabled' => false,
            'message' => 'Referrals are currently switched off.',
        ]);
    }

    $rows = q(
        'SELECT r.base_paise, r.commission_paise, r.commission_pct, r.status, r.created_at,
                u.email
           FROM referrals r
           JOIN users u ON u.id = r.referee_id
          WHERE r.referrer_id = ?
          ORDER BY r.id DESC LIMIT 200',
        [$u['id']]
    )->fetchAll();

    $totals = q1(
        'SELECT COUNT(*) AS n,
                COALESCE(SUM(base_paise),0) AS volume,
                COALESCE(SUM(CASE WHEN status = "paid" THEN commission_paise ELSE 0 END),0) AS earned,
                COALESCE(SUM(CASE WHEN status = "pending" THEN commission_paise ELSE 0 END),0) AS pending
           FROM referrals WHERE referrer_id = ?',
        [$u['id']]
    );

    // Signed-up-but-not-yet-deposited. Worth showing separately so the count on
    // screen matches the count of people the referrer actually invited, rather
    // than only those who happened to fund.
    $joinedNotFunded = (int)(qval(
        'SELECT COUNT(*) FROM users x
          WHERE x.referred_by = ?
            AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.referee_id = x.id)',
        [$u['id']]
    ) ?? 0);

    $ownDeposits = (int)(qval(
        'SELECT COALESCE(SUM(amount_paise),0) FROM deposits
          WHERE user_id = ? AND status = "confirmed"', [$u['id']]
    ) ?? 0);

    $site = (string)(cfg()['site_url'] ?? '');
    if ($site === '') {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $site = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
    }

    json_ok([
        'enabled' => true,
        'code'    => $u['referral_code'],
        'link'    => rtrim($site, '/') . '/signup.html?ref=' . $u['referral_code'],
        'terms'   => [
            'commissionPct'   => setting_f('referral_pct', 5),
            'onlyFirstDeposit'=> true,
            'capPaise'        => setting_i('referral_max_paise', 5000000),
            'levels'          => 1,
            'explanation'     => sprintf(
                'You earn %s%% of the first deposit each person you refer makes, once, credited '
                . 'straight to your rupee balance. There is no second level and no ongoing cut — '
                . 'one payment per person, capped at ₹%s.',
                rtrim(rtrim(number_format(setting_f('referral_pct', 5), 2, '.', ''), '0'), '.'),
                number_format(setting_i('referral_max_paise', 5000000) / 100)
            ),
        ],
        'totals'  => [
            'funded'          => (int)$totals['n'],
            'joinedNotFunded' => $joinedNotFunded,
            'volumePaise'     => (int)$totals['volume'],
            'earnedPaise'     => (int)$totals['earned'],
            'pendingPaise'    => (int)$totals['pending'],
            'ownDepositsPaise'=> $ownDeposits,
        ],
        'tier'    => tier_progress((int)$totals['volume'], $ownDeposits, (string)($u['tier_id'] ?? '')),
        'referrals' => array_map(static fn($r) => [
            // Only a masked address. A referrer does not need the full email of
            // someone who signed up under them.
            'who'             => mask_email((string)$r['email']),
            'basePaise'       => (int)$r['base_paise'],
            'commissionPaise' => (int)$r['commission_paise'],
            'commissionPct'   => (float)$r['commission_pct'],
            'status'          => $r['status'],
            'at'              => $r['created_at'],
        ], $rows),
        'taxNote' => 'Referral commission is income, not a capital gain. It is recorded separately '
                   . 'from your ARV holdings and does not affect their cost basis.',
    ]);
}

function handle_tiers(): void
{
    require_method('GET');
    json_ok(['tiers' => array_map(static fn($t) => [
        'id'        => $t['id'],
        'label'     => $t['label'],
        'metric'    => $t['metric'],
        'threshold' => $t['threshold'],
        'perk'      => $t['perk'],
        'entryFeePct' => $t['entryFeePct'],
        'exitFeePct'  => $t['exitFeePct'],
        'days'      => $t['days'],
        'requirement' => $t['metric'] === 'paise'
            ? sprintf('₹%s in referred deposits', number_format((int)$t['threshold'] / 100))
            : sprintf('referred deposits worth %s× your own', $t['threshold']),
    ], arv_reward_tiers())]);
}

/**
 * Where the user stands, and what the next tier needs.
 *
 * Ratio tiers compare referred volume against the referrer's own deposits, so
 * someone who has put nothing in has no ratio yet — said plainly rather than
 * shown as a divide-by-zero or a misleading 0%.
 */
function tier_progress(int $referredPaise, int $ownPaise, string $currentTier): array
{
    $tiers = arv_reward_tiers();
    $earned = null;
    $next   = null;

    foreach ($tiers as $t) {
        $qualifies = $t['metric'] === 'paise'
            ? $referredPaise >= (int)$t['threshold']
            : ($ownPaise > 0 && ($referredPaise / $ownPaise) >= (float)$t['threshold']);

        if ($qualifies) {
            $earned = $t;
        } elseif ($next === null) {
            $next = $t;
        }
    }

    $gap = null;
    if ($next !== null) {
        if ($next['metric'] === 'paise') {
            $gap = ['type' => 'paise', 'remainingPaise' => max(0, (int)$next['threshold'] - $referredPaise)];
        } elseif ($ownPaise > 0) {
            $needed = (int)ceil((float)$next['threshold'] * $ownPaise);
            $gap = ['type' => 'paise', 'remainingPaise' => max(0, $needed - $referredPaise)];
        } else {
            $gap = ['type' => 'blocked',
                    'reason' => 'Ratio tiers compare referred deposits against your own, so make a '
                              . 'deposit first and this starts counting.'];
        }
    }

    return [
        'current'     => $currentTier !== '' ? $currentTier : ($earned['id'] ?? null),
        'currentPerk' => $earned['perk'] ?? null,
        'next'        => $next ? ['id' => $next['id'], 'label' => $next['label'], 'perk' => $next['perk']] : null,
        'gap'         => $gap,
        'ratio'       => $ownPaise > 0 ? round($referredPaise / $ownPaise, 4) : null,
    ];
}

function mask_email(string $email): string
{
    $parts = explode('@', $email);
    if (count($parts) !== 2) {
        return '\u2014';
    }
    $name = $parts[0];
    $shown = strlen($name) <= 2 ? substr($name, 0, 1) : substr($name, 0, 2);
    return $shown . str_repeat('*', max(2, strlen($name) - strlen($shown))) . '@' . $parts[1];
}
