/**
 * Profile and KYC.
 *
 * PAN is the field that does the work here: it decides the TDS rate on every sale,
 * and getting it wrong costs the holder 20% withheld instead of 1%. So it is
 * validated properly and the consequence is stated next to the input rather than
 * buried in a help page.
 *
 * Aadhaar is limited to four digits by design. Storing a full Aadhaar number
 * without being a licensed KUA/AUA is an offence under the Aadhaar Act, 2016, so
 * the field cannot accept one and the reason is on screen.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;

var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
var VPA_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;

var STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry'
];

var st = { user: null, kyc: null };

/* ------------------------------------------------------------------ painting -- */

function paintStatic() {
  ui.el('#state').innerHTML = '<option value="">Select\u2026</option>'
    + STATES.map(function (s) { return '<option>' + s + '</option>'; }).join('');
  ui.setText('[data-pan-rate]', CFG.TAX.tdsPct + '%');
  ui.setText('[data-nopan]', CFG.TAX.tdsPctNoPan + '%');
}

function statusBadge(s) {
  var map = { verified: 'ok', pending: 'warn', rejected: 'bad', none: '' };
  var label = s === 'none' ? 'not verified' : s;
  return { cls: 'badge ' + (map[s] || ''), label: label };
}

function paint() {
  var u = st.user;
  var k = st.kyc || {};
  if (!u) return;

  ui.setText('[data-email]', u.email || '');

  var b = statusBadge(k.status || 'none');
  ui.els('[data-kyc-badge], [data-kyc-status]').forEach(function (n) {
    n.className = b.cls;
    n.textContent = b.label;
  });

  ui.el('[data-kyc-done]').classList.toggle('hidden', k.status !== 'verified');
  ui.el('[data-kyc-pending]').classList.toggle('hidden', k.status !== 'pending');
  ui.el('[data-kyc-rejected]').classList.toggle('hidden', k.status !== 'rejected');
  if (k.status === 'rejected') ui.setText('[data-kyc-reason]', k.rejectReason || '');

  // Prefill. PAN comes back masked, so it is left blank rather than showing
  // XXs in a field the user might submit.
  ui.el('#fullName').value = k.fullName || u.fullName || '';
  ui.el('#dob').value = k.dob || '';
  ui.el('#addr').value = k.addressLine || '';
  ui.el('#city').value = k.city || '';
  ui.el('#state').value = k.state || '';
  ui.el('#pin').value = k.pincode || '';
  ui.el('#vpa').value = k.upiVpa || '';
  ui.el('#aadhaar4').value = k.aadhaarLast4 || '';

  // Verified details are locked — changing them is an operations action, because
  // a self-service edit after verification defeats the point of verifying.
  var lock = k.status === 'verified' || k.status === 'pending';
  ['#fullName', '#dob', '#pan', '#addr', '#city', '#state', '#pin', '#aadhaar4']
    .forEach(function (sel) { ui.el(sel).disabled = lock; });
  ui.el('[data-kyc-submit]').disabled = lock;
  if (k.hasPan) ui.el('#pan').placeholder = k.panMasked || 'on record';

  paintTaxPosition();
  paintFees();
}

function paintTaxPosition() {
  var host = ui.el('[data-tax-position]');
  if (!host) return;

  var k = st.kyc || {};
  var hasPan = !!k.hasPan;
  var rate = hasPan ? CFG.TAX.tdsPct : CFG.TAX.tdsPctNoPan;

  ui.setText('[data-fy]', 'FY ' + fyLabel());

  host.innerHTML =
    row('TDS rate that applies', rate + '%', hasPan ? '' : 'down')
    + row('Annual threshold', ui.fmtPaise(CFG.TAX.tdsThresholdPaise))
    + row('Tax on gains', CFG.TAX.vdaGainPct + '% + ' + CFG.TAX.cessPct + '% cess')
    + row('Loss set-off', 'not permitted', 'down')
    + '<div class="ledger-row k-' + (hasPan ? 'net' : 'warning') + '">'
      + '<span class="l">' + (hasPan ? 'PAN on record' : 'No PAN on record') + '</span>'
      + '<span class="a">' + (hasPan ? '\u2713' : '!') + '</span>'
      + (hasPan ? '' : '<span class="note">Add your PAN to be taxed at '
          + CFG.TAX.tdsPct + '% rather than ' + CFG.TAX.tdsPctNoPan
          + '% on every sale.</span>')
    + '</div>';

  function row(l, v, cls) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>'
         + '<span class="a ' + (cls || '') + '">' + ui.esc(v) + '</span></div>';
  }
}

function paintFees() {
  var host = ui.el('[data-fees]');
  if (!host) return;

  var f = (st.user && st.user.fees) || {};
  var entry = f.entryPct != null ? f.entryPct : CFG.FEES.entryPct;
  var exit = f.exitPct != null ? f.exitPct : CFG.FEES.exitPct;

  if (st.user && st.user.tier) {
    var t = ui.el('[data-tier]');
    t.classList.remove('hidden');
    t.textContent = st.user.tier;
  }

  host.innerHTML =
    '<div class="ledger-row"><span class="l">Buy fee</span><span class="a">' + entry + '%</span></div>'
    + '<div class="ledger-row"><span class="l">Sell fee</span><span class="a">' + exit + '%</span></div>'
    + '<div class="ledger-row"><span class="l">GST on the fee</span><span class="a">'
      + CFG.FEES.gstPct + '%</span></div>'
    + '<div class="ledger-row"><span class="l">Deposit and withdrawal</span>'
      + '<span class="a">free</span></div>'
    + (entry < CFG.FEES.entryPct || exit < CFG.FEES.exitPct
        ? '<div class="ledger-row k-net"><span class="l">Discount from your tier</span>'
          + '<span class="a">\u2713</span></div>'
        : '');
}

/** Indian financial year label. April to March. */
function fyLabel() {
  var d = new Date();
  var y = d.getFullYear();
  var start = (d.getMonth() + 1) >= 4 ? y : y - 1;
  return start + '-' + String((start + 1) % 100).padStart(2, '0');
}

/* -------------------------------------------------------------------- submit -- */

/* ------------------------------------------------------------ field errors -- */

function clearFieldErrors() {
  ui.els('[data-err]').forEach(function (n) {
    n.classList.add('hidden');
    n.textContent = '';
  });
}

/**
 * Put each error against the field it belongs to.
 *
 * The toast used to carry only the first of them, at the bottom of a long form,
 * with nothing to say which box was wrong. On a form with eight fields that is
 * close to no information at all — and when the message was "Enter your address"
 * for an address that had plainly been entered, it actively misled.
 *
 * @return {boolean} whether anything was shown, so the caller knows if a toast is
 *                   still needed for an error that belongs to no field.
 */
function paintFieldErrors(fields) {
  clearFieldErrors();
  var first = null;

  Object.keys(fields || {}).forEach(function (key) {
    var node = ui.el('[data-err="' + key + '"]');
    if (!node) return;
    node.textContent = fields[key];
    node.classList.remove('hidden');
    if (!first) first = node;
  });

  if (first) {
    // Scroll to the first problem. Submitting from the bottom of the form and
    // being corrected at the top is otherwise invisible.
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var input = first.parentElement && first.parentElement.querySelector('input, select');
    if (input) setTimeout(function () { input.focus({ preventScroll: true }); }, 400);
  }
  return !!first;
}

/* ------------------------------------------------------------------ submit -- */

async function submitKyc(e) {
  e.preventDefault();
  var btn = ui.el('[data-kyc-submit]');
  clearFieldErrors();

  var pan = (ui.el('#pan').value || '').trim().toUpperCase();
  var vpa = (ui.el('#vpa').value || '').trim();
  var addr = (ui.el('#addr').value || '').trim();

  // Caught here as well as on the server, so the commonest mistakes cost no round
  // trip — and so the message lands next to the box either way.
  var local = {};
  if (!PAN_RE.test(pan)) {
    local.pan = 'A PAN is five letters, four digits, then one letter \u2014 e.g. ABCDE1234F.';
  }
  if (addr.length < 5) {
    local.addressLine = addr === ''
      ? 'Enter your address.'
      : 'That is too short to be an address \u2014 add the house or flat number and the '
        + 'street or area. City, state and PIN have their own boxes below.';
  }
  if (!ui.el('#state').value) {
    local.state = 'Select your state from the list.';
  }
  if ((ui.el('#pin').value || '').replace(/\D/g, '').length !== 6) {
    local.pincode = 'A PIN code is six digits.';
  }
  if (vpa && !VPA_RE.test(vpa)) {
    local.upiVpa = 'A UPI ID looks like yourname@bank.';
  }
  if (Object.keys(local).length) {
    paintFieldErrors(local);
    return;
  }

  ui.busy(btn, true, 'Submitting\u2026');
  try {
    var r = await api.submitKyc({
      fullName: ui.el('#fullName').value.trim(),
      dob: ui.el('#dob').value,
      pan: pan,
      addressLine: addr,
      city: ui.el('#city').value.trim(),
      state: ui.el('#state').value,
      pincode: ui.el('#pin').value.trim(),
      upiVpa: vpa,
      aadhaarLast4: ui.el('#aadhaar4').value.trim()
    });
    st.kyc = r.kyc;
    st.user = await api.me(true);
    paint();
    ui.toast(r.message || 'Submitted for review.', 'ok', 8000);
    ui.el('#pan').value = '';
  } catch (err) {
    // A field-level rejection belongs on the field. Only shout in a toast about
    // something that has no field to sit next to — a duplicate PAN, a rate limit,
    // a server that fell over.
    if (err.fields && paintFieldErrors(err.fields)) {
      ui.toast('Some details need correcting \u2014 see the highlighted fields.', 'warn', 6000);
    } else {
      ui.toastError(err);
    }
  } finally {
    ui.busy(btn, false);
  }
}

async function changePassword(e) {
  e.preventDefault();
  var btn = e.currentTarget.querySelector('button[type=submit]');
  ui.busy(btn, true, 'Changing\u2026');
  try {
    await api.changePassword(ui.el('#cur').value, ui.el('#next').value);
    ui.el('#cur').value = '';
    ui.el('#next').value = '';
    ui.toast('Password changed.', 'ok');
  } catch (err) {
    ui.toastError(err);
  } finally {
    ui.busy(btn, false);
  }
}

/* ------------------------------------------------------- payment methods -- */

var IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function pmTypeToggle() {
  var type = ui.el('#pmType').value;
  ui.el('[data-pm-upi]').classList.toggle('hidden', type !== 'upi');
  ui.el('[data-pm-bank]').classList.toggle('hidden', type !== 'bank');
}

function pmLabelFor(m) {
  if (m.type === 'upi') return m.upiVpa;
  var tail = (m.bankAccountNo || '').slice(-4);
  return (m.accountName || 'Bank') + ' · ' + m.bankIfsc + ' · ' + '••' + tail;
}

function paintPaymentMethods(methods) {
  var host = ui.el('[data-pm-list]');
  if (!host) return;

  if (!methods || !methods.length) {
    host.innerHTML = '<div class="empty tiny">No payment methods yet. Add one below to sell ARV peer-to-peer.</div>';
    return;
  }

  host.innerHTML = methods.map(function (m) {
    return '<div class="ledger-row" style="align-items:center">'
      + '<span class="l">'
        + '<span class="badge ' + (m.isDefault ? 'ok' : '') + '">' + (m.type === 'upi' ? 'UPI' : 'Bank') + '</span> '
        + (m.label ? '<strong>' + ui.esc(m.label) + '</strong> · ' : '')
        + '<span class="num tiny">' + ui.esc(pmLabelFor(m)) + '</span>'
        + (m.isDefault ? ' <span class="tiny muted">(default)</span>' : '')
      + '</span>'
      + '<span class="a" style="display:flex;gap:6px">'
        + (m.isDefault ? '' : '<button class="btn btn-sm btn-ghost" data-pm-default="' + m.id + '">Make default</button>')
        + '<button class="btn btn-sm btn-ghost" data-pm-del="' + m.id + '">Delete</button>'
      + '</span>'
      + '</div>';
  }).join('');

  ui.els('[data-pm-default]').forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '…');
      try {
        await api.paymentMethods.setDefault(Number(b.dataset.pmDefault));
        await loadPaymentMethods();
        ui.toast('Default updated.', 'ok');
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });
  ui.els('[data-pm-del]').forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '…');
      try {
        var r = await api.paymentMethods.remove(Number(b.dataset.pmDel));
        await loadPaymentMethods();
        ui.toast(r.message || 'Removed.', 'ok');
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });
}

async function loadPaymentMethods() {
  try {
    var r = await api.paymentMethods.list();
    paintPaymentMethods(r.methods || []);
  } catch (_) {
    var host = ui.el('[data-pm-list]');
    if (host) host.innerHTML = '<div class="empty tiny">Could not load payment methods.</div>';
  }
}

async function addPaymentMethod(e) {
  e.preventDefault();
  var btn = ui.el('[data-pm-submit]');
  clearFieldErrors();

  var type = ui.el('#pmType').value;
  var data = { type: type, label: (ui.el('#pmLabel').value || '').trim() };

  var local = {};
  if (type === 'upi') {
    data.upiVpa = (ui.el('#pmVpa').value || '').trim();
    if (!VPA_RE.test(data.upiVpa)) local.upiVpa = 'A UPI ID looks like yourname@bank.';
  } else {
    data.accountName = (ui.el('#pmAccName').value || '').trim();
    data.bankAccountNo = (ui.el('#pmAccNo').value || '').replace(/\s+/g, '');
    data.bankIfsc = (ui.el('#pmIfsc').value || '').trim().toUpperCase();
    if (data.accountName.length < 2) local.accountName = 'Enter the account holder name.';
    if (!/^\d{6,20}$/.test(data.bankAccountNo)) local.bankAccountNo = 'A bank account number is 6 to 20 digits.';
    if (!IFSC_RE.test(data.bankIfsc)) local.bankIfsc = 'An IFSC is like HDFC0001234.';
  }
  if (Object.keys(local).length) { paintFieldErrors(local); return; }

  ui.busy(btn, true, 'Saving…');
  try {
    var r = await api.paymentMethods.add(data);
    ui.el('#pmVpa').value = '';
    ui.el('#pmAccName').value = '';
    ui.el('#pmAccNo').value = '';
    ui.el('#pmIfsc').value = '';
    ui.el('#pmLabel').value = '';
    await loadPaymentMethods();
    ui.toast(r.message || 'Saved.', 'ok');
  } catch (err) {
    if (err.fields && paintFieldErrors(err.fields)) {
      ui.toast('Check the highlighted fields.', 'warn', 6000);
    } else {
      ui.toastError(err);
    }
  } finally {
    ui.busy(btn, false);
  }
}

/* ---------------------------------------------------------------------- boot -- */

(async function () {
  paintStatic();
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  try {
    var r = await api.getKyc();
    st.kyc = r.kyc;
  } catch (_) {
    st.kyc = user.kyc || {};
  }

  paint();

  ui.on('[data-kyc-form]', 'submit', submitKyc);
  ui.on('[data-pw-form]', 'submit', changePassword);

  // Payment methods (for receiving P2P payments).
  ui.on('[data-pm-form]', 'submit', addPaymentMethod);
  var pmType = ui.el('#pmType');
  if (pmType) pmType.addEventListener('change', pmTypeToggle);
  var pmIfsc = ui.el('#pmIfsc');
  if (pmIfsc) pmIfsc.addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);
  });
  var pmAccNo = ui.el('#pmAccNo');
  if (pmAccNo) pmAccNo.addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 20);
  });
  pmTypeToggle();
  loadPaymentMethods();

  // Uppercase as they type — a lowercase PAN is the commonest rejection.
  ui.el('#pan').addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  });
  ui.el('#pin').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  ui.el('#aadhaar4').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  // Arriving from a KYC prompt should land on the form, not the top of the page.
  if (location.hash === '#kyc') {
    setTimeout(function () {
      ui.el('#kyc').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  }
})();
