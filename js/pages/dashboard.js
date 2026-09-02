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
import { reveal } from '../ui.js';

var CFG = globalThis.ARV_CONFIG;

var st = {
  user: null,
  snap: null,
  range: null,
  chart: null,
  series: null,
  costLine: null,
  candles: []
};

/* ------------------------------------------------------------------- wallet -- */

function paintWallet() {
  var u = st.user;
  if (!u) return;
  var w = u.wallet;
  var nav = st.snap && st.snap.price ? st.snap.price.nav : null;

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
  ui.setText('[data-value]', ui.fmtPaise(w.valuePaise));
  if (parseFloat(w.arvLockedUnits) > 0) {
    var lu = ui.el('[data-units-locked]');
    lu.classList.remove('hidden');
    lu.textContent = '\u00b7 ' + ui.fmtUnits(w.arvLockedUnits, 4) + ' in open orders';
  }

  ui.setText('[data-invested]', ui.fmtPaise(w.investedPaise));
  ui.setText('[data-avg-cost]', w.avgCostNav > 0 ? ui.fmtPrice(w.avgCostNav) : '\u2014');

  ui.paintSigned('[data-unrealised]', w.unrealisedPaise, { base: 'stat-v' });
  ui.paintChange('[data-unrealised-pct]', w.unrealisedPct);
  ui.paintSigned('[data-realised]', w.realisedPaise, { base: 'stat-v' });

  if (nav != null) {
    ui.paintPrice('[data-price]', nav, 'dash');
    if (st.snap.stats) ui.paintChange('[data-change]', st.snap.stats.change24hPct);
  }

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

/* ------------------------------------------------------------------ what-if -- */

/**
 * The full cost of exiting, computed from the live price.
 *
 * Uses the same percentages the server charges. It is an estimate only because
 * the price moves between here and a fill — which the note says rather than
 * implying a guarantee.
 */
async function paintWhatIf() {
  var host = ui.el('[data-whatif]');
  if (!host || !st.user) return;

  var w = st.user.wallet;
  var units = w ? parseFloat(w.arvTotalUnits) : 0;

  if (!units) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">'
      + 'You hold no units yet. <a href="trade.html">Buy ARV</a></span></div>';
    return;
  }

  try {
    // Ask the server: it applies the user's own tier fees, their PAN status and
    // their financial-year TDS position, none of which the browser should guess.
    var r = await api.quoteSell(parseFloat(w.arvUnits) || units);
    var q = r.quote;

    host.innerHTML = rows([
      ['Gross value', q.grossPaise, 'gross'],
      ['Exit fee + GST', -(q.feePaise + q.gstPaise), 'charge'],
      ['TDS withheld' + (q.tds && q.tds.applies ? ' (' + q.tds.ratePct + '%)' : ''),
       -q.tdsPaise, 'tds', q.tds ? q.tds.reason : null],
      ['Credited to rupees', q.netPayoutPaise, 'net'],
      [null],
      ['Cost of acquisition', q.costBasisPaise, 'info'],
      [q.pnlPaise >= 0 ? 'Realised gain' : 'Realised loss', q.pnlPaise, 'pnl'],
      ['Tax at ' + q.effectiveTaxPct.toFixed(1) + '%', q.totalTaxPaise, 'liability',
       'Not withheld \u2014 payable by you when you file'],
      ['Balance at filing', q.balanceTaxPaise, 'liability-total']
    ]);

    if (q.lossNotSetOff) {
      host.insertAdjacentHTML('beforeend',
        '<div class="ledger-row k-warning"><span class="note">This loss could not be set '
        + 'off against other gains or carried forward \u2014 section 115BBH permits neither.'
        + '</span></div>');
    }
  } catch (e) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">'
      + ui.esc(e.message || 'Cannot price a sale right now.') + '</span></div>';
  }

  function rows(list) {
    return list.map(function (r) {
      if (!r[0]) return '<div class="ledger-divider"></div>';
      var neg = r[1] < 0;
      return '<div class="ledger-row k-' + (r[2] || 'info') + '">'
        + '<span class="l">' + ui.esc(r[0]) + '</span>'
        + '<span class="a">' + (neg ? '\u2212' : '') + ui.fmtPaise(Math.abs(r[1] || 0)) + '</span>'
        + (r[3] ? '<span class="note">' + ui.esc(r[3]) + '</span>' : '')
        + '</div>';
    }).join('');
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

async function loadChart() {
  var host = ui.el('[data-chart]');
  if (!host || !globalThis.LightweightCharts || !st.range) return;

  try {
    var r = await api.candles(st.range.tf, st.range.days, CFG.CHARTS.maxCandles);
    st.candles = r.candles || [];

    ui.setText('[data-candle-count]', st.candles.length
      ? st.candles.length + ' candles \u00b7 ' + st.range.tf
      : 'no candles for this range');

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
  } catch (e) {
    ui.setText('[data-candle-count]', 'chart unavailable');
  }
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
  await Promise.all([loadOrders(), paintWhatIf()]);
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
  paintWhatIf();

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
  }, 30000);
})();
