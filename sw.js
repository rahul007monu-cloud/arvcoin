/**
 * Service worker.
 *
 * Caching strategy, and the reasoning behind it:
 *
 *   app HTML, CSS and JS        NETWORK first, cache only when offline
 *   icons                       cache first, they do not change
 *   fonts and pinned CDN libs   cache first, they never change under a version
 *   /api/ on this origin        NEVER cached
 *   exchange and FX endpoints   NEVER cached
 *   accounts.google.com         NEVER cached
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
 * The app's own code is network first, which is a reversal. It was cache first,
 * and the effect was that a deployment did not reach anybody who had opened the
 * site before: they got the previous release out of the cache and the new one was
 * merely stored for next time. Server-side fixes appeared not to work, because in
 * the browser they were not there. The full account is in the fetch handler.
 */

// Only used to evict superseded caches. Updates no longer depend on this being
// changed — see the same-origin branch in the fetch handler for why that mattered.
var CACHE = 'arv-v3.2.0';

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

  // Icons: cache first. They are the one same-origin thing that genuinely does
  // not change, and a launcher icon is not worth a network round trip.
  if (url.origin === self.location.origin && /^\/?icons\//.test(url.pathname.replace(/^\//, ''))) {
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

  // The app's own HTML, CSS and JavaScript: network first, cache only as the
  // offline fallback.
  //
  // This was cache-first, and it was wrong in the worst possible way: it hid every
  // deployment. A returning visitor was served the *previous* release's HTML and
  // JavaScript straight out of the cache, and the newly fetched copy only went
  // into the cache for next time. So the honest report after shipping a fix was
  // "I merged it, deployed it, and nothing changed" — because for that visitor,
  // nothing had. A KYC form fixed on the server was still the old form in the
  // browser, complete with the old validation and the old error handling.
  //
  // The old design tried to cover this with a rule at the top of this file —
  // bump CACHE on every deploy. It was never once bumped across three releases.
  // A correctness requirement that depends on somebody remembering is not a
  // mechanism, and the version below is now only a way to evict old caches, not
  // the thing that makes updates arrive.
  //
  // The cost is real and accepted: every navigation now waits for the network
  // instead of painting from disk. For an application that shows somebody their
  // money, serving last week's code quickly is not the better trade.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // Genuinely offline — now the cache earns its place.
        return caches.match(req).then(function (hit) {
          if (hit) {
            return hit;
          }
          if (req.mode === 'navigate') {
            return caches.match('index.html').then(function (shell) {
              return shell || caches.match('404.html') || offlineResponse();
            });
          }
          return offlineResponse();
        });
      })
    );
  }
});

/**
 * Something rather than nothing when a request cannot be met.
 *
 * Returning undefined from respondWith surfaces as an opaque browser network
 * error, which tells the person nothing about why.
 */
function offlineResponse() {
  return new Response('Offline, and this is not in the cache.', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
