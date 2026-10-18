/* Model prefetch for the web demo: fetch() each .onnx once so it sits in the HTTP cache; ORT later fetches the same URL. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.ModelLoader = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Priority order; mtrans is last and only used with WebGPU. Sizes (bytes) are estimates until content-length is seen.
  const MODELS = [['yolox_s.onnx', 35.9e6], ['frustum_seg.onnx', 0.7e6], ['frustum_box.onnx', 2.9e6], ['heading.onnx', 6.1e6], ['mtrans.onnx', 83.6e6]];
  const EST = {}; MODELS.forEach(([n, s]) => { EST[n] = s; });
  const nameOf = (url) => String(url).split('?')[0].split('/').pop();

  function urlsFor(modelBase, gpu) {
    const base = String(modelBase || '').replace(/\/?$/, '/');
    return MODELS.filter(([n]) => gpu || n !== 'mtrans.onnx').map(([n]) => base + n);
  }
  async function hasGpu(nav) {
    try { return !!(nav && nav.gpu && await nav.gpu.requestAdapter()); } catch (e) { return false; }
  }

  // Sequential in priority order (parallel would split bandwidth and delay the first usable model). One failure never stops the rest.
  async function prefetch(urls, onProgress, fetchImpl) {
    const f = fetchImpl || ((u) => fetch(u));
    const size = urls.map((u) => EST[nameOf(u)] || 0), done = urls.map(() => 0);
    const failed = [];
    const report = (i) => {
      if (!onProgress) return;
      onProgress({ loaded: done.reduce((a, b) => a + b, 0), total: size.reduce((a, b) => a + b, 0), file: nameOf(urls[i]) });
    };
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await f(urls[i]);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const len = +(r.headers && r.headers.get('content-length'));
        if (len > 0) size[i] = len;
        const reader = r.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          done[i] += value.length; report(i);
        }
        size[i] = Math.max(size[i], done[i]);
        report(i);
      } catch (e) { failed.push(urls[i]); }
    }
    return { ok: failed.length === 0, failed };
  }
  const retry = (failed, onProgress, fetchImpl) => prefetch(failed, onProgress, fetchImpl);

  return { MODELS, urlsFor, hasGpu, prefetch, retry };
});
