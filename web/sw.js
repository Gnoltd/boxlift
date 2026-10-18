/* Web demo Service Worker: cache-first for the AI model files under MODEL_BASE (passed as ?base= on the registration URL).
 * Every other request is left alone. Each model crosses the network once; concurrent requests for the same model (the
 * prefetch chip and onnxruntime) wait for the first download instead of starting a second one. */
importScripts('/shim/sw-core.js');
const C = self.SwCore, BASE = C.baseFromSwUrl(self.location.href);
const inflight = new Map();   // cache key -> Promise<boolean> (true once the model is stored)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(C.staleCaches(ks).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(e) {
  const req = e.request, key = C.cacheKey(req.url), cache = await caches.open(C.CACHE_NAME);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  if (inflight.has(key)) {
    if (await inflight.get(key)) { const h = await cache.match(key, { ignoreVary: true }); if (h) return h; }
    return fetch(req);
  }
  let settle;
  const stored = new Promise((r) => { settle = r; });
  inflight.set(key, stored);
  stored.then(() => inflight.delete(key));
  e.waitUntil(stored);
  let res;
  try { res = await fetch(req); } catch (err) { settle(false); throw err; }   // redirects are followed (302 -> signed CDN URL)
  if (!C.shouldCache(res)) { settle(false); return res; }
  // put() reads the clone to the end and rejects when the body breaks off, so only complete files are stored.
  cache.put(key, res.clone()).then(() => settle(true), () => settle(false));
  return res;
}

self.addEventListener('fetch', (e) => {
  if (C.shouldHandle(e.request, BASE)) e.respondWith(cacheFirst(e));
});
