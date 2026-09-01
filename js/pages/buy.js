/**
 * Buy flow.
 *
 * Three steps: quote, pay, issued. The quote is recomputed live from the same
 * `ledger.quoteBuy` the backend uses to execute, so nothing the user agrees to
 * here can differ from what gets recorded.
 *
 * The one thing this flow refuses to do is treat a displayed QR as a received
 * payment. There is no signature to verify and no callback to trust, so
 * issuance requires an explicit confirmation of the bank credit.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as engine from '../index-engine.js';
import * as ledger from '../ledger.js';
import * as db from '../db.js';
import * as qr from '../qr.js';
import { toPaise, fmtPaise, fmtPrice, fmtUnits } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

var st = { step: 1, amountPaise: 1000000, ref: null, quote: null };

/* -------------------------------------------------------------------- steps -- */

function goto(n) {
  st.step = n;
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

/* -------------------------------------------------------------------- quote -- */

function readAmount() {
  var raw = (ui.el('#amt').value || '').replace(/[^\d.]/g, '');
  return toPaise(parseFloat(raw) || 0);
}

function paintQuote() {
  var nav = engine.currentArv();
  var host = ui.el('[data-quote]');
  var btn = ui.el('[data-continue]');
  var ack = ui.el('[data-ack]');
  var err = ui.el('[data-amt-err]');

  ui.setText('[data-price-badge]', nav != null ? fmtPrice(nav) + ' / unit' : 'waiting for price');

  if (nav == null) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">' +
      '<span class="spinner"></span> Waiting for a live price\u2026</span></div>';
    btn.disabled = true;
    return;
  }

  st.amountPaise = readAmount();
  var q = ledger.quoteBuy(st.amountPaise, nav);
  st.quote = q;

  if (q.errors.length) {
    err.textContent = q.errors[0];
    err.classList.remove('hidden');
    ui.el('#amt').setAttribute('aria-invalid', 'true');
  } else {
    err.classList.add('hidden');
    ui.el('#amt').removeAttribute('aria-invalid');
  }

  host.innerHTML =
    row('You pay', q.grossPaise, 'gross') +
    row('Entry fee (' + CFG.FEES.entryPct + '%)', -q.feePaise, 'charge') +
    row('GST on the fee (' + CFG.FEES.gstPct + '%)', -q.gstPaise, 'charge') +
    row('Invested', q.netInvestPaise, 'net') +
    '<div class="ledger-divider"></div>' +
    '<div class="ledger-row"><span class="l">Units at ' + fmtPrice(q.execNav) + '</span>' +
      '<span class="a">' + fmtUnits(q.units) + '</span></div>' +
    '<div class="ledger-row"><span class="l">Your cost per unit</span>' +
      '<span class="a">' + fmtPrice(q.effectiveNav) + '</span>' +
      '<span class="note">ARV must reach ' + fmtPrice(q.effectiveNav) +
      ' before this deposit is in profit, because charges are paid up front.</span></div>' +
    '<div class="ledger-row"><span class="l">Execution price</span>' +
      '<span class="a">' + fmtPrice(q.execNav) + '</span>' +
      '<span class="note">Includes ' + CFG.FEES.slippagePct +
      '% assumed slippage \u2014 a real order does not fill at the mid price.</span></div>';

  btn.disabled = !(q.valid && ack.checked);

  function row(label, paise, kind) {
    var neg = paise < 0;
    return '<div class="ledger-row k-' + kind + '">' +
      '<span class="l">' + ui.esc(label) + '</span>' +
      '<span class="a">' + (neg ? '\u2212' : '') + fmtPaise(Math.abs(paise)) + '</span></div>';
  }
}

/* ---------------------------------------------------------------------- pay -- */

async function startPayment() {
  var btn = ui.el('[data-continue]');
  ui.busy(btn, true, 'Creating\u2026');

  try {
    var nav = engine.currentArv();
    var res = await db.createDeposit(st.amountPaise, nav);
    st.ref = res.ref;

    ui.setText('[data-pay-amount]', fmtPaise(st.amountPaise));
    ui.setText('[data-ref]', res.ref);
    ui.setText('[data-settle]', CFG.PAYMENTS.settlementHours + ' hours');

    var r = await qr.render(ui.el('[data-qr]'), {
      amountPaise: st.amountPaise,
      ref: res.ref
    });

    if (r.ok) {
      var vpaRow = ui.el('[data-vpa-row]');
      vpaRow.hidden = false;
      ui.setText('[data-vpa]', CFG.PAYMENTS.vpa);

      var link = ui.el('[data-intent-link]');
      if (qr.isMobile()) {
        link.href = r.uri;
        link.classList.remove('hidden');
      }
    }

    // The operator panel. Shown when the signed-in account is flagged as an
    // operator; in the hosted setup the Edge Function re-checks that flag
    // server-side, so revealing the button is a convenience, not the control.
    var profile = await db.getProfile().catch(function () { return null; });
    if (profile && profile.isAdmin) {
      ui.el('[data-admin-confirm]').hidden = false;
    }

    goto(2);
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

async function confirmPayment() {
  var btn = ui.el('[data-confirm]');
  ui.busy(btn, true, 'Issuing units\u2026');

  try {
    var nav = engine.currentArv();
    var upiRef = (ui.el('#upiref').value || '').trim();
    var res = await db.confirmDeposit(st.ref, nav, upiRef);

    ui.setText('[data-done-units]', fmtUnits(res.units));
    ui.setText('[data-done-nav]', fmtPrice(res.quote ? res.quote.execNav : nav));
    ui.setText('[data-done-ref]', st.ref);

    ui.toast('Units issued at ' + fmtPrice(res.quote ? res.quote.execNav : nav), 'ok');
    goto(3);
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* --------------------------------------------------------------------- boot -- */

(async function () {
  ui.setText('[data-min]', fmtPaise(CFG.FEES.minInvestPaise));

  await ui.boot();
  var user = await db.requireUser();
  if (!user) return;

  ui.el('#amt').addEventListener('input', paintQuote);
  ui.el('[data-ack]').addEventListener('change', paintQuote);

  ui.els('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.el('#amt').value = (Number(b.dataset.quick) / 100).toString();
      paintQuote();
    });
  });

  ui.on('[data-continue]', 'click', startPayment);
  ui.on('[data-confirm]', 'click', confirmPayment);
  ui.on('[data-back]', 'click', function () { goto(1); });

  ui.on('[data-copy-vpa]', 'click', function () {
    navigator.clipboard.writeText(CFG.PAYMENTS.vpa)
      .then(function () { ui.toast('UPI ID copied', 'ok', 2000); })
      .catch(function () { ui.toast('Could not copy \u2014 select it manually', 'warn'); });
  });

  paintQuote();
  // Requote as the market moves, but only while the user is still choosing.
  feed.onTick(function () { if (st.step === 1) paintQuote(); });
})();
