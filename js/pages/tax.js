/**
 * Tax statement.
 *
 * Everything on this page comes from what was recorded on each fill. Nothing is
 * recomputed here, and that is the important design decision: `trades` carries
 * the FIFO cost basis, the realised gain, the 30% and the cess as they stood when
 * the fill happened, with the lots that existed at that moment. Re-deriving them
 * later would give a different answer as soon as a lot had been partly consumed
 * by a subsequent sale — and the earlier answer is the correct one.
 *
 * Three amounts are kept visibly apart because conflating them is the commonest
 * way a crypto statement misleads:
 *
 *   TDS withheld    already taken from you and paid to the government. A credit.
 *   Tax on gains    your own liability at filing. Never withheld here.
 *   Fees and GST    our charge, and the tax on our charge. Neither is deductible.
 *
 * Losses are shown and never netted. s.115BBH(2) forbids the set-off, so a page
 * that quietly subtracted them would understate what is owed — which is a worse
 * failure than showing an uncomfortable number.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;

var st = { fy: '', data: null };

/* ------------------------------------------------------------------- rows --- */

function row(label, value, cls, note) {
  return '<div class="ledger-row' + (cls ? ' ' + cls : '') + '">'
    + '<span class="l">' + label + '</span>'
    + '<span class="a">' + value + '</span>'
    + (note ? '<span class="note">' + note + '</span>' : '')
    + '</div>';
}

function signed(paise) {
  if (paise == null) return '\u2014';
  return (paise > 0 ? '+' : (paise < 0 ? '\u2212' : '')) + ui.fmtPaise(Math.abs(paise));
}

/* ---------------------------------------------------------------- headline -- */

function paintHeadline() {
  var d = st.data;
  var r = d.realised;
  var rates = d.rates;

  ui.setText('[data-fy-label]', 'FY ' + d.fy);
  ui.setText('[data-disposals]', String(r.count));
  ui.setText('[data-gross]', ui.fmtPaise(r.grossPaise));
  ui.setText('[data-gains]', ui.fmtPaise(r.gainPaise));
  ui.setText('[data-due]', ui.fmtPaise(r.totalDuePaise));

  ui.setText('[data-rate]', String(rates.gainPct));
  ui.setText('[data-cess]', String(rates.cessPct));
  ui.setText('[data-rate2]', String(rates.gainPct));
  ui.setText('[data-cess2]', String(rates.cessPct));
  ui.setText('[data-tds-rate]', String(CFG.TAX.tdsPct));
  ui.setText('[data-nopan-rate]', String(CFG.TAX.tdsPctNoPan));

  var badge = ui.el('[data-live-badge]');
  badge.className = 'badge ' + (d.current ? 'warn' : 'ok');
  badge.textContent = d.current ? 'year in progress' : 'year closed';

  // A negative balance means the withholding exceeded the liability. That is a
  // refund, and calling it "still to pay: −₹400" would be nonsense.
  var bal = ui.el('[data-balance]');
  var refund = r.balancePaise < 0;
  bal.textContent = ui.fmtPaise(Math.abs(r.balancePaise));
  bal.className = 'stat-v ' + (refund ? 'up' : '');
  ui.setText('[data-balance-note]', refund
    ? 'refundable — TDS exceeded the tax due'
    : 'after crediting ' + ui.fmtPaise(r.tdsWithheldPaise) + ' of TDS');

  /* the arithmetic, in the order it happens */
  ui.setHtml('[data-computation]',
    row('Sale proceeds', ui.fmtPaise(r.grossPaise), 'k-gross',
        'Gross consideration across ' + r.count + ' disposal' + (r.count === 1 ? '' : 's') + '.')
    + row('Less cost of acquisition', '\u2212' + ui.fmtPaise(r.costPaise), '',
        'FIFO — the oldest units you held, at what they actually cost.')
    + row('Gains', ui.fmtPaise(r.gainPaise), 'k-pnl')
    + (r.lossPaise > 0
        ? row('Losses', ui.fmtPaise(r.lossPaise), 'k-warning',
              'Shown for your records only. Section 115BBH(2) does not allow them to be '
              + 'set against the gains above, or carried forward.')
        : '')
    + row('Taxable at ' + rates.gainPct + '%', ui.fmtPaise(r.taxablePaise), 'k-liability')
    + row('Tax', ui.fmtPaise(r.taxPaise), 'k-liability')
    + row('Cess at ' + rates.cessPct + '%', ui.fmtPaise(r.cessPaise), 'k-liability')
    + row('Total liability', ui.fmtPaise(r.totalDuePaise), 'k-liability-total')
    + row('Less TDS already withheld', '\u2212' + ui.fmtPaise(r.tdsWithheldPaise), '',
        'Paid to the government against your PAN. Check it in Form 26AS.')
    + row(refund ? 'Refundable' : 'Payable at filing',
          ui.fmtPaise(Math.abs(r.balancePaise)), 'k-net'));
}

/* --------------------------------------------------------------------- TDS -- */

function paintTds() {
  var t = st.data.tds;

  var badge = ui.el('[data-tds-badge]');
  badge.className = 'badge ' + (t.hasPan ? (t.crossed ? 'info' : 'ok') : 'bad');
  badge.textContent = t.hasPan ? t.ratePct + '%' : 'no PAN \u2014 ' + t.ratePct + '%';

  ui.setHtml('[data-tds]',
    row('Section', ui.esc(t.section))
    + row('Rate applied', t.ratePct + '%', t.hasPan ? '' : 'k-warning',
        t.hasPan ? '' : 'Add your PAN and this drops to ' + CFG.TAX.tdsPct
                  + '%. <a href="profile.html#kyc">Add it now</a>.')
    + row('Sale proceeds this year', ui.fmtPaise(t.aggregatePaise))
    + row('Annual threshold', ui.fmtPaise(t.thresholdPaise))
    + row(t.crossed ? 'Threshold crossed' : 'Headroom left',
          t.crossed ? 'yes' : ui.fmtPaise(t.headroomPaise),
          t.crossed ? 'k-warning' : '')
    + row('Withheld and paid over', ui.fmtPaise(t.withheldPaise), 'k-net'));

  var pct = t.thresholdPaise > 0
    ? Math.min(100, (t.aggregatePaise / t.thresholdPaise) * 100)
    : 0;
  ui.el('[data-threshold-bar]').style.width = pct.toFixed(1) + '%';
  ui.setText('[data-threshold-txt]',
    ui.fmtPaise(t.aggregatePaise) + ' of ' + ui.fmtPaise(t.thresholdPaise));

  ui.setText('[data-tds-note]', t.note);
}

/* -------------------------------------------------------------- unrealised -- */

function paintUnrealised() {
  var u = st.data.unrealised;
  var units = parseFloat(u.units || '0');

  ui.setHtml('[data-unrealised]',
    row('Units held', ui.fmtUnits(u.units))
    + row('What they cost', ui.fmtPaise(u.costPaise))
    + row('Worth now', u.valuePaise != null ? ui.fmtPaise(u.valuePaise) : 'price unavailable')
    + row('Unrealised', u.pnlPaise != null ? signed(u.pnlPaise) : '\u2014',
          u.pnlPaise != null ? (u.pnlPaise >= 0 ? 'k-pnl' : 'k-warning') : '')
    + row('Price used', u.nav != null ? ui.fmtPrice(u.nav) : '\u2014'));

  ui.setText('[data-unrealised-note]', u.note);

  var host = ui.el('[data-lots]');
  if (!units || !u.lots.length) {
    host.innerHTML = '<div class="empty" style="padding:var(--sp-5)">'
      + 'No open lots. You are not holding any ARV.</div>';
    return;
  }

  host.innerHTML =
    '<table class="data"><thead><tr>'
      + '<th>Acquired</th><th class="right">Units</th><th class="right">Cost</th>'
      + '<th class="right">Bought at</th><th class="right">Worth now</th>'
    + '</tr></thead><tbody>'
    + u.lots.map(function (l) {
      var gain = l.valuePaise != null ? l.valuePaise - l.costPaise : null;
      return '<tr>'
        + '<td class="muted nowrap">' + ui.fmtDate(l.acquiredAt) + '</td>'
        + '<td class="right num">' + ui.fmtUnits(l.units, 4) + '</td>'
        + '<td class="right num">' + ui.fmtPaise(l.costPaise) + '</td>'
        + '<td class="right num muted">' + ui.fmtPrice(l.nav) + '</td>'
        + '<td class="right num ' + (gain != null ? ui.direction(gain) : '') + '">'
          + (l.valuePaise != null ? ui.fmtPaise(l.valuePaise) : '\u2014') + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';
}

/* ------------------------------------------------- purchases, other income -- */

function paintOther() {
  var a = st.data.acquisitions;
  var o = st.data.otherIncome;
  var c = st.data.charges;

  ui.setHtml('[data-acquisitions]',
    row('Purchases', String(a.count))
    + row('Units acquired', ui.fmtUnits(a.units))
    + row('Rupees committed', ui.fmtPaise(a.grossPaise)));

  ui.setHtml('[data-other]',
    row('Referral commission', ui.fmtPaise(o.referralPaise), 'k-gross'));

  ui.setHtml('[data-charges]',
    row('Fees on purchases', ui.fmtPaise(c.buyFeePaise), 'k-charge')
    + row('Fees on sales', ui.fmtPaise(c.sellFeePaise), 'k-charge')
    + row('GST on those fees', ui.fmtPaise(c.buyGstPaise + c.sellGstPaise), 'k-charge')
    + row('Total charges', ui.fmtPaise(c.totalPaise), 'k-liability-total',
          'Real money you paid, and none of it deductible against a VDA gain \u2014 '
          + 'section 115BBH allows only cost of acquisition.'));

  ui.setText('[data-other-note]', o.note);
}

/* --------------------------------------------------------------- disposals -- */

function paintDisposals() {
  var rows = st.data.disposals;
  var host = ui.el('[data-disposal-rows]');

  if (!rows.length) {
    host.innerHTML = '<div class="empty"><div class="icon">\u25cb</div>'
      + 'No sales in FY ' + st.data.fy + ', so there is nothing to tax for this year.</div>';
    return;
  }

  host.innerHTML =
    '<table class="data"><thead><tr>'
      + '<th>When</th><th class="right">Units</th><th class="right">Price</th>'
      + '<th class="right">Proceeds</th><th class="right">Cost basis</th>'
      + '<th class="right">Gain</th><th class="right">Tax + cess</th>'
      + '<th class="right">TDS</th><th class="right">Received</th>'
    + '</tr></thead><tbody>'
    + rows.map(function (d) {
      return '<tr>'
        + '<td class="muted nowrap">' + ui.fmtTime(d.at, true) + '</td>'
        + '<td class="right num">' + ui.fmtUnits(d.units, 4) + '</td>'
        + '<td class="right num">' + ui.fmtPrice(d.nav) + '</td>'
        + '<td class="right num">' + ui.fmtPaise(d.grossPaise) + '</td>'
        + '<td class="right num muted">' + ui.fmtPaise(d.costPaise) + '</td>'
        + '<td class="right num ' + ui.direction(d.pnlPaise) + '">' + signed(d.pnlPaise) + '</td>'
        + '<td class="right num">' + ui.fmtPaise(d.taxPaise + d.cessPaise) + '</td>'
        + '<td class="right num down">' + ui.fmtPaise(d.tdsPaise) + '</td>'
        + '<td class="right num strong">' + ui.fmtPaise(d.netPaise) + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';
}

/* --------------------------------------------------------------------- csv -- */

function exportCsv() {
  var d = st.data;
  if (!d) return;
  var r = d.realised;

  var rows = [
    ['ARV Coin tax statement'],
    ['Financial year', d.fy],
    ['Generated', new Date().toISOString()],
    [],
    ['Disposals'],
    ['When', 'Units', 'Price (INR)', 'Proceeds (INR)', 'Cost basis (INR)', 'Gain (INR)',
     'Tax (INR)', 'Cess (INR)', 'TDS (INR)', 'Received (INR)', 'Reference']
  ];

  d.disposals.forEach(function (x) {
    rows.push([x.at, x.units, x.nav, (x.grossPaise / 100).toFixed(2),
               (x.costPaise / 100).toFixed(2), (x.pnlPaise / 100).toFixed(2),
               (x.taxPaise / 100).toFixed(2), (x.cessPaise / 100).toFixed(2),
               (x.tdsPaise / 100).toFixed(2), (x.netPaise / 100).toFixed(2), x.ref]);
  });

  rows.push([], ['Summary'],
    ['Sale proceeds', (r.grossPaise / 100).toFixed(2)],
    ['Cost of acquisition', (r.costPaise / 100).toFixed(2)],
    ['Gains', (r.gainPaise / 100).toFixed(2)],
    ['Losses (not set off)', (r.lossPaise / 100).toFixed(2)],
    ['Taxable', (r.taxablePaise / 100).toFixed(2)],
    ['Tax at ' + d.rates.gainPct + '%', (r.taxPaise / 100).toFixed(2)],
    ['Cess at ' + d.rates.cessPct + '%', (r.cessPaise / 100).toFixed(2)],
    ['Total liability', (r.totalDuePaise / 100).toFixed(2)],
    ['TDS withheld', (r.tdsWithheldPaise / 100).toFixed(2)],
    ['Balance at filing', (r.balancePaise / 100).toFixed(2)],
    [],
    ['Referral income (slab rate, not a capital gain)', (d.otherIncome.referralPaise / 100).toFixed(2)],
    ['Fees and GST paid (not deductible)', (d.charges.totalPaise / 100).toFixed(2)],
    [],
    ['Still held: units', d.unrealised.units],
    ['Still held: cost', (d.unrealised.costPaise / 100).toFixed(2)],
    ['Still held: value', d.unrealised.valuePaise != null ? (d.unrealised.valuePaise / 100).toFixed(2) : ''],
    [],
    [d.disclaimer]
  );

  ui.downloadCsv('arv-tax-' + d.fy + '.csv', rows);
}

/* -------------------------------------------------------------------- load -- */

async function load() {
  try {
    st.data = await api.taxStatement(st.fy || undefined);
  } catch (e) {
    ui.toastError(e);
    return;
  }

  st.fy = st.data.fy;
  ui.el('[data-fy]').value = st.fy;
  ui.setText('[data-disclaimer]', st.data.disclaimer);

  paintHeadline();
  paintTds();
  paintUnrealised();
  paintOther();
  paintDisposals();
}

(async function () {
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;

  try {
    var y = await api.financialYears();
    ui.el('[data-fy]').innerHTML = (y.years || []).map(function (f) {
      return '<option value="' + f + '">FY ' + f + '</option>';
    }).join('');
  } catch (_) {
    ui.el('[data-fy]').innerHTML = '<option value="">Current year</option>';
  }

  await load();

  ui.on('[data-fy]', 'change', function (e) {
    st.fy = e.target.value;
    load();
  });
  ui.on('[data-csv]', 'click', exportCsv);
  ui.on('[data-print]', 'click', function () { window.print(); });
})();
