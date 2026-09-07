<?php
/**
 * Payment methods — where a seller receives INR in a P2P trade.
 *
 * The platform never touches this money; a P2P buyer pays the seller directly.
 * So these rows are reference data: a UPI VPA, or bank account details, that get
 * COPIED onto a trade at match time. Editing or deleting a method never changes
 * a trade already in flight, because the trade carries its own snapshot.
 *
 * Every write is require_user + require_csrf + POST, and only ever touches the
 * caller's own rows.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_p2p.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'list':        handle_list();        break;
    case 'add':         handle_add();         break;
    case 'delete':      handle_delete();      break;
    case 'set_default': handle_set_default(); break;
    default:
        json_fail(400, 'Unknown action.');
}

// A VPA is name@bank — validated loosely, the same shape the KYC form accepts.
const PM_VPA_RE  = '/^[\w.\-]{2,}@[a-zA-Z]{2,}$/';
// An IFSC is four letters, a 0, then six alphanumerics.
const PM_IFSC_RE = '/^[A-Z]{4}0[A-Z0-9]{6}$/';

/* =============================================================== list ===== */

function handle_list(): void
{
    require_method('GET');
    $u = require_user();

    $rows = q('SELECT * FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, id DESC',
              [$u['id']])->fetchAll();

    json_ok(['methods' => array_map('p2p_payment_method_public', $rows)]);
}

/* ================================================================ add ===== */

function handle_add(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();
    rate_limit('pm_add', 20, 3600);

    $type  = input_str('type');
    $label = substr(input_str('label'), 0, 80);

    if (!in_array($type, ['upi', 'bank'], true)) {
        json_fail(422, 'Choose UPI or bank.');
    }

    $upiVpa = $accountName = $bankAccountNo = $bankIfsc = '';

    if ($type === 'upi') {
        $upiVpa = input_str('upiVpa');
        if (!preg_match(PM_VPA_RE, $upiVpa)) {
            json_fail(422, 'A UPI ID looks like yourname@bank.', ['fields' => ['upiVpa' => 'Enter a valid UPI ID, e.g. yourname@okhdfc.']]);
        }
    } else {
        $accountName   = substr(input_str('accountName'), 0, 120);
        $bankAccountNo = preg_replace('/\s+/', '', input_str('bankAccountNo'));
        $bankIfsc      = strtoupper(preg_replace('/\s+/', '', input_str('bankIfsc')));

        $fields = [];
        if ($accountName === '') {
            $fields['accountName'] = 'Enter the account holder name.';
        }
        if (!preg_match('/^\d{6,20}$/', (string)$bankAccountNo)) {
            $fields['bankAccountNo'] = 'A bank account number is 6 to 20 digits.';
        }
        if (!preg_match(PM_IFSC_RE, (string)$bankIfsc)) {
            $fields['bankIfsc'] = 'An IFSC is like HDFC0001234 — four letters, a 0, then six characters.';
        }
        if ($fields) {
            json_fail(422, 'Check the bank details.', ['fields' => $fields]);
        }
    }

    // A generous cap so the list stays a list, not a dumping ground.
    $count = (int)(qval('SELECT COUNT(*) FROM payment_methods WHERE user_id = ?', [$u['id']]) ?? 0);
    if ($count >= 10) {
        json_fail(409, 'You have reached the limit of 10 saved payment methods. Delete one first.');
    }

    $id = tx(static function (PDO $pdo) use ($u, $type, $label, $upiVpa, $accountName, $bankAccountNo, $bankIfsc, $count) {
        // The first method a user adds becomes their default automatically.
        $isDefault = $count === 0 ? 1 : 0;

        $pdo->prepare(
            'INSERT INTO payment_methods
               (user_id, type, label, upi_vpa, account_name, bank_account_no, bank_ifsc, is_default)
             VALUES (?,?,?,?,?,?,?,?)'
        )->execute([
            (int)$u['id'], $type, $label, $upiVpa, $accountName, $bankAccountNo, $bankIfsc, $isDefault,
        ]);
        return (int)$pdo->lastInsertId();
    });

    audit('payment_method.add', ['entity' => 'payment_methods', 'entity_id' => (string)$id,
                                 'detail' => ['type' => $type]]);

    $row = q1('SELECT * FROM payment_methods WHERE id = ? AND user_id = ?', [$id, $u['id']]);
    json_ok(['method' => p2p_payment_method_public($row), 'message' => 'Payment method saved.']);
}

/* ============================================================= delete ===== */

function handle_delete(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id = input_int('id');
    if ($id <= 0) {
        json_fail(422, 'Which payment method?');
    }

    $m = q1('SELECT * FROM payment_methods WHERE id = ? AND user_id = ?', [$id, $u['id']]);
    if (!$m) {
        json_fail(404, 'Payment method not found.');
    }

    tx(static function (PDO $pdo) use ($id, $u, $m) {
        $pdo->prepare('DELETE FROM payment_methods WHERE id = ? AND user_id = ?')
            ->execute([$id, (int)$u['id']]);

        // If the default was removed, promote the newest remaining one so the
        // seller always has a default to snapshot at match time.
        if ((int)$m['is_default'] === 1) {
            $next = $pdo->prepare('SELECT id FROM payment_methods WHERE user_id = ? ORDER BY id DESC LIMIT 1');
            $next->execute([(int)$u['id']]);
            $nid = $next->fetchColumn();
            if ($nid) {
                $pdo->prepare('UPDATE payment_methods SET is_default = 1 WHERE id = ?')->execute([(int)$nid]);
            }
        }
    });

    audit('payment_method.delete', ['entity' => 'payment_methods', 'entity_id' => (string)$id]);
    json_ok(['message' => 'Payment method removed.']);
}

/* ========================================================= set default ==== */

function handle_set_default(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();

    $id = input_int('id');
    if ($id <= 0) {
        json_fail(422, 'Which payment method?');
    }

    $m = q1('SELECT id FROM payment_methods WHERE id = ? AND user_id = ?', [$id, $u['id']]);
    if (!$m) {
        json_fail(404, 'Payment method not found.');
    }

    tx(static function (PDO $pdo) use ($id, $u) {
        $pdo->prepare('UPDATE payment_methods SET is_default = 0 WHERE user_id = ?')->execute([(int)$u['id']]);
        $pdo->prepare('UPDATE payment_methods SET is_default = 1 WHERE id = ? AND user_id = ?')
            ->execute([$id, (int)$u['id']]);
    });

    audit('payment_method.set_default', ['entity' => 'payment_methods', 'entity_id' => (string)$id]);
    json_ok(['message' => 'Default payment method updated.']);
}
