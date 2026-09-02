/**
 * Withdraw — rupees out, to UPI.
 *
 * Only the rupee balance leaves. Selling ARV is a separate action with its own tax
 * position, and keeping the two apart is what stops a withdrawal screen having to
 * explain capital gains.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;
var st = { user: null };

/* ------------------------------------------------------------------ painting -- */

function paint() {
  var u = st.user;
  var w = u && u.wallet;

  ui.setText('[data-min]', ui.fmtPaise(CFG.FEES.minWithdrawPaise));

  if (w) {
    ui.setText('[data-balance]', ui.fmtPaise(w.inrPaise) + ' available');
    ui.setText('[data-units]', ui.fmtUnits(w.arvUnits, 4) + ' ARV');
    ui.setText('[data-worth]', ui.fmtPaise(w.valuePaise));

    // Portions of what is actually available, so "All" can never overdraw.
    ui.setHtml('[data-quick]', [25, 50, 75, 100].map(function (pc) {
      return '<button class="btn btn-sm" data-qpct="' + pc + '">' + pc + '%</button>';
    }).join(''));

    ui.els('[data-qpct]').forEach(function (b) {
      b.addEventListener('click', function () {
        var paise = Math.floor(w.inrPaise * (Number(b.dataset.qpct) / 100));
        ui.el('#amt').value = String(paise / 100);
        validate();
      });
    });
  }

  if (u && u.kyc) {
    if (u.kyc.status !== 'verified') {
      ui.el('[data-kyc-gate]').classList.remove('hidden');
    }
    if (u.kyc.upiVpa) ui.el('#vpa').value = u.kyc.upiVpa;
  }

  ui.paintTimer(ui.el('[data-window]'), {
    elapsedSeconds: 0,
    minMinutes: CFG.PAYMENTS.withdrawMinMinutes,
    maxMinutes: CFG.PAYMENTS.withdrawMaxMinutes,
    note: 'Payouts are sent within this window once requested.'
  });
}

/* ----------------------------------------------------------------- validate -- */

function validate() {
  var w = st.user && st.user.wallet;
  var btn = ui.el('[data-submit]');
  var amtErr = ui.el('[data-amt-err]');
  var vpaErr = ui.el('[data-vpa-err]');

  amtErr.classList.add('hidden');
  vpaErr.classList.add('hidden');

  var paise = ui.toPaise(parseFloat((ui.el('#amt').value || '').replace(/[^\d.]/g, '')) || 0);
  var vpa = (ui.el('#vpa').value || '').trim();
  var okAmount = true;
  var okVpa = true;

  if (paise < CFG.FEES.minWithdrawPaise) {
    okAmount = false;
    if (paise > 0) {
      amtErr.textContent = 'The minimum withdrawal is ' + ui.fmtPaise(CFG.FEES.minWithdrawPaise) + '.';
      amtErr.classList.remove('hidden');
    }
  } else if (w && paise > w.inrPaise) {
    okAmount = false;
    amtErr.textContent = 'You have ' + ui.fmtPaise(w.inrPaise)
      + ' available. Sell ARV first to withdraw more.';
    amtErr.classList.remove('hidden');
  }

  if (vpa && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(vpa)) {
    okVpa = false;
    vpaErr.textContent = 'A UPI ID looks like yourname@bank.';
    vpaErr.classList.remove('hidden');
  }

  btn.disabled = !(okAmount && okVpa && vpa);
}

/* ------------------------------------------------------------------- submit -- */

async function submit() {
  var btn = ui.el('[data-submit]');
  var paise = ui.toPaise(parseFloat((ui.el('#amt').value || '').replace(/[^\d.]/g, '')) || 0);
  var vpa = (ui.el('#vpa').value || '').trim();

  // A wrong UPI ID is the most common cause of a failed payout, and it is far
  // cheaper to confirm here than to chase a bounced transfer.
  if (!confirm('Send ' + ui.fmtPaise(paise) + ' to ' + vpa + '?\n\n'
             + 'Check the UPI ID — a payout to the wrong ID has to be traced and resent.')) {
    return;
  }

  ui.busy(btn, true, 'Requesting\u2026');
  try {
    var r = await api.createWithdrawal(paise, vpa);
    ui.toast(r.message || 'Requested.', 'ok', 9000);
    ui.el('#amt').value = '';
    st.user = await api.me(true);
    paint();
    validate();
    loadHistory();
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* ------------------------------------------------------------------ history -- */

function statusBadge(s) {
  var map = { paid: 'ok', approved: 'info', requested: 'warn', rejected: 'bad' };
  return '<span class="badge ' + (map[s] || '') + '">' + ui.esc(s) + '</span>';
}

async function loadHistory() {
  var host = ui.el('[data-history]');
  if (!host) return;

  try {
    var r = await api.myWithdrawals();
    var rows = r.withdrawals || [];

    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="6" class="empty">No withdrawals yet.</td></tr>';
      return;
    }

    host.innerHTML = rows.map(function (w) {
      var wait = w.minutesLeft != null && !w.overdue
        ? '<div class="tiny muted">' + w.minutesLeft + 'm left</div>'
        : (w.overdue ? '<div class="tiny warn">past the window</div>' : '');
      var cancel = w.status === 'requested'
        ? '<button class="btn btn-sm btn-ghost" data-cancel="' + ui.esc(w.ref) + '">Cancel</button>'
        : '';
      return '<tr>'
        + '<td class="mono tiny">' + ui.esc(w.ref) + '</td>'
        + '<td class="tiny">' + ui.fmtTime(w.createdAt, true) + '</td>'
        + '<td class="num">' + ui.fmtPaise(w.amountPaise) + '</td>'
        + '<td class="mono tiny">' + ui.esc(w.upiVpa) + '</td>'
        + '<td>' + statusBadge(w.status) + wait
          + (w.rejectReason ? '<div class="tiny muted">' + ui.esc(w.rejectReason) + '</div>' : '')
          + '</td>'
        + '<td class="right">' + cancel + '</td>'
        + '</tr>';
    }).join('');

    ui.els('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        ui.busy(b, true, '\u2026');
        try {
          var res = await api.cancelWithdrawal(b.dataset.cancel);
          ui.toast(res.message || 'Cancelled.', 'ok');
          st.user = await api.me(true);
          paint();
          loadHistory();
        } catch (e) {
          ui.toastError(e);
          ui.busy(b, false);
        }
      });
    });
  } catch (_) {
    host.innerHTML = '<tr><td colspan="6" class="empty">Could not load.</td></tr>';
  }
}

/* --------------------------------------------------------------------- boot -- */

(async function () {
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  paint();
  validate();
  loadHistory();

  ui.el('#amt').addEventListener('input', validate);
  ui.el('#vpa').addEventListener('input', validate);
  ui.on('[data-submit]', 'click', submit);

  // A payout is approved by a person, so this refreshes at a human pace.
  api.poll(async function () {
    st.user = await api.me(true);
    paint();
    loadHistory();
  }, 30000);
})();
