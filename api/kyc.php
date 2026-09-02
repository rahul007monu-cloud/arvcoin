<?php
/**
 * KYC.
 *
 * ---------------------------------------------------------------------------
 * Why there is no Aadhaar number in this file
 * ---------------------------------------------------------------------------
 * Storing an Aadhaar number or image without being a licensed KUA/AUA is an
 * offence under the Aadhaar Act, 2016, and it carries imprisonment. It is also a
 * breach liability nobody wants: an Aadhaar database is the single most
 * attractive thing a small platform can hold.
 *
 * So this endpoint accepts the last four digits only, for display and matching,
 * and expects a licensed provider — Digio, Signzy, HyperVerge, Karza — to perform
 * the actual verification and return a reference plus a yes/no. The full number
 * never reaches this server, and the column to hold one deliberately does not
 * exist in the schema.
 *
 * While no provider is configured, Aadhaar stays optional and is clearly marked
 * unverified. PAN is the field that does the real work anyway: it decides the TDS
 * rate, and holding it is lawful.
 */

declare(strict_types=1);

require __DIR__ . '/_boot.php';
require __DIR__ . '/_money.php';

$action = $_GET['action'] ?? input_str('action');

switch ($action) {
    case 'get':    handle_get();    break;
    case 'submit': handle_submit(); break;
    default:
        json_fail(400, 'Unknown action.');
}

function handle_get(): void
{
    require_method('GET');
    $u = require_user();

    $k = q1('SELECT * FROM kyc WHERE user_id = ?', [$u['id']]);
    json_ok([
        'kyc' => $k ? kyc_public($k) : ['status' => 'none'],
        'requirements' => [
            'required'         => setting_b('kyc_required', true),
            'requiredBefore'   => 'first purchase and any withdrawal',
            'minAge'           => 18,
            'aadhaarProvider'  => (string)setting('aadhaar_provider', ''),
            'aadhaarOptional'  => (string)setting('aadhaar_provider', '') === '',
            'reviewSlaHours'   => 24,
        ],
    ]);
}

function handle_submit(): void
{
    require_method('POST');
    require_csrf();
    $u = require_user();
    rate_limit('kyc_submit', 8, 3600, 3600);

    $k = q1('SELECT status FROM kyc WHERE user_id = ?', [$u['id']]);
    if (($k['status'] ?? 'none') === 'verified') {
        json_fail(409, 'Your KYC is already verified. Contact operations to change these details.');
    }
    if (($k['status'] ?? 'none') === 'pending') {
        json_fail(409, 'Your KYC is already under review.');
    }

    $fullName = substr(input_str('fullName'), 0, 120);
    $dob      = input_str('dob');
    $pan      = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', input_str('pan')));
    $address  = substr(input_str('addressLine'), 0, 255);
    $city     = substr(input_str('city'), 0, 80);
    $state    = substr(input_str('state'), 0, 80);
    $pincode  = preg_replace('/\D/', '', input_str('pincode'));
    $upiVpa   = input_str('upiVpa');
    $aadhaar4 = preg_replace('/\D/', '', input_str('aadhaarLast4'));

    $errors = [];

    if (strlen($fullName) < 3) {
        $errors['fullName'] = 'Enter your full name as it appears on your PAN.';
    }

    // Five letters, four digits, one letter. The fourth character encodes the
    // holder type and the fifth is the first letter of the surname, so a
    // mistyped PAN is usually still well-formed — which is why it also has to be
    // verified rather than merely validated.
    if (!preg_match('/^[A-Z]{5}[0-9]{4}[A-Z]$/', $pan)) {
        $errors['pan'] = 'A PAN is five letters, four digits, then one letter — e.g. ABCDE1234F.';
    }

    if ($dob === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dob)) {
        $errors['dob'] = 'Enter your date of birth.';
    } else {
        $age = (int)((time() - strtotime($dob)) / (365.25 * 86400));
        if ($age < 18) {
            $errors['dob'] = 'You must be at least 18 to hold an account.';
        } elseif ($age > 120) {
            $errors['dob'] = 'Check that date of birth.';
        }
    }

    if (strlen($address) < 8) {
        $errors['addressLine'] = 'Enter your address.';
    }
    if ($state === '') {
        $errors['state'] = 'Select your state.';
    }
    if (strlen($pincode) !== 6) {
        $errors['pincode'] = 'A PIN code is six digits.';
    }
    if ($upiVpa !== '' && !preg_match('/^[\w.\-]{2,}@[a-zA-Z]{2,}$/', $upiVpa)) {
        $errors['upiVpa'] = 'A UPI ID looks like yourname@bank.';
    }
    if ($aadhaar4 !== '' && strlen($aadhaar4) !== 4) {
        $errors['aadhaarLast4'] = 'Enter only the last four digits of your Aadhaar.';
    }

    if ($errors) {
        json_fail(422, 'Some details need correcting.', ['fields' => $errors]);
    }

    // One PAN, one account. The same PAN across several accounts is the standard
    // way round a per-person limit, and it also breaks TDS reporting.
    $dup = q1('SELECT user_id FROM kyc WHERE pan = ? AND user_id <> ?', [$pan, $u['id']]);
    if ($dup) {
        json_fail(409, 'That PAN is already registered to another account.');
    }

    q('UPDATE kyc
          SET full_name = ?, dob = ?, pan = ?, address_line = ?, city = ?, state = ?,
              pincode = ?, upi_vpa = COALESCE(NULLIF(?, ""), upi_vpa),
              aadhaar_last4 = ?, status = "pending", submitted_at = UTC_TIMESTAMP(),
              reject_reason = ""
        WHERE user_id = ?',
      [$fullName, $dob, $pan, $address, $city, $state, $pincode, $upiVpa, $aadhaar4, $u['id']]);

    // Keep the display name in step so the dashboard greeting matches the KYC.
    q('UPDATE users SET full_name = ? WHERE id = ? AND full_name = ""', [$fullName, $u['id']]);

    audit('kyc.submit', ['entity' => 'kyc', 'entity_id' => (string)$u['id'],
                         'detail' => ['panLast' => substr($pan, -1), 'state' => $state]]);

    $k = q1('SELECT * FROM kyc WHERE user_id = ?', [$u['id']]);

    json_ok([
        'kyc' => kyc_public($k),
        'message' => 'Submitted for review. Verification is usually within 24 hours, and you can '
                   . 'buy as soon as it clears.',
    ]);
}

function kyc_public(array $k): array
{
    $pan = (string)$k['pan'];
    return [
        'status'          => $k['status'],
        'fullName'        => $k['full_name'],
        'dob'             => $k['dob'],
        // Masked on the way out. There is no screen that needs a full PAN
        // rendered back into a browser.
        'panMasked'       => $pan !== '' ? substr($pan, 0, 2) . 'XXXXX' . substr($pan, -1) : '',
        'hasPan'          => $pan !== '',
        'panVerified'     => (bool)$k['pan_verified'],
        'addressLine'     => $k['address_line'],
        'city'            => $k['city'],
        'state'           => $k['state'],
        'pincode'         => $k['pincode'],
        'upiVpa'          => $k['upi_vpa'],
        'aadhaarLast4'    => $k['aadhaar_last4'],
        'aadhaarVerified' => (bool)$k['aadhaar_verified'],
        'submittedAt'     => $k['submitted_at'],
        'reviewedAt'      => $k['reviewed_at'],
        'rejectReason'    => $k['reject_reason'],
        // Said out loud so nobody assumes an unverified Aadhaar means more than
        // it does.
        'aadhaarNote'     => 'Only the last four digits are held. Full Aadhaar verification '
                           . 'requires a licensed provider and is never stored here.',
    ];
}
