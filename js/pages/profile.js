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
    '<div class="ledger-row"><span class="l">Entry fee</span><span class="a">' + entry + '%</span></div>'
    + '<div class="ledger-row"><span class="l">Exit fee</span><span class="a">' + exit + '%</span></div>'
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

async function submitKyc(e) {
  e.preventDefault();
  var btn = ui.el('[data-kyc-submit]');
  var panErr = ui.el('[data-pan-err]');
  panErr.classList.add('hidden');

  var pan = (ui.el('#pan').value || '').trim().toUpperCase();
  var vpa = (ui.el('#vpa').value || '').trim();

  if (!PAN_RE.test(pan)) {
    panErr.textContent = 'A PAN is five letters, four digits, then one letter \u2014 e.g. ABCDE1234F.';
    panErr.classList.remove('hidden');
    ui.el('#pan').focus();
    return;
  }
  if (vpa && !VPA_RE.test(vpa)) {
    ui.toast('A UPI ID looks like yourname@bank.', 'warn');
    return;
  }

  ui.busy(btn, true, 'Submitting\u2026');
  try {
    var r = await api.submitKyc({
      fullName: ui.el('#fullName').value.trim(),
      dob: ui.el('#dob').value,
      pan: pan,
      addressLine: ui.el('#addr').value.trim(),
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
    if (err.fields && err.fields.pan) {
      panErr.textContent = err.fields.pan;
      panErr.classList.remove('hidden');
    }
    ui.toastError(err);
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
