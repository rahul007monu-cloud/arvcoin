<?php
/**
 * Operator endpoints.
 *
 * Every action here re-checks the operator flag against the database. A hidden
 * button is not a permission model, and the front end deciding what to show is a
 * convenience, never the control.
 *
 * The reconciliation endpoint is the one that matters most. Everything else is
 * administration; reconciliation is what keeps the platform solvent, because the
 * treasury's obligation to unit holders only holds if the Bitcoin behind it is
 * actually there.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';
require __DIR__ . '/_match.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'overview':          handle_overview();        break;
    case 'deposits':          handle_deposits();        break;
    case 'confirm_deposit':   handle_confirm_deposit(); break;
    case 'reject_deposit':    handle_reject_deposit();  break;
    case 'withdrawals':       handle_withdrawals();     break;
    case 'approve_withdraw':  handle_approve();         break;
    case 'mark_paid':         handle_mark_paid();       break;
    case 'reject_withdraw':   handle_reject_withdraw(); break;
    case 'kyc_queue':         handle_kyc_queue();       break;
    case 'kyc_review':        handle_kyc_review();      break;
    case 'reconcile':         handle_reconcile();       break;
    case 'users':             handle_users();           break;
    case 'settings':          handle_settings();        break;
    case 'save_setting':      handle_save_setting();    break;
    default:
        json_fail(400, 'Unknown action.');
}

/* =========================================================== overview ===== */

function handle_overview(): void
{
    require_method('GET');
    require_admin();

    $meta = arv_nav_meta();

    $counts = q1(
        'SELECT
           (SELECT COUNT(*) FROM deposits WHERE status = "submitted")            AS deposits_pending,
           (SELECT COUNT(*) FROM withdrawals WHERE status = "requested")         AS withdrawals_pending,
           (SELECT COUNT(*) FROM withdrawals WHERE status = "approved")          AS withdrawals_approved,
           (SELECT COUNT(*) FROM kyc WHERE status = "pending")                   AS kyc_pending,
           (SELECT COUNT(*) FROM users WHERE status = "active")                  AS users_active,
           (SELECT COUNT(*) FROM orders WHERE status IN ("open","triggered","partial")) AS orders_open'
    );

    // Overdue queues, surfaced separately. A promise of "within an hour" that
    // quietly slips is worse than not making it.
    $overdue = q1(
        'SELECT
           (SELECT COUNT(*) FROM deposits
             WHERE status = "submitted"
               AND submitted_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE))  AS deposits,
           (SELECT COUNT(*) FROM withdrawals
             WHERE status IN ("requested","approved")
               AND promised_by < UTC_TIMESTAMP())                                AS withdrawals',
        [setting_i('deposit_max_minutes', 15)]
    );

    $money = q1(
        'SELECT
           (SELECT COALESCE(SUM(inr_paise + inr_locked_paise),0) FROM wallets)   AS user_inr,
           (SELECT COALESCE(SUM(arv_units + arv_locked_units),0) FROM wallets)   AS units_outstanding,
           (SELECT COALESCE(SUM(invested_paise),0) FROM wallets)                 AS invested,
           (SELECT COALESCE(SUM(amount_paise),0) FROM deposits WHERE status = "confirmed") AS deposited,
           (SELECT COALESCE(SUM(amount_paise),0) FROM withdrawals WHERE status = "paid")   AS paid_out,
           (SELECT COALESCE(SUM(buyer_fee_paise + seller_fee_paise),0) FROM trades)        AS fees,
           (SELECT COALESCE(SUM(buyer_gst_paise + seller_gst_paise),0) FROM trades)        AS gst,
           (SELECT COALESCE(SUM(seller_tds_paise),0) FROM trades)                          AS tds,
           (SELECT COALESCE(SUM(commission_paise),0) FROM referrals WHERE status = "paid") AS referral_paid'
    );

    json_ok([
        'price'   => $meta,
        'feed'    => q1('SELECT * FROM cron_runs WHERE job = "ingest"'),
        'crons'   => q('SELECT * FROM cron_runs ORDER BY job')->fetchAll(),
        'queues'  => array_map('intval', $counts),
        'overdue' => array_map('intval', $overdue),
        'money'   => [
            'userInrPaise'      => (int)$money['user_inr'],
            'unitsOutstanding'  => (string)$money['units_outstanding'],
            'investedPaise'     => (int)$money['invested'],
            'depositedPaise'    => (int)$money['deposited'],
            'paidOutPaise'      => (int)$money['paid_out'],
            'feesPaise'         => (int)$money['fees'],
            // Both of these are liabilities, not revenue — labelled here so a
            // dashboard cannot present them as income.
            'gstPaise'          => (int)$money['gst'],
            'tdsPaise'          => (int)$money['tds'],
            'referralPaidPaise' => (int)$money['referral_paid'],
        ],
        'warnings' => operator_warnings(),
    ]);
}

/**
 * Things an operator should be told rather than left to discover.
 */
function operator_warnings(): array
{
    $w = [];

    if ((string)setting('upi_vpa', '') === '') {
        $w[] = 'No UPI ID is configured, so the deposit QR is a placeholder and nobody can pay in.';
    }
    $meta = arv_nav_meta();
    if ($meta['nav'] === null) {
        $w[] = 'No price has been recorded. Trading is closed until the price cron runs.';
    } elseif ($meta['stale']) {
        $w[] = sprintf('The price feed is %d minutes behind, so trading is paused.',
                       (int)ceil((int)$meta['ageSeconds'] / 60));
    }
    $daily = (int)(qval('SELECT COUNT(*) FROM arv_candles WHERE tf = "1D"') ?? 0);
    if ($daily < 100) {
        $w[] = 'History has not been backfilled — the long-range chart will be nearly empty.';
    }
    if (!setting_b('sell_fallback_to_treasury', true)) {
        $w[] = 'The sell fallback is off. In a falling market holders may be unable to exit at all.';
    }
    if (setting_b('referral_enabled', true) && setting_f('referral_pct', 5) > 10) {
        $w[] = 'Referral commission is above 10% of a deposit. Have counsel look at that before it runs.';
    }
    if (setting_b('maintenance_mode')) {
        $w[] = 'Maintenance mode is on — users cannot trade.';
    }
    return $w;
}

/* =========================================================== deposits ===== */

function handle_deposits(): void
{
    require_method('GET');
    require_admin();

    $status = (string)($_GET['status'] ?? 'submitted');
    $rows = q(
        'SELECT d.*, u.email, u.full_name, k.pan, k.status AS kyc_status
           FROM deposits d
           JOIN users u ON u.id = d.user_id
           LEFT JOIN kyc k ON k.user_id = d.user_id
          WHERE d.status = ?
          ORDER BY d.submitted_at ASC, d.id ASC
          LIMIT 200', [$status]
    )->fetchAll();

    json_ok(['deposits' => array_map(static fn($d) => [
        'ref'           => $d['ref'],
        'userId'        => (int)$d['user_id'],
        'email'         => $d['email'],
        'name'          => $d['full_name'],
        'kycStatus'     => $d['kyc_status'] ?? 'none',
        'amountPaise'   => (int)$d['amount_paise'],
        'utr'           => $d['utr'],
        'screenshot'    => $d['screenshot_path'] !== '' ? $d['screenshot_path'] : null,
        'createdAt'     => $d['created_at'],
        'submittedAt'   => $d['submitted_at'],
        'waitingMinutes'=> $d['submitted_at'] ? (int)floor((time() - strtotime($d['submitted_at'])) / 60) : null,
    ], $rows)]);
}

/**
 * Confirm a bank credit and credit the wallet.
 *
 * The referral commission is paid here, in the same transaction, because it is
 * triggered by the referee's first confirmed deposit and must not be able to
 * happen twice or happen without the deposit.
 */
function handle_confirm_deposit(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $ref = input_str('ref');
    $note = substr(input_str('note'), 0, 255);

    $result = tx(static function (PDO $pdo) use ($ref, $admin, $note) {
        $st = $pdo->prepare('SELECT * FROM deposits WHERE ref = ? FOR UPDATE');
        $st->execute([$ref]);
        $d = $st->fetch();

        if (!$d) {
            throw new RuntimeException('Deposit not found.');
        }
        if ($d['status'] === 'confirmed') {
            throw new RuntimeException('That deposit is already confirmed. Nothing was credited twice.');
        }
        if (in_array($d['status'], ['rejected', 'expired'], true)) {
            throw new RuntimeException('That deposit is ' . $d['status'] . ' and cannot be confirmed.');
        }

        $userId = (int)$d['user_id'];
        $paise  = (int)$d['amount_paise'];

        wallet_apply($pdo, $userId, $paise);
        ledger_add($pdo, $userId, 'deposit', $paise, 0, [
            'ref' => $ref, 'relatedId' => (int)$d['id'],
            'note' => 'Deposit confirmed' . ($note !== '' ? ' — ' . $note : ''),
        ]);

        $pdo->prepare('UPDATE deposits SET status = "confirmed", confirmed_at = UTC_TIMESTAMP(),
                              confirmed_by = ? WHERE id = ?')
            ->execute([(int)$admin['id'], $d['id']]);

        // Referral commission — first confirmed deposit only.
        $commission = null;
        if (setting_b('referral_enabled', true)) {
            $u = $pdo->prepare('SELECT referred_by FROM users WHERE id = ?');
            $u->execute([$userId]);
            $referrer = $u->fetchColumn();

            if ($referrer) {
                // The unique key on referee_id makes "once per referred user"
                // structural rather than a check that could be raced.
                $already = $pdo->prepare('SELECT id FROM referrals WHERE referee_id = ?');
                $already->execute([$userId]);

                if (!$already->fetchColumn()) {
                    $pct = setting_f('referral_pct', 5);
                    $cap = setting_i('referral_max_paise', 5000000);
                    $amount = min($cap, pct_of($paise, $pct));

                    if ($amount > 0) {
                        $pdo->prepare(
                            'INSERT INTO referrals (referrer_id, referee_id, trigger_deposit_id,
                                                    base_paise, commission_paise, commission_pct,
                                                    status, paid_at)
                             VALUES (?, ?, ?, ?, ?, ?, "paid", UTC_TIMESTAMP())'
                        )->execute([(int)$referrer, $userId, (int)$d['id'], $paise, $amount, $pct]);

                        wallet_apply($pdo, (int)$referrer, $amount);
                        // Recorded as its own kind so it never contaminates the
                        // VDA cost basis — commission is income, not a capital gain.
                        ledger_add($pdo, (int)$referrer, 'referral_commission', $amount, 0, [
                            'ref' => $ref, 'relatedId' => $userId,
                            'note' => sprintf('%s%% referral commission on a referred first deposit', $pct),
                        ]);
                        $commission = ['referrerId' => (int)$referrer, 'paise' => $amount, 'pct' => $pct];
                    }
                }
            }
        }

        return ['creditedPaise' => $paise, 'userId' => $userId, 'commission' => $commission];
    });

    audit('deposit.confirm', ['entity' => 'deposits', 'entity_id' => $ref, 'detail' => $result]);

    json_ok($result + ['message' => sprintf('Credited ₹%s.', number_format($result['creditedPaise'] / 100, 2))]);
}

function handle_reject_deposit(): void
{
    require_method('POST');
    require_csrf();
    require_admin();

    $ref    = input_str('ref');
    $reason = substr(input_str('reason'), 0, 255);
    if ($reason === '') {
        json_fail(422, 'Give a reason — the user sees it.');
    }

    $d = q1('SELECT * FROM deposits WHERE ref = ?', [$ref]);
    if (!$d) {
        json_fail(404, 'Deposit not found.');
    }
    if ($d['status'] === 'confirmed') {
        json_fail(409, 'That deposit is already credited. Post a compensating adjustment instead of rejecting it.');
    }

    q('UPDATE deposits SET status = "rejected", reject_reason = ? WHERE id = ?', [$reason, $d['id']]);
    audit('deposit.reject', ['entity' => 'deposits', 'entity_id' => $ref, 'detail' => ['reason' => $reason]]);
    json_ok(['message' => 'Deposit rejected.']);
}

/* ======================================================== withdrawals ===== */

function handle_withdrawals(): void
{
    require_method('GET');
    require_admin();

    $status = (string)($_GET['status'] ?? 'requested');
    $rows = q(
        'SELECT w.*, u.email, u.full_name, k.pan
           FROM withdrawals w
           JOIN users u ON u.id = w.user_id
           LEFT JOIN kyc k ON k.user_id = w.user_id
          WHERE w.status = ?
          ORDER BY w.created_at ASC LIMIT 200', [$status]
    )->fetchAll();

    json_ok(['withdrawals' => array_map(static fn($w) => [
        'ref'          => $w['ref'],
        'userId'       => (int)$w['user_id'],
        'email'        => $w['email'],
        'name'         => $w['full_name'],
        'amountPaise'  => (int)$w['amount_paise'],
        'upiVpa'       => $w['upi_vpa'],
        'status'       => $w['status'],
        'createdAt'    => $w['created_at'],
        'promisedBy'   => $w['promised_by'],
        'overdue'      => $w['promised_by'] !== null && strtotime($w['promised_by']) < time(),
        'waitingMinutes' => (int)floor((time() - strtotime($w['created_at'])) / 60),
    ], $rows)]);
}

function handle_approve(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $ref = input_str('ref');
    $w = q1('SELECT * FROM withdrawals WHERE ref = ?', [$ref]);
    if (!$w) {
        json_fail(404, 'Withdrawal not found.');
    }
    if ($w['status'] !== 'requested') {
        json_fail(409, 'That withdrawal is already ' . $w['status'] . '.');
    }

    q('UPDATE withdrawals SET status = "approved", approved_at = UTC_TIMESTAMP(), handled_by = ?
       WHERE id = ?', [(int)$admin['id'], $w['id']]);

    audit('withdraw.approve', ['entity' => 'withdrawals', 'entity_id' => $ref]);
    json_ok(['message' => 'Approved. Send the UPI payment, then mark it paid.']);
}

/**
 * Mark a payout sent, releasing the hold.
 *
 * This is the point of no return: the rupees leave the ledger because they have
 * left the bank account. Recording the UTR makes that traceable afterwards.
 */
function handle_mark_paid(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $ref = input_str('ref');
    $utr = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', input_str('utr')));

    $result = tx(static function (PDO $pdo) use ($ref, $utr, $admin) {
        $st = $pdo->prepare('SELECT * FROM withdrawals WHERE ref = ? FOR UPDATE');
        $st->execute([$ref]);
        $w = $st->fetch();

        if (!$w) {
            throw new RuntimeException('Withdrawal not found.');
        }
        if ($w['status'] === 'paid') {
            throw new RuntimeException('That withdrawal is already marked paid.');
        }
        if (!in_array($w['status'], ['requested', 'approved'], true)) {
            throw new RuntimeException('That withdrawal is ' . $w['status'] . '.');
        }

        $paise  = (int)$w['amount_paise'];
        $userId = (int)$w['user_id'];

        // The hold created at request time is now spent — reduce locked, and the
        // money is gone from the platform.
        wallet_apply($pdo, $userId, 0, -$paise);
        ledger_add($pdo, $userId, 'withdrawal', 0, 0, [
            'ref' => $ref, 'relatedId' => (int)$w['id'],
            'note' => sprintf('Paid ₹%s to %s%s',
                              number_format($paise / 100, 2), $w['upi_vpa'],
                              $utr !== '' ? ' (UTR ' . $utr . ')' : ''),
        ]);

        $pdo->prepare('UPDATE withdrawals SET status = "paid", paid_at = UTC_TIMESTAMP(),
                              utr = ?, handled_by = ? WHERE id = ?')
            ->execute([$utr, (int)$admin['id'], $w['id']]);

        return ['paidPaise' => $paise, 'userId' => $userId];
    });

    audit('withdraw.paid', ['entity' => 'withdrawals', 'entity_id' => $ref, 'detail' => $result]);
    json_ok($result + ['message' => 'Marked paid.']);
}

function handle_reject_withdraw(): void
{
    require_method('POST');
    require_csrf();
    require_admin();

    $ref    = input_str('ref');
    $reason = substr(input_str('reason'), 0, 255);
    if ($reason === '') {
        json_fail(422, 'Give a reason — the user sees it.');
    }

    $result = tx(static function (PDO $pdo) use ($ref, $reason) {
        $st = $pdo->prepare('SELECT * FROM withdrawals WHERE ref = ? FOR UPDATE');
        $st->execute([$ref]);
        $w = $st->fetch();

        if (!$w) {
            throw new RuntimeException('Withdrawal not found.');
        }
        if ($w['status'] === 'paid') {
            throw new RuntimeException('That withdrawal is already paid. Post a compensating adjustment instead.');
        }

        $paise = (int)$w['amount_paise'];
        // The held amount goes back to available — it never left.
        wallet_apply($pdo, (int)$w['user_id'], $paise, -$paise);
        ledger_add($pdo, (int)$w['user_id'], 'adjustment', 0, 0, [
            'ref' => $ref, 'note' => 'Withdrawal rejected — hold released: ' . $reason,
        ]);

        $pdo->prepare('UPDATE withdrawals SET status = "rejected", reject_reason = ? WHERE id = ?')
            ->execute([$reason, $w['id']]);

        return ['returnedPaise' => $paise];
    });

    audit('withdraw.reject', ['entity' => 'withdrawals', 'entity_id' => $ref]);
    json_ok($result + ['message' => 'Rejected and the hold released.']);
}

/* ================================================================ KYC ===== */

function handle_kyc_queue(): void
{
    require_method('GET');
    require_admin();

    $rows = q(
        'SELECT k.*, u.email, u.created_at AS joined
           FROM kyc k JOIN users u ON u.id = k.user_id
          WHERE k.status = "pending"
          ORDER BY k.submitted_at ASC LIMIT 200'
    )->fetchAll();

    json_ok(['queue' => array_map(static fn($k) => [
        'userId'       => (int)$k['user_id'],
        'email'        => $k['email'],
        'fullName'     => $k['full_name'],
        'dob'          => $k['dob'],
        // An operator reviewing KYC does need the PAN to check it, so it is not
        // masked here — this endpoint is operator-only and audited.
        'pan'          => $k['pan'],
        'addressLine'  => $k['address_line'],
        'city'         => $k['city'],
        'state'        => $k['state'],
        'pincode'      => $k['pincode'],
        'aadhaarLast4' => $k['aadhaar_last4'],
        'upiVpa'       => $k['upi_vpa'],
        'submittedAt'  => $k['submitted_at'],
        'joined'       => $k['joined'],
        'waitingHours' => $k['submitted_at'] ? (int)floor((time() - strtotime($k['submitted_at'])) / 3600) : null,
    ], $rows)]);
}

function handle_kyc_review(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $userId  = input_int('userId');
    $approve = (bool)input('approve', false);
    $reason  = substr(input_str('reason'), 0, 255);

    if ($userId <= 0) {
        json_fail(422, 'Which user?');
    }
    if (!$approve && $reason === '') {
        json_fail(422, 'Give a reason for rejection — the user sees it and needs to know what to fix.');
    }

    $k = q1('SELECT status FROM kyc WHERE user_id = ?', [$userId]);
    if (!$k) {
        json_fail(404, 'No KYC record for that user.');
    }

    q('UPDATE kyc SET status = ?, pan_verified = ?, reviewed_at = UTC_TIMESTAMP(),
              reviewed_by = ?, reject_reason = ?
       WHERE user_id = ?',
      [$approve ? 'verified' : 'rejected', $approve ? 1 : 0, (int)$admin['id'],
       $approve ? '' : $reason, $userId]);

    audit($approve ? 'kyc.approve' : 'kyc.reject',
          ['entity' => 'kyc', 'entity_id' => (string)$userId, 'detail' => ['reason' => $reason]]);

    json_ok(['message' => $approve ? 'KYC verified.' : 'KYC rejected.']);
}

/* ========================================================= reconcile ====== */

/**
 * The check that keeps the platform solvent.
 *
 * Units outstanding, valued at the index price, is what the treasury owes unit
 * holders. Divided by Bitcoin's rupee price, that is the quantity of Bitcoin that
 * must actually be held. The operator enters what is really there and the
 * difference is tracking error.
 *
 * That difference is funded by whoever redeems last, and it compounds quietly —
 * which is exactly why it needs a number on a screen rather than a good intention.
 *
 * Rupee liabilities are separated out because they are a different obligation:
 * INR in user wallets is money that must simply be there, not exposure that has
 * to be hedged.
 */
function handle_reconcile(): void
{
    require_method('GET');
    require_admin();

    $meta = arv_nav_meta();
    $nav  = $meta['nav'];

    $btcRow = q1('SELECT close FROM asset_candles WHERE asset_key = "BTC" AND tf = "1m"
                   ORDER BY ts DESC LIMIT 1');
    $fx     = qval('SELECT usd_inr FROM fx_rates ORDER BY day DESC LIMIT 1');
    $btcInr = ($btcRow && $fx) ? (float)$btcRow['close'] * (float)$fx : null;

    $w = q1('SELECT COALESCE(SUM(arv_units + arv_locked_units),0) AS units,
                    COALESCE(SUM(inr_paise + inr_locked_paise),0) AS inr,
                    COALESCE(SUM(invested_paise),0) AS invested
               FROM wallets');

    $unitsU8   = u8((string)$w['units']);
    $liability = $nav !== null ? u8_to_paise($unitsU8, (float)$nav) : null;
    $btcNeeded = ($btcInr !== null && $liability !== null && $btcInr > 0)
        ? ($liability / 100) / $btcInr
        : null;

    // Does the ledger agree with the wallet balances? If these diverge, one of
    // them is wrong and the ledger is the book of record.
    $ledger = q1('SELECT COALESCE(SUM(inr_delta_paise),0) AS inr,
                         COALESCE(SUM(arv_delta_units),0) AS units FROM ledger');
    $ledgerInr   = (int)$ledger['inr'];
    $ledgerUnits = u8((string)$ledger['units']);

    json_ok([
        'price' => $meta,
        'obligation' => [
            'unitsOutstanding' => u8str($unitsU8),
            'nav'              => $nav,
            'liabilityPaise'   => $liability,
            'btcPriceInr'      => $btcInr,
            'btcRequired'      => $btcNeeded !== null ? round($btcNeeded, 8) : null,
            'userInrPaise'     => (int)$w['inr'],
            'investedPaise'    => (int)$w['invested'],
        ],
        'ledgerCheck' => [
            'ledgerInrPaise'   => $ledgerInr,
            'walletInrPaise'   => (int)$w['inr'],
            'inrDriftPaise'    => (int)$w['inr'] - $ledgerInr,
            'ledgerUnits'      => u8str($ledgerUnits),
            'walletUnits'      => u8str($unitsU8),
            'unitsDrift'       => u8str($unitsU8 - $ledgerUnits),
            'balanced'         => ((int)$w['inr'] - $ledgerInr) === 0 && ($unitsU8 - $ledgerUnits) === 0,
            'note'             => 'Wallets are a cached balance; the ledger is the book of record. '
                                . 'Any drift means a write went to one and not the other.',
        ],
        'treasuryFills' => q1(
            'SELECT
               COALESCE(SUM(CASE WHEN seller_id IS NULL THEN units ELSE 0 END),0) AS sold_to_users,
               COALESCE(SUM(CASE WHEN buyer_id  IS NULL THEN units ELSE 0 END),0) AS bought_from_users,
               COUNT(CASE WHEN counterparty = "treasury" THEN 1 END)              AS treasury_trades,
               COUNT(CASE WHEN counterparty = "user" THEN 1 END)                  AS user_trades
             FROM trades'
        ),
        'guidance' => 'Enter the Bitcoin actually held. Under half a percent of the requirement is '
                    . 'ordinary execution drift. More than that needs correcting before the next '
                    . 'redemption, because the shortfall is paid for by whoever exits last.',
    ]);
}

/* ============================================================== users ===== */

function handle_users(): void
{
    require_method('GET');
    require_admin();

    $search = trim((string)($_GET['q'] ?? ''));
    $params = [];
    $where  = '';
    if ($search !== '') {
        $where = 'WHERE u.email LIKE ? OR u.full_name LIKE ? OR u.referral_code = ?';
        $like  = '%' . $search . '%';
        $params = [$like, $like, strtoupper($search)];
    }

    $rows = q(
        "SELECT u.id, u.email, u.full_name, u.referral_code, u.tier_id, u.is_admin,
                u.status, u.created_at, u.last_login_at,
                k.status AS kyc_status,
                w.inr_paise, w.inr_locked_paise, w.arv_units, w.arv_locked_units, w.invested_paise
           FROM users u
           LEFT JOIN kyc k ON k.user_id = u.id
           LEFT JOIN wallets w ON w.user_id = u.id
           {$where}
          ORDER BY u.id DESC LIMIT 200", $params
    )->fetchAll();

    json_ok(['users' => array_map(static fn($u) => [
        'id'          => (int)$u['id'],
        'email'       => $u['email'],
        'name'        => $u['full_name'],
        'refCode'     => $u['referral_code'],
        'tier'        => $u['tier_id'] ?: null,
        'isAdmin'     => (bool)$u['is_admin'],
        'status'      => $u['status'],
        'kycStatus'   => $u['kyc_status'] ?? 'none',
        'inrPaise'    => (int)($u['inr_paise'] ?? 0),
        'inrLocked'   => (int)($u['inr_locked_paise'] ?? 0),
        'arvUnits'    => (string)($u['arv_units'] ?? '0'),
        'arvLocked'   => (string)($u['arv_locked_units'] ?? '0'),
        'investedPaise' => (int)($u['invested_paise'] ?? 0),
        'joined'      => $u['created_at'],
        'lastLogin'   => $u['last_login_at'],
    ], $rows)]);
}

/* =========================================================== settings ===== */

function handle_settings(): void
{
    require_method('GET');
    require_admin();
    json_ok(['settings' => settings(), 'warnings' => operator_warnings()]);
}

/**
 * Change a setting.
 *
 * Only an allow-list is writable, and a few are refused outright. Loss set-off
 * and fee deductibility are not preferences — the law does not permit either, and
 * a toggle that lets an operator turn them on is a toggle that produces a wrong
 * tax statement for every user.
 */
function handle_save_setting(): void
{
    require_method('POST');
    require_csrf();
    require_admin();

    $key   = input_str('key');
    $value = (string)input('value', '');

    $writable = [
        'entry_fee_pct', 'exit_fee_pct', 'gst_pct', 'slippage_pct',
        'min_order_paise', 'min_withdraw_paise',
        'sell_fallback_to_treasury', 'sell_fallback_minutes',
        'buy_fills_from_treasury', 'order_expiry_hours',
        'deposit_min_minutes', 'deposit_max_minutes',
        'withdraw_min_minutes', 'withdraw_max_minutes',
        'referral_enabled', 'referral_pct', 'referral_max_paise',
        'kyc_required', 'upi_vpa', 'payee_name',
        'price_max_age_seconds', 'maintenance_mode',
        'login_otp_always', 'aadhaar_provider',
        'tds_pct', 'tds_pct_no_pan', 'vda_gain_pct', 'cess_pct',
        'tds_threshold_paise', 'tds_threshold_specified_paise',
    ];

    if (!in_array($key, $writable, true)) {
        json_fail(422, 'That setting is not editable here.');
    }

    // Guardrails on the ones where a wrong value is expensive rather than merely
    // wrong.
    $numeric = [
        'entry_fee_pct' => [0, 5], 'exit_fee_pct' => [0, 5], 'gst_pct' => [0, 28],
        'slippage_pct' => [0, 2], 'referral_pct' => [0, 10],
        'sell_fallback_minutes' => [1, 10080], 'price_max_age_seconds' => [60, 86400],
        'vda_gain_pct' => [0, 50], 'cess_pct' => [0, 10],
        'tds_pct' => [0, 30], 'tds_pct_no_pan' => [0, 30],
    ];
    if (isset($numeric[$key])) {
        $n = (float)$value;
        [$lo, $hi] = $numeric[$key];
        if ($n < $lo || $n > $hi) {
            json_fail(422, sprintf('%s must be between %s and %s.', $key, $lo, $hi));
        }
    }

    if ($key === 'referral_pct' && (float)$value > 10) {
        json_fail(422, 'Above 10% this stops looking like a referral fee. Have counsel sign that off first.');
    }

    $before = setting($key);
    setting_set($key, $value);

    audit('setting.change', ['entity' => 'settings', 'entity_id' => $key,
                             'detail' => ['from' => $before, 'to' => $value]]);

    json_ok(['message' => 'Saved.', 'key' => $key, 'value' => $value,
             'warnings' => operator_warnings()]);
}
