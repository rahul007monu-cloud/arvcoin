/**
 * Service worker.
 *
 * Caching strategy, and the reasoning behind it:
 *
 *   app shell (HTML, CSS, JS)   cache first, refreshed in the background
 *   fonts and pinned CDN libs   cache first, they never change under a version
 *   /api/ on this origin        NEVER cached
 *   exchange and FX endpoints   NEVER cached
 *
 * Those last two rules are the ones that matter. A stale price or a stale balance
 * served from cache is worse than no answer at all: someone opens the app on a
 * bad connection, sees yesterday's number, and acts on it. Anything carrying a
 * price, a balance or a session goes to the network or fails visibly.
 *
 * The same-origin API is excluded by path, not by hostname. It shares an origin
 * with the shell, so a hostname check would not catch it and every wallet
 * response would end up in the cache — which is how a signed-out browser gets
 * served the previous user's balance.
 *
 * Bump CACHE on every deploy, and add new files to ASSETS.
 */

var CACHE = 'arv-v3.0.0';

var ASSETS = [
  'index.html',
  'trade.html',
  'dashboard.html',
  'deposit.html',
  'withdraw.html',
  'transactions.html',
  'tax.html',
  'referral.html',
  'profile.html',
  'admin.html',
  'legal.html',
  'login.html',
  'signup.html',
  '404.html',
  'arv-config.js',
  'css/core.css',
  'js/api.js',
  'js/ui.js',
  'js/feed.js',
  'js/reveal.js',
  'js/qr.js',
  'js/pages/home.js',
  'js/pages/auth.js',
  'js/pages/dashboard.js',
  'js/pages/trade.js',
  'js/pages/deposit.js',
  'js/pages/withdraw.js',
  'js/pages/transactions.js',
  'js/pages/tax.js',
  'js/pages/referral.js',
  'js/pages/profile.js',
  'js/pages/admin.js',
  'js/pages/legal.js',
  'favicon.svg',
  'manifest.json'
];

// Hosts whose responses must never be served from cache.
var NEVER_CACHE = [
  'api.binance.com', 'stream.binance.com',
  'www.okx.com', 'ws.okx.com',
  'api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com',
  'api.bybit.com',
  'api.kraken.com', 'ws.kraken.com',
  'api.coingecko.com',
  'api.frankfurter.dev', 'open.er-api.com',

  // Google Identity Services. A cached copy of an identity script is a bad
  // trade at any cache-hit rate: it is the code that mints the token we then
  // trust, Google updates it without warning, and a stale one fails in ways
  // that look like our bug rather than a stale asset.
  'accounts.google.com'
];

/** Same-origin paths that carry live or private data. */
function isPrivatePath(pathname) {
  return /(^|\/)api\//.test(pathname)
      || /(^|\/)install\.php$/.test(pathname)
      || /(^|\/)uploads\//.test(pathname);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // addAll rejects the whole batch if any single request fails, which would
      // leave the app with no cache at all. Individual puts degrade gracefully.
      return Promise.all(ASSETS.map(function (a) {
        return c.add(new Request(a, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Live data and anything account-related: network only, no cache, no fallback.
  if (NEVER_CACHE.some(function (h) { return url.hostname.indexOf(h) !== -1; })
      || (url.origin === self.location.origin && isPrivatePath(url.pathname))) {
    e.respondWith(fetch(req));
    return;
  }

  // CDN libraries and fonts: cache after first fetch — they are version-pinned.
  if (url.hostname.indexOf('cdn.jsdelivr.net') !== -1 ||
      url.hostname.indexOf('fonts.googleapis.com') !== -1 ||
      url.hostname.indexOf('fonts.gstatic.com') !== -1) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          // Opaque cross-origin responses have status 0 and cannot be inspected,
          // but they are still usable — so they are cached on type rather than
          // on res.ok, which is false for every one of them.
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // Same-origin app shell: cache first, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var network = fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () {
          // Offline. For a navigation, fall back to the cached shell so the app
          // opens at all; it will then say the feed is unavailable rather than
          // showing a browser error page.
          if (req.mode === 'navigate') {
            return caches.match('index.html').then(function (shell) {
              return shell || caches.match('404.html');
            });
          }
          return undefined;
        });
        return hit || network;
      })
    );
  }
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
