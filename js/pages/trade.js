/**
 * Trade.
 *
 * Buy and sell, the order book, and the tape.
 *
 * Every quote comes from the server, not from arithmetic in the browser. The
 * client could compute a fee from config and it would usually agree — but "usually
 * agrees" is not good enough for a number somebody presses a button on. The
 * server knows the user's tier, their PAN status and their financial-year TDS
 * position, and it is the thing that will actually write the ledger.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';
import * as feed from '../feed.js';
import { TF_MINUTES } from '../feed.js';

var CFG = globalThis.ARV_CONFIG;

// The assets the chart can show. 'ARV' is the index itself (INR — the server
// derives its candles from BTC's asset_candles, scaled by the index formula);
// the rest are the tracked coins (USD, from asset_candles) and are display-only
// — selecting one never touches the order form or the money path.
var CHART_ASSETS = [
  { key: 'ARV', label: 'ARV' },
  { key: 'BTC', label: 'BTC' },
  { key: 'ETH', label: 'ETH' },
  { key: 'SOL', label: 'SOL' },
  { key: 'XRP', label: 'XRP' }
];

var st = {
  user: null,
  snap: null,
  side: 'buy',
  otype: 'market',
  asset: 'ARV',
  tf: CFG.CHARTS.defaultTimeframe,
  ctype: 'candles',
  chart: null,
  series: null,
  volume: null,
  candles: [],
  hovering: false,
  quote: null,
  quoteTimer: null,
  feed: null,
  // The last bar as {t(ms), o, h, l, c} kept in sync with the live feed so a tick
  // can extend it or roll a new one without touching the rest of the series.
  liveBar: null,
  unsubTick: null,
  feedStarted: false
};

/* ------------------------------------------------------------------ ticker -- */

function paintTicker() {
  var p = st.snap && st.snap.price;
  var s = st.snap && st.snap.stats;
  if (!p || p.nav == null) return;

  ui.setUsdInr(st.snap.index && st.snap.index.fxUsdInr);
  ui.paintPriceDual('[data-price]', p.nav, 'trade');
  ui.paintNavTicker(st.snap);

  if (s) {
    ui.paintChange('[data-change]', s.change24hPct);
    ui.setHtml('[data-high]', ui.fmtDual(s.high24h));
    ui.setHtml('[data-low]', ui.fmtDual(s.low24h));
    var l = ui.el('[data-launch]');
    l.textContent = ui.fmtPct(s.sinceLaunchPct);
    l.className = 'num ' + ui.direction(s.sinceLaunchPct);
  }

  var idx = st.snap.index || {};
  if (idx.btcInr != null) ui.setText('[data-btc]', ui.fmtBig(idx.btcInr));

  var dot = ui.el('[data-dot]');
  if (dot) dot.className = 'live-dot ' + (p.stale ? 'stale' : '');

  var paused = p.nav == null || p.stale;
  ui.el('[data-paused]').classList.toggle('hidden', !paused);
  if (paused) {
    ui.setText('[data-paused-reason]', (st.snap.feed && st.snap.feed.note) || '');
  }

  if (!st.hovering && st.candles.length) paintOhlc(st.candles[st.candles.length - 1]);
}

function paintOhlc(k) {
  var host = ui.el('[data-ohlc]');
  if (!host || !k) return;
  var up = k.c >= k.o;
  host.innerHTML =
    '<span>O <b>' + fmtAssetPrice(k.o) + '</b></span>'
    + '<span>H <b>' + fmtAssetPrice(k.h) + '</b></span>'
    + '<span>L <b>' + fmtAssetPrice(k.l) + '</b></span>'
    + '<span>C <b class="' + (up ? 'up' : 'down') + '">' + fmtAssetPrice(k.c) + '</b></span>';
}

/* ------------------------------------------------------------------- chart -- */

/** True when the chart is showing a tracked coin (USD) rather than the ARV index (INR). */
function isCoinAsset() {
  return st.asset !== 'ARV';
}

/** Decimals for the current asset's axis: ARV rupees vs USD coin prices. */
function assetPriceDecimals() {
  return isCoinAsset() ? 2 : CFG.INDEX.priceDecimals;
}

/** Format a price for the OHLC readout: rupees for ARV, dollars for a coin. */
function fmtAssetPrice(v) {
  if (v == null || !isFinite(v)) return '\u2014';
  if (isCoinAsset()) return '$' + Number(v).toLocaleString(CFG.UI.locale, {
    minimumFractionDigits: 2, maximumFractionDigits: assetPriceDecimals()
  });
  return ui.fmtPrice(v);
}

function buildAssetTabs() {
  var host = ui.el('[data-asset-tabs]');
  if (!host) return;
  host.innerHTML = CHART_ASSETS.map(function (a) {
    return '<button class="tab' + (a.key === st.asset ? ' on' : '') + '" data-asset="'
      + a.key + '">' + a.label + '</button>';
  }).join('');

  ui.els('[data-asset-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.asset === st.asset) return;
      ui.els('[data-asset-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.asset = b.dataset.asset;
      // Tear the live tick subscription down before the series is discarded, so
      // an in-flight tick never writes to a dead chart.
      if (st.unsubTick) { try { st.unsubTick(); } catch (_) {} st.unsubTick = null; }
      st.chart = null;
      st.series = null;
      st.liveBar = null;
      ui.el('[data-chart]').innerHTML = '';
      loadChart();
    });
  });
}

function buildTfTabs() {
  var host = ui.el('[data-tf-tabs]');
  host.innerHTML = CFG.CHARTS.timeframes.map(function (tf) {
    return '<button class="tab' + (tf === st.tf ? ' on' : '') + '" data-tf="' + tf + '">'
      + tf + '</button>';
  }).join('');

  ui.els('[data-tf-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-tf-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.tf = b.dataset.tf;
      st.chart = null;
      ui.el('[data-chart]').innerHTML = '';
      loadChart();
    });
  });

  ui.els('[data-type-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-type-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.ctype = b.dataset.ctype;
      st.chart = null;
      ui.el('[data-chart]').innerHTML = '';
      loadChart();
    });
  });
}

/** Days of history worth pulling for a timeframe. */
function daysFor(tf) {
  // Windows mirror CFG.CHARTS.ranges so a tab pulls the same depth its range
  // would: a week of minutes for the default 1m view, then progressively longer
  // windows as the candle widens.
  return { '1m': 7, '5m': 30, '15m': 90, '1h': 365, '4h': 730, '1D': null, '1W': null }[tf];
}

async function loadChart() {
  var host = ui.el('[data-chart]');
  if (!host || !globalThis.LightweightCharts) return;

  try {
    var coin = isCoinAsset();
    var r = coin
      ? await api.assetCandles(st.asset, st.tf, daysFor(st.tf), CFG.CHARTS.maxCandles)
      : await api.candles(st.tf, daysFor(st.tf), CFG.CHARTS.maxCandles);
    st.candles = r.candles || [];

    var label = coin ? st.asset + ' \u00b7 USD \u00b7 ' : '';
    ui.setText('[data-candle-count]', st.candles.length
      ? label + st.candles.length + ' candles \u00b7 ' + ui.fmtDate(st.candles[0].t) + ' to now'
      : (r.hint || 'no candles for this timeframe'));

    if (!st.candles.length) return;

    var L = globalThis.LightweightCharts;

    st.chart = L.createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight || 560,
      layout: { background: { type: 'solid', color: 'transparent' },
                textColor: '#5d636f', fontSize: 10,
                fontFamily: "'JetBrains Mono',ui-monospace,monospace" },
      grid: { vertLines: { color: 'rgba(255,255,255,.025)' },
              horzLines: { color: 'rgba(255,255,255,.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.07)',
                         scaleMargins: { top: .1, bottom: st.ctype === 'candles' ? .26 : .1 } },
      timeScale: { borderColor: 'rgba(255,255,255,.07)', timeVisible: true,
                   secondsVisible: false, rightOffset: 5, barSpacing: 8 },
      crosshair: { mode: L.CrosshairMode.Normal,
                   vertLine: { color: 'rgba(185,190,201,.35)', style: L.LineStyle.Dashed,
                               labelBackgroundColor: '#24242e' },
                   horzLine: { color: 'rgba(185,190,201,.35)', style: L.LineStyle.Dashed,
                               labelBackgroundColor: '#24242e' } },
      localization: {
        locale: CFG.UI.locale,
        priceFormatter: function (p) { return p.toFixed(assetPriceDecimals()); }
      }
    });

    var dp = assetPriceDecimals();
    var minMove = coin ? 0.01 : 0.0001;

    if (st.ctype === 'candles') {
      st.series = st.chart.addCandlestickSeries({
        upColor: '#3ecf8e', downColor: '#f0616d',
        borderVisible: false,
        wickUpColor: '#3ecf8e', wickDownColor: '#f0616d',
        priceFormat: { type: 'price', precision: dp, minMove: minMove }
      });
      st.series.setData(st.candles.map(function (k) {
        return { time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c };
      }));

      if (CFG.CHARTS.showVolume) {
        st.volume = st.chart.addHistogramSeries({
          priceFormat: { type: 'volume' }, priceScaleId: 'vol',
          lastValueVisible: false, priceLineVisible: false
        });
        st.chart.priceScale('vol').applyOptions({
          scaleMargins: { top: .78, bottom: 0 }, visible: false
        });
        st.volume.setData(st.candles.map(function (k) {
          return { time: Math.floor(k.t / 1000), value: k.v || 0,
                   color: k.c >= k.o ? 'rgba(62,207,142,.4)' : 'rgba(240,97,109,.4)' };
        }));
      }
    } else {
      st.series = st.chart.addAreaSeries({
        lineColor: '#dfe2e9',
        topColor: 'rgba(223,226,233,.18)',
        bottomColor: 'rgba(223,226,233,.01)',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: dp, minMove: minMove }
      });
      st.series.setData(st.candles.map(function (k) {
        return { time: Math.floor(k.t / 1000), value: k.c };
      }));
    }

    // The launch level and the user's cost only make sense for ARV — a coin chart
    // is a plain USD price with no index anchor and nothing the user holds.
    if (!coin) {
      // The launch level, so the whole series reads against the launch anchor
      // (now ₹17.83, not the old ₹1). Title is derived from the same figure the
      // line is drawn at so the label can never drift from the price again.
      var baseInr = CFG.INDEX.arvBaseInr;
      var baseLabel = '\u20b9' + (Number.isInteger(baseInr) ? baseInr : String(baseInr));
      st.series.createPriceLine({
        price: baseInr,
        color: 'rgba(185,190,201,.3)',
        lineStyle: L.LineStyle.Dashed, lineWidth: 1,
        axisLabelVisible: true, title: baseLabel
      });

      // The user's own cost, when they hold something.
      var w = st.user && st.user.wallet;
      if (w && w.avgCostNav > 0) {
        st.series.createPriceLine({
          price: w.avgCostNav,
          color: 'rgba(224,176,85,.75)',
          lineStyle: L.LineStyle.Dashed, lineWidth: 1,
          axisLabelVisible: true, title: 'your cost'
        });
      }
    }

    st.chart.subscribeCrosshairMove(function (param) {
      if (!param || !param.time || !param.point) {
        st.hovering = false;
        if (st.candles.length) paintOhlc(st.candles[st.candles.length - 1]);
        return;
      }
      st.hovering = true;
      var d = param.seriesData.get(st.series);
      if (!d) return;
      paintOhlc(d.open != null
        ? { o: d.open, h: d.high, l: d.low, c: d.close }
        : { o: d.value, h: d.value, l: d.value, c: d.value });
    });

    // Minute data is dense; showing all of it at once is unreadable.
    if (st.tf === '1m' || st.tf === '5m') {
      var range = st.chart.timeScale().getVisibleLogicalRange();
      if (range) st.chart.timeScale().setVisibleLogicalRange({ from: range.to - 180, to: range.to });
    } else {
      st.chart.timeScale().fitContent();
    }

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function (e) {
        var wd = e[0] && e[0].contentRect.width;
        if (wd > 0 && st.chart) st.chart.applyOptions({ width: wd });
      }).observe(host);
    }

    // Seed the live bar from the last server candle so the first tick extends it
    // rather than starting from nothing, then subscribe to the trade feed.
    var last = st.candles[st.candles.length - 1];
    st.liveBar = last
      ? { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c }
      : null;
    wireLiveFeed();
  } catch (e) {
    ui.setText('[data-candle-count]', 'chart unavailable');
  }
}

/* -------------------------------------------------------------- live candle -- */

/** Seconds spanned by one candle of the current timeframe. */
function tfSeconds() {
  return (TF_MINUTES[st.tf] || 1) * 60;
}

/**
 * Live ARV price from the BTC feed.
 *
 * Mirrors api/_money.php index_price(): ARV = base × (BTC_now_in_INR ÷
 * BTC_launch_in_INR). btcNowInr is the live USD price times the current fx, and
 * baseBtcInr is BTC-at-launch in rupees, both taken from the snapshot's `index`.
 * Returns null when any input is missing, so the caller leaves the chart alone.
 */
function liveArvPrice() {
  var idx = st.snap && st.snap.index;
  if (!idx || !idx.base || !idx.baseBtcInr || idx.fxUsdInr == null) return null;
  var btcUsd = feed.priceUsd('BTC');
  if (btcUsd == null || !isFinite(btcUsd)) return null;
  var btcNowInr = btcUsd * idx.fxUsdInr;
  var price = idx.base * (btcNowInr / idx.baseBtcInr);
  return isFinite(price) && price > 0 ? price : null;
}

/**
 * The live price for whatever asset the chart is showing.
 *
 * ARV is the BTC->INR index (liveArvPrice); a coin is its raw USD last trade
 * straight from the feed — the same feed, the same tick, no conversion, because
 * the coin chart is quoted in dollars. feed.priceUsd(key) works for every
 * selected asset because handleTrade() sets state.prices for ALL assets, and XRP
 * now streams too since it is in the WATCHLIST.
 */
function livePrice() {
  if (isCoinAsset()) {
    var p = feed.priceUsd(st.asset);
    return (p != null && isFinite(p) && p > 0) ? p : null;
  }
  return liveArvPrice();
}

/**
 * Grow the chart tick by tick.
 *
 * Only ever the last bar is touched: a tick in the current tf bucket mutates its
 * high/low/close, and a tick that crosses into the next bucket appends a fresh
 * one. The whole series is never rebuilt. The 30s snapshot poll stays the
 * correcting backstop that re-syncs the last bar to the authoritative server
 * candle. lightweight-charts' series.update() with the same or a greater time is
 * an in-place last-bar update, which is exactly this behaviour.
 */
function onLiveTick() {
  if (!st.series || !st.chart) return;
  var price = livePrice();
  if (price == null) return;

  var secs = tfSeconds();
  var nowSec = Math.floor(Date.now() / 1000);
  var bucketSec = Math.floor(nowSec / secs) * secs;

  var bar = st.liveBar;
  var lastBucketSec = bar ? Math.floor((bar.t / 1000) / secs) * secs : null;

  if (bar && lastBucketSec === bucketSec) {
    // Same candle: extend it.
    bar.c = price;
    if (price > bar.h) bar.h = price;
    if (price < bar.l) bar.l = price;
  } else {
    // New bucket (or first tick): open a fresh candle at the live price. Its open
    // is the previous close when there is one, so the series stays continuous.
    var open = bar ? bar.c : price;
    bar = { t: bucketSec * 1000, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price };
    st.liveBar = bar;
  }

  if (st.ctype === 'candles') {
    st.series.update({ time: bucketSec, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
  } else {
    st.series.update({ time: bucketSec, value: bar.c });
  }

  // Keep the OHLC readout live too, unless the user is inspecting an older bar.
  if (!st.hovering) paintOhlc(bar);
}

/**
 * Wire the trade feed into the current chart.
 *
 * Idempotent per loadChart(): any previous subscription is dropped first so a tf
 * switch does not stack listeners. Guarded so a chart with no feed (or an
 * unreachable one) still shows the historical server candles.
 */
function wireLiveFeed() {
  if (st.unsubTick) { try { st.unsubTick(); } catch (_) {} st.unsubTick = null; }
  if (!st.series) return;

  if (!st.feedStarted) {
    st.feedStarted = true;
    // Fire-and-forget: if the feed cannot reach any exchange the chart simply
    // stays on its historical candles, which is the required fallback.
    feed.start().catch(function () {});
  }

  // feed.onTick is already coalesced to CFG.FEED.renderThrottleMs, so no extra
  // throttling is needed here.
  st.unsubTick = feed.onTick(function () { onLiveTick(); });
}

/* -------------------------------------------------------------------- form -- */

function sideConfig() {
  var w = st.user && st.user.wallet;
  var isBuy = st.side === 'buy';

  ui.setText('[data-balance-label]', isBuy ? 'Rupee balance' : 'ARV available');
  ui.setText('[data-balance]', w
    ? (isBuy ? ui.fmtPaise(w.inrPaise) : ui.fmtUnits(w.arvUnits, 4) + ' ARV')
    : '\u2014');

  ui.setText('[data-amt-label]', isBuy ? 'Amount to invest' : 'Units to sell');
  ui.setText('[data-cur]', isBuy ? '\u20b9' : '');
  ui.el('[data-amt-wrap]').classList.toggle('amount-input', isBuy);

  var btn = ui.el('[data-submit]');
  btn.textContent = isBuy ? 'Buy ARV' : 'Sell ARV';
  btn.className = 'btn btn-block btn-lg ' + (isBuy ? 'btn-primary' : 'btn-sell');

  ui.setText('[data-side-note]', isBuy
    ? 'Fills immediately \u2014 against anyone selling, and the treasury for the rest.'
    : 'Goes to a real buyer first. If none is waiting, the treasury buys it after '
      + CFG.MARKET.sellFallbackMinutes + ' minutes.');

  // Quick amounts. Rupees for a buy, portions of the holding for a sell.
  var quick = ui.el('[data-quick]');
  if (isBuy) {
    quick.innerHTML = [50000, 100000, 500000, 1000000, 10000000].map(function (p) {
      return '<button class="btn btn-sm" data-q="' + p + '">' + ui.fmtCompact(p / 100) + '</button>';
    }).join('');
  } else {
    quick.innerHTML = [25, 50, 75, 100].map(function (pc) {
      return '<button class="btn btn-sm" data-qpct="' + pc + '">' + pc + '%</button>';
    }).join('');
  }

  bindQuick();
  ui.el('#amt').value = '';
  requestQuote();
}

function bindQuick() {
  ui.els('[data-q]').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.el('#amt').value = String(Number(b.dataset.q) / 100);
      requestQuote();
    });
  });
  ui.els('[data-qpct]').forEach(function (b) {
    b.addEventListener('click', function () {
      var w = st.user && st.user.wallet;
      if (!w) return;
      var avail = parseFloat(w.arvUnits) || 0;
      // Floored at 8dp so "100%" never asks for more than is actually held.
      var u = Math.floor(avail * (Number(b.dataset.qpct) / 100) * 1e8) / 1e8;
      ui.el('#amt').value = String(u);
      requestQuote();
    });
  });
}

/**
 * Ask the server to price it.
 *
 * Debounced — a quote per keystroke would be a request per keystroke, and the
 * answer only matters once someone stops typing.
 */
function requestQuote() {
  clearTimeout(st.quoteTimer);
  st.quoteTimer = setTimeout(doQuote, 350);
}

async function doQuote() {
  var host = ui.el('[data-quote]');
  var btn = ui.el('[data-submit]');
  var err = ui.el('[data-amt-err]');
  var raw = (ui.el('#amt').value || '').replace(/[^\d.]/g, '');
  var value = parseFloat(raw);

  err.classList.add('hidden');
  st.quote = null;

  if (!value || value <= 0) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">'
      + (st.side === 'buy' ? 'Enter an amount' : 'Enter units to sell') + '</span></div>';
    btn.disabled = true;
    return;
  }

  host.innerHTML = '<div class="ledger-row"><span class="l muted">'
    + '<span class="spinner"></span> Pricing\u2026</span></div>';

  try {
    var r = st.side === 'buy'
      ? await api.quoteBuy(ui.toPaise(value))
      : await api.quoteSell(value);
    var q = r.quote;
    st.quote = q;

    host.innerHTML = st.side === 'buy' ? buyRows(q) : sellRows(q);

    var ok = st.side === 'buy' ? q.sufficient !== false : true;
    btn.disabled = !ok;

    if (st.side === 'buy' && q.sufficient === false) {
      err.textContent = 'Short by ' + ui.fmtPaise(q.shortfallPaise)
        + ' including fees. Add funds first.';
      err.classList.remove('hidden');
    }
  } catch (e) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">'
      + ui.esc(e.message || 'Cannot price that.') + '</span></div>';
    btn.disabled = true;
    if (e.needs === 'kyc') ui.toastError(e);
  }
}

function row(label, amount, kind, note, override) {
  var text = override != null
    ? override
    : (amount != null ? (amount < 0 ? '\u2212' : '') + ui.fmtPaise(Math.abs(amount)) : '');
  return '<div class="ledger-row k-' + (kind || 'info') + '">'
    + '<span class="l">' + ui.esc(label) + '</span>'
    + (text ? '<span class="a">' + text + '</span>' : '')
    + (note ? '<span class="note">' + ui.esc(note) + '</span>' : '')
    + '</div>';
}

function buyRows(q) {
  return row('You pay', q.grossPaise, 'gross')
    + row('Entry fee (' + q.entryFeePct + '%)' + (q.tier ? ' \u00b7 ' + q.tier : ''),
          -q.feePaise, 'charge')
    + row('GST on the fee (' + q.gstPct + '%)', -q.gstPaise, 'charge')
    + row('Invested', q.netInvestPaise, 'net')
    + '<div class="ledger-divider"></div>'
    + row('Units at ' + ui.fmtPrice(q.execNav), null, 'info', null, ui.fmtUnits(q.units, 8))
    + row('Your cost per unit', null, 'info',
          'ARV must reach ' + ui.fmtPrice(q.effectiveNav) + ' before this is in profit',
          ui.fmtPrice(q.effectiveNav))
    + row('Total debited', q.totalDebitPaise, 'gross');
}

function sellRows(q) {
  var s = row('Gross value', q.grossPaise, 'gross')
    + row('Exit fee (' + q.exitFeePct + '%)' + (q.tier ? ' \u00b7 ' + q.tier : ''),
          -q.feePaise, 'charge')
    + row('GST on the fee', -q.gstPaise, 'charge')
    + row('TDS withheld' + (q.tds && q.tds.applies ? ' (' + q.tds.ratePct + '%)' : ' \u2014 none'),
          -q.tdsPaise, 'tds', q.tds ? q.tds.reason : null)
    + row('Credited to rupees', q.netPayoutPaise, 'net')
    + '<div class="ledger-divider"></div>'
    + row('Cost of acquisition (FIFO)', q.costBasisPaise, 'info')
    + row(q.pnlPaise >= 0 ? 'Realised gain' : 'Realised loss', q.pnlPaise, 'pnl')
    + row('Tax at ' + q.effectiveTaxPct.toFixed(1) + '%', q.totalTaxPaise, 'liability',
          'Not withheld \u2014 payable by you when you file')
    + row('Less TDS already withheld', -q.tdsPaise, 'liability')
    + row('Balance at filing', q.balanceTaxPaise, 'liability-total');

  if (q.lossNotSetOff) {
    s += '<div class="ledger-row k-warning"><span class="note">This loss cannot be set off '
       + 'against other gains or carried forward \u2014 section 115BBH permits neither.'
       + '</span></div>';
  }
  return s;
}

/* ------------------------------------------------------------------ submit -- */

async function submit() {
  var btn = ui.el('[data-submit]');
  var raw = (ui.el('#amt').value || '').replace(/[^\d.]/g, '');
  var value = parseFloat(raw);
  if (!value) return;

  var payload = { side: st.side, type: st.otype };
  if (st.side === 'buy') payload.amountPaise = ui.toPaise(value);
  else payload.units = String(value);

  if (st.otype === 'limit') {
    var trigger = parseFloat((ui.el('#trigger').value || '').replace(/[^\d.]/g, ''));
    if (!trigger) {
      ui.toast('Enter the price the order should act at.', 'warn');
      return;
    }
    payload.triggerNav = String(trigger);
  }

  ui.busy(btn, true, st.side === 'buy' ? 'Buying\u2026' : 'Placing\u2026');
  try {
    var r = await api.placeOrder(payload);
    ui.toast(r.message || 'Done.', 'ok', 6000);

    ui.el('#amt').value = '';
    if (ui.el('#trigger')) ui.el('#trigger').value = '';

    await refresh();
    doQuote();
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* -------------------------------------------------------------------- book -- */

async function loadBook() {
  var host = ui.el('[data-depth]');
  if (!host) return;

  try {
    var r = await api.book();
    var b = r.book;
    if (!b) {
      host.innerHTML = '<div class="empty tiny">The book opens when the price feed is live.</div>';
      return;
    }

    var buy = b.buyDepthPaise || 0;
    var sell = b.sellDepthPaise || 0;
    var max = Math.max(buy, sell, 1);

    host.innerHTML =
      '<div>'
        + '<div class="row-between tiny" style="margin-bottom:5px">'
          + '<span class="up strong">Wanting to buy</span>'
          + '<span class="num">' + ui.fmtPaise(buy) + '</span></div>'
        + '<div class="depth-bar buy"><span style="width:' + ((buy / max) * 100).toFixed(1) + '%"></span></div>'
        + '<div class="tiny muted" style="margin-top:4px">'
          + ui.fmtUnits(b.buyDepthUnits, 2) + ' ARV \u00b7 ' + (b.buys || []).length + ' orders</div>'
      + '</div>'
      + '<div>'
        + '<div class="row-between tiny" style="margin-bottom:5px">'
          + '<span class="down strong">Wanting to sell</span>'
          + '<span class="num">' + ui.fmtPaise(sell) + '</span></div>'
        + '<div class="depth-bar sell"><span style="width:' + ((sell / max) * 100).toFixed(1) + '%"></span></div>'
        + '<div class="tiny muted" style="margin-top:4px">'
          + ui.fmtUnits(b.sellDepthUnits, 2) + ' ARV \u00b7 ' + (b.sells || []).length + ' orders</div>'
      + '</div>'
      + '<div class="row-between tiny muted" style="padding-top:var(--sp-3);border-top:1px solid var(--line)">'
        + '<span>Everything settles at</span>'
        + '<span class="num strong">' + ui.fmtPrice(b.nav) + '</span></div>';
  } catch (_) {
    host.innerHTML = '<div class="empty tiny">Book unavailable.</div>';
  }
}

async function loadTape() {
  var host = ui.el('[data-tape]');
  if (!host) return;

  try {
    var r = await api.tape(CFG.FEED.tapeLength || 40);
    var rows = r.trades || [];
    ui.setText('[data-tape-count]', rows.length ? rows.length + ' fills' : '');

    if (!rows.length) {
      host.innerHTML = '<div class="empty tiny">No fills yet. The first trade appears here.</div>';
      return;
    }

    host.innerHTML = rows.map(function (t) {
      // Treasury fills are marked, because whether the other side was a person or
      // the platform is a genuinely different fact about the market.
      var mark = t.counterparty === 'treasury'
        ? '<span class="tiny muted" title="Filled by the treasury">\u25cb</span>' : '';
      return '<div class="tape-row">'
        + '<span class="num">' + ui.fmtPrice(t.nav) + ' ' + mark + '</span>'
        + '<span class="num">' + ui.fmtUnits(t.units, 4) + '</span>'
        + '<span class="t">' + ui.fmtTime(t.at) + '</span>'
        + '</div>';
    }).join('');
  } catch (_) {
    host.innerHTML = '<div class="empty tiny">Tape unavailable.</div>';
  }
}

async function loadMyOrders() {
  var host = ui.el('[data-my-orders]');
  if (!host) return;

  try {
    var r = await api.myOrders('open');
    var rows = r.orders || [];
    if (!rows.length) {
      host.innerHTML = '<div class="empty tiny">None open</div>';
      return;
    }

    host.innerHTML = rows.map(function (o) {
      var fb = o.fallbackInMinutes != null && o.side === 'sell'
        ? '<div class="tiny muted">treasury in ' + o.fallbackInMinutes + 'm</div>' : '';
      return '<div class="asset-row" style="grid-template-columns:1fr auto auto">'
        + '<div><span class="badge ' + (o.side === 'buy' ? 'ok' : 'warn') + '">' + o.side
          + '</span> <span class="tiny muted">' + o.type + '</span>'
          + '<div class="num tiny" style="margin-top:3px">'
            + ui.fmtUnits(o.remainingUnits, 4) + ' left'
            + (o.triggerNav ? ' at ' + ui.fmtPrice(o.triggerNav) : '') + '</div>'
          + fb + '</div>'
        + '<span></span>'
        + '<button class="btn btn-sm btn-ghost" data-cancel="' + o.id + '">Cancel</button>'
        + '</div>';
    }).join('');

    ui.els('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        ui.busy(b, true, '\u2026');
        try {
          var res = await api.cancelOrder(Number(b.dataset.cancel));
          ui.toast(res.message || 'Cancelled.', 'ok');
          await refresh();
        } catch (e) { ui.toastError(e); ui.busy(b, false); }
      });
    });
  } catch (_) {
    host.innerHTML = '<div class="empty tiny">Unavailable</div>';
  }
}

/* -------------------------------------------------------------------- boot -- */

async function refresh() {
  st.user = await api.me(true);
  st.snap = await api.snapshot().catch(function () { return null; });
  paintTicker();
  sideConfigLight();
  await Promise.all([loadBook(), loadTape(), loadMyOrders()]);
}

/** Balance only — a full sideConfig would clear what the user is typing. */
function sideConfigLight() {
  var w = st.user && st.user.wallet;
  ui.setText('[data-balance]', w
    ? (st.side === 'buy' ? ui.fmtPaise(w.inrPaise) : ui.fmtUnits(w.arvUnits, 4) + ' ARV')
    : '\u2014');
}

(async function () {
  ui.setText('[data-fallback]', String(CFG.MARKET.sellFallbackMinutes));
  buildAssetTabs();
  buildTfTabs();

  await ui.boot({ feed: false });
  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  // A side can be pre-selected from a link, so "Sell" on the wallet lands here
  // already on the right tab.
  var wanted = new URLSearchParams(location.search).get('side');
  if (wanted === 'sell') st.side = 'sell';

  ui.els('[data-side-toggle] button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.side === st.side);
    b.addEventListener('click', function () {
      ui.els('[data-side-toggle] button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.side = b.dataset.side;
      sideConfig();
    });
  });

  ui.els('[data-order-type] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-order-type] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.otype = b.dataset.otype;
      ui.el('[data-trigger-field]').classList.toggle('hidden', st.otype !== 'limit');
      ui.setText('[data-trigger-hint]', st.side === 'buy'
        ? 'A buy triggers when ARV falls to this level or below.'
        : 'A sell triggers when ARV rises to this level or above.');
      requestQuote();
    });
  });

  ui.el('#amt').addEventListener('input', requestQuote);
  ui.on('[data-submit]', 'click', submit);

  st.snap = await api.snapshot().catch(function () { return null; });
  paintTicker();
  ui.paintServerFeed(st.snap);
  sideConfig();

  await loadChart();
  loadBook();
  loadTape();
  loadMyOrders();

  // The book and the tape change when anyone trades, so they refresh faster than
  // the price does.
  api.poll(function () { return Promise.all([loadBook(), loadTape()]); }, 15000);
  api.poll(async function () {
    st.snap = await api.snapshot();
    paintTicker();
    ui.paintServerFeed(st.snap);
    resyncLiveBar();
  }, 30000);
})();

/**
 * Re-sync the live bar to the authoritative server candle.
 *
 * The tick-by-tick updates are a display convenience; the server's stored candle
 * is the source of truth. Every snapshot poll we pull the latest bar for the
 * current tf and adopt it, so any drift the live ticks introduced is corrected.
 * If the fetch fails the live bar is left as-is and the chart keeps growing.
 */
async function resyncLiveBar() {
  if (!st.series) return;
  try {
    var r = isCoinAsset()
      ? await api.assetCandles(st.asset, st.tf, daysFor(st.tf), 2)
      : await api.candles(st.tf, daysFor(st.tf), 2);
    var rows = r.candles || [];
    var last = rows[rows.length - 1];
    if (!last) return;
    // Only adopt the server bar if it is at or ahead of what we are showing, so a
    // slower server candle never rolls the chart backwards.
    if (!st.liveBar || last.t >= st.liveBar.t) {
      st.liveBar = { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c };
      var time = Math.floor(last.t / 1000);
      if (st.ctype === 'candles') {
        st.series.update({ time: time, open: last.o, high: last.h, low: last.l, close: last.c });
      } else {
        st.series.update({ time: time, value: last.c });
      }
    }
  } catch (_) {}
}
