/**
 * Deposit — rupees in, by UPI.
 *
 * Four steps, and the third one is honest about why it exists: a UPI QR returns
 * nothing to the server, so there is no callback to trust and the credit has to be
 * matched against the bank statement. Pretending otherwise would mean crediting
 * balances on the word of a browser.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';
import * as qr from '../qr.js';

var CFG = globalThis.ARV_CONFIG;
var st = { user: null, deposit: null, timer: null, upi: null };

function goto(n) {
  ui.els('[data-panel]').forEach(function (p) {
    p.classList.toggle('hidden', Number(p.dataset.panel) !== n);
  });
  ui.els('[data-step]').forEach(function (s) {
    var i = Number(s.dataset.step);
    s.classList.toggle('on', i === n);
    s.classList.toggle('done', i < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------- step 1 -- */

function paintStatic() {
  ui.setText('[data-min]', ui.fmtPaise(CFG.MARKET.minOrderPaise));
  ui.setText('[data-min-min]', String(CFG.PAYMENTS.depositMinMinutes));
  ui.setText('[data-max-min]', String(CFG.PAYMENTS.depositMaxMinutes));
}

function paintBalance() {
  var w = st.user && st.user.wallet;
  if (w) ui.setText('[data-balance]', ui.fmtPaise(w.inrPaise) + ' available');
  if (st.user && st.user.kyc && st.user.kyc.status !== 'verified') {
    ui.el('[data-kyc-gate]').classList.remove('hidden');
  }
}

async function createDeposit() {
  var btn = ui.el('[data-continue]');
  var err = ui.el('[data-amt-err]');
  var value = parseFloat((ui.el('#amt').value || '').replace(/[^\d.]/g, ''));

  err.classList.add('hidden');
  if (!value || ui.toPaise(value) < CFG.MARKET.minOrderPaise) {
    err.textContent = 'The minimum deposit is ' + ui.fmtPaise(CFG.MARKET.minOrderPaise) + '.';
    err.classList.remove('hidden');
    return;
  }

  ui.busy(btn, true, 'Creating\u2026');
  try {
    var r = await api.createDeposit(ui.toPaise(value));
    st.deposit = r.deposit;
    await showPayment(r.deposit, r.upi);
    goto(2);
  } catch (e) {
    // An existing request is not an error the user should have to decode.
    if (e.status === 409 && e.existingRef) {
      await resumeExisting(e.existingRef);
      return;
    }
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* ------------------------------------------------------------------- step 2 -- */

async function showPayment(dep, upi) {
  ui.setText('[data-pay-amount]', ui.fmtPaise(dep.amountPaise));
  ui.setText('[data-ref]', dep.ref);

  // Remembered so the copy button and a resumed request use the same address the
  // server just gave us. The payment address lives in settings.upi_vpa and nowhere
  // else — a copy of it in arv-config.js would be a second place to change and a
  // silent blank when only one of them was updated.
  if (upi && upi.vpa) {
    st.upi = upi;
  }

  var r = await qr.render(ui.el('[data-qr]'), {
    uri: dep.qrPayload || null,
    amountPaise: dep.amountPaise,
    ref: dep.ref
  });

  var vpa = (st.upi && st.upi.vpa) || '';
  ui.el('[data-vpa-row]').hidden = !(r.ok && vpa);

  if (r.ok && vpa) {
    ui.setText('[data-vpa]', vpa);
    if (qr.isMobile()) {
      var link = ui.el('[data-intent]');
      link.href = r.uri;
      link.classList.remove('hidden');
    }
  }
}

async function submitProof() {
  var btn = ui.el('[data-submit]');
  var utr = (ui.el('#utr').value || '').trim();
  var file = (ui.el('#shot').files || [])[0] || null;

  if (!utr && !file) {
    ui.toast('Enter the UTR from your payment app, or attach a screenshot.', 'warn');
    return;
  }

  ui.busy(btn, true, 'Submitting\u2026');
  try {
    var r = await api.submitDeposit(st.deposit.ref, utr, file);
    st.deposit = r.deposit;
    paintPending();
    goto(3);
    startWatching();
    ui.toast(r.message || 'Submitted.', 'ok', 7000);
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* ------------------------------------------------------------------- step 3 -- */

function paintPending() {
  var d = st.deposit;
  if (!d) return;

  ui.paintTimer(ui.el('[data-timer]'), {
    elapsedSeconds: d.elapsedSeconds || 0,
    minMinutes: (d.window && d.window.minMinutes) || CFG.PAYMENTS.depositMinMinutes,
    maxMinutes: (d.window && d.window.maxMinutes) || CFG.PAYMENTS.depositMaxMinutes,
    note: 'We are matching your payment against the bank account.'
  });

  ui.setHtml('[data-summary]',
    row('Amount', ui.fmtPaise(d.amountPaise))
    + row('Reference', d.ref)
    + (d.utr ? row('UTR', d.utr) : '')
    + (d.hasScreenshot ? row('Screenshot', 'attached') : '')
    + row('Submitted', ui.ago(d.submittedAt)));

  function row(l, v) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>'
         + '<span class="a">' + ui.esc(v) + '</span></div>';
  }
}

/**
 * Poll for the operator's decision.
 *
 * Slow on purpose — a confirmation is a human action measured in minutes, so a
 * five-second poll would be several hundred pointless requests per deposit.
 */
function startWatching() {
  if (st.timer) st.timer();
  st.timer = api.poll(async function () {
    var r = await api.getDeposit(st.deposit.ref);
    st.deposit = r.deposit;

    if (r.deposit.status === 'confirmed') {
      if (st.timer) { st.timer(); st.timer = null; }
      ui.setText('[data-done-amount]', ui.fmtPaise(r.deposit.amountPaise));
      ui.setText('[data-done-ref]', r.deposit.ref);
      st.user = await api.me(true);
      goto(4);
      loadHistory();
      return;
    }
    if (r.deposit.status === 'rejected') {
      if (st.timer) { st.timer(); st.timer = null; }
      ui.toast('This deposit was not accepted: '
        + ui.esc(r.deposit.rejectReason || 'no reason given'), 'bad', 12000);
      goto(1);
      loadHistory();
      return;
    }
    paintPending();
  }, 20000);
}

/* ------------------------------------------------------------------ resume -- */

async function resumeExisting(ref) {
  try {
    var r = await api.getDeposit(ref);
    st.deposit = r.deposit;

    var box = ui.el('[data-resume]');
    box.classList.remove('hidden');
    ui.setText('[data-resume-detail]',
      ui.fmtPaise(r.deposit.amountPaise) + ', reference ' + r.deposit.ref
      + ' \u00b7 ' + ui.ago(r.deposit.createdAt));

    ui.on('[data-resume-go]', 'click', async function () {
      box.classList.add('hidden');
      if (st.deposit.status === 'submitted') {
        paintPending();
        goto(3);
        startWatching();
      } else {
        await showPayment(st.deposit, r.upi);
        goto(2);
      }
    });

    ui.on('[data-resume-cancel]', 'click', async function (e) {
      ui.busy(e.currentTarget, true, '\u2026');
      try {
        await api.cancelDeposit(ref);
        box.classList.add('hidden');
        st.deposit = null;
        ui.toast('Cancelled. You can start a new one.', 'ok');
        loadHistory();
      } catch (err) { ui.toastError(err); }
      ui.busy(e.currentTarget, false);
    });
  } catch (_) {}
}

/* ----------------------------------------------------------------- history -- */

function statusBadge(s) {
  var map = { confirmed: 'ok', submitted: 'warn', awaiting_payment: 'warn',
              rejected: 'bad', expired: '' };
  return '<span class="badge ' + (map[s] || '') + '">'
       + ui.esc(s.replace(/_/g, ' ')) + '</span>';
}

async function loadHistory() {
  var host = ui.el('[data-history]');
  if (!host) return;
  try {
    var r = await api.myDeposits();
    var rows = r.deposits || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="5" class="empty">No deposits yet.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (d) {
      return '<tr>'
        + '<td class="mono tiny">' + ui.esc(d.ref) + '</td>'
        + '<td class="tiny">' + ui.fmtTime(d.createdAt, true) + '</td>'
        + '<td class="num">' + ui.fmtPaise(d.amountPaise) + '</td>'
        + '<td class="mono tiny">' + ui.esc(d.utr || '\u2014') + '</td>'
        + '<td>' + statusBadge(d.status)
          + (d.rejectReason ? '<div class="tiny muted">' + ui.esc(d.rejectReason) + '</div>' : '')
          + '</td>'
        + '</tr>';
    }).join('');
  } catch (_) {
    host.innerHTML = '<tr><td colspan="5" class="empty">Could not load.</td></tr>';
  }
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  paintStatic();
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;
  st.user = user;
  paintBalance();

  ui.on('[data-continue]', 'click', createDeposit);
  ui.on('[data-submit]', 'click', submitProof);
  ui.on('[data-back]', 'click', function () { goto(1); });

  ui.els('[data-q]').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.el('#amt').value = String(Number(b.dataset.q) / 100);
    });
  });

  ui.on('[data-copy-vpa]', 'click', function () {
    // Whatever is on screen is what gets copied. Reading it from the config would
    // copy an empty string and then claim success, which is the worst outcome on a
    // payment screen — the user pastes nothing and believes they pasted the address.
    var vpa = (st.upi && st.upi.vpa) || (ui.el('[data-vpa]') || {}).textContent || '';
    vpa = vpa.trim();

    if (!vpa) {
      ui.toast('No UPI ID is configured yet, so there is nothing to copy.', 'warn');
      return;
    }
    navigator.clipboard.writeText(vpa)
      .then(function () { ui.toast('UPI ID copied.', 'ok', 2000); })
      .catch(function () { ui.toast('Could not copy \u2014 select it manually.', 'warn'); });
  });

  // An unfinished request from a previous visit should be picked up, not
  // silently blocked when they try again.
  try {
    var r = await api.myDeposits();
    var open = (r.deposits || []).find(function (d) {
      return d.status === 'awaiting_payment' || d.status === 'submitted';
    });
    if (open) await resumeExisting(open.ref);
  } catch (_) {}

  loadHistory();
})();
