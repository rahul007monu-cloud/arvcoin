/* arvcoin — service worker (offline cache) */
var CACHE = "arvcoin-v7";
var ASSETS = [
  "index.html",
  "styles.css",
  "main.js",
  "3d.js",
  "auth.css",
  "auth.js",
  "login.html",
  "signup.html",
  "verify.html",
  "kyc.html",
  "dashboard.html",
  "dashboard.css",
  "dashboard.js",
  "transak.js",
  "wallet.js",
  "pricing.html",
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
  // network-first for HTML, cache-first for assets
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match("index.html"); }); })
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
