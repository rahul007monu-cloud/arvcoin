/**
 * Shared shell — nav, footer, hero, toasts, formatting, scroll reveal.
 *
 * The twelve pages do not each carry their own chrome, so a change to the nav or
 * the footer happens in one place.
 */

import * as api from './api.js';
import * as reveal from './reveal.js';

var CFG = globalThis.ARV_CONFIG;

/* ============================================================ formatting == */

var locale = CFG.UI.locale || 'en-IN';
var symbol = CFG.UI.currencySymbol || '\u20b9';

export function fmtPaise(paise, opts) {
  var o = opts || {};
  var v = (paise || 0) / 100;
  var d = o.decimals != null ? o.decimals : 2;
  return (o.noSymbol ? '' : symbol) + v.toLocaleString(locale, {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

export function fmtPrice(rupees, decimals) {
  var d = decimals != null ? decimals : (CFG.INDEX.priceDecimals || 4);
  if (rupees == null || !isFinite(rupees)) return '\u2014';
  return symbol + Number(rupees).toLocaleString(locale, {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

/* ------------------------------------------------------- USD companion ==== */

/**
 * The live USD/INR rate, threaded in from the server snapshot.
 *
 * USD is a DISPLAY-ONLY figure: it multiplies whatever rupee NAV is already on
 * screen and never touches the money path (orders, ledger, cost basis, fills,
 * tax are all integer paise/₹). One module-level holder, set from the same
 * snapshot every page already paints, keeps the rate identical everywhere.
 */
var currentUsdInr = null;

/** Update the shared rate from a snapshot's index.fxUsdInr. Ignores junk. */
export function setUsdInr(rate) {
  if (rate != null && isFinite(rate) && rate > 0) currentUsdInr = Number(rate);
}

/** The rate in force, falling back to the configured launch-era fallback. */
function usdInr() {
  if (currentUsdInr != null) return currentUsdInr;
  var fb = CFG.FEED && CFG.FEED.fx && CFG.FEED.fx.fallbackRate;
  return (fb && isFinite(fb) && fb > 0) ? fb : null;
}

/**
 * A rupee figure expressed in dollars at the live rate.
 *
 * Degrades to an em-dash on a null/NaN input or a missing rate — it must never
 * render 'NaN' or '$Infinity' on screen.
 */
export function fmtUsd(rupees, decimals) {
  var r = usdInr();
  if (rupees == null || !isFinite(rupees) || r == null) return '\u2014';
  var usd = Number(rupees) / r;
  if (!isFinite(usd)) return '\u2014';
  var d = decimals != null ? decimals : 2;
  return '$' + usd.toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

/**
 * A dual ₹/$ string, e.g. '₹9,998.64 ($111.03)'.
 *
 * The rupee figure leads (fmtPrice); the dollar figure trails as a muted
 * secondary in a .price-usd span so it reads as context, not a competing price.
 * When the dollar value cannot be formed the ₹ figure stands alone.
 */
export function fmtDual(rupees, dRs, dUsd) {
  var rs = fmtPrice(rupees, dRs);
  var usd = fmtUsd(rupees, dUsd);
  if (usd === '\u2014') return rs;
  return rs + ' <span class="price-usd">(' + usd + ')</span>';
}

export function fmtBig(rupees) {
  if (rupees == null || !isFinite(rupees)) return '\u2014';
  return symbol + Math.round(rupees).toLocaleString(locale);
}

/** Indian compact notation — ₹1.24 L, ₹3.40 Cr. */
export function fmtCompact(rupees) {
  if (rupees == null || !isFinite(rupees)) return '\u2014';
  var a = Math.abs(rupees), sign = rupees < 0 ? '\u2212' : '';
  if (a >= 1e7) return sign + symbol + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + symbol + (a / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return sign + symbol + (a / 1e3).toFixed(1) + 'K';
  return sign + symbol + a.toFixed(2);
}

export function fmtUnits(units, decimals) {
  var n = Number(units);
  if (!isFinite(n)) return '\u2014';
  return n.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals != null ? decimals : 8
  });
}

export function fmtPct(pct, decimals) {
  if (pct == null || !isFinite(pct)) return '\u2014';
  var d = decimals != null ? decimals : 2;
  var sign = pct > 0 ? '+' : (pct < 0 ? '\u2212' : '');
  return sign + Math.abs(pct).toFixed(d) + '%';
}

export function direction(n) {
  if (n == null || !isFinite(n) || Math.abs(n) < 1e-12) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export function toPaise(rupees) {
  var n = typeof rupees === 'string' ? parseFloat(rupees.replace(/[^\d.\-]/g, '')) : rupees;
  if (!isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

export function fmtTime(iso, withDate) {
  if (!iso) return '\u2014';
  var d = typeof iso === 'number' ? new Date(iso) : new Date(String(iso).replace(' ', 'T') + 'Z');
  var t = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (!withDate) return t;
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short' }) + ' ' + t;
}

export function fmtDate(iso) {
  if (!iso) return '\u2014';
  var d = typeof iso === 'number' ? new Date(iso) : new Date(String(iso).replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Relative time, for queues where "3 minutes ago" beats a timestamp. */
export function ago(iso) {
  if (!iso) return '\u2014';
  var d = typeof iso === 'number' ? iso : Date.parse(String(iso).replace(' ', 'T') + 'Z');
  var s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* =============================================================== dom ====== */

export function el(sel, root) { return (root || document).querySelector(sel); }
export function els(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}
export function on(sel, ev, fn, root) {
  var e = el(sel, root);
  if (e) e.addEventListener(ev, fn);
  return e;
}
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

/* ============================================================== nav ======= */

var NAV = [
  { href: 'index.html',        label: 'Overview' },
  { href: 'trade.html',        label: 'Trade' },
  { href: 'dashboard.html',    label: 'Wallet',    auth: true },
  { href: 'portfolio.html',    label: 'Portfolio', auth: true },
  { href: 'deposit.html',      label: 'Deposit',   auth: true },
  { href: 'withdraw.html',     label: 'Withdraw',  auth: true },
  { href: 'transactions.html', label: 'History',   auth: true },
  { href: 'referral.html',     label: 'Refer',     auth: true }
];

function currentPage() {
  var p = location.pathname.split('/').pop();
  return p === '' ? 'index.html' : p;
}

export function mountNav(user) {
  var host = el('[data-nav]');
  if (!host) return;

  var here = currentPage();
  var links = NAV.filter(function (n) { return !n.auth || user; })
    .map(function (n) {
      return '<a href="' + n.href + '"' + (n.href === here ? ' class="on"' : '') + '>'
           + n.label + '</a>';
    }).join('');

  var right = user
    ? '<a href="profile.html" class="btn btn-ghost btn-sm">'
      + esc((user.fullName || user.email || '').split('@')[0] || 'Account') + '</a>'
      + (user.isAdmin ? '<a href="admin.html" class="btn btn-ghost btn-sm">Ops</a>' : '')
      + '<button class="btn btn-sm" data-signout>Sign out</button>'
    : '<a href="login.html" class="btn btn-ghost btn-sm">Sign in</a>'
      + '<a href="signup.html" class="btn btn-primary btn-sm">Open account</a>';

  host.innerHTML =
    '<nav class="nav"><div class="wrap">'
    + '<a href="index.html" class="brand">'
      + '<span class="brand-mark">A</span><span>' + esc(CFG.UI.brand) + '</span></a>'
    + '<div class="nav-links" data-navlinks>' + links + '</div>'
    + '<div class="nav-ticker" data-nav-ticker hidden>'
      + '<span class="k">ARV</span>'
      + '<span class="num" data-nav-price>\u2014</span>'
      + '<span class="chip flat" data-nav-change>\u2014</span></div>'
    + '<div class="row" style="gap:8px">' + right + '</div>'
    + '<button class="nav-toggle" data-navtoggle aria-label="Menu" aria-expanded="false">\u2261</button>'
    + '</div></nav>';

  var toggle = el('[data-navtoggle]', host);
  var linksEl = el('[data-navlinks]', host);
  if (toggle && linksEl) {
    toggle.addEventListener('click', function () {
      var open = linksEl.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var out = el('[data-signout]', host);
  if (out) {
    out.addEventListener('click', async function () {
      busy(out, true, 'Signing out\u2026');
      try { await api.logout(); } catch (_) {}
      location.href = 'index.html';
    });
  }
}

/* ============================================================ footer ====== */

export function mountFooter() {
  var host = el('[data-footer]');
  if (!host) return;

  var f = CFG.FEES, t = CFG.TAX;
  var launch = new Date(CFG.INDEX.launchMs).toLocaleDateString(locale, {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  host.innerHTML =
    '<footer class="foot"><div class="wrap">'
    + '<div class="foot-grid">'
      + '<div>'
        + '<div class="brand" style="margin-bottom:14px">'
          + '<span class="brand-mark">A</span><span>' + esc(CFG.UI.brandFull) + '</span></div>'
        + '<p class="risk-line">'
          + 'ARV is an index unit priced at ' + fmtPrice(CFG.INDEX.arvBaseInr)
          + ' at launch on ' + launch + ', tracking Bitcoin. Its value moves with the market '
          + 'and can fall as well as rise \u2014 you may get back less than you put in. Past '
          + 'performance says nothing about future returns. Gains on virtual digital assets are '
          + 'taxed at ' + t.vdaGainPct + '% plus ' + t.cessPct + '% cess, losses cannot be set '
          + 'off, and ' + t.tdsPct + '% TDS is withheld on sale under section 194S. Not '
          + 'registered with any regulator and not covered by any investor protection scheme.'
        + '</p>'
      + '</div>'
      + '<div><h5>Market</h5><ul>'
        + '<li><a href="trade.html">Trade</a></li>'
        + '<li><a href="index.html#how">How the price works</a></li>'
        + '<li><a href="index.html#costs">Fees and tax</a></li>'
      + '</ul></div>'
      + '<div><h5>Account</h5><ul>'
        + '<li><a href="dashboard.html">Wallet</a></li>'
        + '<li><a href="portfolio.html">Portfolio</a></li>'
        + '<li><a href="transactions.html">History</a></li>'
        + '<li><a href="tax.html">Tax statement</a></li>'
        + '<li><a href="profile.html">Profile &amp; KYC</a></li>'
        + '<li><a href="referral.html">Refer &amp; earn</a></li>'
      + '</ul></div>'
      + '<div><h5>Legal</h5><ul>'
        + '<li><a href="legal.html#risk">Risk disclosure</a></li>'
        + '<li><a href="legal.html#terms">Terms</a></li>'
        + '<li><a href="legal.html#tax">Tax treatment</a></li>'
        + '<li><a href="legal.html#privacy">Privacy</a></li>'
        + '<li><a href="legal.html#regulatory">Regulatory status</a></li>'
      + '</ul></div>'
    + '</div>'
    + '<div class="foot-bottom">'
      + '<span>Entry ' + f.entryPct + '% \u00b7 Exit ' + f.exitPct + '% \u00b7 GST '
        + f.gstPct + '% on fees</span>'
      + '<span class="feed-status" data-feed-status>'
        + '<span class="live-dot off"></span><span>connecting\u2026</span></span>'
    + '</div>'
    + '</div></footer>';
}

/* ============================================================== hero ====== */

/**
 * Build the hero's material layers.
 *
 * Injected rather than written into every page's markup: four presentational
 * divs that carry no content have no business being in the HTML, and this keeps
 * the config switches in one place.
 */
export function mountHero() {
  var media = el('[data-hero-media]');
  if (!media) return;

  var h = CFG.UI.hero || {};
  var small = window.innerWidth < 760;
  var parts = ['<div class="hero-plate"></div>'];

  if (h.engineTurning !== false) parts.push('<div class="hero-engine"></div>');
  if (h.specularSweep !== false && (h.sweepOnMobile !== false || !small)) {
    parts.push('<div class="hero-sweep" style="--sweep:' + (h.sweepSeconds || 18) + 's"></div>');
  }
  if (h.grain !== false) parts.push('<div class="hero-grain"></div>');

  media.innerHTML = parts.join('');
  media.setAttribute('aria-hidden', 'true');
}

/* ============================================================= toasts ===== */

function toastHost() {
  var h = el('.toast-host');
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
  var host = toastHost();
  var t = document.createElement('div');
  t.className = 'toast ' + (kind || 'info');
  t.innerHTML = '<div>' + msg + '</div>';
  host.appendChild(t);

  setTimeout(function () {
    t.classList.add('out');
    setTimeout(function () { t.remove(); }, 250);
  }, ms || CFG.UI.toastMs || 4000);
  return t;
}

/**
 * Show an error from the API.
 *
 * Some failures are not really errors but a required next step — KYC missing, a
 * stale price pausing trading — so those get their own treatment rather than a
 * red box that only says no.
 */
export function toastError(e) {
  var msg = (e && e.message) ? e.message : String(e || 'Something went wrong');

  if (e && e.needs === 'kyc') {
    return toast(esc(msg) + ' <a href="profile.html#kyc" class="arrow">Complete KYC</a>', 'warn', 9000);
  }
  if (e && e.needs === 'email_verification') {
    return toast(esc(msg) + ' <a href="verify.html" class="arrow">Verify email</a>', 'warn', 9000);
  }
  if (e && e.status === 503) {
    return toast(esc(msg), 'warn', 9000);
  }
  if (e && e.fields) {
    var first = Object.keys(e.fields)[0];
    return toast(esc(e.fields[first] || msg), 'bad', 7000);
  }
  return toast(esc(msg), 'bad', 7000);
}

/* ============================================================= prices ===== */

var lastPainted = Object.create(null);

/**
 * Paint a price and flash the direction it moved.
 *
 * The flash is what makes a live number legible as live. The reflow before
 * re-adding the class is deliberate — without it, two ticks in the same
 * direction do not restart the animation and the number looks frozen.
 */
export function paintPrice(target, price, key, decimals) {
  var node = typeof target === 'string' ? el(target) : target;
  if (!node || price == null) return;

  var k = key || 'default';
  var prev = lastPainted[k];
  node.textContent = fmtPrice(price, decimals);

  if (prev != null && price !== prev) {
    var cls = price > prev ? 'tick-up' : 'tick-down';
    node.classList.remove('tick-up', 'tick-down');
    void node.offsetWidth;
    node.classList.add(cls);
  }
  lastPainted[k] = price;
}

/**
 * Paint a live price with the muted $ companion beside the ₹ figure.
 *
 * Same direction flash as paintPrice — the animation lives on the whole node so
 * the ₹ figure still ticks — but the content is the dual ₹/$ string. Used for
 * the top nav ticker and any live/current price that should carry USD context.
 */
export function paintPriceDual(target, price, key, decimals) {
  var node = typeof target === 'string' ? el(target) : target;
  if (!node || price == null) return;

  var k = key || 'default';
  var prev = lastPainted[k];
  node.innerHTML = fmtDual(price, decimals);

  if (prev != null && price !== prev) {
    var cls = price > prev ? 'tick-up' : 'tick-down';
    node.classList.remove('tick-up', 'tick-down');
    void node.offsetWidth;
    node.classList.add(cls);
  }
  lastPainted[k] = price;
}

export function paintChange(target, pct) {
  var node = typeof target === 'string' ? el(target) : target;
  if (!node) return;
  node.className = 'chip ' + direction(pct);
  node.textContent = fmtPct(pct);
}

export function paintSigned(target, paise, opts) {
  var node = typeof target === 'string' ? el(target) : target;
  if (!node) return;
  var o = opts || {};
  var d = direction(paise);
  node.textContent = (paise > 0 ? '+' : (paise < 0 ? '\u2212' : ''))
                   + fmtPaise(Math.abs(paise || 0));
  node.className = (o.base || '') + ' ' + d;
}

/* ======================================================== feed status ===== */

/**
 * Feed status from the server's own snapshot.
 *
 * Used on pages that do not open a live socket. They still need to say whether
 * the price is current, and leaving the indicator on "connecting…" for ever is a
 * worse lie than saying nothing.
 */
export function paintServerFeed(snapshot) {
  var nodes = els('[data-feed-status]');
  if (!nodes.length) return;

  var p = (snapshot && snapshot.price) || {};
  var f = (snapshot && snapshot.feed) || {};
  var cls, label;

  if (p.nav == null) {
    cls = 'off';
    label = 'price feed not running';
  } else if (p.stale) {
    cls = 'stale';
    label = 'feed behind \u00b7 trading paused';
  } else {
    cls = '';
    var age = p.ageSeconds != null ? p.ageSeconds : 0;
    label = (f.source || 'server') + ' \u00b7 '
          + (age < 90 ? 'live' : Math.round(age / 60) + 'm ago');
  }

  nodes.forEach(function (n) {
    n.innerHTML = '<span class="live-dot ' + cls + '"></span><span>' + esc(label) + '</span>';
  });
}

/** Nav ticker, driven by a server snapshot rather than a socket. */
export function paintNavTicker(snapshot) {
  var wrap = el('[data-nav-ticker]');
  if (!wrap || !snapshot || !snapshot.price || snapshot.price.nav == null) return;
  // Every page that paints the ticker refreshes the shared USD/INR rate from the
  // same snapshot, so ₹/$ agrees across the whole app.
  setUsdInr(snapshot.index && snapshot.index.fxUsdInr);
  wrap.hidden = false;
  paintPriceDual(el('[data-nav-price]', wrap), snapshot.price.nav, 'nav');
  if (snapshot.stats) paintChange(el('[data-nav-change]', wrap), snapshot.stats.change24hPct);
}

export function mountFeedStatus(feed) {
  var nodes = els('[data-feed-status]');
  if (!nodes.length || !feed) return function () {};

  return feed.onStatus(function (s) {
    var cls = s.stale ? 'stale'
            : (s.mode === 'websocket' ? '' : (s.mode === 'polling' ? 'stale' : 'off'));
    var label;
    if (!s.source) label = 'connecting\u2026';
    else if (s.stale) label = s.label + ' \u00b7 stale';
    // Only a real trade stream earns the phrase. Polling is a fallback and saying
    // otherwise would be a claim the screen cannot back up.
    else if (s.tickByTick) label = s.label + ' \u00b7 tick by tick';
    else if (s.mode === 'websocket') label = s.label + ' \u00b7 live';
    else if (s.mode === 'polling') label = s.label + ' \u00b7 polling';
    else label = s.label + ' \u00b7 connecting\u2026';

    nodes.forEach(function (n) {
      n.innerHTML = '<span class="live-dot ' + cls + '"></span><span>' + esc(label) + '</span>';
    });
  });
}

/* ================================================================ csv ===== */

export function downloadCsv(filename, rows) {
  var csv = rows.map(function (r) {
    return r.map(function (c) {
      var s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');

  // The BOM is what makes Excel open a UTF-8 CSV without mangling the rupee sign.
  var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* ============================================================== timer ===== */

/**
 * A countdown ring against a promised window.
 *
 * Deposits and withdrawals both quote a range, so this shows the real remaining
 * time rather than an indeterminate spinner. Past the window it says so instead
 * of sitting at zero pretending.
 */
export function paintTimer(node, opts) {
  if (!node) return;
  var o = opts || {};
  var elapsed = Math.max(0, o.elapsedSeconds || 0);
  var maxSec = (o.maxMinutes || 15) * 60;
  var pct = Math.min(100, (elapsed / maxSec) * 100);
  var leftMin = Math.max(0, Math.ceil((maxSec - elapsed) / 60));
  var over = elapsed > maxSec;

  node.classList.toggle('overdue', over);
  node.innerHTML =
    '<div class="timer-ring" style="--pct:' + pct.toFixed(1) + '%">'
      + '<b>' + (over ? '!' : leftMin) + '</b></div>'
    + '<div><div class="strong">' + (over ? 'Taking longer than usual' : 'Usually ' + (o.minMinutes || 2)
      + '\u2013' + (o.maxMinutes || 15) + ' minutes') + '</div>'
    + '<div class="tiny muted">' + esc(over
        ? 'Past the window we quoted. Operations has it \u2014 nothing is lost.'
        : (o.note || 'You can close this page; it carries on without you.')) + '</div></div>';
}

/* =============================================================== boot ===== */

/**
 * Standard page start.
 *
 * Order is deliberate: identity first so the nav renders correctly on the first
 * paint, then reveal, then the live feed. Getting the nav right before paint
 * avoids the flicker of signed-out links being replaced a moment later.
 */
export async function boot(opts) {
  var o = opts || {};

  var user = null;
  try {
    user = await api.me();
  } catch (_) {
    // Offline or the backend is not installed. The page still renders; anything
    // needing an account will say so when it is used.
  }

  mountHero();
  mountNav(user);
  mountFooter();

  reveal.init();

  // Safety net. `[data-reveal]` starts invisible, so if reveal.js failed to load
  // the page would be blank — which is never an acceptable failure mode for a
  // decorative feature.
  setTimeout(function () {
    var hidden = els('[data-reveal]:not(.shown)').filter(function (e) {
      return e.getBoundingClientRect().top < window.innerHeight;
    });
    if (hidden.length) reveal.revealAll();
  }, 1200);

  if (o.feed !== false) {
    try {
      var feed = await import('./feed.js');
      mountFeedStatus(feed);
      await feed.start();
      if (o.onFeed) o.onFeed(feed);
    } catch (e) {
      toast('No market data source is reachable right now. Prices will retry automatically.',
            'warn', 9000);
    }
  } else {
    // A page that does not open a socket still has the status indicator in its
    // footer, and leaving it on "connecting…" for ever is a worse lie than saying
    // nothing. One cheap GET tells it the truth — and populates the nav ticker,
    // so the price is visible on every page rather than only the market ones.
    api.snapshot().then(function (snap) {
      paintServerFeed(snap);
      paintNavTicker(snap);
    }).catch(function () {
      paintServerFeed(null);
    });
  }

  var warnings = CFG.configWarnings().filter(function (w) { return !/UPI VPA/.test(w); });
  if (warnings.length) console.warn('[arv] config:', warnings);

  return { user: user };
}

export { reveal };
