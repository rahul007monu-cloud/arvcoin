/* arvcoin — service worker (offline cache) */
var CACHE = "arvcoin-v27";
var ASSETS = [
  "index.html",
  "styles.css",
  "lux.css",
  "lux.js",
  "helix.js",
  "home.js",
  "3d.js",
  "auth.css",
  "auth.js",
  "firebase-config.js",
  "firebase-auth.js",
  "emailjs-config.js",
  "arv-config.js",
  "arv-core.js",
  "compliance-lint.js",
  "login.html",
  "signup.html",
  "verify.html",
  "dashboard.html",
  "dashboard.css",
  "dashboard.js",
  "calls.html",
  "calls.css",
  "calls.js",
  "levels.html",
  "levels.js",
  "levels-ui.js",
  "admin.html",
  "admin.js",
  "pricing.html",
  "pricing.js",
  "checkout.html",
  "checkout.js",
  "about.html",
  "legal.html",
  "404.html",
  "favicon.svg",
  "manifest.json"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(
        ASSETS.map(function (a) {
          return c.add(a).catch(function () { /* ignore missing */ });
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;

  var url = new URL(e.request.url);
  var sameOrigin = url.origin === self.location.origin;
  // CODE files (html/js/css) + navigations -> NETWORK-FIRST (online pe hamesha fresh code).
  // Baaki (images/fonts/svg) -> cache-first (fast).
  var isCode = e.request.mode === "navigate" || /\.(html|js|css)$/i.test(url.pathname);

  if (sameOrigin && isCode) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return resp;
      }).catch(function () {
        return caches.match(e.request).then(function (r) {
          return r || (e.request.mode === "navigate" ? caches.match("index.html") : r);
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return (
        cached ||
        fetch(e.request).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return resp;
        }).catch(function () { return cached; })
      );
    })
  );
});
