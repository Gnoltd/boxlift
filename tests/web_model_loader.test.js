// node tests/web_model_loader.test.js — ModelLoader.prefetch/retry/urlsFor with an injected fetch (ReadableStream bodies).
const assert = require('assert');
const ModelLoader = require('../web/shim/model-loader.js');

const BASE = 'https://models.example/m/';
function body(n, chunk, failAt) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (failAt != null && sent >= failAt) return c.error(new Error('reset'));
      if (sent >= n) return c.close();
      const k = Math.min(chunk, n - sent); sent += k; c.enqueue(new Uint8Array(k));
    }
  });
}
// plan: file name -> {status, size, failAt}
function fakeFetch(plan, calls) {
  return async (url) => {
    calls.push(url);
    const p = plan[url.slice(BASE.length)];
    if (!p) return { ok: false, status: 404 };
    if (p.status && p.status !== 200) return { ok: false, status: p.status };
    return { ok: true, status: 200, headers: { get: (h) => (/content-length/i.test(h) ? String(p.size) : null) }, body: body(p.size, 10, p.failAt) };
  };
}

(async () => {
  // urlsFor: priority order, mtrans last and only with WebGPU
  const withGpu = ModelLoader.urlsFor(BASE, true);
  assert.deepStrictEqual(withGpu.map((u) => u.slice(BASE.length)),
    ['yolox_s.onnx', 'frustum_seg.onnx', 'frustum_box.onnx', 'heading.onnx', 'mtrans.onnx']);
  const noGpu = ModelLoader.urlsFor(BASE, false);
  assert.ok(!noGpu.some((u) => /mtrans/.test(u)));
  assert.strictEqual(noGpu.length, 4);
  assert.strictEqual(ModelLoader.urlsFor('https://x/m', true)[0], 'https://x/m/yolox_s.onnx'); // adds missing slash

  // hasGpu: injected navigator
  assert.strictEqual(await ModelLoader.hasGpu({}), false);
  assert.strictEqual(await ModelLoader.hasGpu({ gpu: { requestAdapter: async () => null } }), false);
  assert.strictEqual(await ModelLoader.hasGpu({ gpu: { requestAdapter: async () => ({}) } }), true);
  assert.strictEqual(await ModelLoader.hasGpu({ gpu: { requestAdapter: async () => { throw new Error('x'); } } }), false);

  // all ok: monotonic progress, total reflects content-length
  const plan = { 'a.onnx': { size: 100 }, 'b.onnx': { size: 50 }, 'c.onnx': { size: 30 } };
  let calls = [], ev = [];
  let r = await ModelLoader.prefetch(['a', 'b', 'c'].map((n) => BASE + n + '.onnx'), (e) => ev.push(e), fakeFetch(plan, calls));
  assert.deepStrictEqual(r, { ok: true, failed: [] });
  assert.ok(ev.length > 3);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].loaded >= ev[i - 1].loaded, 'loaded must not decrease');
  assert.strictEqual(ev[ev.length - 1].loaded, 180);
  assert.strictEqual(ev[ev.length - 1].total, 180);
  assert.ok(ev.every((e) => typeof e.file === 'string'));

  // one 500 and one mid-stream abort: others still download
  plan['b.onnx'] = { status: 500 };
  plan['c.onnx'] = { size: 30, failAt: 10 };
  plan['d.onnx'] = { size: 20 };
  calls = []; ev = [];
  const urls = ['a', 'b', 'c', 'd'].map((n) => BASE + n + '.onnx');
  r = await ModelLoader.prefetch(urls, (e) => ev.push(e), fakeFetch(plan, calls));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.failed, [urls[1], urls[2]]);
  assert.deepStrictEqual(calls, urls, 'every file attempted');
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].loaded >= ev[i - 1].loaded);

  // a fetch that throws (network blocked) also only fails that file
  const boom = async (u) => { if (/b\.onnx/.test(u)) throw new TypeError('Failed to fetch'); return fakeFetch(plan, [])(u); };
  r = await ModelLoader.prefetch(urls, () => {}, boom);
  assert.deepStrictEqual(r.failed.includes(urls[1]), true);
  assert.strictEqual(r.failed.includes(urls[0]), false);

  // retry: only the failed ones are re-requested
  plan['b.onnx'] = { size: 50 }; plan['c.onnx'] = { size: 30 };
  calls = [];
  r = await ModelLoader.retry([urls[1], urls[2]], () => {}, fakeFetch(plan, calls));
  assert.deepStrictEqual(r, { ok: true, failed: [] });
  assert.deepStrictEqual(calls, [urls[1], urls[2]]);

  // empty list is ok
  assert.deepStrictEqual(await ModelLoader.prefetch([], () => {}, fakeFetch(plan, [])), { ok: true, failed: [] });
  console.log('web_model_loader ok');
})().catch((e) => { console.error(e); process.exit(1); });
