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

    if ($fullName === '') {
        $errors['fullName'] = 'Enter your full name as it appears on your PAN.';
    } elseif (strlen($fullName) < 3) {
        $errors['fullName'] = 'That looks too short — enter your full name as printed on your PAN.';
    }

    // Five letters, four digits, one letter. The fourth character encodes the
    // holder type and the fifth is the first letter of the surname, so a
    // mistyped PAN is usually still well-formed — which is why it also has to be
    // verified rather than merely validated.
    if ($pan === '') {
        $errors['pan'] = 'Enter your PAN — it decides the TDS rate on every sale.';
    } elseif (!preg_match('/^[A-Z]{5}[0-9]{4}[A-Z]$/', $pan)) {
        $errors['pan'] = sprintf(
            'A PAN is five letters, four digits, then one letter — e.g. ABCDE1234F. You entered %d character%s.',
            strlen($pan), strlen($pan) === 1 ? '' : 's'
        );
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

    // City, state and PIN are their own fields, so this line only has to identify
    // the building and the street. Five characters is enough for "A-12 MG Rd" and
    // still refuses a single letter.
    //
    // The message says what is wrong. It used to read "Enter your address", which
    // is what you tell someone who left the box empty — so a person who had filled
    // it in was told to do the thing they had just done, with no hint that the
    // objection was length. That is the worst kind of validation error: it is
    // correct, and it is useless.
    if ($address === '') {
        $errors['addressLine'] = 'Enter your address.';
    } elseif (strlen($address) < 5) {
        $errors['addressLine'] = 'That is too short to be an address — add the house or flat '
                               . 'number and the street or area. City, state and PIN have their '
                               . 'own boxes below.';
    }
    if ($state === '') {
        $errors['state'] = 'Select your state from the list.';
    }
    if (strlen($pincode) !== 6) {
        $errors['pincode'] = $pincode === ''
            ? 'Enter your 6-digit PIN code.'
            : sprintf('A PIN code is six digits — that one has %d.', strlen($pincode));
    }
    if ($city === '') {
        $errors['city'] = 'Enter your city.';
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

    // An upsert, not an UPDATE.
    //
    // This was a bare UPDATE, and for an account whose kyc row was missing it did
    // nothing at all: no row matched, so nothing was written, the SELECT below
    // returned null, and kyc_public(null) threw a TypeError that the global
    // handler turned into "Something went wrong on our side." The person had
    // filled in eight fields correctly and got a generic server error, twice,
    // with their details discarded each time.
    //
    // handle_get() a few lines up already guards for the same missing row, which
    // is the tell: the row was known to be optional on the way out and assumed to
    // exist on the way in. Creating it is the right answer either way — there is
    // no reading of this endpoint where "no row yet" should mean "refuse".
    q('INSERT INTO kyc (user_id, full_name, dob, pan, address_line, city, state,
                        pincode, upi_vpa, aadhaar_last4, status, submitted_at, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "pending", UTC_TIMESTAMP(), "")
       ON DUPLICATE KEY UPDATE
              full_name = VALUES(full_name), dob = VALUES(dob), pan = VALUES(pan),
              address_line = VALUES(address_line), city = VALUES(city),
              state = VALUES(state), pincode = VALUES(pincode),
              -- Keep an existing payout address when the form leaves it blank.
              upi_vpa = COALESCE(NULLIF(VALUES(upi_vpa), ""), upi_vpa),
              aadhaar_last4 = VALUES(aadhaar_last4),
              status = "pending", submitted_at = UTC_TIMESTAMP(), reject_reason = ""',
      [$u['id'], $fullName, $dob, $pan, $address, $city, $state, $pincode, $upiVpa, $aadhaar4]);

    // The wallet has the same shape of problem: nothing creates it here, and its
    // absence surfaces later as a null balance rather than as an error anybody can
    // act on.
    q('INSERT INTO wallets (user_id) VALUES (?)
       ON DUPLICATE KEY UPDATE user_id = user_id', [$u['id']]);

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

/**
 * The client-facing shape of a KYC record.
 *
 * Takes null, and answers "none". It used to require an array, which made every
 * caller responsible for remembering that the row is optional — one of them did
 * remember and one did not, and the one that did not returned a 500 to somebody
 * who had filled the form in correctly. A shape function is the wrong place to
 * enforce that a row exists.
 */
function kyc_public(?array $k): array
{
    if ($k === null) {
        return ['status' => 'none'];
    }
    $pan = (string)($k['pan'] ?? '');
    return [
        'status'          => $k['status'] ?? 'none',
        'fullName'        => $k['full_name'] ?? '',
        'dob'             => $k['dob'] ?? null,
        // Masked on the way out. There is no screen that needs a full PAN
        // rendered back into a browser.
        'panMasked'       => $pan !== '' ? substr($pan, 0, 2) . 'XXXXX' . substr($pan, -1) : '',
        'hasPan'          => $pan !== '',
        'panVerified'     => (bool)($k['pan_verified'] ?? false),
        'addressLine'     => $k['address_line'] ?? '',
        'city'            => $k['city'] ?? '',
        'state'           => $k['state'] ?? '',
        'pincode'         => $k['pincode'] ?? '',
        'upiVpa'          => $k['upi_vpa'] ?? '',
        'aadhaarLast4'    => $k['aadhaar_last4'] ?? '',
        'aadhaarVerified' => (bool)($k['aadhaar_verified'] ?? false),
        'submittedAt'     => $k['submitted_at'] ?? null,
        'reviewedAt'      => $k['reviewed_at'] ?? null,
        'rejectReason'    => $k['reject_reason'] ?? '',
        // Said out loud so nobody assumes an unverified Aadhaar means more than
        // it does.
        'aadhaarNote'     => 'Only the last four digits are held. Full Aadhaar verification '
                           . 'requires a licensed provider and is never stored here.',
    ];
}
