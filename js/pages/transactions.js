/**
 * Transaction history.
 *
 * A flat, complete, append-only list. No pagination tricks that hide old rows,
 * no filtering that defaults to a flattering window: the default view is
 * everything. The CSV export exists because at some point this has to go to
 * whoever is preparing the return.
 */

import * as ui from '../ui.js';
import * as db from '../db.js';
import { fmtPaise, fmtPrice, fmtUnits, fyOf, currentFy, direction } from '../money.js';

var st = { all: [], type: '', fy: '' };

/* ------------------------------------------------------------------ filters -- */

function filtered() {
  return st.all.filter(function (t) {
    if (st.type && t.type !== st.type) return false;
    if (st.fy && t.fy !== st.fy) return false;
    return true;
  });
}

function buildFyOptions() {
  var sel = ui.el('[data-fy]');
  if (!sel) return;

  var years = {};
  st.all.forEach(function (t) { if (t.fy) years[t.fy] = 1; });
  var list = Object.keys(years).sort().reverse();
  if (!list.length) list = [currentFy()];

  sel.innerHTML = '<option value="">All financial years</option>' +
    list.map(function (f) { return '<option value="' + f + '">FY ' + f + '</option>'; }).join('');

  sel.addEventListener('change', function () { st.fy = sel.value; paint(); });
}

/* -------------------------------------------------------------------- totals -- */

function paintTotals() {
  var rows = filtered().filter(function (t) {
    return t.status === 'confirmed' || t.status === 'settled';
  });

  var din = 0, dout = 0, fees = 0, tds = 0;
  rows.forEach(function (t) {
    if (t.type === 'deposit') din += t.grossPaise || 0;
    if (t.type === 'redeem') dout += t.netPaise || 0;
    fees += (t.feePaise || 0) + (t.gstPaise || 0);
    tds += t.tdsPaise || 0;
  });

  ui.setText('[data-sum-in]', fmtPaise(din));
  ui.setText('[data-sum-out]', fmtPaise(dout));
  ui.setText('[data-sum-fees]', fmtPaise(fees));
  ui.setText('[data-sum-tds]', fmtPaise(tds));
}

/* --------------------------------------------------------------------- rows -- */

function statusBadge(s) {
  var map = {
    settled: 'ok', confirmed: 'ok', pending: 'warn',
    awaiting_payment: 'warn', failed: 'bad', cancelled: 'bad'
  };
  return '<span class="badge ' + (map[s] || '') + '">' +
         ui.esc(s === 'awaiting_payment' ? 'awaiting payment' : s) + '</span>';
}

function paintRows() {
  var host = ui.el('[data-rows]');
  var rows = filtered();

  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="11"><div class="empty">' +
      '<div class="icon">\u25ca</div>Nothing matches this filter.' +
      (st.all.length ? '' : '<br><a href="buy.html">Make your first deposit</a>') +
      '</div></td></tr>';
    return;
  }

  host.innerHTML = rows.map(function (t) {
    var isBuy = t.type === 'deposit';
    var pnl = t.realisedGainPaise;
    var pnlCell = pnl != null && !isBuy
      ? '<span class="' + direction(pnl) + '">' +
        (pnl >= 0 ? '+' : '\u2212') + fmtPaise(Math.abs(pnl)) + '</span>'
      : '\u2014';

    return '<tr>' +
      '<td class="mono tiny">' + ui.esc(t.ref || '\u2014') + '</td>' +
      '<td class="tiny nowrap">' + ui.fmtTime(t.createdAt, true) + '</td>' +
      '<td><span class="badge ' + (isBuy ? 'info' : 'warn') + '">' +
        (isBuy ? 'Buy' : 'Redeem') + '</span></td>' +
      '<td class="num">' + fmtUnits(t.units) + '</td>' +
      '<td class="num">' + (t.nav ? fmtPrice(t.nav) : '\u2014') + '</td>' +
      '<td class="num">' + fmtPaise(t.grossPaise || 0) + '</td>' +
      '<td class="num">' + fmtPaise((t.feePaise || 0) + (t.gstPaise || 0)) + '</td>' +
      '<td class="num">' + (t.tdsPaise ? fmtPaise(t.tdsPaise) : '\u2014') + '</td>' +
      '<td class="num strong">' + fmtPaise(t.netPaise || 0) + '</td>' +
      '<td class="num">' + pnlCell + '</td>' +
      '<td>' + statusBadge(t.status) + '</td>' +
    '</tr>';
  }).join('');
}

function paint() {
  paintTotals();
  paintRows();
}

/* ---------------------------------------------------------------------- csv -- */

function exportCsv() {
  var rows = [[
    'Reference', 'Date', 'Type', 'Status', 'Units', 'Price (INR)',
    'Gross (INR)', 'Fee (INR)', 'GST (INR)', 'TDS (INR)', 'Net (INR)',
    'Cost basis (INR)', 'Realised gain/loss (INR)',
    'Tax 30% (INR)', 'Cess 4% (INR)', 'Financial year'
  ]];

  var r2 = function (p) { return p != null ? (p / 100).toFixed(2) : ''; };

  filtered().forEach(function (t) {
    rows.push([
      t.ref, new Date(t.createdAt).toISOString(), t.type, t.status,
      t.units != null ? t.units.toFixed(8) : '',
      t.nav != null ? t.nav.toFixed(8) : '',
      r2(t.grossPaise), r2(t.feePaise), r2(t.gstPaise), r2(t.tdsPaise), r2(t.netPaise),
      r2(t.costBasisPaise), r2(t.realisedGainPaise),
      r2(t.taxPaise), r2(t.cessPaise), t.fy || ''
    ]);
  });

  ui.downloadCsv('arv-transactions-' + new Date().toISOString().slice(0, 10) + '.csv', rows);
  ui.toast('Exported ' + (rows.length - 1) + ' rows', 'ok');
}

/* --------------------------------------------------------------------- boot -- */

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

  // Older rows may predate the FY column being populated.
  st.all.forEach(function (t) { if (!t.fy && t.createdAt) t.fy = fyOf(t.createdAt); });

  buildFyOptions();

  ui.els('[data-filter] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-filter] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.type = b.dataset.type;
      paint();
    });
  });

  ui.on('[data-csv]', 'click', exportCsv);
  paint();
})();
