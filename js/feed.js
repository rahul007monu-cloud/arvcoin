/**
 * Live market feed — trade by trade.
 *
 * ---------------------------------------------------------------------------
 * Why the trades channel and not a ticker
 * ---------------------------------------------------------------------------
 * A ticker channel sends a snapshot roughly once a second. That produces a price
 * that visibly steps rather than moves, and no tape at all. Subscribing to
 * individual executions instead gives what a trading screen is supposed to show:
 * every fill as it happens, several a second when the market is busy, each with
 * its own size and direction.
 *
 * Ticks arrive faster than a screen can usefully repaint, so rendering is
 * coalesced to `renderThrottleMs`. Nothing is dropped from the tape — only the
 * paint is throttled.
 *
 * ---------------------------------------------------------------------------
 * Why several exchanges
 * ---------------------------------------------------------------------------
 * Exchange APIs are geo-restricted, and which ones are blocked depends on where
 * the browser is. Measured from a US egress point: Binance and Bybit refuse
 * outright while OKX, Coinbase and Kraken answer; from an Indian connection the
 * pattern differs. So the feed probes the configured order, takes the first that
 * responds, remembers it, and fails over if it goes quiet.
 *
 * This feed is for *display*. Trades are priced by the server from its own stored
 * candles — a fill must never depend on what one browser happened to see.
 */

var CFG = globalThis.ARV_CONFIG;

export var TF_MINUTES = {
  '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440, '1W': 10080
};

var LS_SOURCE = 'arv.feed.source';

var state = {
  source: null,
  adapter: null,
  ws: null,
  wsAttempt: 0,
  wsWatchdog: null,
  pollTimer: null,
  healthTimer: null,
  lastTickAt: 0,
  prices: Object.create(null),     // key -> USD
  tape: [],                        // newest first
  tickListeners: [],
  tradeListeners: [],
  statusListeners: [],
  pendingPaint: null,
  probing: null,
  stopped: false
};

/* ------------------------------------------------------------------ utils -- */

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

function rememberSource(name) {
  try { localStorage.setItem(LS_SOURCE, JSON.stringify({ name: name, at: Date.now() })); }
  catch (_) {}
}

function recalledSource() {
  try {
    var c = JSON.parse(localStorage.getItem(LS_SOURCE) || 'null');
    if (!c || !c.name || (Date.now() - c.at) > 86400000) return null;
    return CFG.FEED.sources.indexOf(c.name) !== -1 ? c.name : null;
  } catch (_) { return null; }
}

/* =========================================================== adapters ===== */

var ADAPTERS = {

  binance: {
    label: 'Binance',
    hasSocket: true,
    async probe(signal) {
      var j = await getJson('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1', signal);
      // A geo-block arrives as a 200 carrying {code, msg}, so a successful status
      // is not enough to trust.
      if (!Array.isArray(j)) throw new Error(j && j.msg ? j.msg : 'unexpected shape');
      return true;
    },
    socket(assets, onTrade) {
      var streams = assets.map(function (a) {
        return a.symbols.binance.toLowerCase() + '@trade';
      }).join('/');
      var ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + streams);
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.binance] = a.key; });

      ws.onmessage = function (ev) {
        try {
          var d = JSON.parse(ev.data).data;
          if (!d || !d.p) return;
          var key = bySym[d.s];
          if (!key) return;
          onTrade({
            key: key,
            priceUsd: num(d.p),
            size: num(d.q),
            // `m` is true when the buyer was the maker, i.e. a sell hit the bid.
            side: d.m ? 'sell' : 'buy',
            ts: d.T || Date.now()
          });
        } catch (_) {}
      };
      return ws;
    }
  },

  okx: {
    label: 'OKX',
    hasSocket: true,
    async probe(signal) {
      var j = await getJson('https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=1', signal);
      if (!j || j.code !== '0' || !j.data || !j.data.length) throw new Error(j && j.msg);
      return true;
    },
    socket(assets, onTrade) {
      var ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.okx] = a.key; });

      ws.onopen = function () {
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: assets.map(function (a) { return { channel: 'trades', instId: a.symbols.okx }; })
        }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (!m.data || !m.arg || m.arg.channel !== 'trades') return;
          m.data.forEach(function (d) {
            var key = bySym[d.instId];
            if (key) {
              onTrade({ key: key, priceUsd: num(d.px), size: num(d.sz), side: d.side, ts: num(d.ts) });
            }
          });
        } catch (_) {}
      };
      return ws;
    }
  },

  coinbase: {
    label: 'Coinbase',
    hasSocket: true,
    async probe(signal) {
      var j = await getJson('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60', signal);
      if (!Array.isArray(j) || !j.length) throw new Error('empty');
      return true;
    },
    socket(assets, onTrade) {
      var ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      var bySym = {};
      assets.forEach(function (a) { bySym[a.symbols.coinbase] = a.key; });

      ws.onopen = function () {
        ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: assets.map(function (a) { return a.symbols.coinbase; }),
          channels: ['matches']
        }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if ((m.type !== 'match' && m.type !== 'last_match') || !m.price) return;
          var key = bySym[m.product_id];
          if (key) {
            onTrade({
              key: key, priceUsd: num(m.price), size: num(m.size),
              // Coinbase reports the resting side, so the aggressor is the other one.
              side: m.side === 'sell' ? 'buy' : 'sell',
              ts: m.time ? Date.parse(m.time) : Date.now()
            });
          }
        } catch (_) {}
      };
      return ws;
    }
  },

  kraken: {
    label: 'Kraken',
    hasSocket: true,
    wsSymbols: { XBTUSD: 'BTC/USD', ETHUSD: 'ETH/USD', SOLUSD: 'SOL/USD', XRPUSD: 'XRP/USD' },
    async probe(signal) {
      var j = await getJson('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1', signal);
      if (!j || (j.error && j.error.length) || !j.result) throw new Error('bad payload');
      return true;
    },
    socket(assets, onTrade) {
      var self = this;
      var ws = new WebSocket('wss://ws.kraken.com/v2');
      var bySym = {};
      var syms = [];
      assets.forEach(function (a) {
        var w = self.wsSymbols[a.symbols.kraken];
        if (w) { bySym[w] = a.key; syms.push(w); }
      });

      ws.onopen = function () {
        ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: syms } }));
      };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.channel !== 'trade' || !m.data) return;
          m.data.forEach(function (d) {
            var key = bySym[d.symbol];
            if (key) {
              onTrade({
                key: key, priceUsd: num(d.price), size: num(d.qty),
                side: d.side, ts: d.timestamp ? Date.parse(d.timestamp) : Date.now()
              });
            }
          });
        } catch (_) {}
      };
      return ws;
    }
  },

  coingecko: {
    // Aggregator, not an exchange: no stream and no trades. Last resort so a spot
    // price still appears when every exchange is unreachable.
    label: 'CoinGecko',
    hasSocket: false,
    async probe(signal) {
      var j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', signal);
      if (!j || !j.bitcoin || !j.bitcoin.usd) throw new Error('no price');
      return true;
    },
    async spot(assets, signal) {
      var ids = assets.map(function (a) { return a.symbols.coingecko; }).join(',');
      var j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd', signal);
      var out = {};
      assets.forEach(function (a) {
        var v = j[a.symbols.coingecko];
        if (v && v.usd) out[a.key] = v.usd;
      });
      return out;
    }
  }
};

/* ============================================================== plumbing == */

function allAssets() {
  return CFG.BASKET.concat(CFG.WATCHLIST);
}

function emitStatus() {
  var s = status();
  state.statusListeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
}

/**
 * Handle one execution.
 *
 * The tape is updated synchronously so nothing is lost, but listeners are
 * notified on a throttle — a busy market can deliver dozens of trades a second
 * and repainting for each would starve the main thread for no visible gain.
 */
function handleTrade(t) {
  var prev = state.prices[t.key];
  state.prices[t.key] = t.priceUsd;
  state.lastTickAt = Date.now();

  if (CFG.BASKET.some(function (a) { return a.key === t.key; })) {
    state.tape.unshift({
      priceUsd: t.priceUsd,
      size: t.size,
      side: t.side || (prev != null ? (t.priceUsd >= prev ? 'buy' : 'sell') : 'buy'),
      ts: t.ts || Date.now()
    });
    if (state.tape.length > (CFG.FEED.tapeLength || 40)) state.tape.pop();

    state.tradeListeners.forEach(function (fn) { try { fn(state.tape[0]); } catch (_) {} });
  }

  schedulePaint(t);
}

function schedulePaint(t) {
  if (state.pendingPaint) return;
  state.pendingPaint = setTimeout(function () {
    state.pendingPaint = null;
    state.tickListeners.forEach(function (fn) { try { fn(t); } catch (_) {} });
  }, CFG.FEED.renderThrottleMs || 80);
}

/* ------------------------------------------------------------------ probe -- */

export async function selectSource(force) {
  if (state.adapter && !force) return state.source;
  if (state.probing) return state.probing;

  state.probing = (async function () {
    var order = CFG.FEED.sources.slice();
    var remembered = force ? null : recalledSource();
    if (remembered) {
      order = [remembered].concat(order.filter(function (n) { return n !== remembered; }));
    }

    var tried = [];
    for (var i = 0; i < order.length; i++) {
      var ad = ADAPTERS[order[i]];
      if (!ad) continue;
      var t = withTimeout(CFG.FEED.probeTimeoutMs);
      try {
        await ad.probe(t.signal);
        t.done();
        state.adapter = ad;
        state.source = order[i];
        rememberSource(order[i]);
        emitStatus();
        return order[i];
      } catch (e) {
        t.done();
        tried.push(order[i] + ' (' + ((e && e.message) || 'failed').slice(0, 40) + ')');
      }
    }
    try { localStorage.removeItem(LS_SOURCE); } catch (_) {}
    throw new Error('No market data source reachable. Tried: ' + tried.join(', '));
  })();

  try { return await state.probing; } finally { state.probing = null; }
}

/* ----------------------------------------------------------------- socket -- */

function openSocket() {
  var ad = state.adapter;
  if (!ad || !ad.hasSocket || state.stopped) return;

  try {
    var ws = ad.socket(allAssets(), handleTrade);
    state.ws = ws;

    // A socket that never opens is a price that never updates. Corporate proxies
    // and captive portals routinely allow HTTPS while blocking wss, and the
    // failure is silent — it just sits in CONNECTING. So if it has not opened
    // shortly, start polling as well; reconnection keeps trying underneath.
    clearTimeout(state.wsWatchdog);
    state.wsWatchdog = setTimeout(function () {
      if (state.stopped) return;
      if (!state.ws || state.ws.readyState !== 1) startPolling();
    }, CFG.FEED.wsOpenTimeoutMs || 8000);

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
  var base = Math.min(
    CFG.FEED.wsReconnectBaseMs * Math.pow(2, state.wsAttempt - 1),
    CFG.FEED.wsReconnectMaxMs
  );
  // Jitter. Without it every open tab reconnects in lockstep after an outage and
  // recreates the stampede that caused it.
  setTimeout(function () {
    if (!state.stopped && !state.ws) openSocket();
  }, base * (0.7 + Math.random() * 0.6));
}

/* ---------------------------------------------------------------- polling -- */

async function spotOnce() {
  var assets = allAssets();
  var ad = state.adapter;

  if (ad && ad.spot) {
    var t = withTimeout(12000);
    try {
      var out = await ad.spot(assets, t.signal);
      t.done();
      return out;
    } catch (e) { t.done(); throw e; }
  }

  // One 1m candle per asset is the cheapest spot read available everywhere.
  var res = {};
  await Promise.all(assets.map(async function (a) {
    try {
      var c = await candles(a.key, '1m', 1);
      if (c.length) res[a.key] = c[c.length - 1].c;
    } catch (_) {}
  }));
  return res;
}

function startPolling() {
  if (state.pollTimer || state.stopped) return;
  var run = async function () {
    if (state.stopped) return;
    try {
      var s = await spotOnce();
      Object.keys(s).forEach(function (k) {
        handleTrade({ key: k, priceUsd: s[k], size: 0, ts: Date.now() });
      });
    } catch (_) {}
  };
  state.pollTimer = setInterval(run, CFG.FEED.pollFallbackMs);
  run();
  emitStatus();
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  emitStatus();
}

/**
 * Watchdog.
 *
 * A WebSocket can stay open and simply stop delivering. That reads as a calm
 * market rather than a failure, which is worse than an error — so silence past
 * the stale window drops the source and re-probes from the top.
 */
function startHealthCheck() {
  if (state.healthTimer) return;
  state.healthTimer = setInterval(async function () {
    if (state.stopped) return;
    var quiet = state.lastTickAt ? Date.now() - state.lastTickAt : 0;
    if (state.lastTickAt && quiet > CFG.FEED.staleAfterMs) {
      try { if (state.ws) state.ws.close(); } catch (_) {}
      state.ws = null;
      state.adapter = null;
      state.source = null;
      emitStatus();
      try {
        await selectSource(true);
        if (state.adapter.hasSocket) openSocket(); else startPolling();
      } catch (_) {}
    }
  }, 20000);
}

/* ---------------------------------------------------------------- candles -- */

/**
 * Candles for a reference asset, in USD.
 *
 * Only used for the watchlist sparklines — ARV's own candles come from the
 * server, which is what gives them five years of depth.
 */
export async function candles(assetKey, tf, limit) {
  await selectSource();
  var asset = allAssets().find(function (a) { return a.key === assetKey; });
  if (!asset) throw new Error('Unknown asset ' + assetKey);

  var n = limit || 100;
  var t = withTimeout(15000);
  try {
    var out;
    switch (state.source) {
      case 'binance':
        out = (await getJson('https://api.binance.com/api/v3/klines?symbol=' + asset.symbols.binance
              + '&interval=' + tf + '&limit=' + n, t.signal))
          .map(function (k) { return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
        break;
      case 'okx':
        var bar = { '1h': '1H', '4h': '4H', '1D': '1D', '1W': '1W' }[tf] || tf;
        out = ((await getJson('https://www.okx.com/api/v5/market/candles?instId=' + asset.symbols.okx
              + '&bar=' + bar + '&limit=' + Math.min(n, 300), t.signal)).data || [])
          .map(function (k) { return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
        break;
      case 'coinbase':
        var gran = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 }[tf] || 60;
        out = (await getJson('https://api.exchange.coinbase.com/products/' + asset.symbols.coinbase
              + '/candles?granularity=' + gran, t.signal))
          // [time, low, high, open, close, volume] — low and high come first here.
          .map(function (k) { return { t: k[0] * 1000, o: k[3], h: k[2], l: k[1], c: k[4], v: k[5] }; });
        break;
      case 'kraken':
        var iv = TF_MINUTES[tf] || 1;
        var j = await getJson('https://api.kraken.com/0/public/OHLC?pair=' + asset.symbols.kraken
              + '&interval=' + iv, t.signal);
        var key = Object.keys(j.result || {}).find(function (k) { return k !== 'last'; });
        out = (j.result[key] || []).map(function (k) {
          return { t: +k[0] * 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] };
        });
        break;
      default:
        out = [];
    }
    t.done();
    return out.sort(function (a, b) { return a.t - b.t; }).slice(-n);
  } catch (e) {
    t.done();
    throw e;
  }
}

/* -------------------------------------------------------------------- api -- */

export async function start() {
  state.stopped = false;
  await selectSource();

  // Seed immediately so the UI has numbers before the first execution arrives.
  try {
    var s = await spotOnce();
    Object.keys(s).forEach(function (k) {
      handleTrade({ key: k, priceUsd: s[k], size: 0, ts: Date.now() });
    });
  } catch (_) {}

  if (state.adapter.hasSocket) openSocket(); else startPolling();
  startHealthCheck();

  if (CFG.UI.motion && CFG.UI.motion.pauseWhenHidden) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      // Re-probe on return if the tab slept through a disconnect.
      if (!state.ws && !state.pollTimer) start().catch(function () {});
    });
  }

  return status();
}

export function stop() {
  state.stopped = true;
  try { if (state.ws) state.ws.close(); } catch (_) {}
  state.ws = null;
  clearTimeout(state.wsWatchdog);
  clearInterval(state.pollTimer); state.pollTimer = null;
  clearInterval(state.healthTimer); state.healthTimer = null;
}

export function onTick(fn) {
  state.tickListeners.push(fn);
  return function () {
    state.tickListeners = state.tickListeners.filter(function (f) { return f !== fn; });
  };
}

export function onTrade(fn) {
  state.tradeListeners.push(fn);
  return function () {
    state.tradeListeners = state.tradeListeners.filter(function (f) { return f !== fn; });
  };
}

export function onStatus(fn) {
  state.statusListeners.push(fn);
  fn(status());
  return function () {
    state.statusListeners = state.statusListeners.filter(function (f) { return f !== fn; });
  };
}

export function priceUsd(key) { return state.prices[key]; }
export function allPricesUsd() { return Object.assign(Object.create(null), state.prices); }
export function getTape() { return state.tape.slice(); }

export function status() {
  var open = !!(state.ws && state.ws.readyState === 1);
  var quiet = state.lastTickAt ? Date.now() - state.lastTickAt : null;
  return {
    source: state.source,
    label: state.adapter ? state.adapter.label : null,
    live: open || !!state.pollTimer,
    mode: open ? 'websocket' : (state.pollTimer ? 'polling' : 'connecting'),
    // Only a real trade stream deserves to be called tick-by-tick; polling is a
    // fallback and should not be dressed up as one.
    tickByTick: open && state.adapter && state.adapter.hasSocket,
    lastTickAt: state.lastTickAt,
    stale: quiet != null && quiet > CFG.FEED.staleAfterMs,
    prices: allPricesUsd()
  };
}
