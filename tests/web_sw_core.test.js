// node tests/web_sw_core.test.js — pure helpers of the web demo Service Worker (web/shim/sw-core.js): which requests are
// cached model files, the stable cache key, which responses may be stored, and which old caches to drop.
const assert = require('assert');
const C = require('../web/shim/sw-core.js');

const HF = 'https://huggingface.co/u/boxlift-models/resolve/main/';
assert.strictEqual(C.CACHE_NAME, 'boxlift-models-v1');

// model base from the registration URL (/sw.js?base=...), never hard-coded
assert.strictEqual(C.baseFromSwUrl('https://d.example/sw.js?base=' + encodeURIComponent(HF)), HF);
assert.strictEqual(C.baseFromSwUrl('https://d.example/sw.js'), '');
assert.strictEqual(C.baseFromSwUrl('not a url'), '');

// is-model-url: starts with the base and the path ends with .onnx / .json
assert.strictEqual(C.isModelUrl(HF + 'yolox_s.onnx', HF), true);
assert.strictEqual(C.isModelUrl(HF + 'frustum.json', HF), true);
assert.strictEqual(C.isModelUrl(HF + 'yolox_s.onnx#x', HF), true);
assert.strictEqual(C.isModelUrl(HF + 'README.md', HF), false);
assert.strictEqual(C.isModelUrl('https://other.example/yolox_s.onnx', HF), false);
assert.strictEqual(C.isModelUrl('https://huggingface.co/u/evil/yolox_s.onnx', HF), false);
assert.strictEqual(C.isModelUrl(HF + 'yolox_s.onnx', ''), false, 'no base: never intercept');
assert.strictEqual(C.isModelUrl(HF + 'yolox_s.onnx', undefined), false);
assert.strictEqual(C.isModelUrl('https://d.example/models/heading.onnx', 'https://d.example/models/'), true);
assert.strictEqual(C.isModelUrl('https://d.example/ext/ort/ort.wasm', 'https://d.example/models/'), false);
assert.strictEqual(C.isModelUrl(HF + 'x.onnx.bak', HF), false);

// cache key: the STABLE request URL (no fragment)
assert.strictEqual(C.cacheKey(HF + 'yolox_s.onnx'), HF + 'yolox_s.onnx');
assert.strictEqual(C.cacheKey(HF + 'yolox_s.onnx#frag'), HF + 'yolox_s.onnx');

// shouldHandle: GET model requests without Range only
const req = (url, o) => ({ url, method: (o && o.method) || 'GET', headers: { get: (k) => (o && o.headers && o.headers[k.toLowerCase()]) || null } });
assert.strictEqual(C.shouldHandle(req(HF + 'mtrans.onnx'), HF), true);
assert.strictEqual(C.shouldHandle(req(HF + 'mtrans.onnx', { method: 'POST' }), HF), false);
assert.strictEqual(C.shouldHandle(req(HF + 'mtrans.onnx', { method: 'HEAD' }), HF), false);
assert.strictEqual(C.shouldHandle(req(HF + 'mtrans.onnx', { headers: { range: 'bytes=0-99' } }), HF), false, 'Range goes to network');
assert.strictEqual(C.shouldHandle(req('https://d.example/boot.js'), HF), false);
assert.strictEqual(C.shouldHandle(null, HF), false);

// shouldCache: only complete 200 responses (no partial 206, no opaque, no errors)
assert.strictEqual(C.shouldCache({ ok: true, status: 200, type: 'cors' }), true);
assert.strictEqual(C.shouldCache({ ok: true, status: 200, type: 'basic' }), true);
assert.strictEqual(C.shouldCache({ ok: true, status: 206, type: 'cors' }), false);
assert.strictEqual(C.shouldCache({ ok: false, status: 404, type: 'cors' }), false);
assert.strictEqual(C.shouldCache({ ok: false, status: 0, type: 'opaque' }), false);
assert.strictEqual(C.shouldCache({ ok: true, status: 200, type: 'opaqueredirect' }), false);
assert.strictEqual(C.shouldCache(null), false);

// old versions of the model cache are dropped on activate; other caches are left alone
assert.deepStrictEqual(C.staleCaches(['boxlift-models-v0', 'boxlift-models-v1', 'other', 'boxlift-models-old']), ['boxlift-models-v0', 'boxlift-models-old']);
assert.deepStrictEqual(C.staleCaches([]), []);

console.log('web_sw_core ok');

// cacheFirst with injected caches / fetch: cache errors fall back to the network, one download per file, only 200 stored
(async () => {
  const URL0 = HF + 'yolox_s.onnx';
  const res = (status, tag) => ({ ok: status >= 200 && status < 300, status, type: 'cors', tag, clone() { return { ...this, cloned: true }; } });
  const mkReq = (url) => ({ url, method: 'GET', headers: { get: () => null } });
  function env(o) {
    o = o || {};
    const store = new Map(o.stored || []), puts = [], fetches = [], waits = [];
    const cache = {
      match: async (k) => { if (o.matchFails) throw new Error('match'); return store.get(k); },
      put: async (k, r) => { puts.push([k, r]); if (o.putFails) throw new Error('quota'); store.set(k, r); }
    };
    const caches = { open: async () => { if (o.openFails) throw new Error('blocked'); return cache; } };
    const fetchFn = async (r) => { fetches.push(r.url); if (o.slow) await new Promise((z) => setTimeout(z, 20)); return res(o.status || 200, 'net'); };
    return { deps: { caches, fetch: fetchFn, inflight: new Map(), waitUntil: (p) => waits.push(p) }, puts, fetches, waits, store };
  }
  let e = env({ openFails: true });
  let r = await C.cacheFirst(mkReq(URL0), e.deps);
  assert.strictEqual(r.tag, 'net', 'caches.open rejects -> network'); assert.deepStrictEqual(e.fetches, [URL0]);
  e = env({ matchFails: true });
  r = await C.cacheFirst(mkReq(URL0), e.deps);
  assert.strictEqual(r.tag, 'net', 'cache.match rejects -> network');
  e = env({ stored: [[URL0, res(200, 'cached')]] });
  r = await C.cacheFirst(mkReq(URL0), e.deps);
  assert.strictEqual(r.tag, 'cached'); assert.strictEqual(e.fetches.length, 0, 'hit: no fetch');
  e = env();
  r = await C.cacheFirst(mkReq(URL0 + '#x'), e.deps);
  assert.strictEqual(r.tag, 'net'); await Promise.all(e.waits);
  assert.strictEqual(e.puts.length, 1); assert.strictEqual(e.puts[0][0], URL0, 'stable key'); assert.strictEqual(e.puts[0][1].cloned, true, 'put gets a clone');
  e = env({ slow: true });
  const [a, b] = await Promise.all([C.cacheFirst(mkReq(URL0), e.deps), C.cacheFirst(mkReq(URL0), e.deps)]);
  assert.strictEqual(e.fetches.length, 1, 'two concurrent misses -> one fetch'); assert.ok(a && b);
  e = env({ status: 404 });
  r = await C.cacheFirst(mkReq(URL0), e.deps);
  assert.strictEqual(r.status, 404); assert.strictEqual(e.puts.length, 0, 'non-200 not cached');
  e = env({ putFails: true });
  r = await C.cacheFirst(mkReq(URL0), e.deps); await Promise.all(e.waits);
  assert.strictEqual(r.tag, 'net', 'put failure stays graceful');
  e = env({ slow: true, matchFails: false });
  // waiter whose second match fails falls back to the network
  const d = e.deps; let calls = 0;
  const cache2 = { match: async () => { if (calls++ >= 1) throw new Error('match'); return undefined; }, put: async () => {} };
  d.caches = { open: async () => cache2 };
  d.inflight.set(URL0, Promise.resolve(true));
  r = await C.cacheFirst(mkReq(URL0), d);
  assert.strictEqual(r.tag, 'net', 'waiter: second match rejects -> network');
  console.log('web_sw_core cacheFirst ok');
})().catch((err) => { console.error(err); process.exit(1); });
