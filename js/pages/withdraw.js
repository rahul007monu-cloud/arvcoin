/**
 * Redeem flow.
 *
 * The design goal of this screen is that nobody is surprised in July. Indian VDA
 * tax has three properties that catch people out, and all three are stated on
 * screen before the confirm button becomes active:
 *
 *   the 30% + cess is NOT withheld — it is owed later
 *   platform fees are not deductible against the gain
 *   losses cannot be set off or carried forward
 *
 * The quote comes from the same `ledger.quoteSell` that executes the redemption,
 * so the itemisation shown is arithmetically the record that gets written.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as engine from '../index-engine.js';
import * as ledger from '../ledger.js';
import * as db from '../db.js';
import * as qr from '../qr.js';
import { fmtPaise, fmtPrice, fmtUnits, roundUnits, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  step: 1, holdings: null, lots: [], profile: null,
  fyGross: 0, quote: null, units: 0
};

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

function ctx() {
  return {
    hasPan: !!(st.profile && st.profile.pan),
    isSpecifiedPerson: !!(st.profile && st.profile.isSpecifiedPerson),
    fyGrossProceedsPaise: st.fyGross,
    availableUnits: st.holdings ? st.holdings.units : 0
  };
}

function paintQuote() {
  var nav = engine.currentArv();
  var host = ui.el('[data-quote]');
  var btn = ui.el('[data-continue]');
  var err = ui.el('[data-units-err]');

  ui.setText('[data-price-badge]', nav != null ? fmtPrice(nav) + ' / unit' : 'waiting for price');

  if (nav == null || !st.holdings) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">' +
      '<span class="spinner"></span> Waiting for a live price\u2026</span></div>';
    btn.disabled = true;
    return;
  }

  ui.setText('[data-held]', fmtUnits(st.holdings.units));
  ui.setText('[data-worth]', fmtPaise(Math.floor(st.holdings.units * nav * 100)));

  var raw = (ui.el('#units').value || '').replace(/[^\d.]/g, '');
  st.units = roundUnits(parseFloat(raw) || 0);

  if (!st.units) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">Enter units to redeem</span></div>';
    err.classList.add('hidden');
    btn.disabled = true;
    return;
  }

  var q = ledger.quoteSell(st.units, nav, st.lots, ctx());
  st.quote = q;

  if (q.errors.length) {
    err.textContent = q.errors[0];
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }

  host.innerHTML = renderLedger(ledger.explainSell(q));
  btn.disabled = !q.valid;
}

function renderLedger(rows) {
  return rows.map(function (r) {
    if (r.divider) return '<div class="ledger-divider"></div>';
    var amt = r.paise != null
      ? '<span class="a">' + (r.paise < 0 ? '\u2212' : '') +
        fmtPaise(Math.abs(r.paise)) + '</span>'
      : '';
    return '<div class="ledger-row k-' + (r.kind || 'info') + '">' +
      '<span class="l">' + ui.esc(r.label) + '</span>' + amt +
      (r.note ? '<span class="note">' + ui.esc(r.note) + '</span>' : '') +
    '</div>';
  }).join('');
}

/* -------------------------------------------------------------------- final -- */

function paintFinal() {
  var q = st.quote;
  if (!q) return;

  ui.setHtml('[data-final]', renderLedger(ledger.explainSell(q)));

  var lots = ui.el('[data-lots]');
  if (lots) {
    lots.innerHTML = q.lotsConsumed.length
      ? q.lotsConsumed.map(function (c) {
          return '<tr>' +
            '<td class="tiny">' + (c.acquiredAt ? ui.fmtDate(c.acquiredAt) : '\u2014') + '</td>' +
            '<td class="num">' + fmtUnits(c.units) + '</td>' +
            '<td class="num">' + fmtPaise(c.costPaise) + '</td>' +
          '</tr>';
        }).join('')
      : '<tr><td colspan="3" class="empty">No lot data</td></tr>';
  }

  var ack = ui.el('[data-ack2]');
  var exec = ui.el('[data-execute]');
  ack.checked = false;
  exec.disabled = true;
}

/* ------------------------------------------------------------------ execute -- */

async function execute() {
  var btn = ui.el('[data-execute]');
  ui.busy(btn, true, 'Redeeming\u2026');

  try {
    var vpa = (ui.el('#vpa').value || '').trim();
    if (vpa && (!st.profile || st.profile.upiVpa !== vpa)) {
      await db.updateProfile({ upiVpa: vpa });
      st.profile = Object.assign({}, st.profile, { upiVpa: vpa });
    }

    var nav = engine.currentArv();
    var res = await db.redeem(st.units, nav, ctx());
    var q = res.quote || st.quote;

    ui.setText('[data-payout]', fmtPaise(q.netPayoutPaise));
    ui.setText('[data-payout-ref]', res.ref);
    ui.setText('[data-payout-vpa]', vpa || '\u2014');
    ui.setText('[data-fy]', q.fy);
    ui.setText('[data-settle]', CFG.PAYMENTS.settlementHours + ' hours');

    // A QR for the payout direction too, so the operator can scan and pay out
    // without retyping the amount.
    await qr.render(ui.el('[data-payout-qr]'), {
      vpa: vpa,
      payeeName: (st.profile && st.profile.fullName) || 'Redemption',
      amountPaise: q.netPayoutPaise,
      ref: res.ref
    });

    var receipt = ui.el('[data-receipt]');
    if (receipt) {
      receipt.innerHTML =
        rec('Units redeemed', fmtUnits(q.units)) +
        rec('Price', fmtPrice(q.execNav)) +
        rec('Gross', fmtPaise(q.grossPaise)) +
        rec('TDS withheld', fmtPaise(q.tdsPaise)) +
        rec('Paid to you', fmtPaise(q.netPayoutPaise)) +
        rec('Tax due at filing', fmtPaise(q.balanceTaxPayablePaise));
    }

    ui.toast('Redeemed ' + fmtUnits(q.units) + ' units', 'ok');
    goto(3);
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }

  function rec(l, v) {
    return '<div class="ledger-row"><span class="l">' + l +
           '</span><span class="a">' + v + '</span></div>';
  }
}

/* --------------------------------------------------------------------- boot -- */

(async function () {
  ui.setText('[data-pan-rate]', CFG.TAX.tdsPct + '%');
  ui.setText('[data-nopan-rate]', CFG.TAX.tdsPctNoPan + '%');

  await ui.boot();
  var user = await db.requireUser();
  if (!user) return;

  try {
    st.holdings = await db.getHoldings();
    st.lots = await db.getLots();
    st.profile = await db.getProfile();
    st.fyGross = await db.fyGrossProceeds();
  } catch (e) {
    ui.toastError(e);
    return;
  }

  if (st.profile && st.profile.upiVpa) ui.el('#vpa').value = st.profile.upiVpa;
  if (!st.profile || !st.profile.pan) ui.el('[data-pan-warn]').hidden = false;

  if (!st.holdings || st.holdings.units <= 0) {
    ui.el('[data-quote]').innerHTML =
      '<div class="ledger-row"><span class="l muted">You hold no units to redeem. ' +
      '<a href="buy.html">Buy ARV</a> first.</span></div>';
  }

  ui.el('#units').addEventListener('input', paintQuote);

  ui.els('[data-pct]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!st.holdings) return;
      var pct = Number(b.dataset.pct) / 100;
      // Floor at 8dp so 100% never asks for more than is held.
      var u = Math.floor(st.holdings.units * pct * 1e8) / 1e8;
      ui.el('#units').value = String(u);
      paintQuote();
    });
  });

  ui.on('[data-continue]', 'click', function () { paintFinal(); goto(2); });
  ui.on('[data-back]', 'click', function () { goto(1); });
  ui.on('[data-ack2]', 'change', function (e) {
    ui.el('[data-execute]').disabled = !e.target.checked;
  });
  ui.on('[data-execute]', 'click', execute);

  paintQuote();
  feed.onTick(function () { if (st.step === 1) paintQuote(); });
})();
