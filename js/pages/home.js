/**
 * Landing page.
 *
 * Everything here is computed from live data — the price, the chart, the worked
 * fee examples, the watchlist. Nothing is a screenshot or a hardcoded figure, so
 * what a visitor reads is what the trade screen will quote them a moment later.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';
import * as feed from '../feed.js';
import { reveal } from '../ui.js';

var CFG = globalThis.ARV_CONFIG;

var st = { snap: null, chart: null, series: null, candles: [], last: null };

/**
 * BTC->ARV scale for the whole series. ARV = base × (BTC_now_INR ÷ BTC_launch_INR),
 * so per candle ARV = BTC_usd × (base × fx ÷ BTC_launch_INR) — the same identity
 * the live price uses. Falls back to config anchors before the snapshot arrives.
 */
function arvScale() {
  var idx = st.snap && st.snap.index;
  if (idx && idx.base && idx.baseBtcInr > 0 && idx.fxUsdInr != null) {
    return idx.base * idx.fxUsdInr / idx.baseBtcInr;
  }
  var baseBtcInr = CFG.INDEX.baseUsd.BTC * CFG.INDEX.baseFxUsdInr;
  var fx = (idx && idx.fxUsdInr) || (CFG.FEED.fx && CFG.FEED.fx.fallbackRate) || 90;
  return baseBtcInr > 0 ? (CFG.INDEX.arvBaseInr * fx) / baseBtcInr : 0;
}

function applyScale(rows, s) {
  return rows.map(function (k) {
    return { t: k.t, o: k.o * s, h: k.h * s, l: k.l * s, c: k.c * s, v: k.v };
  });
}

/* ------------------------------------------------------------------ static -- */

function paintStatic() {
  ui.setText('[data-launch]', new Date(CFG.INDEX.launchMs).toLocaleDateString(CFG.UI.locale, {
    day: 'numeric', month: 'long', year: 'numeric'
  }));
  ui.setText('[data-fallback]', CFG.MARKET.sellFallbackMinutes + ' minutes');
}

/**
 * Decorative candles in the hero.
 *
 * Built from the real daily series once it loads, so the shape a visitor sees is
 * actually Bitcoin's recent behaviour rather than invented noise. Falls back to a
 * fixed pattern if the series is unavailable — a hero should never be empty
 * because an API was slow.
 */
function paintHeroCandles(candles) {
  var host = ui.el('[data-hero-candles]');
  if (!host) return;

  var src = (candles && candles.length >= 24)
    ? candles.slice(-24)
    : [0.5, 0.62, 0.55, 0.7, 0.66, 0.78, 0.72, 0.85, 0.8, 0.68, 0.74, 0.62,
       0.7, 0.82, 0.9, 0.84, 0.76, 0.88, 0.94, 0.86, 0.8, 0.9, 0.96, 0.88]
      .map(function (v, i, a) {
        return { o: i ? a[i - 1] : v, c: v, h: Math.max(v, i ? a[i - 1] : v) * 1.04,
                 l: Math.min(v, i ? a[i - 1] : v) * 0.96 };
      });

  var lo = Math.min.apply(null, src.map(function (k) { return k.l; }));
  var hi = Math.max.apply(null, src.map(function (k) { return k.h; }));
  var span = (hi - lo) || 1;

  host.innerHTML = src.map(function (k, i) {
    var body = Math.max(6, (Math.abs(k.c - k.o) / span) * 100);
    var cls = k.c >= k.o ? 'up' : 'down';
    return '<span class="candle ' + cls + '" style="--body:' + body.toFixed(1) + '%;--i:' + i + '"></span>';
  }).join('');

  // The bars grow on reveal, so the hero has one piece of market motion that is
  // not the price ticking.
  requestAnimationFrame(function () { host.classList.add('shown'); });
}

/* ------------------------------------------------------------------- price -- */

function paintPrice(snap) {
  if (!snap || !snap.price || snap.price.nav == null) return;
  var nav = snap.price.nav;

  // Live rate from this same snapshot, then the hero price with its $ companion.
  ui.setUsdInr(snap.index && snap.index.fxUsdInr);
  ui.paintPriceDual('[data-hero-price]', nav, 'hero');
  st.last = nav;

  if (snap.stats) {
    ui.paintChange('[data-hero-change]', snap.stats.change24hPct);
    ui.setHtml('[data-ath]', ui.fmtDual(snap.stats.allTimeHigh));
    ui.setHtml('[data-atl]', ui.fmtDual(snap.stats.allTimeLow));

    var l = ui.el('[data-hero-launch]');
    if (l) {
      l.textContent = ui.fmtPct(snap.stats.sinceLaunchPct);
      l.className = 'strong ' + ui.direction(snap.stats.sinceLaunchPct);
    }
  }

  var idx = snap.index || {};
  if (idx.btcInr != null) ui.setText('[data-btc-inr]', ui.fmtBig(idx.btcInr));
  if (idx.btcUsd != null) {
    ui.setText('[data-btc-usd]', '$' + Math.round(idx.btcUsd).toLocaleString('en-US'));
  }

  // The identity. Both percentages side by side, and the panel says whether they
  // agree rather than leaving a reader to compare two decimals.
  var wrap = ui.el('.identity');
  if (wrap && idx.btcChangePct != null && idx.arvChangePct != null) {
    var b = ui.el('[data-id-btc]'), a = ui.el('[data-id-arv]');
    b.textContent = ui.fmtPct(idx.btcChangePct);
    b.className = 'v ' + ui.direction(idx.btcChangePct);
    a.textContent = ui.fmtPct(idx.arvChangePct);
    a.className = 'v ' + ui.direction(idx.arvChangePct);

    var agrees = Math.abs(idx.btcChangePct - idx.arvChangePct) < 0.01;
    wrap.classList.toggle('agrees', agrees);
    wrap.classList.toggle('diverges', !agrees);
    ui.el('.identity-eq').textContent = agrees ? '\u2261' : '\u2260';
  }

  var dot = ui.el('[data-hero-dot]');
  if (dot) dot.className = 'live-dot ' + (snap.price.stale ? 'stale' : '');
}

/* ------------------------------------------------------------------- chart -- */

async function loadChart() {
  var host = ui.el('[data-hero-chart]');
  if (!host || !globalThis.LightweightCharts) return;

  try {
    // The full history, fetched CLIENT-SIDE from the exchange (feed.history) and
    // scaled BTC->ARV — the same reliable path the trade chart uses, so it never
    // depends on server backfill. Daily since 2017 shows the 2022 drawdown too.
    var raw = await feed.history('BTC', '1D', 2600);
    st.candles = applyScale(raw, arvScale());
    if (!st.candles.length) return;

    var L = globalThis.LightweightCharts;
    var chart = L.createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight || 250,
      layout: { background: { type: 'solid', color: 'transparent' },
                textColor: '#5d636f', fontSize: 10,
                fontFamily: "'JetBrains Mono',ui-monospace,monospace" },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,.03)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: .15, bottom: .08 } },
      timeScale: { borderVisible: false, timeVisible: false, rightOffset: 2 },
      crosshair: { mode: L.CrosshairMode.Magnet,
                   vertLine: { color: 'rgba(185,190,201,.3)', labelVisible: false },
                   horzLine: { color: 'rgba(185,190,201,.3)', labelBackgroundColor: '#24242e' } },
      handleScroll: false, handleScale: false,
      localization: {
        locale: CFG.UI.locale,
        priceFormatter: function (p) { return p.toFixed(2); }
      }
    });

    var series = chart.addAreaSeries({
      lineColor: '#dfe2e9',
      topColor: 'rgba(223,226,233,.20)',
      bottomColor: 'rgba(223,226,233,.01)',
      lineWidth: 1.5,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: CFG.INDEX.priceDecimals, minMove: 0.0001 }
    });
    series.setData(st.candles.map(function (k) {
      return { time: Math.floor(k.t / 1000), value: k.c };
    }));

    // The launch level, so the whole history reads against the launch anchor
    // (now ₹17.83, drawn from CFG.INDEX.arvBaseInr rather than a hard-coded ₹1).
    series.createPriceLine({
      price: CFG.INDEX.arvBaseInr,
      color: 'rgba(185,190,201,.35)',
      lineStyle: L.LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
      title: 'launch'
    });

    chart.timeScale().fitContent();
    st.chart = chart;
    st.series = series;

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function (e) {
        var w = e[0] && e[0].contentRect.width;
        if (w > 0) chart.applyOptions({ width: w });
      }).observe(host);
    }

    paintHeroCandles(st.candles);
  } catch (e) {
    // A missing chart is not worth a toast on a landing page.
    paintHeroCandles(null);
  }
}

/* --------------------------------------------------------------- watchlist -- */

function sparkline(points, up) {
  if (!points || points.length < 2) return '';
  var lo = Math.min.apply(null, points), hi = Math.max.apply(null, points);
  var span = (hi - lo) || 1;
  var w = 84, h = 26;
  var d = points.map(function (v, i) {
    return (i ? 'L' : 'M') + ((i / (points.length - 1)) * w).toFixed(1)
         + ' ' + (h - ((v - lo) / span) * (h - 3) - 1.5).toFixed(1);
  }).join(' ');
  return '<svg class="spark ' + (up ? 'up' : 'down') + '" viewBox="0 0 ' + w + ' ' + h + '" '
       + 'preserveAspectRatio="none" aria-hidden="true">'
       + '<path class="fill" d="' + d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z"/>'
       + '<path d="' + d + '"/></svg>';
}

async function loadWatchlist() {
  var host = ui.el('[data-watchlist]');
  if (!host) return;

  var rows = [];

  // ARV first — it is the product; the coins beneath it are context. Every row
  // links to its chart on the trade page (ARV, or ?asset=KEY for a coin).
  var snap = st.snap;
  if (snap && snap.price && snap.price.nav != null) {
    rows.push({
      key: 'ARV', name: 'ARV Coin', cls: 'arv',
      href: 'trade.html',
      price: ui.fmtDual(snap.price.nav),
      sub: 'Index unit · tracks Bitcoin',
      change: snap.stats ? snap.stats.change24hPct : null,
      spark: st.candles.length ? st.candles.slice(-60).map(function (k) { return k.c; }) : null,
      badge: '<span class="badge metal">tracked</span>'
    });
  }

  try {
    var w = await api.watchlist();
    (w.assets || []).forEach(function (a) {
      rows.push({
        key: a.key,
        name: a.name,
        cls: a.key.toLowerCase(),
        href: 'trade.html?asset=' + encodeURIComponent(a.key),
        price: a.priceUsd != null
          ? '$' + a.priceUsd.toLocaleString('en-US', { maximumFractionDigits: a.priceUsd < 10 ? 2 : 0 })
          : '\u2014',
        sub: a.inIndex ? 'In the index · 100% weight' : 'Reference only · 0% weight',
        change: a.change24h,
        spark: null,
        badge: a.inIndex ? '<span class="badge btc-badge">index</span>' : ''
      });
    });
  } catch (_) {}

  if (!rows.length) {
    host.innerHTML = '<div class="empty">Market data is not available yet.</div>';
    return;
  }

  // Give every coin its own sparkline like ARV has, fetched client-side from the
  // exchange (feed.history) — the same reliable source the charts use.
  await Promise.all(rows.map(async function (r) {
    if (r.spark || r.key === 'ARV') return;
    try {
      var c = await feed.history(r.key, '1D', 60);
      if (c && c.length > 1) r.spark = c.map(function (k) { return k.c; });
    } catch (_) {}
  }));

  host.innerHTML = rows.map(function (r, i) {
    var d = ui.direction(r.change);
    return '<a class="asset-row railed ' + r.cls + '" href="' + r.href + '" data-reveal="soft"'
      + ' style="--i:' + i + ';text-decoration:none;color:inherit">'
      + '<span class="coin ' + r.cls + '"><span>' + ui.esc(r.key) + '</span></span>'
      + '<div class="asset-name"><div class="t">' + ui.esc(r.name) + '</div>'
        + '<div class="s">' + ui.esc(r.sub) + '</div></div>'
      + (r.spark ? sparkline(r.spark, d !== 'down') : '<span></span>')
      + '<div class="right"><div class="num strong">' + r.price + '</div>'
        + '<div class="chip ' + d + '" style="margin-top:3px">' + ui.fmtPct(r.change) + '</div></div>'
      + '</a>';
  }).join('');

  host.setAttribute('data-reveal-group', 'tight');
  reveal.observe(host);
}

/* ---------------------------------------------------------------- examples -- */

/**
 * Worked fee and tax examples.
 *
 * Computed client-side from the live price using the same percentages the server
 * uses, so the landing page cannot quietly advertise a cheaper fee than the trade
 * screen charges.
 */
function paintExamples() {
  var snap = st.snap;
  if (!snap || !snap.price || snap.price.nav == null) return;

  var nav = snap.price.nav;
  var f = CFG.FEES, t = CFG.TAX;
  var gross = 10000000;                        // ₹1,00,000 in paise

  var fee = Math.round(gross * f.entryPct / 100);
  var gst = Math.round(fee * f.gstPct / 100);
  var net = gross - fee - gst;
  var execNav = nav * (1 + f.slippagePct / 100);
  var units = Math.floor((net / 100 / execNav) * 1e8) / 1e8;
  var effective = units > 0 ? (gross / 100) / units : 0;

  ui.setHtml('[data-buy-example]', rows([
    ['You pay', gross, 'gross'],
    ['Entry fee (' + f.entryPct + '%)', -fee, 'charge'],
    ['GST on the fee (' + f.gstPct + '%)', -gst, 'charge',
     'GST applies to the fee only, never to the amount invested'],
    ['Invested', net, 'net'],
    [null],
    ['Units at ' + ui.fmtPrice(execNav), null, 'info', null, ui.fmtUnits(units)],
    ['Your cost per unit', null, 'info',
     'ARV has to reach ' + ui.fmtPrice(effective) + ' before this is in profit, because charges are paid up front',
     ui.fmtPrice(effective)]
  ]));

  // Sell side, on a 50% rise.
  var sellNav = nav * 1.5 * (1 - f.slippagePct / 100);
  var sGross = Math.floor(units * sellNav * 100);
  var sFee = Math.round(sGross * f.exitPct / 100);
  var sGst = Math.round(sFee * f.gstPct / 100);
  var tds = Math.round(sGross * t.tdsPct / 100);
  var cost = net;
  var pnl = sGross - cost;
  var payout = sGross - sFee - sGst - tds;

  ui.setHtml('[data-sell-example]', rows([
    ['Gross sale value', sGross, 'gross'],
    ['Exit fee (' + f.exitPct + '%)', -sFee, 'charge'],
    ['GST on the fee', -sGst, 'charge'],
    ['TDS withheld (' + t.tdsPct + '%, s.194S)', -tds, 'tds',
     'Withheld now and credited against your liability — it appears in Form 26AS'],
    ['Credited to your balance', payout, 'net'],
    [null],
    ['Cost of acquisition', cost, 'info'],
    ['Realised gain', pnl, 'pnl']
  ]));

  function rows(list) {
    return list.map(function (r) {
      if (!r[0]) return '<div class="ledger-divider"></div>';
      var amount = r[4] != null
        ? r[4]
        : (r[1] != null ? (r[1] < 0 ? '\u2212' : '') + ui.fmtPaise(Math.abs(r[1])) : '');
      return '<div class="ledger-row k-' + (r[2] || 'info') + '">'
        + '<span class="l">' + ui.esc(r[0]) + '</span>'
        + (amount ? '<span class="a">' + amount + '</span>' : '')
        + (r[3] ? '<span class="note">' + ui.esc(r[3]) + '</span>' : '')
        + '</div>';
    }).join('');
  }
}

/* ------------------------------------------------------------------- tiers -- */

async function loadTiers() {
  var host = ui.el('[data-tiers]');
  if (!host) return;
  try {
    var r = await api.rewardTiers();
    host.innerHTML = (r.tiers || []).map(function (t, i) {
      return '<div class="card card-tight card-lift" data-reveal="soft" style="--i:' + i + '">'
        + '<div class="tier-name" style="margin-bottom:6px">' + ui.esc(t.label) + '</div>'
        + '<div class="tiny muted" style="margin-bottom:var(--sp-3)">' + ui.esc(t.requirement) + '</div>'
        + '<div class="small">' + ui.esc(t.perk) + '</div>'
        + '</div>';
    }).join('');
    reveal.observe(host);
  } catch (_) {
    host.innerHTML = '';
  }
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  paintStatic();
  paintHeroCandles(null);          // something in the hero from the first frame

  await ui.boot({ feed: false });  // the landing page reads the server snapshot

  try {
    st.snap = await api.snapshot();
    paintPrice(st.snap);
    paintExamples();
    ui.paintNavTicker(st.snap);
    ui.paintServerFeed(st.snap);
  } catch (e) {
    ui.el('[data-hero-price]').textContent = '\u2014';
    ui.paintServerFeed(null);
  }

  await loadChart();
  loadWatchlist();
  loadTiers();

  // The server recomputes the index every minute, so polling matches that rather
  // than hammering it.
  api.poll(async function () {
    st.snap = await api.snapshot();
    paintPrice(st.snap);
    paintExamples();
    ui.paintNavTicker(st.snap);
    ui.paintServerFeed(st.snap);
  }, 30000);
})();
