/**
 * Portfolio.
 *
 * The Wallet answers "what do I hold"; this page answers "what is it worth, and
 * what would I keep if I left". Total value = cash + the live value of the ARV
 * holding, split by how much of the portfolio each side is. The performance
 * chart carries the user's own average-cost line, the P&L cards frame the gain
 * against its tax, and "if you sold everything now" prices a full exit against
 * the live NAV. Nothing here needs an endpoint the Wallet does not already use:
 * it reads api.me() (the wallet object) and api.snapshot(), and prices an exit
 * with api.quoteSell() exactly as the Wallet did.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  user: null,
  snap: null,
  range: null,
  chart: null,
  series: null,
  costLine: null,
  candles: []
};

/* ---------------------------------------------------------------- portfolio -- */

function paintPortfolio() {
  var u = st.user;
  if (!u) return;
  var w = u.wallet;

  ui.setText('[data-greeting]',
    (u.fullName ? u.fullName.split(' ')[0] + '\u2019s portfolio' : 'Portfolio'));

  if (!w) return;

  // Cash is the free balance plus anything held in open orders; ARV value is the
  // live valuation of the whole holding. Together they are the portfolio.
  var cashPaise = (w.inrPaise || 0) + (w.inrLockedPaise || 0);
  var arvPaise = w.valuePaise || 0;
  var totalPaise = cashPaise + arvPaise;

  ui.setText('[data-total]', ui.fmtPaise(totalPaise));
  ui.setText('[data-cash]', ui.fmtPaise(cashPaise));
  ui.setText('[data-arv-value]', ui.fmtPaise(arvPaise));
  ui.setText('[data-units]', ui.fmtUnits(w.arvTotalUnits, 4));

  var cashPct = totalPaise > 0 ? (cashPaise / totalPaise) * 100 : 0;
  var arvPct = totalPaise > 0 ? (arvPaise / totalPaise) * 100 : 0;
  ui.setText('[data-cash-pct]', ui.fmtPct(cashPct, 1));
  ui.setText('[data-arv-pct]', ui.fmtPct(arvPct, 1));

  if (w.inrLockedPaise > 0) {
    var cl = ui.el('[data-cash-locked]');
    if (cl) { cl.classList.remove('hidden'); cl.textContent = '\u00b7 ' + ui.fmtPaise(w.inrLockedPaise) + ' in open orders'; }
  }
  if (parseFloat(w.arvLockedUnits) > 0) {
    var lu = ui.el('[data-units-locked]');
    if (lu) { lu.classList.remove('hidden'); lu.textContent = '\u00b7 ' + ui.fmtUnits(w.arvLockedUnits, 4) + ' in open orders'; }
  }

  // P&L cards.
  ui.setText('[data-invested]', ui.fmtPaise(w.investedPaise));
  ui.setText('[data-avg-cost]', w.avgCostNav > 0 ? ui.fmtPrice(w.avgCostNav) : '\u2014');
  ui.paintSigned('[data-unrealised]', w.unrealisedPaise, { base: 'stat-v' });
  ui.paintChange('[data-unrealised-pct]', w.unrealisedPct);
  ui.paintSigned('[data-realised]', w.realisedPaise, { base: 'stat-v' });
}

function paintPaused() {
  var p = st.snap && st.snap.price;
  var f = st.snap && st.snap.feed;
  var box = ui.el('[data-paused-notice]');
  if (!box) return;

  var paused = !p || p.nav == null || p.stale;
  box.classList.toggle('hidden', !paused);
  if (paused) {
    ui.setText('[data-paused-reason]', (f && f.note) || 'The price feed is not current.');
  }
}

/* ------------------------------------------------------------------ what-if -- */

/**
 * The full cost of exiting, computed from the live price.
 *
 * Uses the same percentages the server charges. It is an estimate only because
 * the price moves between here and a fill \u2014 which the note says rather than
 * implying a guarantee. Also feeds the "Exit after tax" card.
 */
async function paintWhatIf() {
  var host = ui.el('[data-whatif]');
  var w = st.user && st.user.wallet;
  var units = w ? parseFloat(w.arvTotalUnits) : 0;

  if (!units) {
    if (host) {
      host.innerHTML = '<div class="ledger-row"><span class="l muted">'
        + 'You hold no units yet. <a href="trade.html">Buy ARV</a></span></div>';
    }
    ui.setText('[data-exit-net]', '\u2014');
    return;
  }

  try {
    // Ask the server: it applies the user's own tier fees, their PAN status and
    // their financial-year TDS position, none of which the browser should guess.
    var r = await api.quoteSell(parseFloat(w.arvUnits) || units);
    var q = r.quote;

    ui.setText('[data-exit-net]', ui.fmtPaise(q.balanceTaxPaise));

    if (!host) return;

    host.innerHTML = rows([
      ['Gross value', q.grossPaise, 'gross'],
      ['Exit fee + GST', -(q.feePaise + q.gstPaise), 'charge'],
      ['TDS withheld' + (q.tds && q.tds.applies ? ' (' + q.tds.ratePct + '%)' : ''),
       -q.tdsPaise, 'tds', q.tds ? q.tds.reason : null],
      ['Credited to rupees', q.netPayoutPaise, 'net'],
      [null],
      ['Cost of acquisition', q.costBasisPaise, 'info'],
      [q.pnlPaise >= 0 ? 'Realised gain' : 'Realised loss', q.pnlPaise, 'pnl'],
      ['Tax at ' + q.effectiveTaxPct.toFixed(1) + '%', q.totalTaxPaise, 'liability',
       'Not withheld \u2014 payable by you when you file'],
      ['Balance at filing', q.balanceTaxPaise, 'liability-total']
    ]);

    if (q.lossNotSetOff) {
      host.insertAdjacentHTML('beforeend',
        '<div class="ledger-row k-warning"><span class="note">This loss could not be set '
        + 'off against other gains or carried forward \u2014 section 115BBH permits neither.'
        + '</span></div>');
    }
  } catch (e) {
    ui.setText('[data-exit-net]', '\u2014');
    if (host) {
      host.innerHTML = '<div class="ledger-row"><span class="l muted">'
        + ui.esc(e.message || 'Cannot price a sale right now.') + '</span></div>';
    }
  }

  function rows(list) {
    return list.map(function (r) {
      if (!r[0]) return '<div class="ledger-divider"></div>';
      var neg = r[1] < 0;
      return '<div class="ledger-row k-' + (r[2] || 'info') + '">'
        + '<span class="l">' + ui.esc(r[0]) + '</span>'
        + '<span class="a">' + (neg ? '\u2212' : '') + ui.fmtPaise(Math.abs(r[1] || 0)) + '</span>'
        + (r[3] ? '<span class="note">' + ui.esc(r[3]) + '</span>' : '')
        + '</div>';
    }).join('');
  }
}

/* -------------------------------------------------------------------- chart -- */

function buildRangeTabs() {
  var host = ui.el('[data-range-tabs]');
  if (!host) return;
  var ranges = CFG.CHARTS.ranges || [];
  st.range = ranges.find(function (r) { return r.label === CFG.CHARTS.defaultRange; }) || ranges[0];

  host.innerHTML = ranges.map(function (r) {
    return '<button class="tab' + (r === st.range ? ' on' : '') + '" data-range="' + r.label + '">'
      + r.label + '</button>';
  }).join('');

  ui.els('[data-range-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-range-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.range = ranges.find(function (r) { return r.label === b.dataset.range; });
      loadChart();
    });
  });
}

async function loadChart() {
  var host = ui.el('[data-chart]');
  if (!host || !globalThis.LightweightCharts || !st.range) return;

  try {
    var r = await api.candles(st.range.tf, st.range.days, CFG.CHARTS.maxCandles);
    st.candles = r.candles || [];

    ui.setText('[data-candle-count]', st.candles.length
      ? st.candles.length + ' candles \u00b7 ' + st.range.tf
      : 'no candles for this range');

    if (!st.candles.length) return;

    var L = globalThis.LightweightCharts;

    if (!st.chart) {
      st.chart = L.createChart(host, {
        width: host.clientWidth,
        height: host.clientHeight || 430,
        layout: { background: { type: 'solid', color: 'transparent' },
                  textColor: '#5d636f', fontSize: 10,
                  fontFamily: "'JetBrains Mono',ui-monospace,monospace" },
        grid: { vertLines: { color: 'rgba(255,255,255,.025)' },
                horzLines: { color: 'rgba(255,255,255,.03)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,.07)',
                           scaleMargins: { top: .12, bottom: .1 } },
        timeScale: { borderColor: 'rgba(255,255,255,.07)', timeVisible: true, rightOffset: 4 },
        crosshair: { mode: L.CrosshairMode.Normal,
                     vertLine: { color: 'rgba(185,190,201,.35)', style: L.LineStyle.Dashed,
                                 labelBackgroundColor: '#24242e' },
                     horzLine: { color: 'rgba(185,190,201,.35)', style: L.LineStyle.Dashed,
                                 labelBackgroundColor: '#24242e' } },
        localization: {
          locale: CFG.UI.locale,
          priceFormatter: function (p) { return p.toFixed(CFG.INDEX.priceDecimals); }
        }
      });

      st.series = st.chart.addAreaSeries({
        lineColor: '#dfe2e9',
        topColor: 'rgba(223,226,233,.18)',
        bottomColor: 'rgba(223,226,233,.01)',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: CFG.INDEX.priceDecimals, minMove: 0.0001 }
      });

      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function (e) {
          var w = e[0] && e[0].contentRect.width;
          if (w > 0) st.chart.applyOptions({ width: w });
        }).observe(host);
      }
    }

    st.series.setData(st.candles.map(function (k) {
      return { time: Math.floor(k.t / 1000), value: k.c };
    }));

    // The user's own average cost. Seeing your entry against the current price is
    // the single most useful annotation on a portfolio chart.
    var w = st.user && st.user.wallet;
    if (st.costLine) { try { st.series.removePriceLine(st.costLine); } catch (_) {} st.costLine = null; }
    if (w && w.avgCostNav > 0) {
      st.costLine = st.series.createPriceLine({
        price: w.avgCostNav,
        color: 'rgba(224,176,85,.75)',
        lineWidth: 1,
        lineStyle: L.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'your cost'
      });
    } else {
      ui.setText('[data-cost-line-note]', 'Buy ARV and your average cost appears here');
    }

    st.chart.timeScale().fitContent();
  } catch (e) {
    ui.setText('[data-candle-count]', 'chart unavailable');
  }
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  buildRangeTabs();

  await ui.boot({ feed: false });
  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  st.snap = await api.snapshot().catch(function () { return null; });
  paintPortfolio();
  paintPaused();
  ui.paintNavTicker(st.snap);
  ui.paintServerFeed(st.snap);

  await loadChart();
  paintWhatIf();

  // The index is recomputed once a minute, so polling matches that.
  api.poll(async function () {
    st.snap = await api.snapshot();
    st.user = await api.me(true);
    paintPortfolio();
    paintPaused();
    ui.paintNavTicker(st.snap);
    ui.paintServerFeed(st.snap);
    paintWhatIf();
  }, 30000);
})();
