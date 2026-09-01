/**
 * The ARV index.
 *
 * One formula drives everything in this product:
 *
 *   ARV(t) = ARV_BASE × Σ [ weight_i × ( quotePrice_i(t) / quotePrice_i(launch) ) ]
 *
 * With today's config there is a single asset at weight 1.0, so ARV is simply
 * Bitcoin's percentage move applied to ₹1. Bitcoin doubles, ARV is ₹2. Bitcoin
 * drops 8%, ARV is ₹0.92. The weighted sum is already in place so that turning
 * this into a multi-asset basket is a config edit, not a rewrite.
 *
 * Quoted in rupees
 * ----------------
 * `quotePrice` is Bitcoin in ₹, not in $. That is deliberate: deposits are in
 * rupees and the treasury holds Bitcoin, so a rupee-quoted index is the only
 * one whose printed change matches what the money actually did. It also keeps
 * the UI honest — BTC in ₹ and ARV show the identical percentage, because they
 * are the same number scaled.
 *
 * The cost is that every historical candle needs the USD/INR rate *of that
 * candle*, which is what the FX curve in fx.js provides.
 *
 * Issuance does not move the price
 * --------------------------------
 * Nothing here reads deposits, redemptions or units outstanding. New money
 * cannot lift ARV and redemptions cannot depress it — the price is a pure
 * function of market data. That is what separates an index unit from a number
 * an operator can push around, and it is why every buy and sell in this app
 * settles at a price neither side controls.
 */

import * as feed from './feed.js';
import * as fx from './fx.js';
import { roundUnits } from './money.js';

var CFG = globalThis.ARV_CONFIG;
var IDX = CFG.INDEX;

/* --------------------------------------------------------------- base refs -- */

/** Launch reference price for an asset, in the quote currency. */
export function quoteBase(key) {
  var usd = IDX.baseUsd[key];
  if (usd == null) return null;
  return IDX.quote === 'INR' ? usd * IDX.baseFxUsdInr : usd;
}

/** Convert a USD price to the quote currency at a given FX rate. */
function toQuote(usd, rate) {
  return IDX.quote === 'INR' ? usd * rate : usd;
}

/* ------------------------------------------------------------- spot pricing -- */

/**
 * ARV price in ₹ from a set of USD prices.
 * Returns null when any basket asset is missing — a partial basket would print
 * a confidently wrong price, which is worse than printing nothing.
 */
export function arvFromUsd(pricesUsd, fxRate) {
  var rate = fxRate || fx.peekRate() || CFG.FEED.fx.fallbackRate;
  var ratio = 0;

  for (var i = 0; i < CFG.BASKET.length; i++) {
    var a = CFG.BASKET[i];
    var usd = pricesUsd[a.key];
    var base = quoteBase(a.key);
    if (!isFinite(usd) || !base) return null;
    ratio += a.weight * (toQuote(usd, rate) / base);
  }
  return IDX.arvBaseInr * ratio;
}

/** Live ARV price from the feed's current prices. Null until data arrives. */
export function currentArv() {
  return arvFromUsd(feed.allPricesUsd(), fx.peekRate());
}

/** Basket asset in the quote currency, live. */
export function currentQuotePrice(key) {
  var usd = feed.priceUsd(key);
  if (!isFinite(usd)) return null;
  return toQuote(usd, fx.peekRate() || CFG.FEED.fx.fallbackRate);
}

/** Percentage change of ARV since launch. */
export function changeSinceLaunch(arv) {
  var p = arv != null ? arv : currentArv();
  if (p == null) return null;
  return ((p - IDX.arvBaseInr) / IDX.arvBaseInr) * 100;
}

/* ------------------------------------------------------- candle construction */

/**
 * Turn per-asset USD candles into ARV candles.
 *
 * `byKey` maps asset key -> ascending candle array. Only timestamps present for
 * every basket asset are used, because an index value computed from a partial
 * basket is not comparable to its neighbours.
 *
 * Multi-asset note: open and close are exact, since every component's open and
 * close are simultaneous. High and low are not — component extremes inside a
 * bucket can happen at different moments, so the weighted high is an upper
 * bound rather than a true index high. With one asset at weight 1.0 (the
 * current config) all four are exact.
 */
export function buildArvCandles(byKey, fxCurve) {
  var basket = CFG.BASKET;
  if (!basket.length) return [];

  var first = byKey[basket[0].key] || [];
  if (!first.length) return [];

  // Index every asset by open time for alignment.
  var maps = {};
  basket.forEach(function (a) {
    var m = Object.create(null);
    (byKey[a.key] || []).forEach(function (k) { m[k.t] = k; });
    maps[a.key] = m;
  });

  var out = [];

  for (var i = 0; i < first.length; i++) {
    var t = first[i].t;
    var rate = IDX.quote === 'INR'
      ? (fxCurve ? fxCurve.at(t) : (fx.peekRate() || CFG.FEED.fx.fallbackRate))
      : 1;

    var o = 0, h = 0, l = 0, c = 0, v = 0;
    var complete = true;

    for (var j = 0; j < basket.length; j++) {
      var a = basket[j];
      var k = maps[a.key][t];
      var base = quoteBase(a.key);
      if (!k || !base) { complete = false; break; }
      var f = (a.weight * IDX.arvBaseInr) / base;
      o += toQuote(k.o, rate) * f;
      h += toQuote(k.h, rate) * f;
      l += toQuote(k.l, rate) * f;
      c += toQuote(k.c, rate) * f;
      v += (k.v || 0) * a.weight;
    }

    if (complete) out.push({ t: t, o: o, h: h, l: l, c: c, v: v });
  }

  return out;
}

/**
 * ARV candle series for a timeframe, fetched and converted end to end.
 *
 * `days` bounds how far back to go; null means since launch. Backfill depth is
 * tiered in config because no free API will serve 20 months of minute candles,
 * and no browser should try to hold them.
 */
export async function arvSeries(tf, opts) {
  var o = opts || {};
  var now = Date.now();
  var days = o.days;
  if (days === undefined) {
    var cfgDays = CFG.CHARTS.backfill[tf];
    days = cfgDays !== undefined ? cfgDays : 30;
  }

  var from = days == null
    ? IDX.launchMs
    : Math.max(IDX.launchMs, now - days * 86400000);

  var fxCurve = IDX.quote === 'INR' ? await fx.getRateCurve(from, now) : null;

  var byKey = {};
  for (var i = 0; i < CFG.BASKET.length; i++) {
    var a = CFG.BASKET[i];
    byKey[a.key] = o.deep
      ? await feed.candlesRange(a.key, tf, from, now, o.onProgress)
      : await feed.candles(a.key, tf, { limit: o.limit || CFG.CHARTS.maxCandles });
  }

  var series = buildArvCandles(byKey, fxCurve);

  // Never show a candle from before the index existed.
  series = series.filter(function (k) { return k.t >= IDX.launchMs; });

  return {
    tf: tf,
    candles: series,
    underlying: byKey,
    fxDegraded: !!(fxCurve && fxCurve.degraded),
    source: feed.status().source
  };
}

/* ------------------------------------------------------- live candle builder */

/**
 * Folds live ticks into the in-progress candle.
 *
 * A trading chart has one candle that is still moving. This keeps it correct
 * without refetching: each tick extends the current bucket's high/low and moves
 * its close, and crossing a bucket boundary closes the old candle and opens a
 * new one at the same price — no gap, which is how a continuous market behaves.
 */
export function createLiveCandle(tf, seed) {
  var size = feed.TF_MINUTES[tf] * 60000;
  var cur = seed ? Object.assign({}, seed) : null;

  function bucket(ts) { return Math.floor(ts / size) * size; }

  return {
    /** Returns { candle, closed } — `closed` is the completed candle, if any. */
    push: function (price, ts) {
      var now = ts || Date.now();
      var b = bucket(now);
      if (!isFinite(price)) return { candle: cur, closed: null };

      if (!cur) {
        cur = { t: b, o: price, h: price, l: price, c: price, v: 0 };
        return { candle: cur, closed: null };
      }

      if (b > cur.t) {
        var finished = cur;
        // Open the new candle at the previous close so the series stays
        // continuous, then apply the tick.
        cur = { t: b, o: finished.c, h: Math.max(finished.c, price), l: Math.min(finished.c, price), c: price, v: 0 };
        return { candle: cur, closed: finished };
      }

      cur.h = Math.max(cur.h, price);
      cur.l = Math.min(cur.l, price);
      cur.c = price;
      return { candle: cur, closed: null };
    },

    reset: function (seedCandle) { cur = seedCandle ? Object.assign({}, seedCandle) : null; },
    current: function () { return cur; }
  };
}

/* -------------------------------------------------------------------- stats -- */

/**
 * Ticker statistics from a candle series.
 * `window` is in hours and defaults to 24.
 */
export function stats(candles, windowHours) {
  if (!candles || !candles.length) return null;
  var hours = windowHours || 24;
  var cutoff = Date.now() - hours * 3600000;

  var last = candles[candles.length - 1];
  var win = candles.filter(function (k) { return k.t >= cutoff; });
  if (!win.length) win = candles.slice(-2);

  var open = win[0].o;
  var high = -Infinity, low = Infinity, vol = 0;
  win.forEach(function (k) {
    high = Math.max(high, k.h);
    low = Math.min(low, k.l);
    vol += k.v || 0;
  });

  var allHigh = -Infinity, allLow = Infinity;
  candles.forEach(function (k) {
    allHigh = Math.max(allHigh, k.h);
    allLow = Math.min(allLow, k.l);
  });

  return {
    price: last.c,
    open: open,
    change: last.c - open,
    changePct: open ? ((last.c - open) / open) * 100 : 0,
    high: high,
    low: low,
    volume: vol,
    allTimeHigh: allHigh,
    allTimeLow: allLow,
    sinceLaunchPct: changeSinceLaunch(last.c),
    windowHours: hours,
    asOf: last.t
  };
}

/**
 * Normalise several series to a common 100 base so ARV, BTC, ETH and SOL are
 * comparable on one axis despite living on wildly different scales.
 */
export function normalise(candles) {
  if (!candles || !candles.length) return [];
  var base = candles[0].c;
  if (!base) return [];
  return candles.map(function (k) {
    return { t: k.t, value: (k.c / base) * 100 };
  });
}

/* ------------------------------------------------------------------ issuance */

/**
 * NAV per unit.
 *
 * Equal to the index price by construction: the treasury's holdings are the
 * basket in the basket's weights, so value per unit tracks the index exactly.
 * Kept as a named function because it is a genuinely different concept from
 * "price", and a real fund with tracking error would compute it from actual
 * holdings instead.
 */
export function nav() {
  return currentArv();
}

/** Units a net rupee amount buys at the live NAV. */
export function unitsFor(netPaise) {
  var n = nav();
  if (!n || n <= 0) return 0;
  return roundUnits(Math.floor(((netPaise / 100) / n) * 1e8) / 1e8);
}

/** Config sanity, surfaced in the admin panel. */
export function selfCheck() {
  var problems = CFG.configWarnings();
  var arv = currentArv();
  if (arv != null && (!isFinite(arv) || arv <= 0)) {
    problems.push('Computed ARV price is not a positive number: ' + arv);
  }
  var atLaunch = arvFromUsd(IDX.baseUsd, IDX.baseFxUsdInr);
  if (atLaunch != null && Math.abs(atLaunch - IDX.arvBaseInr) > 1e-9) {
    problems.push(
      'Index does not evaluate to ' + IDX.arvBaseInr + ' at launch prices (got ' +
      atLaunch.toFixed(8) + ') — base prices and weights disagree'
    );
  }
  return problems;
}
