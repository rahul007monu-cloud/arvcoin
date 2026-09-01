/**
 * Tax statement.
 *
 * Presents the FY computation the way the liability actually works, which means
 * showing two numbers most portfolio apps quietly merge:
 *
 *   net profit and loss — what the user feels they made
 *   taxable gains       — gains only, because losses cannot be set off
 *
 * When those differ, the difference is money owed on profit the user does not
 * have. That gap gets its own panel rather than being buried in a footnote.
 */

import * as ui from '../ui.js';
import * as db from '../db.js';
import * as ledger from '../ledger.js';
import { fmtPaise, fmtPrice, fmtUnits, fmtPct, currentFy, fyOf, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;
var st = { all: [], fy: currentFy(), summary: null };

/* ------------------------------------------------------------------ headline -- */

function paintHeadline(s) {
  ui.setText('[data-gains]', fmtPaise(s.realisedGainPaise));
  ui.setText('[data-tax]', fmtPaise(s.totalTaxPaise));
  ui.setText('[data-tds]', fmtPaise(s.tdsWithheldPaise));
  ui.setText('[data-rate]', (CFG.TAX.vdaGainPct * (1 + CFG.TAX.cessPct / 100)).toFixed(1) + '%');
  ui.setText('[data-threshold]', fmtPaise(CFG.TAX.tdsThresholdPaise));
  ui.setText('[data-fy-badge]', 'FY ' + s.fy);

  // A refund is possible: TDS is on gross proceeds, so a year of small gains on
  // large turnover can withhold more than the liability.
  var refund = s.refundDuePaise > 0;
  ui.setText('[data-balance-label]', refund ? 'Refund due' : 'Balance payable');
  var bEl = ui.el('[data-balance]');
  if (bEl) {
    bEl.textContent = fmtPaise(refund ? s.refundDuePaise : s.balancePayablePaise);
    bEl.className = 'stat-v ' + (refund ? 'up' : '');
  }
}

/* --------------------------------------------------------------- computation -- */

function paintComputation(s) {
  var rows = [
    { l: 'Gross consideration on transfers', a: s.grossProceedsPaise, k: 'gross' },
    { l: 'Less cost of acquisition (FIFO)', a: -s.costBasisPaise, k: 'info' },
    { div: true },
    { l: 'Realised gains', a: s.realisedGainPaise, k: 'pnl' },
    { l: 'Realised losses', a: -s.realisedLossPaise, k: 'pnl',
      note: s.realisedLossPaise > 0
        ? 'Recorded but not deductible \u2014 no set-off, no carry-forward'
        : null },
    { l: 'Net profit and loss', a: s.netPnlPaise, k: 'info' },
    { div: true },
    { l: 'Taxable gains (losses excluded)', a: s.realisedGainPaise, k: 'gross' },
    { l: 'Tax at ' + CFG.TAX.vdaGainPct + '%', a: s.taxPaise, k: 'liability' },
    { l: 'Cess at ' + CFG.TAX.cessPct + '% of tax', a: s.cessPaise, k: 'liability' },
    { l: 'Total liability', a: s.totalTaxPaise, k: 'liability-total' },
    { div: true },
    { l: 'Less TDS withheld (s.194S)', a: -s.tdsWithheldPaise, k: 'tds' },
    { l: s.refundDuePaise > 0 ? 'Refund due' : 'Balance payable at filing',
      a: s.refundDuePaise > 0 ? s.refundDuePaise : s.balancePayablePaise, k: 'net' },
    { div: true },
    { l: 'Fees and GST paid (not deductible)', a: s.feesPaise + s.gstPaise, k: 'info',
      note: 'Shown for completeness. Section 115BBH permits no deduction other than cost of acquisition.' }
  ];

  ui.setHtml('[data-computation]', rows.map(function (r) {
    if (r.div) return '<div class="ledger-divider"></div>';
    var neg = r.a < 0;
    return '<div class="ledger-row k-' + r.k + '">' +
      '<span class="l">' + ui.esc(r.l) + '</span>' +
      '<span class="a">' + (neg ? '\u2212' : '') + fmtPaise(Math.abs(r.a)) + '</span>' +
      (r.note ? '<span class="note">' + ui.esc(r.note) + '</span>' : '') +
    '</div>';
  }).join(''));
}

/**
 * The cost of the no-set-off rule, in rupees.
 *
 * Only shown when there were losses, because otherwise it is a lecture about a
 * rule that did not bite.
 */
function paintSetOff(s) {
  var card = ui.el('[data-setoff-card]');
  if (!card) return;

  if (s.realisedLossPaise <= 0) { card.hidden = true; return; }
  card.hidden = false;

  var host = ui.el('[data-setoff]');
  if (!host) return;

  var hypothetical = Math.max(0, s.netPnlPaise);
  var hypoTax = Math.round(hypothetical * (CFG.TAX.vdaGainPct / 100) *
                           (1 + CFG.TAX.cessPct / 100));
  var extra = s.totalTaxPaise - hypoTax;

  host.innerHTML =
    r('Gains', s.realisedGainPaise) +
    r('Losses', -s.realisedLossPaise) +
    r('Net, as you experienced it', s.netPnlPaise) +
    '<div class="ledger-divider"></div>' +
    r('Tax if losses were deductible', hypoTax) +
    r('Tax actually owed', s.totalTaxPaise) +
    '<div class="ledger-row k-warning"><span class="l">Extra tax from the rule</span>' +
      '<span class="a">' + fmtPaise(extra) + '</span>' +
      '<span class="note">Section 115BBH allows no set-off against other virtual ' +
      'digital asset gains, no set-off against other income, and no carry-forward ' +
      'to a later year.</span></div>';

  function r(l, a) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>' +
           '<span class="a">' + (a < 0 ? '\u2212' : '') + fmtPaise(Math.abs(a)) + '</span></div>';
  }
}

/* -------------------------------------------------------------------- detail -- */

function paintDetail() {
  var host = ui.el('[data-detail]');
  var foot = ui.el('[data-detail-foot]');
  var rows = st.all.filter(function (t) {
    return t.type === 'redeem' && t.fy === st.fy &&
           (t.status === 'confirmed' || t.status === 'settled');
  });

  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="9"><div class="empty">' +
      'No redemptions in FY ' + st.fy + '.<br>' +
      '<span class="tiny">Tax on virtual digital assets arises on transfer. ' +
      'Holding, however much it moves, is not a taxable event.</span></div></td></tr>';
    if (foot) foot.innerHTML = '';
    return;
  }

  host.innerHTML = rows.map(function (t) {
    var pnl = t.realisedGainPaise != null
      ? t.realisedGainPaise
      : (t.grossPaise || 0) - (t.costBasisPaise || 0);
    return '<tr>' +
      '<td class="tiny nowrap">' + ui.fmtDate(t.createdAt) + '</td>' +
      '<td class="mono tiny">' + ui.esc(t.ref || '') + '</td>' +
      '<td class="num">' + fmtUnits(t.units) + '</td>' +
      '<td class="num">' + fmtPaise(t.grossPaise || 0) + '</td>' +
      '<td class="num">' + fmtPaise(t.costBasisPaise || 0) + '</td>' +
      '<td class="num ' + direction(pnl) + '">' +
        (pnl >= 0 ? '+' : '\u2212') + fmtPaise(Math.abs(pnl)) + '</td>' +
      '<td class="num">' + fmtPaise(t.taxPaise || 0) + '</td>' +
      '<td class="num">' + fmtPaise(t.cessPaise || 0) + '</td>' +
      '<td class="num">' + fmtPaise(t.tdsPaise || 0) + '</td>' +
    '</tr>';
  }).join('');

  if (foot) {
    var s = st.summary;
    foot.innerHTML = '<tr>' +
      '<td colspan="3">Total \u00b7 ' + rows.length + ' redemption' + (rows.length > 1 ? 's' : '') + '</td>' +
      '<td class="num">' + fmtPaise(s.grossProceedsPaise) + '</td>' +
      '<td class="num">' + fmtPaise(s.costBasisPaise) + '</td>' +
      '<td class="num">' + fmtPaise(s.netPnlPaise) + '</td>' +
      '<td class="num">' + fmtPaise(s.taxPaise) + '</td>' +
      '<td class="num">' + fmtPaise(s.cessPaise) + '</td>' +
      '<td class="num">' + fmtPaise(s.tdsWithheldPaise) + '</td>' +
    '</tr>';
  }
}

/* ----------------------------------------------------------------------- csv -- */

function exportCsv() {
  var s = st.summary;
  var r2 = function (p) { return ((p || 0) / 100).toFixed(2); };

  var rows = [
    ['ARV Coin — tax statement'],
    ['Financial year', st.fy],
    ['Generated', new Date().toISOString()],
    [],
    ['SUMMARY (all amounts in INR)'],
    ['Gross consideration', r2(s.grossProceedsPaise)],
    ['Cost of acquisition (FIFO)', r2(s.costBasisPaise)],
    ['Realised gains', r2(s.realisedGainPaise)],
    ['Realised losses (not deductible)', r2(s.realisedLossPaise)],
    ['Net profit and loss', r2(s.netPnlPaise)],
    ['Tax at ' + CFG.TAX.vdaGainPct + '%', r2(s.taxPaise)],
    ['Cess at ' + CFG.TAX.cessPct + '%', r2(s.cessPaise)],
    ['Total liability', r2(s.totalTaxPaise)],
    ['TDS withheld (s.194S)', r2(s.tdsWithheldPaise)],
    ['Balance payable', r2(s.balancePayablePaise)],
    ['Refund due', r2(s.refundDuePaise)],
    ['Fees and GST paid (not deductible)', r2(s.feesPaise + s.gstPaise)],
    [],
    ['DETAIL'],
    ['Date', 'Reference', 'Units', 'Consideration', 'Cost of acquisition',
     'Gain/loss', 'Tax 30%', 'Cess 4%', 'TDS 1%']
  ];

  st.all.filter(function (t) {
    return t.type === 'redeem' && t.fy === st.fy &&
           (t.status === 'confirmed' || t.status === 'settled');
  }).forEach(function (t) {
    var pnl = t.realisedGainPaise != null
      ? t.realisedGainPaise : (t.grossPaise || 0) - (t.costBasisPaise || 0);
    rows.push([
      new Date(t.createdAt).toISOString().slice(0, 10), t.ref,
      t.units != null ? t.units.toFixed(8) : '',
      r2(t.grossPaise), r2(t.costBasisPaise), r2(pnl),
      r2(t.taxPaise), r2(t.cessPaise), r2(t.tdsPaise)
    ]);
  });

  rows.push([]);
  rows.push(['Method', 'FIFO cost basis. Fees not deductible (s.115BBH).']);
  rows.push(['Note', 'Computation from recorded transactions. Not a filing and not tax advice.']);

  ui.downloadCsv('arv-tax-' + st.fy + '.csv', rows);
  ui.toast('Tax statement exported', 'ok');
}

/* ---------------------------------------------------------------------- boot -- */

function recompute() {
  st.summary = ledger.fySummary(st.all, st.fy);
  paintHeadline(st.summary);
  paintComputation(st.summary);
  paintSetOff(st.summary);
  paintDetail();
}

(async function () {
  await ui.boot({ feed: false, ticker: false });
  var user = await db.requireUser();
  if (!user) return;

  try {
    st.all = await db.getTransactions({});
  } catch (e) {
    ui.toastError(e);
    st.all = [];
  }
  st.all.forEach(function (t) { if (!t.fy && t.createdAt) t.fy = fyOf(t.createdAt); });

  var years = {};
  st.all.forEach(function (t) { if (t.fy) years[t.fy] = 1; });
  years[currentFy()] = 1;
  var list = Object.keys(years).sort().reverse();

  var sel = ui.el('[data-fy]');
  sel.innerHTML = list.map(function (f) {
    return '<option value="' + f + '"' + (f === st.fy ? ' selected' : '') + '>FY ' + f + '</option>';
  }).join('');
  sel.addEventListener('change', function () { st.fy = sel.value; recompute(); });

  ui.on('[data-csv]', 'click', exportCsv);
  recompute();
})();
