/**
 * Charts page — the trading view.
 *
 * Two charts: ARV's own candles at seven timeframes, and a rebased comparison
 * against the reference assets. The live candle is updated in place on every
 * tick so the right-hand bar actually moves, which is the difference between a
 * chart and a picture of one.
 */

import * as ui from '../ui.js';
import * as feed from '../feed.js';
import * as engine from '../index-engine.js';
import * as chart from '../chart.js';
import * as db from '../db.js';
import { fmtPrice, fmtPct, fmtBig, direction } from '../money.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  tf: CFG.CHARTS.defaultTimeframe,
  type: CFG.CHARTS.defaultType,
  api: null,
  candles: [],
  live: null,
  lastPrice: null,
  cmpApi: null,
  cmpDays: 30,
  hovering: false
};

/* ------------------------------------------------------------------ ticker -- */

function paintTicker() {
  var arv = engine.currentArv();
  if (arv == null) return;

  ui.paintPrice(document.querySelector('[data-price]'), arv, st.lastPrice);
  st.lastPrice = arv;

  var s = st.candles.length ? engine.stats(st.candles, 24) : null;
  if (s) {
    ui.paintChange(document.querySelector('[data-change]'), s.changePct);
    ui.setText('[data-high]', fmtPrice(s.high));
    ui.setText('[data-low]', fmtPrice(s.low));
  }

  var lp = engine.changeSinceLaunch(arv);
  var lEl = document.querySelector('[data-launch]');
  if (lEl && lp != null) {
    lEl.textContent = fmtPct(lp);
    lEl.className = 'num ' + direction(lp);
  }

  var btc = engine.currentQuotePrice('BTC');
  if (btc != null) ui.setText('[data-btc]', fmtBig(btc));

  var dot = document.querySelector('[data-dot]');
  if (dot) {
    var fs = feed.status();
    dot.className = 'live-dot ' + (fs.live ? (fs.stale ? 'stale' : '') : 'off');
  }

  // When the pointer is off the chart, the readout shows the newest bar.
  if (!st.hovering) paintOhlc(st.candles[st.candles.length - 1]);
  paintIdentity();
}

function paintOhlc(k) {
  var host = document.querySelector('[data-ohlc]');
  if (!host || !k) return;
  var up = k.c >= k.o;
  var cls = up ? 'up' : 'down';
  host.innerHTML =
    '<span>O <b>' + fmtPrice(k.o) + '</b></span>' +
    '<span>H <b>' + fmtPrice(k.h) + '</b></span>' +
    '<span>L <b>' + fmtPrice(k.l) + '</b></span>' +
    '<span>C <b class="' + cls + '">' + fmtPrice(k.c) + '</b></span>' +
    (k.v ? '<span>Vol <b>' + k.v.toFixed(2) + '</b></span>' : '');
}

/**
 * The identity panel. ARV's percentage move and Bitcoin's rupee percentage move
 * must be the same figure — showing them side by side makes that checkable
 * rather than merely claimed.
 */
function paintIdentity() {
  var host = document.querySelector('[data-identity]');
  if (!host) return;

  var arv = engine.currentArv();
  var btc = engine.currentQuotePrice('BTC');
  var base = engine.quoteBase('BTC');
  if (arv == null || btc == null || !base) return;

  var btcPct = ((btc - base) / base) * 100;
  var arvPct = engine.changeSinceLaunch(arv);
  var agree = Math.abs(btcPct - arvPct) < 1e-6;

  host.innerHTML =
    row('Bitcoin at launch', fmtBig(base)) +
    row('Bitcoin now', fmtBig(btc)) +
    row('Bitcoin change', fmtPct(btcPct), direction(btcPct)) +
    '<div class="ledger-divider"></div>' +
    row('ARV at launch', fmtPrice(CFG.INDEX.arvBaseInr)) +
    row('ARV now', fmtPrice(arv)) +
    row('ARV change', fmtPct(arvPct), direction(arvPct)) +
    '<div class="ledger-row ' + (agree ? 'k-net' : 'k-warning') + '">' +
      '<span class="l">' + (agree ? 'Identical, as designed' : 'Divergence detected') + '</span>' +
      '<span class="a">' + (agree ? '\u2713' : fmtPct(Math.abs(btcPct - arvPct), 6)) + '</span>' +
    '</div>';

  function row(label, value, cls) {
    return '<div class="ledger-row"><span class="l">' + label + '</span>' +
           '<span class="a ' + (cls || '') + '">' + value + '</span></div>';
  }
}

/* ------------------------------------------------------------- main chart -- */

function buildTabs() {
  var host = document.querySelector('[data-tf-tabs]');
  if (!host) return;
  host.innerHTML = CFG.CHARTS.timeframes.map(function (tf) {
    return '<button class="tab' + (tf === st.tf ? ' on' : '') + '" data-tf="' + tf + '">' + tf + '</button>';
  }).join('');

  ui.els('[data-tf-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-tf-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.tf = b.dataset.tf;
      loadMain();
    });
  });

  ui.els('[data-type-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-type-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.type = b.dataset.type;
      loadMain();
    });
  });
}

async function loadMain() {
  var el = document.querySelector('[data-chart]');
  if (!el) return;

  chart.overlay(el, '<div><span class="spinner"></span> Loading ' + st.tf + ' candles\u2026</div>');

  try {
    // Prefer candles the ingest worker has already stored: they go back further
    // than any single exchange call and do not depend on one staying reachable.
    var stored = await db.getStoredCandles(st.tf);
    var res;
    if (stored && stored.length > 30) {
      res = { candles: stored, fxDegraded: false };
    } else {
      res = await engine.arvSeries(st.tf, { deep: st.tf === '1D' || st.tf === '1W' });
    }

    st.candles = res.candles;

    if (!st.candles.length) {
      chart.overlay(el, 'No candles available for ' + st.tf + '.<br>' +
        '<span class="tiny">The selected data source may not serve this timeframe.</span>');
      return;
    }

    if (st.api) chart.destroy(st.api);
    st.api = chart.create(el, { priceKind: 'arv', showVolume: st.type === 'candles' });

    if (st.type === 'candles') {
      chart.addCandles(st.api, { withVolume: CFG.CHARTS.showVolume });
      chart.setCandles(st.api, st.candles);
    } else {
      chart.addArea(st.api, {});
      chart.setArea(st.api, st.candles);
    }

    chart.addPriceLine(st.api, {
      price: CFG.INDEX.arvBaseInr,
      colour: 'rgba(185,195,214,0.35)',
      title: 'launch \u20b91'
    });

    // The user's own average cost, when they hold anything. The single most
    // useful annotation on a portfolio chart.
    if (CFG.CHARTS.showEntryLine) {
      try {
        var h = await db.getHoldings();
        if (h && h.units > 0 && h.investedPaise > 0) {
          chart.addPriceLine(st.api, {
            price: (h.investedPaise / 100) / h.units,
            colour: 'rgba(245,165,36,0.75)',
            title: 'your cost'
          });
        }
      } catch (_) { /* not signed in */ }
    }

    chart.onCrosshair(st.api, function (p) {
      st.hovering = !!p;
      if (p && p.ohlc) paintOhlc({ t: p.time, o: p.ohlc.o, h: p.ohlc.h, l: p.ohlc.l, c: p.ohlc.c });
      else if (p && p.series.area) paintOhlc(st.candles.find(function (k) { return k.t === p.time; }));
      else paintOhlc(st.candles[st.candles.length - 1]);
    });

    // Minute data is dense; showing all of it at once is unreadable.
    if (st.tf === '1m' || st.tf === '5m') chart.showLast(st.api, 180);
    else chart.fit(st.api);

    chart.overlay(el, null);

    ui.setText('[data-candle-count]', st.candles.length + ' candles \u00b7 ' +
      ui.fmtDate(st.candles[0].t) + ' to now' +
      (res.fxDegraded ? ' \u00b7 FX history unavailable, using current rate' : ''));

    st.live = engine.createLiveCandle(st.tf, st.candles[st.candles.length - 1]);
    paintTicker();
  } catch (e) {
    chart.overlay(el, 'Could not load candles.<br><span class="tiny">' +
      ui.esc(e && e.message ? e.message : '') + '</span>');
  }
}

/* -------------------------------------------------------------- comparison -- */

async function loadComparison() {
  var el = document.querySelector('[data-cmp-chart]');
  if (!el) return;

  chart.overlay(el, '<span class="spinner"></span>');

  try {
    var days = st.cmpDays || null;
    var tf = !days ? '1D' : (days <= 7 ? '1h' : (days <= 90 ? '4h' : '1D'));

    if (st.cmpApi) chart.destroy(st.cmpApi);
    st.cmpApi = chart.create(el, { priceKind: 'index' });

    var legend = [];

    // ARV first, from the same series maths as the main chart.
    var arvRes = await engine.arvSeries(tf, { days: days });
    if (arvRes.candles.length) {
      chart.addLine(st.cmpApi, 'ARV', { colour: '#6ee7ff', width: 2.5, title: 'ARV' });
      chart.setLine(st.cmpApi, 'ARV', engine.normalise(arvRes.candles));
      legend.push({ key: 'ARV', colour: '#6ee7ff', candles: arvRes.candles });
    }

    // Bitcoin, in the quote currency, so it overlays ARV exactly.
    var btcSeries = arvRes.underlying && arvRes.underlying.BTC;
    if (btcSeries && btcSeries.length) {
      chart.addLine(st.cmpApi, 'BTC', { colour: '#f7931a', width: 1.5, title: 'BTC' });
      chart.setLine(st.cmpApi, 'BTC', engine.normalise(btcSeries));
      legend.push({ key: 'BTC', colour: '#f7931a', candles: btcSeries });
    }

    for (var i = 0; i < CFG.WATCHLIST.length; i++) {
      var a = CFG.WATCHLIST[i];
      try {
        var c = days
          ? await feed.candles(a.key, tf, { limit: CFG.CHARTS.maxCandles })
          : await feed.candlesRange(a.key, tf, CFG.INDEX.launchMs, Date.now());
        if (!c.length) continue;
        chart.addLine(st.cmpApi, a.key, { colour: a.colour, width: 1.2, title: a.key });
        chart.setLine(st.cmpApi, a.key, engine.normalise(c));
        legend.push({ key: a.key, colour: a.colour, candles: c });
      } catch (_) { /* skip this asset */ }
    }

    chart.addPriceLine(st.cmpApi, { price: 100, colour: 'rgba(185,195,214,0.3)', title: '100' });
    chart.fit(st.cmpApi);
    chart.overlay(el, null);

    var lg = document.querySelector('[data-cmp-legend]');
    if (lg) {
      lg.innerHTML = legend.map(function (l) {
        var first = l.candles[0].c, last = l.candles[l.candles.length - 1].c;
        var pct = ((last - first) / first) * 100;
        return '<div class="legend-item">' +
          '<span class="legend-swatch" style="background:' + l.colour + '"></span>' +
          l.key + ' <span class="' + direction(pct) + '">' + fmtPct(pct) + '</span></div>';
      }).join('');
    }
  } catch (e) {
    chart.overlay(el, 'Comparison unavailable.');
  }
}

function bindComparison() {
  ui.els('[data-cmp-tabs] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-cmp-tabs] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.cmpDays = Number(b.dataset.days) || null;
      loadComparison();
    });
  });
}

/* ---------------------------------------------------------------- refs ----- */

async function loadRefs() {
  var host = document.querySelector('[data-refs]');
  if (!host) return;

  var rows = [{ key: 'BTC', name: 'Bitcoin', weight: 1 }].concat(
    CFG.WATCHLIST.map(function (a) { return { key: a.key, name: a.name, weight: 0 }; })
  );

  host.innerHTML = rows.map(function (r) {
    return '<tr data-ref="' + r.key + '">' +
      '<td><strong>' + r.key + '</strong><div class="tiny muted">' + ui.esc(r.name) + '</div></td>' +
      '<td class="num" data-ref-price>\u2014</td>' +
      '<td class="num" data-ref-chg>\u2014</td>' +
      '<td class="num tiny muted">' + (r.weight ? '100%' : '0%') + '</td>' +
    '</tr>';
  }).join('');

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    try {
      var c = await feed.candles(r.key, '1h', { limit: 26 });
      var tr = host.querySelector('[data-ref="' + r.key + '"]');
      if (!tr || !c.length) continue;
      var last = c[c.length - 1].c;
      var pct = ((last - c[0].o) / c[0].o) * 100;
      tr.querySelector('[data-ref-price]').textContent =
        '$' + last.toLocaleString('en-US', { maximumFractionDigits: last < 10 ? 2 : 0 });
      var chg = tr.querySelector('[data-ref-chg]');
      chg.textContent = fmtPct(pct);
      chg.className = 'num ' + direction(pct);
    } catch (_) {}
  }
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  buildTabs();
  bindComparison();

  await ui.boot();

  await loadMain();
  loadComparison();
  loadRefs();

  feed.onTick(function () {
    var arv = engine.currentArv();
    if (arv == null) return;
    paintTicker();

    if (st.live && st.api) {
      var r = st.live.push(arv);
      if (!r.candle) return;
      if (st.type === 'candles') chart.updateCandle(st.api, r.candle);
      else chart.updateArea(st.api, r.candle);
      if (r.closed) {
        st.candles.push(r.closed);
        if (st.candles.length > CFG.CHARTS.maxCandles) st.candles.shift();
      }
    }
  });

  // Periodic refresh so long-lived tabs do not drift away from the true series.
  setInterval(function () { if (!document.hidden) loadMain(); }, 5 * 60000);
})();
