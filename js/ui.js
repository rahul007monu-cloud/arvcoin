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

/**
 * The paise-input twin of fmtDual, for wallet/portfolio value surfaces that
 * carry integer paise rather than a rupee price. The ₹ figure leads via
 * fmtPaise; the $ companion trails in the same muted .price-usd span. It obeys
 * the identical fallback contract as fmtDual — when the dollar value cannot be
 * formed (no rate / non-finite), the ₹ figure stands ALONE with no stray '(—)'.
 */
export function fmtDualPaise(paise, dUsd) {
  var rs = fmtPaise(paise);
  var usd = fmtUsd((paise || 0) / 100, dUsd);
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

/* Support contact - a mailto with a sensible default subject. One place so the
   footer link and the mobile overflow menu always agree on the address. */
var SUPPORT_EMAIL = 'info@ARVcoin.com';
var SUPPORT_MAILTO = 'mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent('ARV Coin support request');

/**
 * The primary destinations for the mobile bottom tab bar (CoinDCX-style).
 *
 * A curated subset of NAV: the five things a trader reaches for. Secondary
 * items (Deposit/Withdraw/Refer/Profile/Help) live in the overflow "More" menu.
 * Each carries an inline monochrome SVG so the bar needs no icon library and
 * stays on the silver-on-black palette (currentColor inherits the tab colour).
 */
var TAB_ICONS = {
  overview: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  trade: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17V7"/><path d="M4 7l5 5 4-4 7 7"/><path d="M20 8v7h-7"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 7l0-1a2 2 0 0 1 2-2h11"/><circle cx="16" cy="13" r="1.4"/></svg>',
  portfolio: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v9l7-4a9 9 0 0 0-7-5z"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v3h3"/><path d="M12 8v4l3 2"/></svg>',
  signin: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>'
};

var TABS = [
  { href: 'index.html',        label: 'Overview',  icon: 'overview' },
  { href: 'trade.html',        label: 'Trade',     icon: 'trade' },
  { href: 'dashboard.html',    label: 'Wallet',    icon: 'wallet',    auth: true },
  { href: 'portfolio.html',    label: 'Portfolio', icon: 'portfolio', auth: true },
  { href: 'transactions.html', label: 'History',   icon: 'history',   auth: true }
];

/**
 * The fixed bottom tab bar, mobile-only (shown/hidden by CSS at the 760px
 * breakpoint). Auth-only tabs appear only for a signed-in user; a signed-out
 * user gets Overview + Trade and a Sign in tab so no account-only destination
 * is ever exposed. The current page is marked .on, reusing currentPage().
 */
function tabbarMarkup(user, here) {
  var tabs = TABS.filter(function (t) { return !t.auth || user; });

  var last = user
    ? { href: 'profile.html', label: 'Account', icon: 'wallet' }
    : { href: 'login.html', label: 'Sign in', icon: 'signin' };
  // Only add the account/sign-in slot when it is not already the current-page
  // set, keeping the bar to five even, touch-friendly targets.
  if (!tabs.some(function (t) { return t.href === last.href; })) tabs = tabs.concat(last);

  var items = tabs.map(function (t) {
    var on = t.href === here ? ' on' : '';
    return '<a class="tab' + on + '" href="' + t.href + '"'
      + (on ? ' aria-current="page"' : '') + '>'
      + '<span class="tab-ic">' + (TAB_ICONS[t.icon] || '') + '</span>'
      + '<span class="tab-l">' + esc(t.label) + '</span></a>';
  }).join('');

  return '<nav class="tabbar" data-tabbar aria-label="Primary">' + items + '</nav>';
}

export function mountNav(user) {
  var host = el('[data-nav]');
  if (!host) return;

  var here = currentPage();
  var links = NAV.filter(function (n) { return !n.auth || user; })
    .map(function (n) {
      return '<a href="' + n.href + '"' + (n.href === here ? ' class="on"' : '') + '>'
           + n.label + '</a>';
    }).join('')
    // Help lives in the collapsible menu (the mobile "More" overflow) so support
    // is always one tap away even though it is not a primary bottom-bar tab.
    + '<a href="' + SUPPORT_MAILTO + '" class="nav-help">Help &amp; support</a>';

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
    // The live price is a link to the chart: tapping the ARV price anywhere in
    // the header takes you straight to the trade chart.
    + '<a href="trade.html" class="nav-ticker" data-nav-ticker hidden'
      + ' title="Open the ARV chart" style="text-decoration:none;cursor:pointer">'
      + '<span class="k">ARV</span>'
      + '<span class="num" data-nav-price>\u2014</span>'
      + '<span class="chip flat" data-nav-change>\u2014</span></a>'
    + '<div class="row" style="gap:8px">' + right + '</div>'
    + '<button class="nav-toggle" data-navtoggle aria-label="More" aria-expanded="false">\u2261</button>'
    + '</div></nav>'
    // A fixed bottom tab bar for mobile (CoinDCX-style). Hidden on desktop by
    // CSS; the top nav above remains the desktop navigation.
    + tabbarMarkup(user, here);

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
      + '<div><h5>Help &amp; support</h5><ul>'
        + '<li><a href="' + SUPPORT_MAILTO + '">Contact support</a></li>'
        + '<li><a href="' + SUPPORT_MAILTO + '">' + esc(SUPPORT_EMAIL) + '</a></li>'
        + '<li><a href="index.html#how">How the price works</a></li>'
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

/* ------------------------------------------------------------------- PWA -----

   The real "Install app" experience (not iOS "Add to Home Screen"): register the
   service worker on EVERY page so the whole origin is controlled, capture
   Chrome/Edge/Android's beforeinstallprompt, and surface a visible, dismissible
   install banner (plus lighting up any [data-install] button a page renders).
   Runs on import, so it is active on every page that loads a page module.
*/
(function initPwa() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // Installability needs a controlling service worker with a fetch handler.
  // Same 'sw.js' (root scope); a repeat register() for the same scope is a no-op.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // Already installed / launched from the home screen: nothing to offer.
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                || window.navigator.standalone === true;
  if (standalone) return;

  var deferred = null;

  function banner() {
    var existing = document.querySelector('[data-pwa-install]');
    if (existing) return existing;
    var bar = document.createElement('div');
    bar.className = 'pwa-install';
    bar.setAttribute('data-pwa-install', '');
    bar.hidden = true;
    bar.innerHTML =
      '<span class="pwa-ic"><span class="brand-mark">A</span></span>'
      + '<div class="pwa-tx"><b>Install ARV Coin</b>'
      + '<span>Add the app to your device \u2014 full screen, one tap to open.</span></div>'
      + '<button class="btn btn-primary btn-sm" data-pwa-go>Install</button>'
      + '<button class="pwa-x" data-pwa-dismiss aria-label="Not now">\u00d7</button>';
    document.body.appendChild(bar);
    bar.querySelector('[data-pwa-go]').addEventListener('click', install);
    bar.querySelector('[data-pwa-dismiss]').addEventListener('click', function () {
      bar.hidden = true;
      try { sessionStorage.setItem('arv.pwa.dismissed', '1'); } catch (_) {}
    });
    return bar;
  }

  function showInstall() {
    try { if (sessionStorage.getItem('arv.pwa.dismissed') === '1') return; } catch (_) {}
    banner().hidden = false;
    var b = document.querySelector('[data-install]');
    if (b) { b.hidden = false; b.onclick = install; }
  }

  async function install() {
    if (!deferred) return;
    var evt = deferred; deferred = null;
    var bar = document.querySelector('[data-pwa-install]'); if (bar) bar.hidden = true;
    var b = document.querySelector('[data-install]'); if (b) b.hidden = true;
    try { evt.prompt(); await evt.userChoice; } catch (_) {}
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();        // suppress the mini-infobar; show our own affordance
    deferred = e;
    showInstall();
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    var bar = document.querySelector('[data-pwa-install]'); if (bar) bar.hidden = true;
    try { toast('ARV Coin installed.', 'ok'); } catch (_) {}
  });
})();

/* ------------------------------------------------------------- assistant -----

   A floating support assistant on every page. It answers questions about ARV
   from a built-in knowledge base (works with no API key) and, if the operator
   has configured a Gemini key, from Gemini grounded on the same facts. Read-only
   — it never places orders or touches an account.
*/
(function initAssistant() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var history = [];       // {role:'user'|'assistant', text}
  var built = false;
  var busy = false;

  function icon() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"'
      + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg>';
  }

  function build() {
    if (built) return;
    built = true;

    var btn = document.createElement('button');
    btn.className = 'asst-fab';
    btn.setAttribute('data-asst-toggle', '');
    btn.setAttribute('aria-label', 'Ask about ARV');
    btn.innerHTML = icon();

    var panel = document.createElement('div');
    panel.className = 'asst-panel';
    panel.setAttribute('data-asst-panel', '');
    panel.hidden = true;
    panel.innerHTML =
      '<div class="asst-head">'
        + '<span class="asst-title"><span class="live-dot"></span> Ask ARV</span>'
        + '<button class="asst-x" data-asst-close aria-label="Close">\u00d7</button>'
      + '</div>'
      + '<div class="asst-log" data-asst-log></div>'
      + '<form class="asst-input" data-asst-form>'
        + '<input type="text" data-asst-text autocomplete="off" '
          + 'placeholder="How do I buy? What are the fees?" maxlength="500" aria-label="Your question">'
        + '<button class="btn btn-primary btn-sm" type="submit" data-asst-send>Send</button>'
      + '</form>';

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    btn.addEventListener('click', function () { toggle(); });
    panel.querySelector('[data-asst-close]').addEventListener('click', function () { toggle(false); });
    panel.querySelector('[data-asst-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      send();
    });

    // A friendly opener with a few example chips.
    add('assistant',
      'Hi! I can answer questions about ARV \u2014 how it works, buying and selling, '
      + 'fees, tax, deposits and withdrawals. What would you like to know?');
    chips(['How does ARV work?', 'What are the fees?', 'How is tax calculated?', 'How do I deposit?']);
  }

  function toggle(force) {
    var panel = document.querySelector('[data-asst-panel]');
    var btn = document.querySelector('[data-asst-toggle]');
    var open = force === undefined ? panel.hidden : force;
    panel.hidden = !open;
    if (btn) btn.classList.toggle('on', open);
    if (open) {
      var t = panel.querySelector('[data-asst-text]');
      if (t) setTimeout(function () { t.focus(); }, 30);
    }
  }

  function log() { return document.querySelector('[data-asst-log]'); }

  function add(role, text) {
    var el2 = document.createElement('div');
    el2.className = 'asst-msg ' + (role === 'user' ? 'me' : 'bot');
    var safe = esc(text).replace(/\n/g, '<br>')
      .replace(/info@ARVcoin\.com/gi, '<a href="mailto:info@ARVcoin.com">info@ARVcoin.com</a>');
    el2.innerHTML = safe;
    log().appendChild(el2);
    log().scrollTop = log().scrollHeight;
    return el2;
  }

  function chips(items) {
    var wrap = document.createElement('div');
    wrap.className = 'asst-chips';
    wrap.innerHTML = items.map(function (q) {
      return '<button type="button" class="asst-chip">' + esc(q) + '</button>';
    }).join('');
    wrap.querySelectorAll('.asst-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = document.querySelector('[data-asst-text]');
        if (t) t.value = b.textContent;
        send();
      });
    });
    log().appendChild(wrap);
    log().scrollTop = log().scrollHeight;
  }

  async function send() {
    if (busy) return;
    var input = document.querySelector('[data-asst-text]');
    var q = (input.value || '').trim();
    if (!q) return;

    // Remove any starter chips once a conversation begins.
    var oldChips = log().querySelector('.asst-chips');
    if (oldChips) oldChips.remove();

    input.value = '';
    add('user', q);
    history.push({ role: 'user', text: q });

    busy = true;
    var typing = add('assistant', '\u2026');
    typing.classList.add('asst-typing');

    try {
      var r = await api.assistant(q, history.slice(-6));
      typing.remove();
      var ans = (r && r.answer) ? r.answer : 'Sorry, I could not find an answer. Email info@ARVcoin.com and a human will help.';
      add('assistant', ans);
      history.push({ role: 'assistant', text: ans });
    } catch (e) {
      typing.remove();
      add('assistant', 'I could not reach the assistant just now. Please try again, or email info@ARVcoin.com.');
    } finally {
      busy = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
