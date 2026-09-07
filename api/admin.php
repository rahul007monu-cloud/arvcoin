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
require __DIR__ . '/_p2p.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'overview':          handle_overview();        break;
    case 'p2p_trades':        handle_p2p_trades();      break;
    case 'p2p_release':       handle_p2p_release();     break;
    case 'p2p_cancel':        handle_p2p_cancel();      break;
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
    case 'set_user_status':   handle_set_user_status(); break;
    case 'set_user_admin':    handle_set_user_admin();  break;
    case 'ledger':            handle_ledger();          break;
    case 'orders_all':        handle_orders_all();      break;
    case 'cancel_order_admin':handle_cancel_order_admin(); break;
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
                        // The commission is EARNED in rupees (a percentage of the
                        // referred deposit) but PAID in ARV, converted at the index
                        // price at this moment.
                        //
                        // It used to be credited to the rupee balance, and that
                        // balance no longer has a use: trading is peer-to-peer, so
                        // a buyer pays the seller off-platform and api/p2p.php never
                        // touches INR. A rupee commission therefore just accumulated
                        // with no way to spend it. Paying in ARV puts it into the
                        // one thing the account can actually hold and sell.
                        //
                        // NOTE for the operator: these units are ISSUED, not moved
                        // from another account, so the platform's ARV obligation
                        // grows by the commission. That is the real cost of the
                        // referral programme. Funding it from the fee/treasury
                        // account instead would be units-neutral, but would make
                        // referrals fail silently whenever that account ran dry.
                        $navMeta = arv_nav_meta();
                        $nav     = $navMeta['nav'];
                        $units8  = ($nav !== null && (float)$nav > 0)
                            ? paise_to_u8($amount, (float)$nav)
                            : 0;

                        // Only call it paid once the ARV is actually credited. With
                        // no usable price (a cold or long-stale feed) the row is
                        // recorded as 'pending' instead, so the commission is
                        // preserved and visible rather than silently dropped — and
                        // the deposit confirmation itself still succeeds.
                        $didPay = $units8 > 0;

                        $pdo->prepare(
                            'INSERT INTO referrals (referrer_id, referee_id, trigger_deposit_id,
                                                    base_paise, commission_paise, commission_pct,
                                                    status, paid_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ' . ($didPay ? 'UTC_TIMESTAMP()' : 'NULL') . ')'
                        )->execute([
                            (int)$referrer, $userId, (int)$d['id'], $paise, $amount, $pct,
                            $didPay ? 'paid' : 'pending',
                        ]);

                        if ($didPay) {
                            // Credit the units and carry the rupee value as the cost
                            // basis, so value == cost at receipt (unrealised P&L
                            // starts at zero) and a later sale measures the gain from
                            // there.
                            wallet_apply($pdo, (int)$referrer, 0, 0, $units8, 0, $amount, 0);

                            // A lot is not optional: consume_lots() is what a sale
                            // draws from, and units credited without one would make
                            // the referrer's next sell fail on a shortfall.
                            $pdo->prepare(
                                'INSERT INTO lots (user_id, units, units_remaining, cost_paise, nav)
                                 VALUES (?, ?, ?, ?, ?)'
                            )->execute([
                                (int)$referrer, u8str($units8), u8str($units8), $amount, $nav,
                            ]);

                            // Still its own ledger kind, so the income never reads as
                            // a capital gain — the delta is now in ARV, and the rupee
                            // value it was earned at is in the note and on the
                            // referrals row.
                            ledger_add($pdo, (int)$referrer, 'referral_commission', 0, $units8, [
                                'nav' => $nav, 'ref' => $ref, 'relatedId' => $userId,
                                'note' => sprintf(
                                    '%s%% referral commission on a referred first deposit — %s paid as ARV at %s',
                                    $pct, money_note($amount), money_note((int)round((float)$nav * 100))
                                ),
                            ]);
                        }

                        $commission = [
                            'referrerId' => (int)$referrer,
                            'paise'      => $amount,
                            'pct'        => $pct,
                            'arvUnits'   => u8str($units8),
                            'nav'        => $nav,
                            'status'     => $didPay ? 'paid' : 'pending',
                        ];
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

/**
 * Suspend or reactivate a user.
 *
 * status is only ever active <-> suspended here; 'closed' is a separate lifecycle
 * step and is not reachable from this toggle. An operator cannot suspend their own
 * account — locking yourself out of the panel that would let you undo it is a trap
 * with no way back, exactly like the mail-delivery lockout the OTP table guards
 * against.
 */
function handle_set_user_status(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $userId = input_int('userId');
    $status = input_str('status');

    if ($userId <= 0) {
        json_fail(422, 'Which user?');
    }
    if (!in_array($status, ['active', 'suspended'], true)) {
        json_fail(422, 'Status must be active or suspended.');
    }
    // You cannot lock yourself out of the operator panel.
    if ($userId === (int)$admin['id'] && $status === 'suspended') {
        json_fail(422, 'You cannot suspend your own account.');
    }

    $u = q1('SELECT id, status FROM users WHERE id = ?', [$userId]);
    if (!$u) {
        json_fail(404, 'No such user.');
    }

    q('UPDATE users SET status = ? WHERE id = ?', [$status, $userId]);

    audit('user.status', ['entity' => 'users', 'entity_id' => (string)$userId,
                          'detail' => ['from' => $u['status'], 'to' => $status]]);

    json_ok(['message' => $status === 'suspended' ? 'User suspended.' : 'User activated.']);
}

/**
 * Grant or remove operator access.
 *
 * An operator cannot remove their own admin flag — the same lock-yourself-out
 * trap as suspension, and worse here because it would leave a site with no
 * operator at all if they are the only one. Removing it must be done by another
 * operator.
 */
function handle_set_user_admin(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $userId  = input_int('userId');
    $isAdmin = input_int('isAdmin');

    if ($userId <= 0) {
        json_fail(422, 'Which user?');
    }
    if (!in_array($isAdmin, [0, 1], true)) {
        json_fail(422, 'isAdmin must be 0 or 1.');
    }
    // You cannot strip your own operator access.
    if ($userId === (int)$admin['id'] && $isAdmin === 0) {
        json_fail(422, 'You cannot remove your own operator access — ask another operator to do it.');
    }

    $u = q1('SELECT id, is_admin FROM users WHERE id = ?', [$userId]);
    if (!$u) {
        json_fail(404, 'No such user.');
    }

    q('UPDATE users SET is_admin = ? WHERE id = ?', [$isAdmin, $userId]);

    audit('user.admin', ['entity' => 'users', 'entity_id' => (string)$userId,
                         'detail' => ['from' => (int)$u['is_admin'], 'to' => $isAdmin]]);

    json_ok(['message' => $isAdmin ? 'Operator access granted.' : 'Operator access removed.']);
}

/* ============================================================= ledger ===== */

/**
 * The book of record, read-only.
 *
 * Every rupee and unit movement, most recent first. This is append-only and
 * enforced as such by a database trigger — there is deliberately no edit or delete
 * here or anywhere, because a correction is a new compensating entry, never a
 * change to a past one. Optional search is by user id (numeric) or email.
 */
function handle_ledger(): void
{
    require_method('GET');
    require_admin();

    $search = trim((string)($_GET['q'] ?? ''));
    $params = [];
    $where  = '';
    if ($search !== '') {
        if (ctype_digit($search)) {
            $where  = 'WHERE l.user_id = ?';
            $params = [(int)$search];
        } else {
            $where  = 'WHERE u.email LIKE ?';
            $params = ['%' . $search . '%'];
        }
    }

    $rows = q(
        "SELECT l.id, l.user_id, l.kind, l.inr_delta_paise, l.arv_delta_units,
                l.nav, l.ref, l.related_id, l.note, l.fy, l.created_at, u.email
           FROM ledger l
           LEFT JOIN users u ON u.id = l.user_id
           {$where}
          ORDER BY l.id DESC LIMIT 200", $params
    )->fetchAll();

    json_ok(['ledger' => array_map(static fn($r) => [
        'id'            => (int)$r['id'],
        'userId'        => $r['user_id'] !== null ? (int)$r['user_id'] : null,
        'email'         => $r['email'],
        'kind'          => $r['kind'],
        'inrDeltaPaise' => (int)$r['inr_delta_paise'],
        'arvDeltaUnits' => (string)$r['arv_delta_units'],
        'nav'           => $r['nav'] !== null ? (float)$r['nav'] : null,
        'ref'           => $r['ref'],
        'relatedId'     => $r['related_id'] !== null ? (int)$r['related_id'] : null,
        'note'          => $r['note'],
        'fy'            => $r['fy'],
        'createdAt'     => $r['created_at'],
    ], $rows)]);
}

/* ============================================================= orders ===== */

/**
 * Every order across every user, most recent first.
 *
 * The status filter mirrors the book's own vocabulary: "open" means anything still
 * live (open, triggered or partial), the terminal states are exact, and "all"
 * drops the filter. Optional search is by user id (numeric) or email.
 */
function handle_orders_all(): void
{
    require_method('GET');
    require_admin();

    $status = (string)($_GET['status'] ?? 'open');
    $search = trim((string)($_GET['q'] ?? ''));

    $where  = [];
    $params = [];

    if ($status === 'open') {
        $where[] = 'o.status IN ("open","triggered","partial")';
    } elseif (in_array($status, ['filled', 'cancelled', 'expired'], true)) {
        $where[]  = 'o.status = ?';
        $params[] = $status;
    }
    // 'all' (or anything unrecognised) adds no status clause.

    if ($search !== '') {
        if (ctype_digit($search)) {
            $where[]  = 'o.user_id = ?';
            $params[] = (int)$search;
        } else {
            $where[]  = 'u.email LIKE ?';
            $params[] = '%' . $search . '%';
        }
    }

    $clause = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $rows = q(
        "SELECT o.*, u.email
           FROM orders o
           JOIN users u ON u.id = o.user_id
           {$clause}
          ORDER BY o.created_at DESC, o.id DESC LIMIT 200", $params
    )->fetchAll();

    json_ok(['orders' => array_map(static fn($o) => [
        'id'          => (int)$o['id'],
        'ref'         => $o['ref'],
        'userId'      => (int)$o['user_id'],
        'email'       => $o['email'],
        'side'        => $o['side'],
        'type'        => $o['otype'],
        'amountPaise' => $o['amount_paise'] !== null ? (int)$o['amount_paise'] : null,
        'units'       => $o['units'] !== null ? (string)$o['units'] : null,
        'triggerNav'  => $o['trigger_nav'] !== null ? (float)$o['trigger_nav'] : null,
        'filledUnits' => (string)$o['filled_units'],
        'filledPaise' => (int)$o['filled_paise'],
        'lockedPaise' => (int)$o['locked_paise'],
        'lockedUnits' => (string)$o['locked_units'],
        'status'      => $o['status'],
        'createdAt'   => $o['created_at'],
    ], $rows)]);
}

/**
 * Cancel an open order on a user's behalf.
 *
 * This mirrors the user's own cancel in orders.php exactly: only the unfilled
 * remainder is released, and it is released the same way — locked rupees back to
 * available, locked units back to available — inside one transaction that also
 * flips the order to cancelled and writes the ledger entry. The balance maths is
 * not reinvented here; anything already filled is a completed trade and is not
 * touched.
 */
function handle_cancel_order_admin(): void
{
    require_method('POST');
    require_csrf();
    require_admin();

    $id = input_int('orderId');
    if ($id <= 0) {
        json_fail(422, 'Which order?');
    }

    $result = tx(static function (PDO $pdo) use ($id) {
        $st = $pdo->prepare('SELECT * FROM orders WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $o = $st->fetch();

        if (!$o) {
            throw new RuntimeException('Order not found.');
        }
        if (!in_array($o['status'], ['open', 'triggered', 'partial'], true)) {
            throw new RuntimeException('That order is already ' . $o['status'] . '.');
        }

        $userId      = (int)$o['user_id'];
        $lockedPaise = (int)$o['locked_paise'];
        $lockedUnits = u8((string)$o['locked_units']);

        if ($lockedPaise > 0) {
            wallet_apply($pdo, $userId, $lockedPaise, -$lockedPaise);
        }
        if ($lockedUnits > 0) {
            wallet_apply($pdo, $userId, 0, 0, $lockedUnits, -$lockedUnits);
        }

        $pdo->prepare('UPDATE orders SET status = "cancelled", locked_paise = 0, locked_units = 0
                       WHERE id = ?')->execute([$id]);

        ledger_add($pdo, $userId, 'adjustment', 0, 0, [
            'ref' => (string)$o['ref'], 'relatedId' => $id,
            'note' => 'Order cancelled by operator — unfilled portion returned',
        ]);

        return [
            'userId'        => $userId,
            'returnedPaise' => $lockedPaise,
            'returnedUnits' => u8str($lockedUnits),
            'filledUnits'   => (string)$o['filled_units'],
        ];
    });

    audit('order.cancel.admin', ['entity' => 'orders', 'entity_id' => (string)$id, 'detail' => $result]);
    json_ok($result + ['message' => 'Order cancelled.']);
}

/* ============================================================== p2p ======= */

/**
 * Every P2P escrow trade, most recent first, with both parties' details.
 *
 * The operator sees the full seller payment snapshot (they may need it to settle
 * a dispute) and both emails — this endpoint is operator-only and audited. The
 * status filter mirrors the trade lifecycle; 'active' is the live subset an
 * operator would act on (matched or paid), and 'all' drops the filter.
 */
function handle_p2p_trades(): void
{
    require_method('GET');
    require_admin();

    $status = (string)($_GET['status'] ?? 'active');
    $search = trim((string)($_GET['q'] ?? ''));

    $where  = [];
    $params = [];

    if ($status === 'active') {
        // 'active' is the live subset an operator acts on — now including
        // 'disputed', which is precisely the case that needs a human.
        $where[] = "p.status IN ('matched','paid','disputed')";
    } elseif (in_array($status, ['matched', 'paid', 'released', 'cancelled', 'disputed', 'expired'], true)) {
        $where[]  = 'p.status = ?';
        $params[] = $status;
    }
    if ($search !== '') {
        if (ctype_digit($search)) {
            $where[]  = '(p.buyer_id = ? OR p.seller_id = ?)';
            $params[] = (int)$search;
            $params[] = (int)$search;
        } else {
            $where[]  = '(bu.email LIKE ? OR su.email LIKE ?)';
            $params[] = '%' . $search . '%';
            $params[] = '%' . $search . '%';
        }
    }
    $clause = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $rows = q(
        "SELECT p.*, bu.email AS buyer_email, su.email AS seller_email
           FROM p2p_trades p
           JOIN users bu ON bu.id = p.buyer_id
           JOIN users su ON su.id = p.seller_id
           {$clause}
          ORDER BY (p.status = 'disputed') DESC, p.id DESC LIMIT 200", $params
    )->fetchAll();

    // The current treasury account's email, so treasury trades (seller =
    // treasury) can be flagged for the operator: those are the ones the operator
    // must confirm/release after the COMPANY account has received the buyer's
    // rupees — no real seller will ever confirm them. Resolved once here rather
    // than per row. A blank/off treasury simply flags nothing.
    $treasuryEmail = trim((string)setting('p2p_treasury_email', ''));

    json_ok(['trades' => array_map(static function ($t) use ($treasuryEmail) {
        // -1 viewer id so it is neither buyer nor seller; isAdmin exposes the
        // payment snapshot for dispute handling.
        $pub = p2p_trade_public($t, -1, true);
        $pub['buyerEmail']  = $t['buyer_email'];
        $pub['sellerEmail'] = $t['seller_email'];
        $pub['proofImage']  = ($t['proof_image_path'] ?? '') !== '' ? $t['proof_image_path'] : null;
        $pub['resolvedBy']  = $t['resolved_by'] !== null ? (int)$t['resolved_by'] : null;
        // Treasury-seller trade: no resting sell order and the seller is the
        // treasury account. Either signal alone is a strong hint; together they
        // are unambiguous. Surfaced so the operator sees which trades are theirs
        // to settle once the company account is paid.
        $pub['isTreasury'] = $treasuryEmail !== ''
            && strcasecmp((string)$t['seller_email'], $treasuryEmail) === 0
            && $t['seller_order_id'] === null;
        return $pub;
    }, $rows)]);
}

/**
 * Operator override: release a trade's escrow to the buyer.
 *
 * The same money path as the seller's own confirm (p2p_release_core) — units to
 * the buyer, a `trades` row for tax, ledger entries both sides. Allowed for a
 * matched, paid or DISPUTED trade so an operator can resolve one the seller has
 * stopped responding to, or one the confirm timer sent to dispute. Use only when
 * the rupees genuinely reached the seller. The status is re-checked under the row
 * lock before the core runs, so a trade already released/cancelled/expired by a
 * racing user action or the cron cannot be released a second time.
 */
function handle_p2p_release(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $id = input_int('id');
    if ($id <= 0) {
        json_fail(422, 'Which trade?');
    }

    $result = tx(static function (PDO $pdo) use ($id, $admin) {
        $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $t = $st->fetch();
        if (!$t) {
            throw new RuntimeException('Trade not found.');
        }
        if (!in_array($t['status'], ['matched', 'paid', 'disputed'], true)) {
            throw new RuntimeException('This trade is ' . $t['status'] . ' and cannot be released.');
        }
        $wasDisputed = $t['status'] === 'disputed';
        $r = p2p_release_core($pdo, $t);
        // Stamp the resolution audit fields on the (now 'released') row. Only a
        // dispute needs a resolution record, but recording it for any operator
        // release is harmless and useful.
        $pdo->prepare(
            'UPDATE p2p_trades SET resolved_at = UTC_TIMESTAMP(), resolved_by = ?, resolution = ?
              WHERE id = ?'
        )->execute([
            (int)$admin['id'],
            $wasDisputed ? 'dispute resolved: released to buyer' : 'released to buyer by operator',
            $id,
        ]);
        return $r;
    });

    audit('p2p.release.admin', ['entity' => 'p2p_trades', 'entity_id' => (string)$id,
                                'actor' => (int)$admin['id'], 'detail' => $result]);
    json_ok($result + ['message' => sprintf('Released %s ARV to the buyer.', $result['units'])]);
}

/**
 * Operator override: cancel a trade and return the escrow to the seller.
 *
 * The same money path as a user cancel (p2p_cancel_core) — the escrow returns to
 * the seller. Allowed for matched, paid or DISPUTED; a reason is required because
 * it is a manual intervention that the audit log should carry. This is the arm an
 * operator uses when the buyer did NOT actually pay. The status is re-checked
 * under the row lock before the core runs, so a trade already released/cancelled/
 * expired cannot have its escrow returned a second time.
 */
function handle_p2p_cancel(): void
{
    require_method('POST');
    require_csrf();
    $admin = require_admin();

    $id     = input_int('id');
    $reason = substr(input_str('reason'), 0, 200);
    if ($id <= 0) {
        json_fail(422, 'Which trade?');
    }
    if ($reason === '') {
        json_fail(422, 'Give a reason — this is a manual intervention and it is logged.');
    }

    $result = tx(static function (PDO $pdo) use ($id, $reason, $admin) {
        $st = $pdo->prepare('SELECT * FROM p2p_trades WHERE id = ? FOR UPDATE');
        $st->execute([$id]);
        $t = $st->fetch();
        if (!$t) {
            throw new RuntimeException('Trade not found.');
        }
        if (!in_array($t['status'], ['matched', 'paid', 'disputed'], true)) {
            throw new RuntimeException('This trade is ' . $t['status'] . ' and cannot be cancelled.');
        }
        $wasDisputed = $t['status'] === 'disputed';
        $r = p2p_cancel_core($pdo, $t, 'operator: ' . $reason);
        // Record who settled it and how, alongside the cancel_reason the core set.
        $pdo->prepare(
            'UPDATE p2p_trades SET resolved_at = UTC_TIMESTAMP(), resolved_by = ?, resolution = ?
              WHERE id = ?'
        )->execute([
            (int)$admin['id'],
            ($wasDisputed ? 'dispute resolved: escrow returned to seller' : 'cancelled by operator')
                . ' — ' . $reason,
            $id,
        ]);
        return $r;
    });

    audit('p2p.cancel.admin', ['entity' => 'p2p_trades', 'entity_id' => (string)$id,
                               'actor' => (int)$admin['id'], 'detail' => ['reason' => $reason] + $result]);
    json_ok($result + ['message' => 'Trade cancelled and escrow returned to the seller.']);
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
        'login_otp_always', 'aadhaar_provider', 'google_client_id',
        'trust_hours',
        'tds_pct', 'tds_pct_no_pan', 'vda_gain_pct', 'cess_pct',
        'tds_threshold_paise', 'tds_threshold_specified_paise',
        // P2P Phase 2 timers.
        'p2p_match_ttl_hours', 'p2p_pay_ttl_minutes', 'p2p_confirm_ttl_hours',
        // P2P Phase 2b: treasury default-liquidity + fee/TDS collected in ARV.
        'p2p_treasury_email', 'p2p_treasury_enabled', 'p2p_fee_account_email',
        'p2p_fee_pct', 'p2p_tds_pct',
        // Support assistant: on/off, and an optional Gemini API key. With no key
        // the assistant still answers from its built-in knowledge base.
        'assistant_enabled', 'gemini_api_key',
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
        // A month of silent trust is a different product to a day of it. Capped
        // so that raising it is a decision rather than a typo.
        'trust_hours' => [1, 720],
        'vda_gain_pct' => [0, 50], 'cess_pct' => [0, 10],
        'tds_pct' => [0, 30], 'tds_pct_no_pan' => [0, 30],
        // P2P Phase 2 timers. A too-short window traps money in limbo; a
        // too-long one lets a vanished counterparty hold escrow hostage — so
        // both ends are bounded and a change is a decision, not a typo.
        'p2p_match_ttl_hours' => [1, 168],   // 1 hour … 7 days
        'p2p_pay_ttl_minutes' => [5, 1440],  // 5 min … 24 hours
        'p2p_confirm_ttl_hours' => [1, 72],  // 1 hour … 3 days
        // P2P Phase 2b fee model. Both are a percentage of the traded units,
        // collected in ARV. Bounded so a fat-finger cannot quietly skim a large
        // slice of every buyer's units. p2p_tds_pct is SEPARATE from the index
        // tds_pct and defaults to 0 — nothing changes until an operator sets it.
        'p2p_fee_pct' => [0, 5],             // platform fee, 0–5%
        'p2p_tds_pct' => [0, 30],            // P2P TDS, 0–30%
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

    // Checked here because the failure is otherwise silent and confusing: a
    // mistyped client ID renders a Google button that refuses every sign-in with
    // a message from Google's own script, in the browser console, where an
    // operator will never see it. Empty is allowed — that is how the feature is
    // turned off.
    if ($key === 'google_client_id') {
        $value = trim($value);
        if ($value !== '' && !preg_match('/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i', $value)) {
            json_fail(422, 'That does not look like a Google client ID. It ends in '
                         . '.apps.googleusercontent.com and comes from Google Cloud Console '
                         . '→ Credentials → OAuth 2.0 Client IDs. Paste the Client ID, not the secret.');
        }
    }

    // The P2P treasury / fee account emails must name an existing user (empty is
    // allowed — that is how each is turned off / falls back). A validated,
    // KYC/payment/ARV check happens lazily at match/release time (the account can
    // gain those later); here we only reject a typo that names nobody, so an
    // operator gets an error at save time rather than silent no-fill later.
    if ($key === 'p2p_treasury_email' || $key === 'p2p_fee_account_email') {
        $value = trim($value);
        if ($value !== '') {
            $exists = q1('SELECT id FROM users WHERE email = ? LIMIT 1', [$value]);
            if (!$exists) {
                json_fail(422, 'No user account has that email. Create the account first '
                             . '(a normal signup), complete its KYC and add its payment method, '
                             . 'then name it here.');
            }
        }
    }

    // Turning the treasury ON is only meaningful if an email is set and resolves
    // to a usable account — refuse the toggle otherwise so "on" never silently
    // means "unavailable".
    if ($key === 'p2p_treasury_enabled' && ($value === '1' || $value === 'true')) {
        $email = trim((string)setting('p2p_treasury_email', ''));
        if ($email === '') {
            json_fail(422, 'Set the treasury account email before turning the treasury on.');
        }
        $tu = tx(static fn(PDO $pdo) => p2p_treasury_user_by_email($pdo, $email));
        if ($tu === null) {
            json_fail(422, 'That treasury account is not usable yet — it must be an active, '
                         . 'KYC-verified user with a saved payment method. Fix that, then turn it on.');
        }
    }

    $before = setting($key);
    setting_set($key, $value);

    audit('setting.change', ['entity' => 'settings', 'entity_id' => $key,
                             'detail' => ['from' => $before, 'to' => $value]]);

    json_ok(['message' => 'Saved.', 'key' => $key, 'value' => $value,
             'warnings' => operator_warnings()]);
}
