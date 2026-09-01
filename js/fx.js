/**
 * USD/INR.
 *
 * Bitcoin is quoted in dollars everywhere; ARV is quoted in rupees. That
 * conversion sits directly in the price path, so it gets its own module with
 * its own cache, its own fallback chain and its own historical lookup.
 *
 * FX moves slowly compared to crypto, so a cached rate a few hours old is
 * fine — and much better than blocking the price feed on a currency API.
 */

var CFG = globalThis.ARV_CONFIG;
var LS_KEY = 'arv.fx.usdinr';

var state = {
  rate: null,
  asOf: 0,
  source: null,
  inflight: null
};

/* ---------------------------------------------------------------- sources ---- */

var SOURCES = {
  frankfurter: {
    label: 'Frankfurter',
    latest: async function (signal) {
      var r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', { signal });
      if (!r.ok) throw new Error('frankfurter ' + r.status);
      var j = await r.json();
      var v = j && j.rates && j.rates.INR;
      if (!v) throw new Error('frankfurter: no INR');
      return v;
    },
    onDate: async function (iso, signal) {
      var day = iso.slice(0, 10);
      var r = await fetch('https://api.frankfurter.dev/v1/' + day + '?base=USD&symbols=INR', { signal });
      if (!r.ok) throw new Error('frankfurter hist ' + r.status);
      var j = await r.json();
      var v = j && j.rates && j.rates.INR;
      if (!v) throw new Error('frankfurter hist: no INR');
      return v;
    }
  },

  erapi: {
    label: 'ExchangeRate-API',
    latest: async function (signal) {
      var r = await fetch('https://open.er-api.com/v6/latest/USD', { signal });
      if (!r.ok) throw new Error('erapi ' + r.status);
      var j = await r.json();
      var v = j && j.rates && j.rates.INR;
      if (!v) throw new Error('erapi: no INR');
      return v;
    },
    onDate: null
  },

  coingecko: {
    // Derived, not quoted: CoinGecko returns Bitcoin in both USD and INR, and
    // the ratio of the two is an implied FX rate. Accurate to within a few
    // basis points, and useful precisely when dedicated FX APIs are blocked.
    label: 'CoinGecko (implied)',
    latest: async function (signal) {
      var r = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,inr',
        { signal }
      );
      if (!r.ok) throw new Error('coingecko fx ' + r.status);
      var j = await r.json();
      var b = j && j.bitcoin;
      if (!b || !b.usd || !b.inr) throw new Error('coingecko fx: incomplete');
      return b.inr / b.usd;
    },
    onDate: null
  }
};

/* ------------------------------------------------------------------ cache ---- */

function readCache() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    var c = JSON.parse(raw);
    if (!c || !c.rate) return null;
    return c;
  } catch (_) { return null; }
}

function writeCache(rate, source) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      rate: rate, asOf: Date.now(), source: source
    }));
  } catch (_) { /* private browsing — not fatal */ }
}

/* -------------------------------------------------------------------- api ---- */

function withTimeout(ms) {
  var ac = new AbortController();
  var t = setTimeout(function () { ac.abort(); }, ms);
  return { signal: ac.signal, done: function () { clearTimeout(t); } };
}

/**
 * Current USD/INR. Resolves from cache instantly when fresh, otherwise walks
 * the source chain. Always resolves — falls back to the configured constant
 * rather than throwing, because a missing FX rate must not blank the price.
 */
export async function getRate(opts) {
  var o = opts || {};
  var maxAge = o.maxAgeMs != null ? o.maxAgeMs : CFG.FEED.fx.refreshMs;

  if (state.rate && (Date.now() - state.asOf) < maxAge) return state.rate;

  var cached = readCache();
  if (cached && (Date.now() - cached.asOf) < maxAge) {
    state.rate = cached.rate;
    state.asOf = cached.asOf;
    state.source = cached.source;
    return state.rate;
  }

  if (state.inflight) return state.inflight;

  state.inflight = (async function () {
    for (var i = 0; i < CFG.FEED.fx.sources.length; i++) {
      var name = CFG.FEED.fx.sources[i];
      var src = SOURCES[name];
      if (!src) continue;
      var t = withTimeout(CFG.FEED.probeTimeoutMs);
      try {
        var v = await src.latest(t.signal);
        t.done();
        if (v > 0) {
          state.rate = v;
          state.asOf = Date.now();
          state.source = name;
          writeCache(v, name);
          return v;
        }
      } catch (_) {
        t.done();
      }
    }
    // Every source failed. A stale cached rate beats a hardcoded one.
    if (cached && cached.rate) {
      state.rate = cached.rate;
      state.asOf = cached.asOf;
      state.source = cached.source + ' (stale)';
      return state.rate;
    }
    state.rate = CFG.FEED.fx.fallbackRate;
    state.asOf = Date.now();
    state.source = 'config fallback';
    return state.rate;
  })();

  try {
    return await state.inflight;
  } finally {
    state.inflight = null;
  }
}

/**
 * USD/INR on a specific date, for valuing historical candles.
 *
 * Only Frankfurter serves history on the free tier, and it has no weekend or
 * holiday quotes, so it snaps backwards to the previous business day. If
 * history is unavailable the current rate is returned — which introduces a
 * small distortion in old candles, so callers that care should say so in the UI.
 */
var histCache = Object.create(null);

export async function getRateOn(iso) {
  var day = String(iso).slice(0, 10);
  if (histCache[day]) return histCache[day];

  for (var i = 0; i < CFG.FEED.fx.sources.length; i++) {
    var src = SOURCES[CFG.FEED.fx.sources[i]];
    if (!src || !src.onDate) continue;
    var t = withTimeout(CFG.FEED.probeTimeoutMs);
    try {
      var v = await src.onDate(day, t.signal);
      t.done();
      if (v > 0) { histCache[day] = v; return v; }
    } catch (_) {
      t.done();
    }
  }
  return await getRate();
}

/** Cached rate without triggering a fetch. Null if nothing is known yet. */
export function peekRate() {
  if (state.rate) return state.rate;
  var c = readCache();
  return c ? c.rate : null;
}

export function meta() {
  return { rate: state.rate, asOf: state.asOf, source: state.source };
}

/** Convert a USD figure to the configured quote currency. */
export function toQuote(usd, rate) {
  if (CFG.INDEX.quote !== 'INR') return usd;
  var r = rate || state.rate || peekRate() || CFG.FEED.fx.fallbackRate;
  return usd * r;
}


/* ------------------------------------------------------------- rate curve -- */

/**
 * Daily USD/INR series across a date range, in a single request.
 *
 * This exists because valuing 20 months of Bitcoin candles in rupees needs a
 * rupee rate *per candle*, not one rate applied to all of history. Using
 * today's rate throughout would push the entire currency move of the period
 * into the chart as if it were a Bitcoin move, and the further back you look
 * the more wrong the number gets.
 *
 * Frankfurter publishes business-day rates only — no weekends, no holidays —
 * so the returned curve is forward-filled and exposed through a lookup that
 * snaps to the most recent prior quote.
 */
var curveCache = Object.create(null);

export async function getRateCurve(fromMs, toMs) {
  var from = new Date(fromMs).toISOString().slice(0, 10);
  var to = new Date(toMs || Date.now()).toISOString().slice(0, 10);
  var ck = from + '..' + to;
  if (curveCache[ck]) return curveCache[ck];

  var t = withTimeout(20000);
  try {
    var r = await fetch(
      'https://api.frankfurter.dev/v1/' + from + '..' + to + '?base=USD&symbols=INR',
      { signal: t.signal }
    );
    t.done();
    if (!r.ok) throw new Error('curve ' + r.status);
    var j = await r.json();
    if (!j || !j.rates) throw new Error('curve: no rates');

    var days = Object.keys(j.rates).sort();
    var series = days.map(function (d) {
      return { day: d, ms: Date.parse(d + 'T00:00:00Z'), rate: j.rates[d].INR };
    }).filter(function (x) { return isFinite(x.rate); });

    if (!series.length) throw new Error('curve: empty');

    var curve = makeCurve(series);
    curveCache[ck] = curve;
    return curve;
  } catch (_) {
    t.done();
    // Flat curve at the current rate. Long-range charts will carry the
    // distortion described above; callers should surface that in the UI.
    var flat = await getRate();
    var fallback = makeCurve([{ day: from, ms: fromMs, rate: flat }]);
    fallback.degraded = true;
    curveCache[ck] = fallback;
    return fallback;
  }
}

function makeCurve(series) {
  return {
    series: series,
    degraded: false,
    /** Rate in effect at a timestamp — the latest quote at or before it. */
    at: function (ms) {
      if (ms <= series[0].ms) return series[0].rate;
      // Binary search for the last entry not after `ms`.
      var lo = 0, hi = series.length - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (series[mid].ms <= ms) lo = mid; else hi = mid - 1;
      }
      return series[lo].rate;
    }
  };
}
