/**
 * Trading chart.
 *
 * Wraps TradingView's lightweight-charts (v4, loaded from CDN as a UMD global)
 * into something the pages can drive with two calls: `create` then `setSeries`.
 *
 * What this deliberately does NOT draw
 * -----------------------------------
 * There is no order book, no bid/ask depth and no market-depth ladder for ARV,
 * because ARV has no secondary market. Units are issued and redeemed against
 * NAV — there is no counterparty on the other side of a spread. Rendering a
 * fabricated order book would look convincing and mean nothing, so the chart
 * shows what actually exists: price, volume, and the real depth of the
 * underlying Bitcoin market when asked for it.
 *
 * Time handling: lightweight-charts wants UNIX *seconds*. Everything upstream
 * of here works in milliseconds. All conversion happens at this boundary.
 */

var CFG = globalThis.ARV_CONFIG;

var COLOURS = {
  up: '#16c784',
  down: '#ea3943',
  upDim: 'rgba(22,199,132,0.45)',
  downDim: 'rgba(234,57,67,0.45)',
  arv: '#6ee7ff',
  arvFillTop: 'rgba(110,231,255,0.26)',
  arvFillBottom: 'rgba(110,231,255,0.01)',
  grid: 'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.07)',
  text: '#7d8aa3',
  crosshair: 'rgba(185,195,214,0.4)'
};

function lib() {
  var L = globalThis.LightweightCharts;
  if (!L) throw new Error('lightweight-charts has not loaded');
  return L;
}

function toSec(ms) { return Math.floor(ms / 1000); }

/** Candle -> lightweight-charts bar. */
function bar(k) {
  return { time: toSec(k.t), open: k.o, high: k.h, low: k.l, close: k.c };
}

/** Candle -> volume histogram point, coloured by that candle's direction. */
function volBar(k) {
  return {
    time: toSec(k.t),
    value: k.v || 0,
    color: k.c >= k.o ? COLOURS.upDim : COLOURS.downDim
  };
}

/**
 * Price formatting.
 *
 * ARV sits near ₹1, so 4 decimals are needed for a real move to be visible at
 * all. Bitcoin in rupees is in the tens of lakhs, where decimals are noise.
 * One chart may show both, so precision is per-series, not global.
 */
function priceFormat(kind) {
  if (kind === 'arv') {
    return { type: 'price', precision: CFG.INDEX.priceDecimals, minMove: Math.pow(10, -CFG.INDEX.priceDecimals) };
  }
  if (kind === 'big') {
    return { type: 'price', precision: 0, minMove: 1 };
  }
  if (kind === 'index') {
    return { type: 'price', precision: 2, minMove: 0.01 };
  }
  return { type: 'price', precision: 2, minMove: 0.01 };
}

/* ================================================================ create === */

/**
 * @param el       container element
 * @param opts     { height, priceKind, showVolume, showTimeScale, rightOffset }
 */
export function create(el, opts) {
  var o = opts || {};
  var L = lib();

  var chart = L.createChart(el, {
    width: el.clientWidth,
    height: o.height || el.clientHeight || 420,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: COLOURS.text,
      fontFamily: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
      fontSize: 11
    },
    grid: {
      vertLines: { color: COLOURS.grid },
      horzLines: { color: COLOURS.grid }
    },
    rightPriceScale: {
      borderColor: COLOURS.border,
      scaleMargins: { top: 0.12, bottom: o.showVolume ? 0.26 : 0.1 }
    },
    timeScale: {
      borderColor: COLOURS.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: o.rightOffset != null ? o.rightOffset : 6,
      barSpacing: 8,
      visible: o.showTimeScale !== false
    },
    crosshair: {
      mode: L.CrosshairMode.Normal,
      vertLine: {
        color: COLOURS.crosshair, width: 1, style: L.LineStyle.Dashed,
        labelBackgroundColor: '#1d2639'
      },
      horzLine: {
        color: COLOURS.crosshair, width: 1, style: L.LineStyle.Dashed,
        labelBackgroundColor: '#1d2639'
      }
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true },
    localization: {
      locale: CFG.UI.locale,
      priceFormatter: function (p) {
        // Indian grouping in the axis labels, not the browser default.
        var d = o.priceKind === 'arv' ? CFG.INDEX.priceDecimals : (o.priceKind === 'big' ? 0 : 2);
        return p.toLocaleString(CFG.UI.locale, {
          minimumFractionDigits: d, maximumFractionDigits: d
        });
      }
    }
  });

  var api = {
    chart: chart,
    el: el,
    series: {},
    priceLines: [],
    priceKind: o.priceKind || 'arv',
    _ro: null,
    _destroyed: false
  };

  // Keep the chart sized to its container. ResizeObserver rather than a window
  // listener, because the container can change size without the window doing so
  // (sidebar collapse, tab switch, orientation).
  if (typeof ResizeObserver !== 'undefined') {
    api._ro = new ResizeObserver(function (entries) {
      if (api._destroyed) return;
      var r = entries[0] && entries[0].contentRect;
      if (r && r.width > 0) chart.applyOptions({ width: r.width, height: r.height || o.height });
    });
    api._ro.observe(el);
  }

  return api;
}

/* ================================================================ series === */

/** Candlestick series, plus an optional volume histogram beneath it. */
export function addCandles(api, opts) {
  var o = opts || {};
  var s = api.chart.addCandlestickSeries({
    upColor: COLOURS.up,
    downColor: COLOURS.down,
    borderUpColor: COLOURS.up,
    borderDownColor: COLOURS.down,
    wickUpColor: COLOURS.up,
    wickDownColor: COLOURS.down,
    borderVisible: false,
    priceFormat: priceFormat(o.priceKind || api.priceKind),
    priceLineVisible: true,
    priceLineColor: 'rgba(185,195,214,0.28)',
    priceLineStyle: lib().LineStyle.Dotted,
    lastValueVisible: true
  });
  api.series.candles = s;

  if (o.withVolume) {
    var v = api.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false
    });
    // Pin volume to the bottom quarter so it never competes with price.
    api.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
      visible: false
    });
    api.series.volume = v;
  }
  return s;
}

/** Filled area series — calmer than candles for a portfolio view. */
export function addArea(api, opts) {
  var o = opts || {};
  var s = api.chart.addAreaSeries({
    lineColor: o.colour || COLOURS.arv,
    topColor: o.topColour || COLOURS.arvFillTop,
    bottomColor: o.bottomColour || COLOURS.arvFillBottom,
    lineWidth: 2,
    priceFormat: priceFormat(o.priceKind || api.priceKind),
    priceLineVisible: true,
    priceLineColor: 'rgba(185,195,214,0.28)',
    priceLineStyle: lib().LineStyle.Dotted,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 3
  });
  api.series[o.key || 'area'] = s;
  return s;
}

/** Plain line — used for the comparison overlay. */
export function addLine(api, key, opts) {
  var o = opts || {};
  var s = api.chart.addLineSeries({
    color: o.colour || COLOURS.arv,
    lineWidth: o.width || 2,
    priceFormat: priceFormat(o.priceKind || 'index'),
    priceLineVisible: false,
    lastValueVisible: o.lastValueVisible !== false,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 3,
    title: o.title || ''
  });
  api.series[key] = s;
  return s;
}

/* =================================================================== data == */

export function setCandles(api, candles) {
  if (!api.series.candles || !candles) return;
  api.series.candles.setData(candles.map(bar));
  if (api.series.volume) api.series.volume.setData(candles.map(volBar));
}

export function setArea(api, candles, key) {
  var s = api.series[key || 'area'];
  if (!s || !candles) return;
  s.setData(candles.map(function (k) { return { time: toSec(k.t), value: k.c }; }));
}

export function setLine(api, key, points) {
  var s = api.series[key];
  if (!s || !points) return;
  s.setData(points.map(function (p) {
    return { time: toSec(p.t), value: p.value != null ? p.value : p.c };
  }));
}

/**
 * Update the in-progress candle.
 *
 * lightweight-charts' `update` replaces the bar at that timestamp, so calling
 * it repeatedly with the same time is exactly how a live candle is animated —
 * no need to rebuild the series on every tick.
 */
export function updateCandle(api, candle) {
  if (!api.series.candles || !candle) return;
  api.series.candles.update(bar(candle));
  if (api.series.volume) api.series.volume.update(volBar(candle));
}

export function updateArea(api, candle, key) {
  var s = api.series[key || 'area'];
  if (!s || !candle) return;
  s.update({ time: toSec(candle.t), value: candle.c });
}

/* ============================================================ price lines == */

/**
 * Horizontal marker — the user's average cost, a limit-order trigger, the
 * launch level. Seeing your own entry against the current price is the single
 * most useful annotation on a portfolio chart.
 */
export function addPriceLine(api, opts) {
  var o = opts || {};
  var target = api.series.candles || api.series.area;
  if (!target) return null;

  var line = target.createPriceLine({
    price: o.price,
    color: o.colour || 'rgba(245,165,36,0.7)',
    lineWidth: 1,
    lineStyle: lib().LineStyle.Dashed,
    axisLabelVisible: true,
    title: o.title || ''
  });
  api.priceLines.push({ line: line, series: target });
  return line;
}

export function clearPriceLines(api) {
  api.priceLines.forEach(function (p) {
    try { p.series.removePriceLine(p.line); } catch (_) {}
  });
  api.priceLines = [];
}

/* ================================================================ readout == */

/**
 * Wire the crosshair to an OHLC readout.
 *
 * `fn` receives the hovered bar, or null when the pointer leaves the chart, in
 * which case the caller should fall back to showing the latest values.
 */
export function onCrosshair(api, fn) {
  api.chart.subscribeCrosshairMove(function (param) {
    if (!param || !param.time || !param.point) { fn(null); return; }

    var out = { time: param.time * 1000, series: {} };
    param.seriesData.forEach(function (value, series) {
      var key = Object.keys(api.series).find(function (k) { return api.series[k] === series; });
      if (!key) return;
      if (value.open != null) {
        out.series[key] = { o: value.open, h: value.high, l: value.low, c: value.close };
        if (key === 'candles') out.ohlc = out.series[key];
      } else if (value.value != null) {
        out.series[key] = { c: value.value };
      }
    });
    fn(out);
  });
}

/* ================================================================= view ==== */

export function fit(api) {
  try { api.chart.timeScale().fitContent(); } catch (_) {}
}

/** Show only the most recent `n` bars — the sensible default on 1m data. */
export function showLast(api, n) {
  try {
    var ts = api.chart.timeScale();
    var range = ts.getVisibleLogicalRange();
    if (!range) { ts.fitContent(); return; }
    ts.setVisibleLogicalRange({ from: range.to - n, to: range.to });
  } catch (_) {}
}

export function destroy(api) {
  api._destroyed = true;
  if (api._ro) { try { api._ro.disconnect(); } catch (_) {} }
  try { api.chart.remove(); } catch (_) {}
  api.series = {};
  api.priceLines = [];
}

/** Message shown over the chart while loading or on failure. */
export function overlay(el, msg) {
  var existing = el.querySelector('.chart-overlay-msg');
  if (!msg) { if (existing) existing.remove(); return; }
  if (existing) { existing.innerHTML = msg; return; }
  var d = document.createElement('div');
  d.className = 'chart-overlay-msg';
  d.innerHTML = msg;
  el.appendChild(d);
}

export { COLOURS };
