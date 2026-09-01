/**
 * Portfolio dashboard.
 *
 * The "if you redeemed everything now" panel is the reason this page exists in
 * this shape. A dashboard that shows a large green unrealised gain and nothing
 * else trains the wrong expectation: on virtual digital assets, 31.2% of that
 * gain is owed the moment it is realised, fees come off the top, and losses
 * elsewhere cannot be used to reduce it. So the tax consequence sits beside the
 * gain rather than being discovered later.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as engine from '../index-engine.js';
import * as chart from '../chart.js';
import * as db from '../db.js';
import * as ledger from '../ledger.js';
import { fmtPrice, fmtPaise, fmtPct, fmtUnits, fmtBig, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  tf: '1D', api: null, candles: [], live: null, lastPrice: null,
  holdings: null, lots: [], txns: []
};

/* ---------------------------------------------------------------- headline -- */

function paint() {
  var nav = engine.currentArv();
  if (nav == null || !st.holdings) return;

  var p = ledger.position(st.holdings, nav);

  ui.setText('[data-value]', fmtPaise(p.valuePaise));
  ui.setText('[data-units]', fmtUnits(p.units));
  ui.setText('[data-invested]', fmtPaise(p.investedPaise));
  ui.setText('[data-avg-cost]', p.avgCostNav > 0 ? fmtPrice(p.avgCostNav) : '\u2014');

  var pnlEl = document.querySelector('[data-pnl]');
  if (pnlEl) {
    pnlEl.textContent = (p.unrealisedPnlPaise >= 0 ? '+' : '\u2212') +
      fmtPaise(Math.abs(p.unrealisedPnlPaise));
    pnlEl.className = 'stat-v ' + direction(p.unrealisedPnlPaise);
  }
  ui.paintChange(document.querySelector('[data-pnl-pct]'), p.unrealisedPnlPct);

  ui.paintPrice(document.querySelector('[data-price]'), nav, st.lastPrice);
  st.lastPrice = nav;

  var lp = engine.changeSinceLaunch(nav);
  var lEl = document.querySelector('[data-launch]');
  if (lEl && lp != null) {
    lEl.textContent = fmtPct(lp);
    lEl.className = direction(lp);
  }

  paintWhatIf(nav, p);
  paintAllocation(nav, p);
}

/* ------------------------------------------------------------- what-if ----- */

function paintWhatIf(nav, pos) {
  var host = document.querySelector('[data-what-if]');
  if (!host) return;

  if (!pos.units) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">' +
      'You hold no units yet.</span></div>';
    return;
  }

  var q = ledger.quoteSell(pos.units, nav, st.lots, {
    hasPan: st.profileHasPan,
    isSpecifiedPerson: st.profileSpecified,
    fyGrossProceedsPaise: st.fyGross || 0,
    availableUnits: pos.units
  });

  var rows = [
    { l: 'Gross value', a: q.grossPaise, k: 'gross' },
    { l: 'Exit fee + GST', a: -(q.feePaise + q.gstPaise), k: 'charge' },
    { l: 'TDS withheld' + (q.tds.applies ? ' (' + q.tds.ratePct + '%)' : ''), a: -q.tdsPaise, k: 'tds' },
    { l: 'Credited to UPI', a: q.netPayoutPaise, k: 'net' },
    { div: true },
    { l: 'Cost of acquisition', a: q.costBasisPaise, k: 'info' },
    { l: q.pnlPaise >= 0 ? 'Realised gain' : 'Realised loss', a: q.pnlPaise, k: 'pnl' },
    { l: 'Tax at ' + q.effectiveTaxRatePct.toFixed(1) + '%', a: q.totalTaxLiabilityPaise, k: 'liability' },
    { l: 'Balance payable at filing', a: q.balanceTaxPayablePaise, k: 'liability-total' },
    { l: 'Net after tax', a: q.netAfterTaxPaise, k: 'net' }
  ];

  host.innerHTML = rows.map(function (r) {
    if (r.div) return '<div class="ledger-divider"></div>';
    var neg = r.a < 0;
    return '<div class="ledger-row k-' + r.k + '">' +
      '<span class="l">' + ui.esc(r.l) + '</span>' +
      '<span class="a">' + (neg ? '\u2212' : '') + fmtPaise(Math.abs(r.a)) + '</span>' +
    '</div>';
  }).join('') +
  (q.lossNotSetOff
    ? '<div class="ledger-row k-warning"><span class="note">This loss could not be ' +
      'set off against other gains or carried forward \u2014 section 115BBH permits ' +
      'neither.</span></div>'
    : '');
}

/* ----------------------------------------------------------- allocation ---- */

/**
 * What actually backs the units. With a single-asset basket this is one bar, but
 * it states plainly what the treasury holds against the units outstanding —
 * which is the honest version of an "allocation" panel.
 */
function paintAllocation(nav, pos) {
  var host = document.querySelector('[data-allocation]');
  if (!host) return;

  host.innerHTML = CFG.BASKET.map(function (a) {
    var pct = a.weight * 100;
    var quote = engine.currentQuotePrice(a.key);
    return '<div style="margin-bottom:var(--sp-4)">' +
      '<div class="row-between" style="margin-bottom:6px">' +
        '<span class="row" style="gap:7px">' +
          '<span style="width:9px;height:9px;border-radius:2px;background:' + a.colour + '"></span>' +
          '<strong>' + ui.esc(a.name) + '</strong>' +
        '</span>' +
        '<span class="num strong">' + pct.toFixed(0) + '%</span>' +
      '</div>' +
      '<div style="height:6px;border-radius:3px;background:var(--bg-3);overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:' + a.colour + '"></div>' +
      '</div>' +
      '<div class="tiny muted" style="margin-top:6px">' +
        (quote != null ? fmtBig(quote) + ' \u00b7 ' : '') +
        'your share ' + fmtPaise(Math.round(pos.valuePaise * a.weight)) +
      '</div>' +
    '</div>';
  }).join('') +
  (CFG.WATCHLIST.length
    ? '<div class="tiny muted" style="padding-top:var(--sp-2);border-top:1px solid var(--glass-brd)">' +
      CFG.WATCHLIST.map(function (w) { return w.name; }).join(' and ') +
      ' carry zero weight and back none of your units.</div>'
    : '');
}

/* ---------------------------------------------------------------- tables --- */

function paintTxns() {
  var host = document.querySelector('[data-txns]');
  if (!host) return;

  if (!st.txns.length) {
    host.innerHTML = '<tr><td colspan="6"><div class="empty">' +
      '<div class="icon">\u25ca</div>No transactions yet.<br>' +
      '<a href="buy.html">Make your first deposit</a></div></td></tr>';
    return;
  }

  host.innerHTML = st.txns.slice(0, 8).map(function (t) {
    var isBuy = t.type === 'deposit';
    var amount = isBuy ? t.grossPaise : t.netPaise;
    return '<tr>' +
      '<td class="tiny">' + ui.fmtTime(t.createdAt, true) + '</td>' +
      '<td><span class="badge ' + (isBuy ? 'info' : 'warn') + '">' +
        (isBuy ? 'Buy' : 'Redeem') + '</span></td>' +
      '<td class="num">' + fmtUnits(t.units) + '</td>' +
      '<td class="num">' + (t.nav ? fmtPrice(t.nav) : '\u2014') + '</td>' +
      '<td class="num">' + fmtPaise(amount) + '</td>' +
      '<td>' + statusBadge(t.status) + '</td>' +
    '</tr>';
  }).join('');
}

function statusBadge(s) {
  var map = {
    settled: 'ok', confirmed: 'ok', pending: 'warn',
    awaiting_payment: 'warn', failed: 'bad', cancelled: 'bad'
  };
  var label = s === 'awaiting_payment' ? 'awaiting payment' : s;
  return '<span class="badge ' + (map[s] || '') + '">' + ui.esc(label) + '</span>';
}

function paintLots() {
  var host = document.querySelector('[data-lots]');
  if (!host) return;

  if (!st.lots.length) {
    host.innerHTML = '<tr><td colspan="3" class="empty">No open lots.</td></tr>';
    return;
  }

  host.innerHTML = st.lots.map(function (l, i) {
    return '<tr>' +
      '<td class="tiny">' + ui.fmtDate(l.acquiredAt) +
        (i === 0 ? ' <span class="badge warn">next</span>' : '') + '</td>' +
      '<td class="num">' + fmtUnits(l.unitsRemaining) + '</td>' +
      '<td class="num">' + fmtPrice(l.nav) + '</td>' +
    '</tr>';
  }).join('');
}

/* ----------------------------------------------------------------- chart --- */

async function loadChart() {
  var el = document.querySelector('[data-chart]');
  if (!el) return;
  chart.overlay(el, '<span class="spinner"></span>');

  try {
    var res = await engine.arvSeries(st.tf === '1W' ? '4h' : (st.tf === '1h' ? '5m' : '1h'), {
      days: st.tf === '1h' ? 1 : (st.tf === '1D' ? 7 : 60)
    });
    st.candles = res.candles;
    if (!st.candles.length) { chart.overlay(el, 'No price history.'); return; }

    if (st.api) chart.destroy(st.api);
    st.api = chart.create(el, { priceKind: 'arv' });
    chart.addArea(st.api, {});
    chart.setArea(st.api, st.candles);

    if (st.holdings && st.holdings.units > 0 && st.holdings.investedPaise > 0) {
      chart.addPriceLine(st.api, {
        price: (st.holdings.investedPaise / 100) / st.holdings.units,
        colour: 'rgba(245,165,36,0.8)',
        title: 'your cost'
      });
    }
    chart.addPriceLine(st.api, {
      price: CFG.INDEX.arvBaseInr, colour: 'rgba(185,195,214,0.3)', title: '\u20b91'
    });

    chart.fit(st.api);
    chart.overlay(el, null);
    st.live = engine.createLiveCandle(st.tf === '1h' ? '5m' : '1h', st.candles[st.candles.length - 1]);
  } catch (e) {
    chart.overlay(el, 'Price history unavailable.');
  }
}

/* ------------------------------------------------------------------- boot -- */

(async function () {
  var res = await ui.boot();
  var user = await db.requireUser();
  if (!user) return;

  ui.setText('[data-mode-note]',
    db.mode() === 'local'
      ? 'Stored in this browser \u2014 configure Supabase in arv-config.js to persist across devices'
      : 'Signed in as ' + (user.email || ''));

  ui.els('[data-tf-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-tf-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.tf = b.dataset.tf;
      loadChart();
    });
  });

  try {
    var profile = await db.getProfile();
    st.profileHasPan = !!(profile && profile.pan);
    st.profileSpecified = !!(profile && profile.isSpecifiedPerson);
  } catch (_) {}

  try {
    st.holdings = await db.getHoldings();
    st.lots = await db.getLots();
    st.txns = await db.getTransactions({ limit: 20 });
    st.fyGross = await db.fyGrossProceeds();
  } catch (e) {
    ui.toastError(e);
    st.holdings = { units: 0, investedPaise: 0, realisedGainPaise: 0 };
  }

  paintTxns();
  paintLots();
  await loadChart();
  paint();

  feed.onTick(function () {
    paint();
    var nav = engine.currentArv();
    if (st.live && st.api && nav != null) {
      var r = st.live.push(nav);
      if (r.candle) chart.updateArea(st.api, r.candle);
    }
  });
})();
