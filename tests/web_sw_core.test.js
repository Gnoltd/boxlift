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
