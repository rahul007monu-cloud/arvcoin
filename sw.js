/**
 * Service worker.
 *
 * Caching strategy, and the reasoning behind it:
 *
 *   app shell (HTML, CSS, JS)  cache-first, then network
 *   market data (exchange APIs) NEVER cached
 *   Supabase requests          NEVER cached
 *
 * That second rule is the important one. A stale price served from cache is
 * worse than no price at all: someone could open the app offline, see a figure
 * from yesterday, and act on it. Anything that carries a price or a balance goes
 * to the network or fails visibly.
 *
 * Bump CACHE on every deploy, and add new files to ASSETS.
 */

var CACHE = 'arv-v2.0.0';

var ASSETS = [
  'index.html',
  'charts.html',
  'dashboard.html',
  'buy.html',
  'withdraw.html',
  'transactions.html',
  'tax.html',
  'profile.html',
  'admin.html',
  'legal.html',
  'login.html',
  'signup.html',
  '404.html',
  'arv-config.js',
  'css/core.css',
  'js/money.js',
  'js/fx.js',
  'js/feed.js',
  'js/index-engine.js',
  'js/ledger.js',
  'js/chart.js',
  'js/helix.js',
  'js/db.js',
  'js/ui.js',
  'js/qr.js',
  'js/pages/home.js',
  'js/pages/charts.js',
  'js/pages/dashboard.js',
  'js/pages/buy.js',
  'js/pages/withdraw.js',
  'js/pages/transactions.js',
  'js/pages/tax.js',
  'js/pages/profile.js',
  'js/pages/admin.js',
  'js/pages/legal.js',
  'js/pages/auth.js',
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
  'supabase.co'
];

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
  var bypass = NEVER_CACHE.some(function (h) { return url.hostname.indexOf(h) !== -1; });
  if (bypass) {
    e.respondWith(fetch(req));
    return;
  }

  // CDN libraries: cache after first fetch — they are version-pinned.
  if (url.hostname.indexOf('cdn.jsdelivr.net') !== -1 ||
      url.hostname.indexOf('fonts.googleapis.com') !== -1 ||
      url.hostname.indexOf('fonts.gstatic.com') !== -1) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res.ok) {
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
          // opens; it will show that the feed is unavailable rather than a
          // browser error page.
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
