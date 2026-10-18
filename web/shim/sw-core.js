/* Pure helpers of the web demo Service Worker (web/sw.js loads this with importScripts). The HF resolve URL answers 302
 * (no-store) to a signed CDN URL that changes per request, so the HTTP cache never hits; the SW keeps each model in Cache
 * Storage under the STABLE request URL instead. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.SwCore = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CACHE_PREFIX = 'boxlift-models-', CACHE_NAME = CACHE_PREFIX + 'v1';

  // The model base is passed on the registration URL (/sw.js?base=<abs url>), so the SW never hard-codes a host.
  function baseFromSwUrl(swUrl) {
    try { return new URL(String(swUrl)).searchParams.get('base') || ''; } catch (e) { return ''; }
  }
  const cacheKey = (url) => String(url).split('#')[0];
  function isModelUrl(url, base) {
    if (!base) return false;
    const u = cacheKey(url);
    return u.startsWith(base) && /\.(onnx|json)$/.test(u.split('?')[0]);
  }
  // Range requests (partial content) go straight to the network, uncached; only GET is intercepted.
  function shouldHandle(req, base) {
    if (!req || req.method !== 'GET') return false;
    if (req.headers && req.headers.get('range')) return false;
    return isModelUrl(req.url, base);
  }
  const shouldCache = (res) => !!res && res.ok === true && res.status === 200 && (res.type === 'basic' || res.type === 'cors' || res.type === 'default');
  const staleCaches = (names) => names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME);

  // Cache-first with injected deps {caches, fetch, inflight: Map(key -> Promise<boolean stored>), waitUntil}. Any Cache Storage
  // error (blocked, private mode, corrupt) ends in a plain network fetch. Concurrent misses for one file share one download:
  // the waiters get the stored copy once it is in. put() reads the clone to the end and rejects on a broken body, so only
  // complete files are stored; a put failure only means "not cached".
  async function cacheFirst(req, d) {
    const key = cacheKey(req.url), match = (c) => c.match(key, { ignoreVary: true });
    let cache;
    try { cache = await d.caches.open(CACHE_NAME); const hit = await match(cache); if (hit) return hit; } catch (e) { return d.fetch(req); }
    if (d.inflight.has(key)) {
      try { if (await d.inflight.get(key)) { const h = await match(cache); if (h) return h; } } catch (e) { /* fall through to network */ }
      return d.fetch(req);
    }
    let settle;
    const stored = new Promise((r) => { settle = r; });
    d.inflight.set(key, stored);
    stored.then(() => d.inflight.delete(key));
    d.waitUntil(stored);
    let res;
    try { res = await d.fetch(req); } catch (err) { settle(false); throw err; }   // redirects are followed (302 -> signed CDN URL)
    if (!shouldCache(res)) { settle(false); return res; }
    try { Promise.resolve(cache.put(key, res.clone())).then(() => settle(true), () => settle(false)); } catch (e) { settle(false); }
    return res;
  }

  return { CACHE_NAME, baseFromSwUrl, cacheKey, isModelUrl, shouldHandle, shouldCache, staleCaches, cacheFirst };
});
