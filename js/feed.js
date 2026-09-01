/**
 * Market data feed.
 *
 * Every adapter normalises to one shape so nothing downstream knows or cares
 * which exchange answered:
 *
 *   candle = { t: openTimeMs, o, h, l, c, v }     // prices in USD, ascending
 *   tick   = { key, priceUsd, ts }
 *
 * Why there are five of these
 * ---------------------------
 * Exchange APIs are geo-restricted, and which ones are blocked depends on
 * where the browser is. Measured from this sandbox (US egress, 2026-09-01):
 * Binance and Bybit both refuse outright, while OKX, Coinbase and Kraken all
 * answer. From an Indian connection the pattern is usually different. Hardcoding
 * one exchange means the chart is blank for some fraction of users with no
 * diagnosis available, so instead the feed probes the configured order at
 * startup, takes the first source that responds, and fails over mid-session if
 * that source goes quiet.
 *
 * Timeframes are only fetched natively where an exchange supports them.
 * Anything else is rolled up locally from a smaller candle, which is lossless
 * as long as the smaller one divides it evenly.
 */

var CFG = globalThis.ARV_CONFIG;

export var TF_MINUTES = {
  '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440, '1W': 10080
};

function tfMs(tf) { return TF_MINUTES[tf] * 60000; }

function num(x) { return typeof x === 'number' ? x : parseFloat(x); }

function withTimeout(ms) {
  var ac = new AbortController();
  var t = setTimeout(function () { ac.abort(); }, ms);
  return { signal: ac.signal, done: function () { clearTimeout(t); } };
}

async function getJson(url, signal) {
  var r = await fetch(url, { signal: signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

function ascending(rows) {
  return rows.sort(function (a, b) { return a.t - b.t; });
}

/* ========================================================== ADAPTERS ======= */

var ADAPTERS = {

  /* ------------------------------------------------------------- Binance --- */
  binance: {
    label: 'Binance',
    supports: ['1m', '5m', '15m', '1h', '4h', '1D', '1W'],
    maxPerCall: 1000,
    hasSocket: true,
    tfMap: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' },
    rest: 'https://api.binance.com/api/v3',

    async probe(signal) {
      var j = await getJson(this.rest + '/klines?symbol=BTCUSDT&interval=1m&limit=1', signal);
      // Binance answers a geo-block with HTTP 451 *or* a 200 carrying a code/msg
      // object, so a successful status alone is not enough to trust it.
      if (!Array.isArray(j)) throw new Error('binance: ' + (j && j.msg ? j.msg : 'unexpected shape'));
      return true;
    },

    async candles(sym, tf, opts) {
      var o = opts || {};
      var u = this.rest + '/klines?symbol=' + sym + '&interval=' + this.tfMap[tf] +
              '&limit=' + Math.min(o.limit || 500, this.maxPerCall);
      if (o.startMs) u += '&startTime=' + o.startMs;
      if (o.endMs) u += '&endTime=' + o.endMs;
      var j = await getJson(u, o.signal);
      if (!Array.isArray(j)) throw new Error('binance: bad payload');
      return ascending(j.map(function (k) {
        return { t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) };
      }));
    },

    socket(assets, onTick) {
      var streams = assets.map(function (a) {
        return a.symbols.binance.toLowerCase() + '@kline_1m';
      }).join('/');
      var ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + streams);
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.binance] = a.key; });
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          var k = m && m.data && m.data.k;
          if (!k) return;
          var key = bySym[k.s];
          if (!key) return;
          onTick({
            key: key, priceUsd: num(k.c), ts: Date.now(),
            candle: { t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v), closed: !!k.x }
          });
        } catch (_) { /* ignore malformed frame */ }
      };
      return ws;
    }
  },

  /* ----------------------------------------------------------------- OKX --- */
  okx: {
    label: 'OKX',
    supports: ['1m', '5m', '15m', '1h', '4h', '1D', '1W'],
    maxPerCall: 300,
    maxPerHistoryCall: 100,
    hasSocket: true,
    tfMap: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1D': '1D', '1W': '1W' },
    rest: 'https://www.okx.com/api/v5/market',

    async probe(signal) {
      var j = await getJson(this.rest + '/candles?instId=BTC-USDT&bar=1m&limit=1', signal);
      if (!j || j.code !== '0' || !j.data || !j.data.length) throw new Error('okx: ' + (j && j.msg));
      return true;
    },

    async candles(sym, tf, opts) {
      var o = opts || {};
      // OKX splits recent and archived data across two endpoints. `after` means
      // "older than this timestamp", which is the opposite of what the name
      // suggests, and is how you page backwards through history.
      var useHistory = !!o.endMs;
      var base = useHistory ? '/history-candles' : '/candles';
      var cap = useHistory ? this.maxPerHistoryCall : this.maxPerCall;
      var u = this.rest + base + '?instId=' + sym + '&bar=' + this.tfMap[tf] +
              '&limit=' + Math.min(o.limit || cap, cap);
      if (o.endMs) u += '&after=' + o.endMs;
      var j = await getJson(u, o.signal);
      if (!j || j.code !== '0') throw new Error('okx: ' + (j && j.msg));
      return ascending((j.data || []).map(function (d) {
        return { t: num(d[0]), o: num(d[1]), h: num(d[2]), l: num(d[3]), c: num(d[4]), v: num(d[5]) };
      }));
    },

    socket(assets, onTick) {
      var ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.okx] = a.key; });
      ws.onopen = function () {
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: assets.map(function (a) { return { channel: 'tickers', instId: a.symbols.okx }; })
        }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (!m.data || !m.arg || m.arg.channel !== 'tickers') return;
          m.data.forEach(function (d) {
            var key = bySym[d.instId];
            if (key) onTick({ key: key, priceUsd: num(d.last), ts: num(d.ts) || Date.now() });
          });
        } catch (_) { /* ignore */ }
      };
      return ws;
    }
  },

  /* ------------------------------------------------------------ Coinbase --- */
  coinbase: {
    label: 'Coinbase',
    // No native 4h or 1W. Both are exact multiples of supported sizes, so they
    // are rolled up locally instead.
    supports: ['1m', '5m', '15m', '1h', '1D'],
    maxPerCall: 300,
    hasSocket: true,
    granMap: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 },
    rest: 'https://api.exchange.coinbase.com',

    async probe(signal) {
      var j = await getJson(this.rest + '/products/BTC-USD/candles?granularity=60', signal);
      if (!Array.isArray(j) || !j.length) throw new Error('coinbase: empty');
      return true;
    },

    async candles(sym, tf, opts) {
      var o = opts || {};
      var gran = this.granMap[tf];
      var limit = Math.min(o.limit || this.maxPerCall, this.maxPerCall);
      var end = o.endMs || Date.now();
      var start = o.startMs || (end - limit * gran * 1000);
      var u = this.rest + '/products/' + sym + '/candles?granularity=' + gran +
              '&start=' + new Date(start).toISOString() +
              '&end=' + new Date(end).toISOString();
      var j = await getJson(u, o.signal);
      if (!Array.isArray(j)) throw new Error('coinbase: bad payload');
      // Coinbase orders each row [time, low, high, open, close, volume] — low
      // and high come before open and close, unlike every other exchange here.
      return ascending(j.map(function (k) {
        return {
          t: num(k[0]) * 1000,
          o: num(k[3]), h: num(k[2]), l: num(k[1]), c: num(k[4]), v: num(k[5])
        };
      }));
    },

    socket(assets, onTick) {
      var ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.coinbase] = a.key; });
      ws.onopen = function () {
        ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: assets.map(function (a) { return a.symbols.coinbase; }),
          channels: ['ticker']
        }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.type !== 'ticker' || !m.price) return;
          var key = bySym[m.product_id];
          if (key) onTick({ key: key, priceUsd: num(m.price), ts: Date.now() });
        } catch (_) { /* ignore */ }
      };
      return ws;
    }
  },

  /* -------------------------------------------------------------- Kraken --- */
  kraken: {
    label: 'Kraken',
    supports: ['1m', '5m', '15m', '1h', '4h', '1D', '1W'],
    maxPerCall: 720,
    hasSocket: true,
    // Kraken takes the interval in minutes.
    tfMap: { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440, '1W': 10080 },
    wsSymbols: { XBTUSD: 'BTC/USD', ETHUSD: 'ETH/USD', SOLUSD: 'SOL/USD' },
    rest: 'https://api.kraken.com/0/public',

    async probe(signal) {
      var j = await getJson(this.rest + '/OHLC?pair=XBTUSD&interval=1', signal);
      if (!j || (j.error && j.error.length) || !j.result) throw new Error('kraken: ' + (j && j.error));
      return true;
    },

    async candles(sym, tf, opts) {
      var o = opts || {};
      // Kraken only offers `since` as a lower bound and always returns the most
      // recent window from there, so it cannot page backwards into deep
      // history. Fine for live and recent data, weak for a long backfill.
      var u = this.rest + '/OHLC?pair=' + sym + '&interval=' + this.tfMap[tf];
      if (o.startMs) u += '&since=' + Math.floor(o.startMs / 1000);
      var j = await getJson(u, o.signal);
      if (!j || !j.result) throw new Error('kraken: bad payload');
      var key = Object.keys(j.result).find(function (k) { return k !== 'last'; });
      var rows = j.result[key] || [];
      return ascending(rows.map(function (k) {
        return { t: num(k[0]) * 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[6]) };
      }));
    },

    socket(assets, onTick) {
      var self = this;
      var ws = new WebSocket('wss://ws.kraken.com/v2');
      var bySym = {};
      var wsSyms = [];
      assets.forEach(function (a) {
        var w = self.wsSymbols[a.symbols.kraken];
        if (w) { bySym[w] = a.key; wsSyms.push(w); }
      });
      ws.onopen = function () {
        ws.send(JSON.stringify({
          method: 'subscribe',
          params: { channel: 'ticker', symbol: wsSyms }
        }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.channel !== 'ticker' || !m.data) return;
          m.data.forEach(function (d) {
            var key = bySym[d.symbol];
            if (key && d.last) onTick({ key: key, priceUsd: num(d.last), ts: Date.now() });
          });
        } catch (_) { /* ignore */ }
      };
      return ws;
    }
  },

  /* ----------------------------------------------------------- CoinGecko --- */
  coingecko: {
    label: 'CoinGecko',
    // Aggregator, not an exchange: no intraday candles on the free tier and no
    // streaming. Last resort — it keeps spot prices and the daily chart alive
    // when every exchange is unreachable.
    supports: ['1D'],
    maxPerCall: 365,
    hasSocket: false,
    rest: 'https://api.coingecko.com/api/v3',

    async probe(signal) {
      var j = await getJson(this.rest + '/simple/price?ids=bitcoin&vs_currencies=usd', signal);
      if (!j || !j.bitcoin || !j.bitcoin.usd) throw new Error('coingecko: no price');
      return true;
    },

    async candles(id, tf, opts) {
      var o = opts || {};
      var days = Math.min(o.limit || 365, 365);
      var j = await getJson(
        this.rest + '/coins/' + id + '/ohlc?vs_currency=usd&days=' + days, o.signal
      );
      if (!Array.isArray(j)) throw new Error('coingecko: bad payload');
      return ascending(j.map(function (k) {
        return { t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: 0 };
      }));
    },

    async spot(ids, signal) {
      var j = await getJson(
        this.rest + '/simple/price?ids=' + ids.join(',') + '&vs_currencies=usd', signal
      );
      return j;
    }
  }
};

/* ======================================================= ROLLUP =========== */

/**
 * Aggregate candles into a larger timeframe.
 *
 * Open is the first open in the bucket, close the last close, high/low the
 * extremes, volume the sum. Buckets are aligned to the epoch, which matches
 * how exchanges align theirs for every size up to 1D.
 *
 * Weekly is aligned to Monday rather than the epoch, because the epoch fell on
 * a Thursday and a chart with Thursday-opening weeks looks broken.
 */
export function rollup(candles, tf) {
  var size = tfMs(tf);
  if (!candles.length) return [];

  var out = [];
  var cur = null;

  function bucketOf(t) {
    if (tf === '1W') {
      var d = new Date(t);
      var dow = (d.getUTCDay() + 6) % 7;               // Monday = 0
      var monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000;
      return monday;
    }
    return Math.floor(t / size) * size;
  }

  for (var i = 0; i < candles.length; i++) {
    var k = candles[i];
    var b = bucketOf(k.t);
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0 };
    } else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Largest natively-supported timeframe that divides `tf` evenly. */
function sourceTfFor(adapter, tf) {
  if (adapter.supports.indexOf(tf) !== -1) return tf;
  var want = TF_MINUTES[tf];
  var best = null;
  adapter.supports.forEach(function (s) {
    var m = TF_MINUTES[s];
    if (want % m === 0 && (best === null || m > TF_MINUTES[best])) best = s;
  });
  return best;
}

/* ======================================================= FEED ============= */

var state = {
  source: null,
  adapter: null,
  ws: null,
  wsAttempt: 0,
  wsWatchdog: null,
  lastTickAt: 0,
  prices: Object.create(null),      // key -> USD
  listeners: [],
  statusListeners: [],
  pollTimer: null,
  healthTimer: null,
  probing: null,
  stopped: false
};

/* -------------------------------------------------------- source memory ---- */

/**
 * Remember which source answered last time.
 *
 * Probing walks the configured order and eats one timeout per unreachable
 * exchange. Since reachability is a property of the network rather than the
 * moment, re-discovering it on every page load is wasted latency — and every
 * failed probe also writes a red network error into the console, which makes a
 * working app look broken to anyone who opens dev tools.
 *
 * So the winner is cached and tried first. The full order is still walked if it
 * stops working, which is what makes this a hint rather than a decision.
 */
var LS_SOURCE = 'arv.feed.source';

function rememberSource(name) {
  try {
    localStorage.setItem(LS_SOURCE, JSON.stringify({ name: name, at: Date.now() }));
  } catch (_) { /* private mode */ }
}

function recalledSource() {
  try {
    var raw = localStorage.getItem(LS_SOURCE);
    if (!raw) return null;
    var c = JSON.parse(raw);
    // Expire after a day: networks change, and a stale hint should not pin the
    // app to a worse source forever.
    if (!c || !c.name || (Date.now() - c.at) > 86400000) return null;
    return CFG.FEED.sources.indexOf(c.name) !== -1 ? c.name : null;
  } catch (_) { return null; }
}

function forgetSource() {
  try { localStorage.removeItem(LS_SOURCE); } catch (_) {}
}

function allAssets() {
  return CFG.BASKET.concat(CFG.WATCHLIST);
}

function assetByKey(key) {
  return allAssets().find(function (a) { return a.key === key; });
}

function emitStatus() {
  var s = status();
  state.statusListeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
}

/**
 * Pick a source. Probes in configured order and takes the first that answers
 * within the timeout, so a blocked exchange costs one timeout, not the session.
 */
export async function selectSource(force) {
  if (state.adapter && !force) return state.source;
  if (state.probing) return state.probing;

  state.probing = (async function () {
    // Last known-good source first, then the configured order.
    var order = CFG.FEED.sources.slice();
    var remembered = force ? null : recalledSource();
    if (remembered) {
      order = [remembered].concat(order.filter(function (n) { return n !== remembered; }));
    }

    var tried = [];
    for (var i = 0; i < order.length; i++) {
      var name = order[i];
      var ad = ADAPTERS[name];
      if (!ad) continue;
      var t = withTimeout(CFG.FEED.probeTimeoutMs);
      try {
        await ad.probe(t.signal);
        t.done();
        state.adapter = ad;
        state.source = name;
        rememberSource(name);
        emitStatus();
        return name;
      } catch (e) {
        t.done();
        tried.push(name + ' (' + (e && e.message ? e.message.slice(0, 60) : 'failed') + ')');
      }
    }
    forgetSource();
    throw new Error('No market data source reachable. Tried: ' + tried.join(', '));
  })();

  try {
    return await state.probing;
  } finally {
    state.probing = null;
  }
}

/**
 * Candles for one asset at one timeframe, in USD, ascending.
 * Rolls up automatically when the chosen source lacks the timeframe natively.
 */
export async function candles(assetKey, tf, opts) {
  var o = opts || {};
  await selectSource();
  var ad = state.adapter;
  var asset = assetByKey(assetKey);
  if (!asset) throw new Error('Unknown asset ' + assetKey);

  var srcTf = sourceTfFor(ad, tf);
  if (!srcTf) throw new Error(ad.label + ' cannot serve ' + tf);

  var factor = TF_MINUTES[tf] / TF_MINUTES[srcTf];
  var sym = asset.symbols[state.source];
  var t = withTimeout(20000);
  try {
    var raw = await ad.candles(sym, srcTf, {
      limit: Math.min((o.limit || 500) * factor, ad.maxPerCall),
      startMs: o.startMs,
      endMs: o.endMs,
      signal: t.signal
    });
    t.done();
    return factor === 1 ? raw : rollup(raw, tf);
  } catch (e) {
    t.done();
    throw e;
  }
}

/**
 * Page backwards to assemble a long history.
 *
 * Public APIs cap each response at a few hundred candles, so a multi-month
 * window needs many calls. Requests are spaced out deliberately — hammering a
 * free endpoint is the fastest way to get rate-limited into a 429 and end up
 * with a broken chart.
 */
export async function candlesRange(assetKey, tf, fromMs, toMs, onProgress) {
  await selectSource();
  var ad = state.adapter;
  var srcTf = sourceTfFor(ad, tf) || tf;
  var step = ad.maxPerCall;
  var end = toMs || Date.now();
  var acc = [];
  var guard = 0;

  while (end > fromMs && guard < 200) {
    guard++;
    var batch;
    try {
      batch = await candles(assetKey, srcTf, { limit: step, endMs: end });
    } catch (e) {
      break;   // partial history beats none
    }
    if (!batch.length) break;

    acc = batch.concat(acc);
    var oldest = batch[0].t;
    if (oldest >= end) break;             // no progress — stop rather than loop
    end = oldest - 1;

    if (onProgress) onProgress({ oldest: oldest, count: acc.length, from: fromMs });
    await new Promise(function (r) { setTimeout(r, 220); });
  }

  // De-duplicate on open time; overlapping pages are normal.
  var seen = Object.create(null);
  var dedup = [];
  ascending(acc).forEach(function (k) {
    if (!seen[k.t] && k.t >= fromMs) { seen[k.t] = 1; dedup.push(k); }
  });

  return TF_MINUTES[tf] === TF_MINUTES[srcTf] ? dedup : rollup(dedup, tf);
}

/** Latest spot price in USD for every tracked asset. */
export async function spot() {
  await selectSource();
  var out = Object.create(null);
  var assets = allAssets();

  if (state.source === 'coingecko') {
    var ids = assets.map(function (a) { return a.symbols.coingecko; });
    var t = withTimeout(12000);
    try {
      var j = await ADAPTERS.coingecko.spot(ids, t.signal);
      t.done();
      assets.forEach(function (a) {
        var v = j[a.symbols.coingecko];
        if (v && v.usd) out[a.key] = v.usd;
      });
      return out;
    } catch (e) { t.done(); throw e; }
  }

  // One 1m candle per asset is the cheapest universally-available spot read.
  await Promise.all(assets.map(async function (a) {
    try {
      var c = await candles(a.key, '1m', { limit: 1 });
      if (c.length) out[a.key] = c[c.length - 1].c;
    } catch (_) { /* leave this asset out */ }
  }));
  return out;
}

/* ------------------------------------------------------------ live stream -- */

function handleTick(tick) {
  state.prices[tick.key] = tick.priceUsd;
  state.lastTickAt = Date.now();
  state.listeners.forEach(function (fn) { try { fn(tick); } catch (_) {} });
}

function openSocket() {
  var ad = state.adapter;
  if (!ad || !ad.hasSocket || state.stopped) return;

  try {
    var ws = ad.socket(allAssets(), handleTick);
    state.ws = ws;

    // A WebSocket that never opens is a price that never updates. Corporate
    // proxies and captive networks routinely allow HTTPS while blocking wss,
    // and the failure mode is silent: the socket simply sits in CONNECTING.
    // So if it has not opened shortly, start polling as well — reconnection
    // keeps trying in the background, and if it eventually succeeds the poller
    // is stood down.
    clearTimeout(state.wsWatchdog);
    state.wsWatchdog = setTimeout(function () {
      if (state.stopped) return;
      if (!state.ws || state.ws.readyState !== 1) startPolling();
    }, 8000);

    ws.onopen = (function (orig) {
      return function (ev) {
        state.wsAttempt = 0;
        state.lastTickAt = Date.now();
        clearTimeout(state.wsWatchdog);
        stopPolling();
        if (orig) orig.call(ws, ev);
        emitStatus();
      };
    })(ws.onopen);

    ws.onclose = function () {
      state.ws = null;
      if (state.stopped) return;
      // Keep data flowing over REST while the socket is down.
      startPolling();
      emitStatus();
      scheduleReconnect();
    };

    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  } catch (_) {
    startPolling();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.stopped) return;
  state.wsAttempt++;
  // Exponential backoff with jitter. Without jitter, every open tab reconnects
  // in lockstep after an outage and re-creates the thundering herd.
  var base = Math.min(
    CFG.FEED.wsReconnectBaseMs * Math.pow(2, state.wsAttempt - 1),
    CFG.FEED.wsReconnectMaxMs
  );
  var delay = base * (0.7 + Math.random() * 0.6);
  setTimeout(function () {
    if (!state.stopped && !state.ws) openSocket();
  }, delay);
}

function startPolling() {
  if (state.pollTimer || state.stopped) return;

  var poll = async function () {
    if (state.stopped) return;
    try {
      var s = await spot();
      Object.keys(s).forEach(function (k) {
        handleTick({ key: k, priceUsd: s[k], ts: Date.now() });
      });
    } catch (_) { /* next tick */ }
  };

  state.pollTimer = setInterval(poll, CFG.FEED.pollFallbackMs);
  poll();          // don't wait a full interval for the first update
  emitStatus();
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  emitStatus();
}

/**
 * Watchdog. A WebSocket can stay open and simply stop delivering — that reads
 * as a frozen price rather than an error, which is worse than a visible
 * failure. If nothing arrives inside the stale window, drop the source and
 * re-probe from the top of the chain.
 */
function startHealthCheck() {
  if (state.healthTimer) return;
  state.healthTimer = setInterval(async function () {
    if (state.stopped) return;
    var quiet = Date.now() - state.lastTickAt;
    if (state.lastTickAt && quiet > CFG.FEED.staleAfterMs) {
      try { if (state.ws) state.ws.close(); } catch (_) {}
      state.ws = null;
      state.adapter = null;
      state.source = null;
      emitStatus();
      try {
        await selectSource(true);
        if (state.adapter.hasSocket) openSocket(); else startPolling();
      } catch (_) { /* retry next interval */ }
    }
  }, 20000);
}

/** Begin streaming. Idempotent. */
export async function start() {
  state.stopped = false;
  await selectSource();

  // Seed immediately so the UI has numbers before the first frame arrives.
  try {
    var s = await spot();
    Object.keys(s).forEach(function (k) {
      handleTick({ key: k, priceUsd: s[k], ts: Date.now() });
    });
  } catch (_) { /* the socket may still succeed */ }

  if (state.adapter.hasSocket) openSocket(); else startPolling();
  startHealthCheck();
  return status();
}

export function stop() {
  state.stopped = true;
  try { if (state.ws) state.ws.close(); } catch (_) {}
  state.ws = null;
  clearTimeout(state.wsWatchdog); state.wsWatchdog = null;
  clearInterval(state.pollTimer); state.pollTimer = null;
  clearInterval(state.healthTimer); state.healthTimer = null;
}

export function onTick(fn) {
  state.listeners.push(fn);
  return function () {
    state.listeners = state.listeners.filter(function (f) { return f !== fn; });
  };
}

export function onStatus(fn) {
  state.statusListeners.push(fn);
  fn(status());
  return function () {
    state.statusListeners = state.statusListeners.filter(function (f) { return f !== fn; });
  };
}

export function priceUsd(key) {
  return state.prices[key];
}

export function allPricesUsd() {
  return Object.assign(Object.create(null), state.prices);
}

export function status() {
  var quiet = state.lastTickAt ? Date.now() - state.lastTickAt : null;
  // OPEN, not merely constructed. A socket stuck in CONNECTING is not live, and
  // reporting it as live is how a frozen price gets mistaken for a calm market.
  var socketOpen = !!(state.ws && state.ws.readyState === 1);
  return {
    source: state.source,
    label: state.adapter ? state.adapter.label : null,
    live: socketOpen || !!state.pollTimer,
    mode: socketOpen ? 'websocket' : (state.pollTimer ? 'polling' : 'connecting'),
    lastTickAt: state.lastTickAt,
    stale: quiet != null && quiet > CFG.FEED.staleAfterMs,
    prices: allPricesUsd()
  };
}

export function sourceLabels() {
  return CFG.FEED.sources.map(function (n) {
    return { name: n, label: ADAPTERS[n] ? ADAPTERS[n].label : n };
  });
}
