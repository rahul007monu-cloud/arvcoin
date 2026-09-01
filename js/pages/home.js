/**
 * Landing page.
 *
 * Everything on this page is computed from live data — the price, the mini
 * chart, the fee worked example and the watchlist. Nothing is a screenshot or a
 * hardcoded figure, so what a visitor reads here is what the buy screen will
 * quote them a moment later.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as fx from '../fx.js';
import * as engine from '../index-engine.js';
import * as chart from '../chart.js';
import * as ledger from '../ledger.js';
import { fmtPrice, fmtPct, fmtBig, fmtPaise, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  tf: '1D',
  chartApi: null,
  candles: [],
  live: null,
  lastPrice: null
};

var WINDOW_HOURS = { '1h': 1, '1D': 24, '1W': 168 };

/* ------------------------------------------------------------------ static -- */

function paintStatic() {
  var launch = new Date(CFG.INDEX.launchMs);
  ui.setText('[data-launch-date]', launch.toLocaleDateString(CFG.UI.locale, {
    day: 'numeric', month: 'long', year: 'numeric'
  }));

  ui.setText('[data-index-quote]', 'Quoted in ' + (CFG.INDEX.quote === 'INR' ? '\u20b9' : '$'));

  var baseInr = engine.quoteBase('BTC');
  ui.setText('[data-base-inr]', fmtBig(baseInr));
  ui.setText('[data-base-usd]', '$' + CFG.INDEX.baseUsd.BTC.toLocaleString('en-US'));
  ui.setText('[data-base-fx]', CFG.INDEX.baseFxUsdInr.toFixed(2));
}

/* ------------------------------------------------------------------- price -- */

function paintPrice() {
  var arv = engine.currentArv();
  if (arv == null) return;

  ui.paintPrice(document.querySelector('[data-hero-price]'), arv, st.lastPrice);
  st.lastPrice = arv;

  // Window change comes from the candle series; since-launch is definitional.
  var stats = st.candles.length ? engine.stats(st.candles, WINDOW_HOURS[st.tf]) : null;
  if (stats) ui.paintChange(document.querySelector('[data-hero-change]'), stats.changePct);

  var launchPct = engine.changeSinceLaunch(arv);
  var lEl = document.querySelector('[data-hero-launch]');
  if (lEl && launchPct != null) {
    lEl.textContent = fmtPct(launchPct);
    lEl.className = 'strong ' + direction(launchPct);
  }

  var btcUsd = feed.priceUsd('BTC');
  var btcInr = engine.currentQuotePrice('BTC');
  if (btcInr != null) ui.setText('[data-btc-inr]', fmtBig(btcInr));
  if (btcUsd != null) ui.setText('[data-btc-usd]', '$' + Math.round(btcUsd).toLocaleString('en-US'));

  // The multiplier that turns launch Bitcoin into today's — identical to ARV's
  // own price, which is the point being made.
  var base = engine.quoteBase('BTC');
  if (btcInr != null && base) {
    ui.setText('[data-ratio]', (btcInr / base).toFixed(4) + '\u00d7');
  }

  var dot = document.querySelector('[data-hero-dot]');
  if (dot) {
    var s = feed.status();
    dot.className = 'live-dot ' + (s.live ? (s.stale ? 'stale' : '') : 'off');
  }
}

/* ------------------------------------------------------------------- chart -- */

async function loadChart() {
  var el = document.querySelector('[data-hero-chart]');
  if (!el || !globalThis.LightweightCharts) return;

  chart.overlay(el, 'Loading price history\u2026');

  try {
    var res = await engine.arvSeries(st.tf, { days: st.tf === '1W' ? null : undefined });
    st.candles = res.candles;

    if (!st.candles.length) {
      chart.overlay(el, 'No price history available for this timeframe.');
      return;
    }

    if (st.chartApi) chart.destroy(st.chartApi);
    st.chartApi = chart.create(el, { height: el.clientHeight || 260, priceKind: 'arv', showTimeScale: true });
    chart.addArea(st.chartApi, {});
    chart.setArea(st.chartApi, st.candles);

    // The launch level, so the whole chart reads against ₹1.
    chart.addPriceLine(st.chartApi, {
      price: CFG.INDEX.arvBaseInr,
      colour: 'rgba(185,195,214,0.35)',
      title: 'launch'
    });

    chart.fit(st.chartApi);
    chart.overlay(el, null);

    st.live = engine.createLiveCandle(st.tf, st.candles[st.candles.length - 1]);
    ui.setText('[data-hero-window]', st.tf === '1h' ? '1h' : (st.tf === '1D' ? '24h' : '7d'));
    paintPrice();
  } catch (e) {
    chart.overlay(el, 'Price history unavailable.<br><span class="tiny">' +
      ui.esc(e && e.message ? e.message : '') + '</span>');
  }
}

function bindTimeframes() {
  ui.els('[data-hero-tf] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-hero-tf] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.tf = b.dataset.tf;
      loadChart();
    });
  });
}

/* --------------------------------------------------------- worked examples -- */

function renderLedger(sel, rows) {
  var host = document.querySelector(sel);
  if (!host) return;

  host.innerHTML = rows.map(function (r) {
    if (r.divider) return '<div class="ledger-divider"></div>';
    var amt = r.paise != null
      ? '<span class="a ' + (r.paise < 0 ? '' : '') + '">' +
        (r.paise < 0 ? '\u2212' : '') + fmtPaise(Math.abs(r.paise)) + '</span>'
      : '';
    return '<div class="ledger-row k-' + (r.kind || 'info') + '">' +
             '<span class="l">' + ui.esc(r.label) + '</span>' + amt +
             (r.note ? '<span class="note">' + ui.esc(r.note) + '</span>' : '') +
           '</div>';
  }).join('');
}

function paintExamples() {
  var nav = engine.currentArv();
  if (!nav) return;

  // Deposit side.
  var b = ledger.quoteBuy(1000000, nav);
  renderLedger('[data-buy-example]', [
    { label: 'You pay', paise: b.grossPaise, kind: 'gross' },
    { label: 'Entry fee (' + CFG.FEES.entryPct + '%)', paise: -b.feePaise, kind: 'charge' },
    { label: 'GST on the fee (' + CFG.FEES.gstPct + '%)', paise: -b.gstPaise, kind: 'charge',
      note: 'GST applies to the fee only, never to the amount invested' },
    { label: 'Invested', paise: b.netInvestPaise, kind: 'net' },
    { divider: true },
    { label: 'Units issued at ' + fmtPrice(b.execNav), kind: 'info' },
    { label: 'Your cost per unit', kind: 'info',
      note: fmtPrice(b.effectiveNav) + ' once charges are included \u2014 ARV has to reach this before you are ahead' }
  ]);

  // Redemption side, on a +50% move.
  var lots = [{
    id: 'x', units: b.units, unitsRemaining: b.units,
    costPaise: b.netInvestPaise, nav: b.execNav, acquiredAt: Date.now()
  }];
  var s = ledger.quoteSell(b.units, nav * 1.5, lots, {
    hasPan: true, fyGrossProceedsPaise: 0, availableUnits: b.units
  });
  renderLedger('[data-sell-example]', ledger.explainSell(s));
}

/* --------------------------------------------------------------- watchlist -- */

async function loadWatchlist() {
  var host = document.querySelector('[data-watchlist]');
  if (!host) return;

  var assets = [{ key: 'ARV', name: 'ARV Coin', colour: '#6ee7ff', isArv: true }]
    .concat(CFG.WATCHLIST);

  host.innerHTML = assets.map(function (a) {
    return '<div class="card card-tight card-float" data-wl="' + a.key + '">' +
      '<div class="row-between" style="margin-bottom:var(--sp-3)">' +
        '<div class="row" style="gap:8px">' +
          '<span style="width:8px;height:8px;border-radius:2px;background:' + a.colour + '"></span>' +
          '<strong>' + ui.esc(a.name) + '</strong>' +
        '</div>' +
        (a.isArv ? '<span class="badge btc">tracked</span>'
                 : '<span class="badge">reference</span>') +
      '</div>' +
      '<div class="num strong" style="font-size:1.25rem" data-wl-price>\u2014</div>' +
      '<div class="row" style="margin-top:6px">' +
        '<span class="chip flat" data-wl-change>\u2014</span>' +
        '<span class="tiny muted">24h</span>' +
      '</div>' +
    '</div>';
  }).join('');

  // 24h change per asset, from daily candles.
  for (var i = 0; i < CFG.WATCHLIST.length; i++) {
    var a = CFG.WATCHLIST[i];
    try {
      var c = await feed.candles(a.key, '1h', { limit: 26 });
      var card = host.querySelector('[data-wl="' + a.key + '"]');
      if (!card || !c.length) continue;
      var open = c[0].o, last = c[c.length - 1].c;
      var pct = ((last - open) / open) * 100;
      card.querySelector('[data-wl-price]').textContent = '$' + last.toLocaleString('en-US', {
        maximumFractionDigits: last < 10 ? 2 : 0
      });
      ui.paintChange(card.querySelector('[data-wl-change]'), pct);
    } catch (_) { /* leave this card blank rather than failing the page */ }
  }
}

function paintWatchlistArv() {
  var host = document.querySelector('[data-watchlist]');
  if (!host) return;
  var card = host.querySelector('[data-wl="ARV"]');
  if (!card) return;
  var arv = engine.currentArv();
  if (arv == null) return;
  card.querySelector('[data-wl-price]').textContent = fmtPrice(arv);
  var s = st.candles.length ? engine.stats(st.candles, 24) : null;
  if (s) ui.paintChange(card.querySelector('[data-wl-change]'), s.changePct);
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  paintStatic();
  bindTimeframes();

  await ui.boot();

  await loadChart();
  paintExamples();
  loadWatchlist();

  // Live updates. The chart's in-progress candle is updated in place rather than
  // refetching, which is what makes the last bar visibly breathe.
  feed.onTick(function () {
    var arv = engine.currentArv();
    if (arv == null) return;

    paintPrice();
    paintWatchlistArv();

    if (st.live && st.chartApi) {
      var r = st.live.push(arv);
      if (r.candle) {
        chart.updateArea(st.chartApi, r.candle);
        if (r.closed) {
          st.candles.push(r.closed);
          if (st.candles.length > CFG.CHARTS.maxCandles) st.candles.shift();
        }
      }
    }
  });

  // Worked examples move with the market, but slowly — they are illustrative and
  // a figure that rewrites itself every second is unreadable.
  setInterval(paintExamples, 15000);

  // Reload the series when the timeframe's candles will have advanced.
  setInterval(function () {
    if (!document.hidden) loadChart();
  }, 5 * 60000);
})();
