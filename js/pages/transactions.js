/**
 * History.
 *
 * Reads the ledger, not the orders and deposits tables. The ledger is the book of
 * record and the wallet is a cached total of it; a history page assembled from
 * the source tables could disagree with the balance printed next to it, and the
 * user would have no way to know which one to believe.
 *
 * Paging is by id cursor rather than page number. Entries land on top while
 * someone is reading, so an offset-based "page 2" would quietly skip or repeat
 * rows. The cursor cannot.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var st = {
  group: '',
  fy: '',
  view: 'ledger',
  rows: [],
  cursor: null,
  hasMore: false,
  trades: null,
  loading: false
};

/* ------------------------------------------------------------------ labels -- */

// What each ledger kind actually was, in the words a holder would use.
var KIND = {
  deposit:             { label: 'Deposit',            cls: 'up' },
  withdrawal:          { label: 'Withdrawal',         cls: 'down' },
  buy:                 { label: 'Bought ARV',         cls: '' },
  sell:                { label: 'Sold ARV',           cls: '' },
  fee:                 { label: 'Platform fee',       cls: 'down' },
  gst:                 { label: 'GST on the fee',     cls: 'down' },
  tds:                 { label: 'TDS withheld',       cls: 'down' },
  referral_commission: { label: 'Referral commission', cls: 'up' },
  adjustment:          { label: 'Adjustment',         cls: '' },
  reversal:            { label: 'Reversal',           cls: '' }
};

function kindOf(k) {
  return KIND[k] || { label: k, cls: '' };
}

/* ------------------------------------------------------------------ totals -- */

function paintTotals(t) {
  if (!t) return;

  ui.setText('[data-in]', ui.fmtPaise(t.inInPaise || 0));
  ui.setText('[data-out]', ui.fmtPaise(Math.abs(t.inOutPaise || 0)));

  var net = ui.el('[data-net]');
  net.textContent = (t.netPaise > 0 ? '+' : (t.netPaise < 0 ? '\u2212' : ''))
                  + ui.fmtPaise(Math.abs(t.netPaise || 0));
  net.className = 'stat-v ' + ui.direction(t.netPaise);

  // From the server's trade totals, not by adding up the fee rows below. Those
  // rows carry a zero delta by design — the charge is already inside the net buy
  // or sell figure beside them — so summing them would report ₹0.00 to someone who
  // has clearly paid fees.
  ui.setText('[data-charges]', ui.fmtPaise(t.chargesPaise || 0));
  ui.setText('[data-charges-sub]', t.tdsPaise
    ? ui.fmtPaise(t.feesPaise) + ' in fees and GST, ' + ui.fmtPaise(t.tdsPaise) + ' TDS'
    : 'fees and GST — no TDS yet');

  ui.setText('[data-scope]',
    (st.fy ? 'FY ' + st.fy : 'all time')
    + (st.group ? ' \u00b7 ' + st.group : ''));
}

/* ------------------------------------------------------------------ ledger -- */

function paintRows() {
  var host = ui.el('[data-rows]');

  if (!st.rows.length) {
    host.innerHTML = '<div class="empty"><div class="icon">\u25cb</div>'
      + 'Nothing here yet'
      + (st.group || st.fy ? ' for this filter.' : '. Once you deposit, it starts filling up.')
      + '</div>';
    return;
  }

  host.innerHTML =
    '<table class="data"><thead><tr>'
      + '<th>When</th><th>What</th><th class="right">Rupees</th>'
      + '<th class="right">ARV</th><th class="right">Price</th>'
      + '<th>Reference</th>'
    + '</tr></thead><tbody>'
    + st.rows.map(function (r) {
      var k = kindOf(r.kind);
      var units = parseFloat(r.units || '0');
      var inr = r.inrPaise || 0;

      return '<tr>'
        + '<td class="muted nowrap">' + ui.fmtTime(r.at, true) + '</td>'
        + '<td><span class="strong">' + ui.esc(k.label) + '</span>'
          + (r.note ? '<br><span class="tiny muted">' + ui.esc(r.note) + '</span>' : '')
        + '</td>'
        // A charge row has no delta of its own — it is already inside the net buy
        // or sell figure. Saying so beats a bare dash, which reads as missing data.
        + '<td class="right num ' + ui.direction(inr) + '">'
          + (inr ? (inr > 0 ? '+' : '\u2212') + ui.fmtPaise(Math.abs(inr))
                 : (r.group === 'charges'
                     ? '<span class="tiny muted nowrap">in the net</span>'
                     : '\u2014'))
        + '</td>'
        + '<td class="right num ' + ui.direction(units) + '">'
          + (units ? (units > 0 ? '+' : '\u2212') + ui.fmtUnits(Math.abs(units), 4) : '\u2014')
        + '</td>'
        + '<td class="right num muted">' + (r.nav != null ? ui.fmtPrice(r.nav) : '\u2014') + '</td>'
        + '<td class="num tiny muted">' + ui.esc(r.ref || '\u2014') + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';
}

async function load(reset) {
  if (st.loading) return;
  st.loading = true;

  if (reset) {
    st.rows = [];
    st.cursor = null;
    ui.el('[data-rows]').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  }

  var btn = ui.el('[data-more]');
  if (!reset) ui.busy(btn, true, 'Loading\u2026');

  try {
    var r = await api.ledger({
      limit: 100,
      before: st.cursor || undefined,
      fy: st.fy || undefined,
      group: st.group || undefined
    });

    st.rows = st.rows.concat(r.rows || []);
    st.cursor = r.nextCursor;
    st.hasMore = !!r.hasMore;

    paintRows();
    paintTotals(r.totals);

    btn.classList.toggle('hidden', !st.hasMore);
    ui.el('[data-end]').classList.toggle('hidden', st.hasMore || !st.rows.length);
  } catch (e) {
    ui.toastError(e);
    if (reset) {
      ui.el('[data-rows]').innerHTML =
        '<div class="empty">Could not load your history. '
        + ui.esc(e.message || '') + '</div>';
    }
  } finally {
    ui.busy(btn, false);
    st.loading = false;
  }
}

/* ------------------------------------------------------------------- fills -- */

async function loadTrades() {
  if (st.trades) {
    paintTrades();
    return;
  }

  try {
    var r = await api.myTrades(200);
    st.trades = r.trades || [];
  } catch (e) {
    ui.el('[data-trades]').innerHTML =
      '<div class="empty">Could not load your fills. ' + ui.esc(e.message || '') + '</div>';
    return;
  }
  paintTrades();
}

/**
 * Fills for the selected year.
 *
 * The year filter applies to both views, so the fills tab honours it too rather
 * than showing a different period from the one selected above it.
 */
function visibleTrades() {
  var rows = st.trades || [];
  return st.fy ? rows.filter(function (t) { return t.fy === st.fy; }) : rows;
}

function paintTrades() {
  var host = ui.el('[data-trades]');
  var rows = visibleTrades();

  if (!rows.length) {
    host.innerHTML = '<div class="empty"><div class="icon">\u25cb</div>'
      + 'No fills yet. <a href="trade.html" class="arrow">Place an order</a></div>';
    return;
  }

  host.innerHTML =
    '<table class="data"><thead><tr>'
      + '<th>When</th><th>Side</th><th class="right">Units</th><th class="right">Price</th>'
      + '<th class="right">Gross</th><th class="right">Charges</th>'
      + '<th class="right">Cost basis</th><th class="right">Gain</th>'
      + '<th>Counterparty</th>'
    + '</tr></thead><tbody>'
    + rows.map(function (t) {
      var charges = (t.feePaise || 0) + (t.gstPaise || 0) + (t.tdsPaise || 0);
      return '<tr>'
        + '<td class="muted nowrap">' + ui.fmtTime(t.at, true) + '</td>'
        + '<td><span class="badge ' + (t.side === 'buy' ? 'ok' : 'info') + '">'
          + t.side + '</span></td>'
        + '<td class="right num">' + ui.fmtUnits(t.units, 4) + '</td>'
        + '<td class="right num">' + ui.fmtPrice(t.nav) + '</td>'
        + '<td class="right num">' + ui.fmtPaise(t.grossPaise) + '</td>'
        + '<td class="right num down">' + (charges ? ui.fmtPaise(charges) : '\u2014') + '</td>'
        + '<td class="right num muted">'
          + (t.costBasisPaise != null ? ui.fmtPaise(t.costBasisPaise) : '\u2014') + '</td>'
        + '<td class="right num ' + ui.direction(t.pnlPaise) + '">'
          + (t.pnlPaise != null
              ? (t.pnlPaise >= 0 ? '+' : '\u2212') + ui.fmtPaise(Math.abs(t.pnlPaise))
              : '\u2014')
        + '</td>'
        + '<td class="tiny muted">' + ui.esc(t.counterparty) + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';
}

/* --------------------------------------------------------------------- csv -- */

function exportCsv() {
  if (st.view === 'trades') {
    var t = visibleTrades();
    if (!t.length) return ui.toast('Nothing to export yet.', 'warn');
    return ui.downloadCsv('arv-fills' + (st.fy ? '-' + st.fy : '') + '.csv', [
      ['When', 'Side', 'Units', 'Price (INR)', 'Gross (INR)', 'Fee', 'GST', 'TDS',
       'Cost basis', 'Gain', 'Counterparty', 'FY', 'Reference']
    ].concat(t.map(function (x) {
      return [x.at, x.side, x.units, x.nav, (x.grossPaise / 100).toFixed(2),
              (x.feePaise / 100).toFixed(2), (x.gstPaise / 100).toFixed(2),
              (x.tdsPaise / 100).toFixed(2),
              x.costBasisPaise != null ? (x.costBasisPaise / 100).toFixed(2) : '',
              x.pnlPaise != null ? (x.pnlPaise / 100).toFixed(2) : '',
              x.counterparty, x.fy, x.ref];
    })));
  }

  if (!st.rows.length) return ui.toast('Nothing to export yet.', 'warn');

  // Only what has been loaded is exported, and the filename says which slice it
  // is — a file silently containing the first 100 rows of a longer history would
  // be worse than no file.
  ui.downloadCsv('arv-history' + (st.fy ? '-' + st.fy : '') + '.csv', [
    ['When', 'Kind', 'Rupees', 'ARV units', 'Price (INR)', 'Reference', 'Note', 'FY']
  ].concat(st.rows.map(function (r) {
    return [r.at, kindOf(r.kind).label, (r.inrPaise / 100).toFixed(2), r.units,
            r.nav != null ? r.nav : '', r.ref, r.note, r.fy];
  })));

  if (st.hasMore) {
    ui.toast('Exported the ' + st.rows.length + ' entries loaded so far. '
           + 'Load older entries first for the full year.', 'info', 7000);
  }
}

/* -------------------------------------------------------------------- boot -- */

function setView(v) {
  st.view = v;
  ui.els('[data-views] .tab').forEach(function (b) {
    b.classList.toggle('on', b.dataset.view === v);
  });
  ui.el('[data-pane="ledger"]').classList.toggle('hidden', v !== 'ledger');
  ui.el('[data-pane="trades"]').classList.toggle('hidden', v !== 'trades');
  ui.el('[data-groups]').classList.toggle('hidden', v !== 'ledger');
  if (v === 'trades') loadTrades();
}

(async function () {
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;

  // Year list first, so the dropdown is populated before the first fetch and the
  // page does not visibly reflow when it arrives.
  try {
    var y = await api.financialYears();
    ui.el('[data-fy]').innerHTML =
      '<option value="">All time</option>'
      + (y.years || []).map(function (f) {
          return '<option value="' + f + '">FY ' + f + '</option>';
        }).join('');
  } catch (_) {
    ui.el('[data-fy]').innerHTML = '<option value="">All time</option>';
  }

  await load(true);

  ui.els('[data-groups] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-groups] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.group = b.dataset.group;
      load(true);
    });
  });

  ui.els('[data-views] .tab').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });

  ui.on('[data-fy]', 'change', function (e) {
    st.fy = e.target.value;
    // Fills are already all in memory, so the year change is a repaint rather
    // than another round trip.
    if (st.view === 'trades') loadTrades();
    load(true);
  });

  ui.on('[data-more]', 'click', function () { load(false); });
  ui.on('[data-csv]', 'click', exportCsv);
})();
