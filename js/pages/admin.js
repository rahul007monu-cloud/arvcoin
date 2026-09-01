/**
 * Operations panel.
 *
 * The reconciliation view is the reason this page exists. Everything else here —
 * pending deposits, payouts, config — is administration. Reconciliation is the
 * control that keeps the product solvent.
 *
 * The logic: units outstanding × the index's Bitcoin exposure = the Bitcoin the
 * treasury must hold. Compare that against what is actually held. Any difference
 * is tracking error, and it is paid for by whoever redeems last, which makes it
 * the one number an operator cannot afford to leave unchecked.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as engine from '../index-engine.js';
import * as db from '../db.js';
import { fmtPaise, fmtPrice, fmtUnits, fmtBig, fmtPct, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;
var st = { treasury: null, deposits: [], payouts: [], txns: [] };

/* --------------------------------------------------------- reconciliation --- */

/**
 * Bitcoin required to back the units outstanding.
 *
 * Units × NAV gives the rupee liability. Dividing by Bitcoin's rupee price gives
 * the quantity of Bitcoin that liability represents. With a single-asset basket
 * at weight 1.0 this is the whole requirement.
 */
function requirement() {
  var nav = engine.currentArv();
  var btcInr = engine.currentQuotePrice('BTC');
  var units = st.treasury ? st.treasury.unitsOutstanding : 0;
  if (nav == null || btcInr == null) return null;

  var liabilityPaise = Math.round(units * nav * 100);
  var weight = CFG.BASKET[0] ? CFG.BASKET[0].weight : 1;

  return {
    units: units,
    nav: nav,
    btcInr: btcInr,
    liabilityPaise: liabilityPaise,
    btcRequired: btcInr > 0 ? ((liabilityPaise / 100) * weight) / btcInr : 0
  };
}

function paintRecon() {
  var host = ui.el('[data-recon]');
  if (!host) return;

  var r = requirement();
  if (!r) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">' +
      '<span class="spinner"></span> Waiting for a live price\u2026</span></div>';
    return;
  }

  host.innerHTML =
    row('Units outstanding', fmtUnits(r.units)) +
    row('ARV price', fmtPrice(r.nav)) +
    row('Liability to holders', fmtPaise(r.liabilityPaise), 'gross') +
    '<div class="ledger-divider"></div>' +
    row('Bitcoin price', fmtBig(r.btcInr)) +
    '<div class="ledger-row k-liability-total">' +
      '<span class="l">Bitcoin required</span>' +
      '<span class="a">' + r.btcRequired.toFixed(8) + ' BTC</span>' +
      '<span class="note">This much Bitcoin, held, is what makes the index return ' +
      'deliverable to holders.</span>' +
    '</div>';

  paintDiff();

  function row(l, v, kind) {
    return '<div class="ledger-row k-' + (kind || 'info') + '">' +
           '<span class="l">' + l + '</span><span class="a">' + v + '</span></div>';
  }
}

function paintDiff() {
  var host = ui.el('[data-recon-diff]');
  if (!host) return;

  var r = requirement();
  var raw = (ui.el('#actual-btc').value || '').replace(/[^\d.]/g, '');
  var actual = parseFloat(raw);

  if (!r || !isFinite(actual)) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">' +
      'Enter the Bitcoin actually held to see the difference.</span></div>';
    return;
  }

  var diff = actual - r.btcRequired;
  var diffInr = diff * r.btcInr;

  // With no units outstanding there is nothing to be a percentage *of*, so a
  // percentage would read 0% and wrongly imply everything reconciles. Whatever
  // is held in that state is entirely unallocated, which is a different
  // statement and deserves its own one.
  var noLiability = r.btcRequired < 1e-12;
  var diffPct = noLiability ? null : (diff / r.btcRequired) * 100;
  var ok = noLiability ? Math.abs(diff) < 1e-12 : Math.abs(diffPct) < 0.5;

  host.innerHTML =
    '<div class="ledger-row"><span class="l">Required</span>' +
      '<span class="a">' + r.btcRequired.toFixed(8) + '</span></div>' +
    '<div class="ledger-row"><span class="l">Actually held</span>' +
      '<span class="a">' + actual.toFixed(8) + '</span></div>' +
    '<div class="ledger-row k-' + (ok ? 'net' : 'warning') + '">' +
      '<span class="l">' +
        (Math.abs(diff) < 1e-12 ? 'Balanced' : (diff > 0 ? 'Surplus' : 'Shortfall')) +
      '</span>' +
      '<span class="a">' + (diff >= 0 ? '+' : '\u2212') +
        Math.abs(diff).toFixed(8) + ' BTC</span>' +
      '<span class="note">' +
        (diffPct != null ? fmtPct(diffPct) + ' \u00b7 ' : '') +
        (diffInr >= 0 ? '+' : '\u2212') + fmtBig(Math.abs(diffInr)) + '. ' +
        verdict() +
      '</span>' +
    '</div>';

  function verdict() {
    if (noLiability) {
      return Math.abs(diff) < 1e-12
        ? 'No units outstanding and nothing held \u2014 balanced.'
        : 'No units are outstanding, so none of this is owed to holders. ' +
          'The entire balance is unallocated treasury, not profit.';
    }
    if (ok) return 'Within half a percent \u2014 acceptable tracking error.';
    return diff < 0
      ? 'Holders are under-covered. Buy the difference before the next redemption.'
      : 'More is held than is owed. The excess is unallocated, not profit.';
  }
}

/* ------------------------------------------------------------------ queues -- */

function paintPending() {
  var host = ui.el('[data-pending]');
  if (!host) return;

  var rows = st.deposits.filter(function (d) { return d.status === 'awaiting_payment'; });
  ui.setText('[data-pending-count]', String(rows.length));

  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="4" class="empty">Nothing awaiting payment.</td></tr>';
    return;
  }

  host.innerHTML = rows.map(function (d) {
    return '<tr>' +
      '<td class="mono tiny">' + ui.esc(d.ref) + '</td>' +
      '<td class="tiny">' + ui.fmtTime(d.createdAt, true) + '</td>' +
      '<td class="num">' + fmtPaise(d.amountPaise) + '</td>' +
      '<td class="right"><button class="btn btn-sm btn-accent" data-confirm-ref="' +
        ui.esc(d.ref) + '">Confirm</button></td>' +
    '</tr>';
  }).join('');

  ui.els('[data-confirm-ref]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var ref = b.dataset.confirmRef;
      var upiRef = prompt('UPI transaction reference for ' + ref + ' (optional):') || '';
      ui.busy(b, true, 'Issuing\u2026');
      try {
        var nav = engine.currentArv();
        var res = await db.confirmDeposit(ref, nav, upiRef.trim());
        ui.toast('Issued ' + fmtUnits(res.units) + ' units at ' +
                 fmtPrice(res.quote ? res.quote.execNav : nav), 'ok');
        await reload();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });
}

function paintPayouts() {
  var host = ui.el('[data-payouts]');
  if (!host) return;

  var rows = st.payouts.filter(function (p) { return p.status === 'pending'; });
  ui.setText('[data-payout-count]', String(rows.length));

  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="4" class="empty">No payouts due.</td></tr>';
    return;
  }

  host.innerHTML = rows.map(function (p) {
    return '<tr>' +
      '<td class="mono tiny">' + ui.esc(p.ref) + '</td>' +
      '<td class="mono tiny">' + ui.esc(p.upiVpa || '\u2014') + '</td>' +
      '<td class="num strong">' + fmtPaise(p.amountPaise) + '</td>' +
      '<td class="right tiny muted">pending</td>' +
    '</tr>';
  }).join('');
}

/* ------------------------------------------------------------------ config -- */

function paintConfig() {
  var host = ui.el('[data-config]');
  if (!host) return;

  ui.setText('[data-mode-badge]', db.mode() === 'local' ? 'local storage' : 'Supabase');

  var items = [
    ['Basket', CFG.BASKET.map(function (a) {
      return a.key + ' ' + (a.weight * 100).toFixed(0) + '%';
    }).join(', ')],
    ['Quote currency', CFG.INDEX.quote],
    ['Launch', new Date(CFG.INDEX.launchMs).toISOString().slice(0, 10)],
    ['Base price', '$' + CFG.INDEX.baseUsd.BTC.toLocaleString('en-US') +
      ' @ ' + CFG.INDEX.baseFxUsdInr],
    ['ARV at launch', fmtPrice(CFG.INDEX.arvBaseInr)],
    ['Entry / exit fee', CFG.FEES.entryPct + '% / ' + CFG.FEES.exitPct + '%'],
    ['GST on fees', CFG.FEES.gstPct + '%'],
    ['Slippage assumed', CFG.FEES.slippagePct + '%'],
    ['VDA tax', CFG.TAX.vdaGainPct + '% + ' + CFG.TAX.cessPct + '% cess'],
    ['TDS', CFG.TAX.tdsPct + '% (no PAN ' + CFG.TAX.tdsPctNoPan + '%)'],
    ['TDS threshold', fmtPaise(CFG.TAX.tdsThresholdPaise)],
    ['Cost basis', CFG.TAX.costBasisMethod],
    ['Loss set-off', CFG.TAX.allowLossSetOff ? 'ALLOWED — misconfigured' : 'not permitted'],
    ['Data source', (feed.status().label || '\u2014') + ' \u00b7 ' + feed.status().mode],
    ['UPI', CFG.PAYMENTS.vpa || 'not configured']
  ];

  host.innerHTML = items.map(function (i) {
    return '<div class="stat"><span class="stat-k">' + i[0] + '</span>' +
           '<span class="num" style="font-size:0.95rem">' + ui.esc(i[1]) + '</span></div>';
  }).join('');

  var warn = ui.el('[data-warnings]');
  if (warn) {
    var problems = engine.selfCheck();
    warn.innerHTML = problems.length
      ? '<div class="note-box warn"><strong>Configuration notes</strong><ul style="margin:8px 0 0;padding-left:1.1rem">' +
        problems.map(function (p) { return '<li>' + ui.esc(p) + '</li>'; }).join('') +
        '</ul></div>'
      : '<div class="note-box ok">Configuration is consistent. The index evaluates to ' +
        fmtPrice(CFG.INDEX.arvBaseInr) + ' at the locked launch prices.</div>';
  }
}

/* -------------------------------------------------------------- tax owed --- */

function paintTaxOwed() {
  var host = ui.el('[data-tax-owed]');
  if (!host) return;

  var tds = 0, gst = 0, fees = 0;
  st.txns.forEach(function (t) {
    if (t.status !== 'confirmed' && t.status !== 'settled') return;
    tds += t.tdsPaise || 0;
    gst += t.gstPaise || 0;
    fees += t.feePaise || 0;
  });

  host.innerHTML =
    tile('TDS withheld (s.194S)', fmtPaise(tds), 'deposit with the department') +
    tile('GST collected on fees', fmtPaise(gst), 'a liability, not revenue') +
    tile('Platform fees earned', fmtPaise(fees), 'this is the actual revenue');

  function tile(k, v, sub) {
    return '<div class="stat"><span class="stat-k">' + k + '</span>' +
           '<span class="stat-v" style="font-size:1.3rem">' + v + '</span>' +
           '<span class="stat-sub">' + sub + '</span></div>';
  }
}

/* -------------------------------------------------------------------- boot -- */

async function reload() {
  try {
    st.treasury = await db.getTreasury();
    st.deposits = await db.getDeposits();
    st.payouts = await db.getPayouts();
    st.txns = await db.getTransactions({});
  } catch (e) {
    ui.toastError(e);
  }
  paintPending();
  paintPayouts();
  paintTaxOwed();
  paintRecon();
}

(async function () {
  await ui.boot();
  var user = await db.requireUser();
  if (!user) return;

  // In the hosted setup the Edge Functions enforce this; the check here only
  // avoids showing an operator a screen full of controls that will be refused.
  var profile = await db.getProfile().catch(function () { return null; });
  if (db.mode() === 'supabase' && (!profile || !profile.isAdmin)) {
    document.querySelector('main').innerHTML =
      '<div class="wrap" style="padding:var(--sp-8) 0">' +
      '<div class="note-box bad"><strong>Not authorised.</strong> This page is for ' +
      'operator accounts. Set <code>is_admin</code> on the profile row in Supabase ' +
      'to grant access \u2014 see SETUP.md.</div></div>';
    return;
  }

  ui.el('#actual-btc').addEventListener('input', paintDiff);
  paintConfig();
  await reload();

  feed.onTick(function () { paintRecon(); });
  setInterval(function () { if (!document.hidden) paintConfig(); }, 30000);
})();
