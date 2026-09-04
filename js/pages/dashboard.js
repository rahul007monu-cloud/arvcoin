/**
 * Wallet.
 *
 * The panel that shapes this page is "if you sold everything now". A dashboard
 * that shows a large green unrealised gain and nothing else teaches the wrong
 * expectation: on virtual digital assets 31.2% of that gain is owed the moment it
 * is realised, fees come off the top, and losses elsewhere cannot reduce it. So
 * the tax consequence sits beside the gain rather than being discovered in July.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';
import * as feed from '../feed.js';
import { TF_MINUTES } from '../feed.js';
import { reveal } from '../ui.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  user: null,
  snap: null,
  range: null,
  chart: null,
  series: null,
  costLine: null,
  candles: [],
  liveBar: null,
  unsubTick: null,
  feedStarted: false
};

/* ------------------------------------------------------------------- wallet -- */

function paintWallet() {
  var u = st.user;
  if (!u) return;
  var w = u.wallet;

  ui.setText('[data-greeting]',
    (u.fullName ? u.fullName.split(' ')[0] : 'Welcome') + (u.fullName ? '\u2019s wallet' : ''));

  if (!w) return;

  ui.setText('[data-inr]', ui.fmtPaise(w.inrPaise));
  if (w.inrLockedPaise > 0) {
    var l = ui.el('[data-inr-locked]');
    l.classList.remove('hidden');
    l.textContent = ui.fmtPaise(w.inrLockedPaise) + ' held in open orders';
  }

  ui.setText('[data-units]', ui.fmtUnits(w.arvUnits, 4));
  // Holding value is priced at the live NAV, so it carries the $ companion. The
  // rate comes from the snapshot via paintNavTicker; falls back to config.
  ui.setHtml('[data-value]', ui.fmtDualPaise(w.valuePaise));
  if (parseFloat(w.arvLockedUnits) > 0) {
    var lu = ui.el('[data-units-locked]');
    lu.classList.remove('hidden');
    lu.textContent = '\u00b7 ' + ui.fmtUnits(w.arvLockedUnits, 4) + ' in open orders';
  }

  // Full P&L (invested, unrealised, realised, avg cost) and the exit breakdown
  // now live on portfolio.html; the Wallet stays focused on cash and units.

  // Referral
  ui.setText('[data-ref-code]', u.referralCode || '\u2014');
  ui.setText('[data-ref-pct]', CFG.REFERRAL.commissionPct + '%');
  if (u.tier) {
    var t = ui.el('[data-tier]');
    t.hidden = false;
    t.textContent = u.tier;
  }

  // Gates
  if (u.kyc && u.kyc.status !== 'verified') {
    ui.el('[data-kyc-notice]').classList.remove('hidden');
  }
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

/**
 * BTC->ARV scale for the whole series (same identity as liveArvPrice/index_price).
 * Falls back to config anchors before the snapshot arrives.
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

async function loadChart() {
  var host = ui.el('[data-chart]');
  if (!host || !globalThis.LightweightCharts || !st.range) return;

  try {
    // Candles CLIENT-SIDE from the exchange (feed.history), scaled BTC->ARV — the
    // reliable path the trade chart uses, with no dependency on server backfill.
    var raw = await feed.history('BTC', st.range.tf, CFG.CHARTS.maxCandles);
    st.candles = applyScale(raw, arvScale());

    ui.setText('[data-candle-count]', st.candles.length
      ? st.candles.length + ' candles \u00b7 ' + st.range.tf
      : 'chart unavailable \u2014 could not reach a market data source');

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

    // Seed the live bar from the last server candle, then wire the trade feed so
    // the ARV area chart grows tick-by-tick like the Bitcoin chart.
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

/** Seconds spanned by one candle of the current range's timeframe. */
function tfSeconds() {
  return (TF_MINUTES[st.range && st.range.tf] || 1) * 60;
}

/**
 * Live ARV price from the BTC feed, using the same identity as the server's
 * index_price(): ARV = base × (BTC_now_in_INR ÷ BTC_launch_in_INR). Returns null
 * when any input is missing so the caller leaves the chart untouched.
 */
function liveArvPrice() {
  var idx = st.snap && st.snap.index;
  if (!idx || !idx.base || !idx.baseBtcInr || idx.fxUsdInr == null) return null;
  var btcUsd = feed.priceUsd('BTC');
  if (btcUsd == null || !isFinite(btcUsd)) return null;
  var price = idx.base * ((btcUsd * idx.fxUsdInr) / idx.baseBtcInr);
  return isFinite(price) && price > 0 ? price : null;
}

/** Grow the area chart's last point tick by tick; never rebuild the series. */
function onLiveTick() {
  if (!st.series || !st.chart) return;
  var price = liveArvPrice();
  if (price == null) return;

  var secs = tfSeconds();
  var bucketSec = Math.floor(Math.floor(Date.now() / 1000) / secs) * secs;
  var bar = st.liveBar;
  var lastBucketSec = bar ? Math.floor((bar.t / 1000) / secs) * secs : null;

  if (bar && lastBucketSec === bucketSec) {
    bar.c = price;
  } else {
    st.liveBar = bar = { t: bucketSec * 1000, o: bar ? bar.c : price, h: price, l: price, c: price };
  }
  st.series.update({ time: bucketSec, value: bar.c });
}

/**
 * Subscribe the ARV chart to the trade feed. Idempotent, and guarded so an
 * unreachable feed leaves the historical server candles on screen.
 */
function wireLiveFeed() {
  if (st.unsubTick) { try { st.unsubTick(); } catch (_) {} st.unsubTick = null; }
  if (!st.series) return;
  if (!st.feedStarted) {
    st.feedStarted = true;
    feed.start().catch(function () {});
  }
  st.unsubTick = feed.onTick(function () { onLiveTick(); });
}

/** Re-sync the live bar to the authoritative server candle on each poll. */
async function resyncLiveBar() {
  if (!st.series || !st.range) return;
  try {
    var raw = await feed.history('BTC', st.range.tf, 3);
    var rows = applyScale(raw, arvScale());
    var last = rows[rows.length - 1];
    if (!last) return;
    if (!st.liveBar || last.t >= st.liveBar.t) {
      st.liveBar = { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c };
      st.series.update({ time: Math.floor(last.t / 1000), value: last.c });
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------- orders -- */

function statusBadge(s) {
  var map = { filled: 'ok', partial: 'info', open: 'warn', triggered: 'warn',
              cancelled: '', expired: '', paid: 'ok', confirmed: 'ok',
              requested: 'warn', submitted: 'warn', rejected: 'bad' };
  return '<span class="badge ' + (map[s] || '') + '">' + ui.esc(s.replace(/_/g, ' ')) + '</span>';
}

async function loadOrders() {
  var host = ui.el('[data-orders]');
  if (!host) return;

  try {
    var r = await api.myOrders('open');
    var rows = r.orders || [];

    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="7"><div class="empty">'
        + 'No open orders. <a href="trade.html">Place one</a></div></td></tr>';
      return;
    }

    host.innerHTML = rows.map(function (o) {
      var fb = o.fallbackInMinutes != null && o.side === 'sell'
        ? '<div class="tiny muted">treasury buys in ' + o.fallbackInMinutes + 'm</div>'
        : '';
      return '<tr>'
        + '<td class="mono tiny">' + ui.esc(o.ref) + '</td>'
        + '<td><span class="badge ' + (o.side === 'buy' ? 'ok' : 'warn') + '">'
          + o.side + '</span></td>'
        + '<td class="tiny">' + o.type + (o.triggerNav ? '' : '') + '</td>'
        + '<td class="num">' + ui.fmtUnits(o.remainingUnits, 4) + fb + '</td>'
        + '<td class="num">' + (o.triggerNav ? ui.fmtPrice(o.triggerNav) : 'index') + '</td>'
        + '<td>' + statusBadge(o.status) + '</td>'
        + '<td class="right"><button class="btn btn-sm btn-ghost" data-cancel="'
          + o.id + '">Cancel</button></td>'
        + '</tr>';
    }).join('');

    ui.els('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        ui.busy(b, true, '\u2026');
        try {
          var res = await api.cancelOrder(Number(b.dataset.cancel));
          ui.toast(res.message || 'Cancelled.', 'ok');
          await refresh();
        } catch (e) {
          ui.toastError(e);
          ui.busy(b, false);
        }
      });
    });
  } catch (e) {
    host.innerHTML = '<tr><td colspan="7" class="empty">Could not load orders.</td></tr>';
  }
}

/* ----------------------------------------------------------------- activity -- */

async function loadActivity() {
  var host = ui.el('[data-activity]');
  if (!host) return;

  try {
    // Deposits, withdrawals and fills, merged into one readable list.
    var results = await Promise.all([
      api.myDeposits().catch(function () { return { deposits: [] }; }),
      api.myWithdrawals().catch(function () { return { withdrawals: [] }; }),
      api.myOrders('all').catch(function () { return { orders: [] }; })
    ]);

    var items = [];
    (results[0].deposits || []).forEach(function (d) {
      items.push({ at: d.createdAt, what: 'Deposit', badge: 'info',
                   units: null, price: null, amount: d.amountPaise, status: d.status });
    });
    (results[1].withdrawals || []).forEach(function (w) {
      items.push({ at: w.createdAt, what: 'Withdrawal', badge: 'warn',
                   units: null, price: null, amount: -w.amountPaise, status: w.status });
    });
    (results[2].orders || []).filter(function (o) {
      return parseFloat(o.filledUnits) > 0;
    }).forEach(function (o) {
      items.push({ at: o.createdAt, what: o.side === 'buy' ? 'Bought ARV' : 'Sold ARV',
                   badge: o.side === 'buy' ? 'ok' : 'warn',
                   units: o.filledUnits, price: null,
                   amount: o.side === 'buy' ? -o.filledPaise : o.filledPaise,
                   status: o.status });
    });

    items.sort(function (a, b) {
      return Date.parse(String(b.at).replace(' ', 'T')) - Date.parse(String(a.at).replace(' ', 'T'));
    });

    if (!items.length) {
      host.innerHTML = '<tr><td colspan="5"><div class="empty">'
        + '<div class="icon">\u25c7</div>Nothing yet.<br>'
        + '<a href="deposit.html">Add funds</a> to get started.</div></td></tr>';
      return;
    }

    host.innerHTML = items.slice(0, 10).map(function (i) {
      return '<tr>'
        + '<td class="tiny nowrap">' + ui.ago(i.at) + '</td>'
        + '<td><span class="badge ' + i.badge + '">' + i.what + '</span> '
          + statusBadge(i.status) + '</td>'
        + '<td class="num">' + (i.units ? ui.fmtUnits(i.units, 4) : '\u2014') + '</td>'
        + '<td class="num">' + (i.price ? ui.fmtPrice(i.price) : '\u2014') + '</td>'
        + '<td class="num ' + (i.amount >= 0 ? 'up' : '') + '">'
          + (i.amount >= 0 ? '+' : '\u2212') + ui.fmtPaise(Math.abs(i.amount)) + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) {
    host.innerHTML = '<tr><td colspan="5" class="empty">Could not load activity.</td></tr>';
  }
}

/* ---------------------------------------------------------------- watchlist -- */

async function loadWatchlist() {
  var host = ui.el('[data-watchlist]');
  if (!host) return;
  try {
    var w = await api.watchlist();
    host.innerHTML = (w.assets || []).map(function (a, i) {
      var d = ui.direction(a.change24h);
      return '<div class="asset-row railed ' + a.key.toLowerCase() + '" data-reveal="soft" style="--i:' + i + '">'
        + '<span class="coin ' + a.key.toLowerCase() + '"><span>' + a.key + '</span></span>'
        + '<div class="asset-name"><div class="t">' + ui.esc(a.name) + '</div>'
          + '<div class="s">' + (a.inIndex ? 'in the index' : '0% weight') + '</div></div>'
        + '<div class="right"><div class="num strong">'
          + (a.priceUsd != null
              ? '$' + a.priceUsd.toLocaleString('en-US', { maximumFractionDigits: a.priceUsd < 10 ? 2 : 0 })
              : '\u2014')
          + '</div><div class="chip ' + d + '" style="margin-top:3px">'
          + ui.fmtPct(a.change24h) + '</div></div>'
        + '</div>';
    }).join('');
    host.setAttribute('data-reveal-group', 'tight');
    reveal.observe(host);
  } catch (_) {
    host.innerHTML = '<div class="empty tiny">Market data unavailable.</div>';
  }
}

/* -------------------------------------------------------------------- boot -- */

async function refresh() {
  st.user = await api.me(true);
  st.snap = await api.snapshot().catch(function () { return null; });
  paintWallet();
  paintPaused();
  ui.paintNavTicker(st.snap);
  ui.paintServerFeed(st.snap);
  await loadOrders();
}

(async function () {
  buildRangeTabs();

  await ui.boot({ feed: false });
  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  st.snap = await api.snapshot().catch(function () { return null; });
  paintWallet();
  paintPaused();
  ui.paintNavTicker(st.snap);
  ui.paintServerFeed(st.snap);

  await loadChart();
  loadOrders();
  loadActivity();
  loadWatchlist();

  ui.on('[data-copy-ref]', 'click', function (e) {
    var link = location.origin + '/signup.html?ref=' + (st.user.referralCode || '');
    navigator.clipboard.writeText(link)
      .then(function () { ui.toast('Referral link copied.', 'ok', 2500); })
      .catch(function () { ui.toast('Could not copy \u2014 select it manually.', 'warn'); });
  });

  // The index is recomputed once a minute, so polling matches that.
  api.poll(async function () {
    st.snap = await api.snapshot();
    st.user = await api.me(true);
    paintWallet();
    paintPaused();
    ui.paintNavTicker(st.snap);
    ui.paintServerFeed(st.snap);
    resyncLiveBar();
  }, 30000);
})();
