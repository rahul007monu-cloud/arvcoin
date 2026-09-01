/**
 * Profile — name, PAN, payout UPI.
 *
 * The PAN field is validated against the real format because getting it wrong
 * is expensive: an unrecognised PAN means section 206AA treats the account as
 * having none, and 20% of every redemption is withheld instead of 1%.
 */

import * as ui from '../ui.js';
import * as db from '../db.js';
import { fmtPaise, currentFy } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

// Five letters, four digits, one letter. The fourth character encodes the holder
// type ('P' for an individual) and the fifth is the first letter of the surname.
var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
var VPA_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;

var st = { profile: null, fyGross: 0 };

function paintTaxPosition() {
  var host = ui.el('[data-tax-position]');
  if (!host) return;

  var hasPan = !!(st.profile && st.profile.pan);
  var specified = !!(st.profile && st.profile.isSpecifiedPerson);
  var threshold = specified ? CFG.TAX.tdsThresholdSpecifiedPaise : CFG.TAX.tdsThresholdPaise;
  var rate = hasPan ? CFG.TAX.tdsPct : CFG.TAX.tdsPctNoPan;
  var headroom = Math.max(0, threshold - st.fyGross);

  host.innerHTML =
    row('Financial year', currentFy()) +
    row('TDS rate that applies', rate + '%', hasPan ? '' : 'down') +
    row('Annual threshold', fmtPaise(threshold)) +
    row('Redeemed so far this year', fmtPaise(st.fyGross)) +
    row('Remaining below threshold', fmtPaise(headroom)) +
    '<div class="ledger-row k-' + (hasPan ? 'net' : 'warning') + '">' +
      '<span class="l">' + (hasPan ? 'PAN on record' : 'No PAN on record') + '</span>' +
      '<span class="a">' + (hasPan ? '\u2713' : '!') + '</span>' +
      (hasPan ? '' : '<span class="note">Add your PAN to be taxed at ' +
        CFG.TAX.tdsPct + '% rather than ' + CFG.TAX.tdsPctNoPan + '%.</span>') +
    '</div>';

  function row(l, v, cls) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>' +
           '<span class="a ' + (cls || '') + '">' + v + '</span></div>';
  }
}

function paintKyc() {
  var badge = ui.el('[data-kyc]');
  if (!badge) return;
  var s = (st.profile && st.profile.kycStatus) || 'none';
  var map = { verified: 'ok', pending: 'warn', rejected: 'bad', none: '' };
  badge.className = 'badge ' + (map[s] || '');
  badge.textContent = s === 'none' ? 'not verified' : s;
}

(async function () {
  ui.setText('[data-pan]', CFG.TAX.tdsPct + '%');
  ui.setText('[data-nopan]', CFG.TAX.tdsPctNoPan + '%');

  await ui.boot({ feed: false, ticker: false });
  var user = await db.requireUser();
  if (!user) return;

  if (db.mode() === 'local') {
    var card = ui.el('[data-local-card]');
    if (card) card.hidden = false;
  }

  try {
    st.profile = await db.getProfile();
    st.fyGross = await db.fyGrossProceeds();
  } catch (e) {
    ui.toastError(e);
  }

  if (st.profile) {
    ui.el('#name').value = st.profile.fullName || st.profile.full_name || '';
    ui.el('#pan').value = st.profile.pan || '';
    ui.el('#vpa').value = st.profile.upiVpa || st.profile.upi_vpa || '';
  }

  paintKyc();
  paintTaxPosition();

  ui.el('[data-form]').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = e.target.querySelector('button[type=submit]');

    var pan = ui.el('#pan').value.trim().toUpperCase();
    var vpa = ui.el('#vpa').value.trim();

    var panErr = ui.el('[data-pan-err]');
    var vpaErr = ui.el('[data-vpa-err]');
    panErr.classList.add('hidden');
    vpaErr.classList.add('hidden');

    if (pan && !PAN_RE.test(pan)) {
      panErr.textContent = 'A PAN is five letters, four digits, then one letter — e.g. ABCDE1234F.';
      panErr.classList.remove('hidden');
      return;
    }
    if (vpa && !VPA_RE.test(vpa)) {
      vpaErr.textContent = 'A UPI ID looks like yourname@bank.';
      vpaErr.classList.remove('hidden');
      return;
    }

    ui.busy(btn, true, 'Saving\u2026');
    try {
      st.profile = await db.updateProfile({
        fullName: ui.el('#name').value.trim(),
        pan: pan,
        upiVpa: vpa
      });
      ui.el('#pan').value = pan;
      paintKyc();
      paintTaxPosition();
      ui.toast('Saved', 'ok');
    } catch (err) {
      ui.toastError(err);
    } finally {
      ui.busy(btn, false);
    }
  });

  ui.on('[data-reset]', 'click', function () {
    if (!confirm('Erase all local ARV data in this browser? This cannot be undone.')) return;
    db.resetLocal();
    location.href = 'index.html';
  });
})();
