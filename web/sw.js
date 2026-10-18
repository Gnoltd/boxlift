/* Web demo Service Worker: cache-first for the AI model files under MODEL_BASE (passed as ?base= on the registration URL).
 * Every other request is left alone. The logic (one download per model, network fallback on cache errors) is
 * SwCore.cacheFirst in /shim/sw-core.js, unit-tested in Node. */
importScripts('/shim/sw-core.js');
const C = self.SwCore, BASE = C.baseFromSwUrl(self.location.href);
const inflight = new Map();   // cache key -> Promise<boolean> (true once the model is stored)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(C.staleCaches(ks).map((k) => caches.delete(k)))).catch(() => {}).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (!C.shouldHandle(e.request, BASE)) return;
  e.respondWith(C.cacheFirst(e.request, { caches, fetch: (r) => fetch(r), inflight, waitUntil: (p) => e.waitUntil(p) }));
});
