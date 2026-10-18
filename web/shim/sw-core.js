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

  return { CACHE_NAME, baseFromSwUrl, cacheKey, isModelUrl, shouldHandle, shouldCache, staleCaches };
});
