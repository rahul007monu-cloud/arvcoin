<?php
/**
 * Withdrawals — rupees out, to UPI.
 *
 * Only the INR wallet is withdrawn. Selling ARV is a separate step that credits
 * rupees first, which is what keeps the two concerns apart: a sale has a tax
 * position and a market price, a withdrawal has neither.
 *
 * The amount is debited and held the moment the request is made, not when an
 * operator approves it. Otherwise a user could request their whole balance three
 * times over and an operator would pay all three.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'create': handle_create(); break;
    case 'mine':   handle_mine();   break;
    case 'cancel': handle_cancel(); break;
    default:
        json_fail(400, 'Unknown action.');
}

function handle_create(): void
{
    require_method('POST');
    require_csrf();
    maintenance_guard();
    $u = require_user();
    rate_limit('withdraw_create', 10, 3600, 1800);

    $paise = input_int('amountPaise');
    $vpa   = input_str('upiVpa');
    $min   = setting_i('min_withdraw_paise', 10000);

    if ($paise < $min) {
        json_fail(422, sprintf('The minimum withdrawal is ₹%s.', number_format($min / 100)));
    }

    // KYC gates money leaving the platform even though it does not gate selling.
    // Paying out to an unverified account is the part that carries real AML risk.
    if (setting_b('kyc_required', true)) {
        $kyc = q1('SELECT status FROM kyc WHERE user_id = ?', [$u['id']]);
        if (($kyc['status'] ?? 'none') !== 'verified') {
            json_fail(403, 'Complete KYC before withdrawing.', [
                'needs' => 'kyc', 'kycStatus' => $kyc['status'] ?? 'none',
            ]);
        }
    }

    if ($vpa === '') {
        $kyc = q1('SELECT upi_vpa FROM kyc WHERE user_id = ?', [$u['id']]);
        $vpa = (string)($kyc['upi_vpa'] ?? '');
    }
    if (!preg_match('/^[\w.\-]{2,}@[a-zA-Z]{2,}$/', $vpa)) {
        json_fail(422, 'Enter a valid UPI ID, like yourname@bank.');
    }

    $open = qval('SELECT COUNT(*) FROM withdrawals
                   WHERE user_id = ? AND status IN ("requested","approved")', [$u['id']]);
    if ((int)$open >= 3) {
        json_fail(409, 'You already have three withdrawals in the queue. Wait for those to settle.');
    }

    $ref     = ref('WDR');
    $maxMins = setting_i('withdraw_max_minutes', 60);

    $id = tx(static function (PDO $pdo) use ($u, $paise, $vpa, $ref, $maxMins) {
        $w = wallet_for_update($pdo, (int)$u['id']);
        if ((int)$w['inr_paise'] < $paise) {
            throw new RuntimeException(sprintf(
                'You have ₹%s available. Sell ARV first if you want to withdraw more.',
                number_format((int)$w['inr_paise'] / 100, 2)
            ));
        }

        // Held immediately, in the same transaction as the request row.
        wallet_apply($pdo, (int)$u['id'], -$paise, $paise);

        $pdo->prepare(
            'INSERT INTO withdrawals (ref, user_id, amount_paise, upi_vpa, status, promised_by)
             VALUES (?, ?, ?, ?, "requested", DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))'
        )->execute([$ref, (int)$u['id'], $paise, $vpa, $maxMins]);

        $id = (int)$pdo->lastInsertId();
        ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
            'ref' => $ref, 'relatedId' => $id,
            'note' => sprintf('₹%s held for withdrawal to %s', number_format($paise / 100, 2), $vpa),
        ]);
        return $id;
    });

    // Save the payout ID for next time — retyping a UPI ID is where typos, and
    // therefore failed payouts, come from.
    q('UPDATE kyc SET upi_vpa = ? WHERE user_id = ? AND upi_vpa = ""', [$vpa, $u['id']]);

    audit('withdraw.create', ['entity' => 'withdrawals', 'entity_id' => $ref,
                              'detail' => ['paise' => $paise]]);

    json_ok([
        'withdrawal' => withdrawal_public($id, (int)$u['id']),
        'window'     => [
            'minMinutes' => setting_i('withdraw_min_minutes', 5),
            'maxMinutes' => $maxMins,
        ],
        'message' => sprintf(
            'Requested. Payouts go out in %d to %d minutes. The amount is already held, so your '
            . 'balance reflects it immediately.',
            setting_i('withdraw_min_minutes', 5), $maxMins
        ),
    ]);
}

function handle_mine(): void
{
    require_method('GET');
    $u = require_user();
    $rows = q('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100',
              [$u['id']])->fetchAll();
    json_ok(['withdrawals' => array_map('withdrawal_row_public', $rows)]);
}

function handle_cancel(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $ref = input_str('ref');

    $result = tx(static function (PDO $pdo) use ($u, $ref) {
        $st = $pdo->prepare('SELECT * FROM withdrawals WHERE ref = ? AND user_id = ? FOR UPDATE');
        $st->execute([$ref, (int)$u['id']]);
        $wd = $st->fetch();

        if (!$wd) {
            throw new RuntimeException('Withdrawal not found.');
        }
        // Once approved, an operator may already have sent the money. Cancelling
        // then would return rupees the user has also received in their bank.
        if ($wd['status'] !== 'requested') {
            throw new RuntimeException(
                $wd['status'] === 'approved'
                    ? 'That withdrawal is already approved and being paid out. Contact operations.'
                    : 'That withdrawal is already ' . $wd['status'] . '.'
            );
        }

        $paise = (int)$wd['amount_paise'];
        wallet_apply($pdo, (int)$u['id'], $paise, -$paise);

        $pdo->prepare('UPDATE withdrawals SET status = "rejected",
                              reject_reason = "Cancelled by the user" WHERE id = ?')
            ->execute([$wd['id']]);

        ledger_add($pdo, (int)$u['id'], 'adjustment', 0, 0, [
            'ref' => $ref, 'relatedId' => (int)$wd['id'],
            'note' => 'Withdrawal cancelled — hold released',
        ]);

        return ['returnedPaise' => $paise];
    });

    audit('withdraw.cancel', ['entity' => 'withdrawals', 'entity_id' => $ref]);
    json_ok($result + ['message' => 'Withdrawal cancelled and the hold released.']);
}

function withdrawal_public(int $id, int $userId): array
{
    $w = q1('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?', [$id, $userId]);
    if (!$w) {
        json_fail(404, 'Withdrawal not found.');
    }
    return withdrawal_row_public($w);
}

function withdrawal_row_public(array $w): array
{
    $promised = $w['promised_by'] !== null ? strtotime($w['promised_by']) : null;

    return [
        'ref'          => $w['ref'],
        'amountPaise'  => (int)$w['amount_paise'],
        'upiVpa'       => $w['upi_vpa'],
        'status'       => $w['status'],
        'createdAt'    => $w['created_at'],
        'approvedAt'   => $w['approved_at'],
        'paidAt'       => $w['paid_at'],
        'promisedBy'   => $w['promised_by'],
        'rejectReason' => $w['reject_reason'],
        'minutesLeft'  => ($promised && in_array($w['status'], ['requested', 'approved'], true))
            ? max(0, (int)ceil(($promised - time()) / 60))
            : null,
        // Surfaced rather than hidden: if a payout has run past the window the
        // user was promised, they should be able to see that and chase it.
        'overdue'      => $promised !== null && time() > $promised
                          && in_array($w['status'], ['requested', 'approved'], true),
    ];
}
