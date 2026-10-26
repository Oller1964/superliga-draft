// Gør appen installerbar og hurtig at åbne. Alt hentes fra nettet først,
// så man altid ser nyeste picks og priser; den gemte kopi bruges kun uden net.
var CACHE = "superliga-draft-v4";
var SKAL = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.webmanifest", "ikon-192.png", "ikon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SKAL); }));
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (navne) {
    return Promise.all(navne.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }));
  self.clients.claim();
});
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (svar) {
    if (svar.ok && !url.pathname.includes("/data/")) {
      var kopi = svar.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, kopi); });
    }
    return svar;
  }).catch(function () { return caches.match(e.request); }));
});
