/**
 * Shared UI shell.
 *
 * Renders the nav, footer, live ticker, toasts and feed-status indicator so the
 * twelve pages do not each carry their own copy of the chrome. A change to the
 * nav is a change in one file.
 */

import * as feed from './feed.js';
import * as fx from './fx.js';
import * as engine from './index-engine.js';
import * as db from './db.js';
import { fmtPrice, fmtPct, fmtBig, direction } from './money.js';

var CFG = globalThis.ARV_CONFIG;

var NAV = [
  { href: 'index.html',        label: 'Overview' },
  { href: 'charts.html',       label: 'Charts' },
  { href: 'dashboard.html',    label: 'Portfolio', auth: true },
  { href: 'buy.html',          label: 'Buy' },
  { href: 'withdraw.html',     label: 'Redeem',    auth: true },
  { href: 'transactions.html', label: 'History',   auth: true },
  { href: 'tax.html',          label: 'Tax',       auth: true }
];

/* ------------------------------------------------------------------- nav ---- */

function currentPage() {
  var p = location.pathname.split('/').pop();
  return p === '' ? 'index.html' : p;
}

export async function mountNav() {
  var host = document.querySelector('[data-nav]');
  if (!host) return;

  var user = await db.currentUser().catch(function () { return null; });
  var here = currentPage();

  var links = NAV.filter(function (n) { return !n.auth || user; })
    .map(function (n) {
      var on = n.href === here ? ' class="on"' : '';
      return '<a href="' + n.href + '"' + on + '>' + n.label + '</a>';
    }).join('');

  var right = user
    ? '<a href="profile.html" class="btn btn-ghost btn-sm">' +
        (user.email ? user.email.split('@')[0] : 'Account') +
      '</a><button class="btn btn-sm" data-signout>Sign out</button>'
    : '<a href="login.html" class="btn btn-ghost btn-sm">Sign in</a>' +
      '<a href="signup.html" class="btn btn-primary btn-sm">Get started</a>';

  host.innerHTML =
    '<nav class="nav"><div class="wrap">' +
      '<a href="index.html" class="brand">' +
        '<span class="brand-mark">A</span><span>' + CFG.UI.brand + '</span>' +
      '</a>' +
      '<div class="nav-links" data-navlinks>' + links + '</div>' +
      '<div class="nav-ticker" data-nav-ticker hidden>' +
        '<span class="k">ARV</span>' +
        '<span class="num" data-nav-price>\u2014</span>' +
        '<span class="chip flat" data-nav-change>\u2014</span>' +
      '</div>' +
      '<div class="row" style="gap:8px">' + right + '</div>' +
      '<button class="nav-toggle" data-navtoggle aria-label="Menu">\u2261</button>' +
    '</div></nav>';

  var toggle = host.querySelector('[data-navtoggle]');
  var linksEl = host.querySelector('[data-navlinks]');
  if (toggle && linksEl) {
    toggle.addEventListener('click', function () { linksEl.classList.toggle('open'); });
  }

  var out = host.querySelector('[data-signout]');
  if (out) {
    out.addEventListener('click', async function () {
      await db.signOut();
      location.href = 'index.html';
    });
  }
}

/* ---------------------------------------------------------------- footer --- */

export function mountFooter() {
  var host = document.querySelector('[data-footer]');
  if (!host) return;
  var f = CFG.FEES, t = CFG.TAX;

  host.innerHTML =
    '<footer class="foot"><div class="wrap">' +
      '<div class="foot-grid">' +
        '<div>' +
          '<div class="brand" style="margin-bottom:12px">' +
            '<span class="brand-mark">A</span><span>' + CFG.UI.brand + '</span>' +
          '</div>' +
          '<p class="risk-line">' +
            'ARV is an index unit priced at \u20b91 at launch on ' +
            new Date(CFG.INDEX.launchMs).toLocaleDateString(CFG.UI.locale, { day: 'numeric', month: 'long', year: 'numeric' }) +
            ', tracking Bitcoin. Its value moves with the market and can fall as ' +
            'well as rise \u2014 you may get back less than you put in. Past ' +
            'performance says nothing about future returns. Gains on virtual ' +
            'digital assets are taxed at ' + t.vdaGainPct + '% plus ' + t.cessPct +
            '% cess, losses cannot be set off, and ' + t.tdsPct + '% TDS is ' +
            'withheld on redemption under section 194S.' +
          '</p>' +
        '</div>' +
        '<div><h5>Product</h5><ul>' +
          '<li><a href="charts.html">Charts</a></li>' +
          '<li><a href="dashboard.html">Portfolio</a></li>' +
          '<li><a href="buy.html">Buy ARV</a></li>' +
          '<li><a href="withdraw.html">Redeem</a></li>' +
        '</ul></div>' +
        '<div><h5>Account</h5><ul>' +
          '<li><a href="transactions.html">History</a></li>' +
          '<li><a href="tax.html">Tax statement</a></li>' +
          '<li><a href="profile.html">Profile &amp; KYC</a></li>' +
          '<li><a href="admin.html">Operations</a></li>' +
        '</ul></div>' +
        '<div><h5>Legal</h5><ul>' +
          '<li><a href="legal.html#risk">Risk disclosure</a></li>' +
          '<li><a href="legal.html#terms">Terms</a></li>' +
          '<li><a href="legal.html#privacy">Privacy</a></li>' +
          '<li><a href="legal.html#tax">Tax</a></li>' +
          '<li><a href="legal.html#fees">Fees</a></li>' +
          '<li><a href="legal.html#grievance">Grievance</a></li>' +
        '</ul></div>' +
      '</div>' +
      '<div class="foot-bottom">' +
        '<span>Entry ' + f.entryPct + '% \u00b7 Exit ' + f.exitPct + '% \u00b7 GST ' +
          f.gstPct + '% on fees</span>' +
        '<span class="feed-status" data-feed-status>' +
          '<span class="live-dot off"></span><span>connecting\u2026</span></span>' +
      '</div>' +
    '</div></footer>';
}

/* ---------------------------------------------------------------- toasts --- */

function toastHost() {
  var h = document.querySelector('.toast-host');
  if (!h) {
    h = document.createElement('div');
    h.className = 'toast-host';
    h.setAttribute('role', 'status');
    h.setAttribute('aria-live', 'polite');
    document.body.appendChild(h);
  }
  return h;
}

export function toast(msg, kind, ms) {
  var h = toastHost();
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || 'info');
  el.innerHTML = '<div>' + msg + '</div>';
  h.appendChild(el);

  var life = ms || CFG.UI.toastMs;
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { el.remove(); }, 260);
  }, life);
  return el;
}

export function toastError(e) {
  var msg = e && e.message ? e.message : String(e || 'Something went wrong');
  return toast(msg, 'bad', 7000);
}

/* --------------------------------------------------------------- ticker ---- */

var lastPrice = null;

/**
 * Paint a price into an element, flashing it in the direction it moved.
 * The flash is what makes a live number legible as live.
 */
export function paintPrice(el, price, prev, decimals) {
  if (!el) return;
  el.textContent = fmtPrice(price, decimals);
  if (prev != null && price !== prev) {
    var cls = price > prev ? 'tick-up' : 'tick-down';
    el.classList.remove('tick-up', 'tick-down');
    // Force a reflow so the animation restarts even on consecutive same-direction ticks.
    void el.offsetWidth;
    el.classList.add(cls);
  }
}

export function paintChange(el, pct) {
  if (!el) return;
  var d = direction(pct);
  el.className = 'chip ' + d;
  el.textContent = fmtPct(pct);
}

/** Keep the nav ticker in step with the feed. */
export function mountNavTicker(getChangePct) {
  var wrap = document.querySelector('[data-nav-ticker]');
  if (!wrap) return function () {};

  var priceEl = wrap.querySelector('[data-nav-price]');
  var chEl = wrap.querySelector('[data-nav-change]');

  return feed.onTick(function () {
    var arv = engine.currentArv();
    if (arv == null) return;
    wrap.hidden = false;
    paintPrice(priceEl, arv, lastPrice);
    lastPrice = arv;
    var pct = getChangePct ? getChangePct() : engine.changeSinceLaunch(arv);
    if (pct != null) paintChange(chEl, pct);
  });
}

/* ----------------------------------------------------------- feed status --- */

/**
 * Show which source is serving data and whether it is live.
 *
 * Worth surfacing rather than hiding: exchange availability varies by region, so
 * when a chart looks wrong the first useful question is which feed answered.
 */
export function mountFeedStatus() {
  var els = document.querySelectorAll('[data-feed-status]');
  if (!els.length) return function () {};

  return feed.onStatus(function (s) {
    // A streaming socket is the healthy state; polling still delivers prices but
    // at a coarser cadence, so it is shown differently rather than as "live".
    var cls = s.stale ? 'stale'
            : (s.mode === 'websocket' ? '' : (s.mode === 'polling' ? 'stale' : 'off'));
    var label;
    if (!s.source) label = 'connecting\u2026';
    else if (s.stale) label = s.label + ' \u00b7 stale';
    else if (s.mode === 'websocket') label = s.label + ' \u00b7 live';
    else if (s.mode === 'polling') label = s.label + ' \u00b7 polling';
    else label = s.label + ' \u00b7 connecting\u2026';

    var rate = fx.peekRate();
    var extra = rate && CFG.INDEX.quote === 'INR'
      ? ' \u00b7 USD/INR ' + rate.toFixed(2) : '';

    els.forEach(function (el) {
      el.innerHTML = '<span class="live-dot ' + cls + '"></span><span>' +
                     label + extra + '</span>';
    });
  });
}

/* ------------------------------------------------------------ page setup --- */

/**
 * Standard page boot.
 *
 * Order matters: FX before the feed, because an INR-quoted index cannot be
 * computed without a rate, and a price that renders as a dash for two seconds
 * looks broken.
 */
export async function boot(opts) {
  var o = opts || {};

  mountFooter();
  await mountNav();
  mountFeedStatus();

  if (o.helix !== false) {
    // Non-blocking: the page is fully usable if the 3D scene never loads.
    import('./helix.js').then(function (h) {
      var r = h.init();
      if (r.ok) {
        feed.onTick(function () {
          var pct = engine.changeSinceLaunch();
          if (pct != null) h.setMarket(pct);
        });
      }
    }).catch(function () { /* fallback gradient is already in the CSS */ });
  }

  if (o.feed !== false) {
    try {
      await fx.getRate();
      await feed.start();
    } catch (e) {
      toast(
        'No market data source is reachable right now. ' +
        'Prices and charts will retry automatically.', 'warn', 9000
      );
    }
  }

  if (o.ticker !== false) mountNavTicker();

  // Surface config problems to whoever is operating this, rather than failing
  // quietly with a subtly wrong number on screen.
  var warnings = engine.selfCheck().filter(function (w) {
    return !/Supabase not configured|No UPI VPA/.test(w);
  });
  if (warnings.length) console.warn('[arv] config:', warnings);

  return { user: await db.currentUser().catch(function () { return null; }) };
}

/* -------------------------------------------------------------- helpers ---- */

export function el(sel, root) {
  return (root || document).querySelector(sel);
}

export function els(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

export function on(sel, ev, fn, root) {
  var e = el(sel, root);
  if (e) e.addEventListener(ev, fn);
  return e;
}

/** Set text content on every match of a selector. */
export function setText(sel, text, root) {
  els(sel, root).forEach(function (e) { e.textContent = text; });
}

export function setHtml(sel, html, root) {
  els(sel, root).forEach(function (e) { e.innerHTML = html; });
}

export function show(sel, yes, root) {
  els(sel, root).forEach(function (e) { e.classList.toggle('hidden', !yes); });
}

export function busy(btn, yes, label) {
  if (!btn) return;
  if (yes) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>' + (label || 'Working\u2026');
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    btn.disabled = false;
  }
}

export function fmtTime(ms, withDate) {
  var d = new Date(ms);
  var t = d.toLocaleTimeString(CFG.UI.locale, { hour: '2-digit', minute: '2-digit' });
  if (!withDate) return t;
  return d.toLocaleDateString(CFG.UI.locale, { day: '2-digit', month: 'short' }) + ' ' + t;
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(CFG.UI.locale, {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

/** Escape untrusted text before it goes anywhere near innerHTML. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Download a generated CSV — used by the history and tax pages. */
export function downloadCsv(filename, rows) {
  var csv = rows.map(function (r) {
    return r.map(function (c) {
      var s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');

  var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

export { fmtPrice, fmtPct, fmtBig };
