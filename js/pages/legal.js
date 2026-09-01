/**
 * Legal page.
 *
 * The fee and tax tables are generated from arv-config.js rather than written
 * out by hand. A disclosure document that has to be edited every time a rate
 * changes is a document that will eventually be wrong, and being wrong about
 * what you charge is worse than saying nothing.
 */

import * as ui from '../ui.js';
import * as engine from '../index-engine.js';
import { fmtPaise, fmtPrice, fmtBig } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

function paint() {
  var f = CFG.FEES, t = CFG.TAX, i = CFG.INDEX;

  ui.setText('[data-updated]', new Date().toLocaleDateString(CFG.UI.locale, {
    day: 'numeric', month: 'long', year: 'numeric'
  }));

  ui.setText('[data-base]', fmtPrice(i.arvBaseInr));
  ui.setText('[data-launch]', new Date(i.launchMs).toLocaleDateString(CFG.UI.locale, {
    day: 'numeric', month: 'long', year: 'numeric'
  }));
  ui.setText('[data-min-buy]', fmtPaise(f.minInvestPaise));
  ui.setText('[data-min-sell]', fmtPaise(f.minRedeemPaise));
  ui.setText('[data-slip]', f.slippagePct + '%');
  ui.setText('[data-settle]', CFG.PAYMENTS.settlementHours + ' hours');

  // The formula, spelled out with the actual configured weights.
  var terms = CFG.BASKET.map(function (a) {
    return (a.weight === 1 ? '' : a.weight.toFixed(2) + ' \u00d7 ') +
      a.key + '(t) \u00f7 ' + a.key + '(launch)';
  }).join(' + ');
  ui.setText('[data-formula]', fmtPrice(i.arvBaseInr) + ' \u00d7 [ ' + terms + ' ]');

  var baseInr = engine.quoteBase('BTC');
  ui.setText('[data-base-btc]',
    'Bitcoin at $' + i.baseUsd.BTC.toLocaleString('en-US') +
    ', USD/INR ' + i.baseFxUsdInr.toFixed(2) +
    (baseInr ? ', so ' + fmtBig(baseInr) : ''));

  /* ------------------------------------------------------------ fee table -- */
  var feeRows = [
    ['Entry fee', f.entryPct + '% of the amount deposited', 'On deposit'],
    ['Exit fee', f.exitPct + '% of the gross redemption value', 'On redemption'],
    ['GST', f.gstPct + '% of the fee above \u2014 not of the principal', 'On both'],
    ['Management fee', f.annualMgmtPct > 0 ? f.annualMgmtPct + '% a year of assets' : 'None', 'Ongoing'],
    ['Assumed slippage', f.slippagePct + '% against you on execution', 'On both'],
    ['Minimum deposit', fmtPaise(f.minInvestPaise), '\u2014'],
    ['Minimum redemption', fmtPaise(f.minRedeemPaise), '\u2014'],
    ['Deposit by UPI', 'No charge', '\u2014'],
    ['Payout to UPI', 'No charge', '\u2014'],
    ['Account, statements, CSV export', 'No charge', '\u2014']
  ];

  ui.setHtml('[data-fee-table]',
    '<thead><tr><th>Charge</th><th>Amount</th><th>When</th></tr></thead><tbody>' +
    feeRows.map(function (r) {
      return '<tr><td><strong>' + ui.esc(r[0]) + '</strong></td>' +
             '<td>' + ui.esc(r[1]) + '</td>' +
             '<td class="tiny muted">' + ui.esc(r[2]) + '</td></tr>';
    }).join('') + '</tbody>');

  /* ------------------------------------------------------------ tax table -- */
  var effective = (t.vdaGainPct * (1 + t.cessPct / 100)).toFixed(1);
  var taxRows = [
    ['Tax on gains', t.vdaGainPct + '% flat', 'Section 115BBH',
      'Your liability at filing \u2014 NOT withheld here'],
    ['Health &amp; education cess', t.cessPct + '% of the tax', '\u2014',
      'Takes the effective rate to ' + effective + '%'],
    ['TDS', t.tdsPct + '% of gross consideration', 'Section 194S',
      'WITHHELD by this platform at redemption'],
    ['TDS without PAN', t.tdsPctNoPan + '% of gross consideration', 'Section 206AA',
      'Applies when no PAN is on record'],
    ['TDS threshold', fmtPaise(t.tdsThresholdPaise) + ' per financial year', 'Section 194S',
      'Crossing it makes the whole transfer liable, not just the excess'],
    ['Threshold, specified persons', fmtPaise(t.tdsThresholdSpecifiedPaise) + ' per year', '\u2014', '\u2014'],
    ['Deductions allowed', 'Cost of acquisition only', 'Section 115BBH',
      'Fees and GST are NOT deductible'],
    ['Loss set-off', t.allowLossSetOff ? 'Permitted' : 'Not permitted', 'Section 115BBH',
      'No set-off against anything, no carry-forward'],
    ['Cost basis method', t.costBasisMethod, '\u2014', 'Oldest units redeemed first'],
    ['GST on platform fees', CFG.FEES.gstPct + '%', '\u2014', 'On the fee, not the principal']
  ];

  ui.setHtml('[data-tax-table]',
    '<thead><tr><th>Item</th><th>Rate</th><th>Provision</th><th>Note</th></tr></thead><tbody>' +
    taxRows.map(function (r) {
      return '<tr><td><strong>' + r[0] + '</strong></td>' +
             '<td class="num">' + ui.esc(r[1]) + '</td>' +
             '<td class="tiny muted">' + ui.esc(r[2]) + '</td>' +
             '<td class="tiny">' + ui.esc(r[3]) + '</td></tr>';
    }).join('') + '</tbody>');
}

(async function () {
  paint();
  await ui.boot({ feed: false, ticker: false });
})();
