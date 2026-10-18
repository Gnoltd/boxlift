/*
 * 2D detector page (iframe inside the CVAT tab, extension origin): YOLOX via onnxruntime-web, on the GPU
 * (WebGPU) when the browser has one, else WASM on one thread; pre/post-processing in detect.js. Requests run one
 * after another (a session runs one inference at a time). The content script hands over a MessageChannel port in its
 * first message; requests and answers then go only through that port:
 *   -> {id, kind: 'size'}   loads YOLOX
 *   <- {id, ok, size, ep}   ep = 'webgpu' | 'wasm'
 *   -> {id, rgba: ArrayBuffer (SxS letterboxed RGBA), r (scale of the image in the input), opts}
 *   <- {id, ok, dets: [{u0, v0, u1, v1, score, cls, label}], ms} | {id, ok: false, error}
 *   -> {id, kind: 'heading', crops: ArrayBuffer (n x 3 x 128 x 128 float, heading.js), n}
 *   <- {id, ok, logits: Float32Array (n x 8)}   front / back model (tools/heading/)
 *   -> {id, kind: 'frustum', pts: ArrayBuffer (n x 1024 x 3, frustum.js prepare), onehot: ArrayBuffer (n x 6), n}
 *   <- {id, ok, out: Float32Array (n x 30), cen: [[x, y, z]] , nObj: [object points]}   frustum models (tools/frustum/)
 *   -> {id, kind: 'mtrans', image, overlap, cloud, cloud2d, real: ArrayBuffers (mtrans.js newBatch), n}
 *   <- {id, ok, box: Float32Array (n x 7), dir: Float32Array (n x 2)}   MTrans, cars (GPU only: ~2 s per car on WASM)
 *   ready: {ready: true} as soon as the port is connected (each model loads on its first request)
 * Nothing leaves the browser: the model and the runtime are files of the extension.
 */
(function () {
  'use strict';
  const MODEL = 'models/yolox_s.onnx';            // S over Tiny: more objects found (tools/public/NHAT-KY-DO.md)
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = 1;             // not cross-origin isolated inside the CVAT tab
  const HEADING = 'models/heading.onnx', SEG = 'models/frustum_seg.onnx', BOX = 'models/frustum_box.onnx', MTRANS = 'models/mtrans.onnx';
  // GPU when there is one (YOLOX-S: ~0.7 s per camera on one CPU thread); a failed GPU session falls back to WASM
  const gpu = (async () => { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; } })();
  let ep = 'wasm';
  async function create(file) {
    const url = chrome.runtime.getURL(file);
    if (await gpu) {
      try { const s = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'] }); ep = 'webgpu'; return s; }
      catch (e) { console.warn('[lidar-cam] WebGPU unavailable for', file, '-', e.message, '-> WASM'); }
    }
    return ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
  }
  /** fn() once, shared by every caller; a failure is forgotten so the next call tries again. */
  const lazy = (fn) => { let p = null; return () => (p ??= fn().catch((e) => { p = null; throw e; })); };
  const load = lazy(() => create(MODEL));
  const loadHeading = lazy(() => create(HEADING));
  const loadFrustum = lazy(() => Promise.all([create(SEG), create(BOX)]));
  // MTrans only on the GPU (51 ms per car there, ~2 s on one WASM thread): without one the caller keeps the frustum box
  const loadMTrans = lazy(async () => {
    if (!(await gpu)) throw new Error('no WebGPU');
    return ort.InferenceSession.create(chrome.runtime.getURL(MTRANS), { executionProviders: ['webgpu'] });
  });
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  // request kind -> answer fields (id and ok are added by the port handler)
  const handlers = {
    async size() {                               // YOLOX: only auto-detection needs it
      const s = await load();
      return { size: s.inputMetadata[0].shape[2], ep };
    },
    async frustum(data) {                        // frustum.js: seg -> object points -> box, n boxes at once
      const [seg, box] = await loadFrustum(), n = data.n, F = Frustum, C = F.CLASSES.length;
      const pts = new Float32Array(data.pts), oh = new Float32Array(data.onehot);
      const lg = (await seg.run({ points: new ort.Tensor('float32', pts, [n, F.N1, 3]), onehot: new ort.Tensor('float32', oh, [n, C]) })).logits.data;
      const obj = Array.from({ length: n }, (_, k) => F.objectPoints(pts.subarray(k * F.N1 * 3, (k + 1) * F.N1 * 3), lg, k * F.N1 * 2));
      const P2 = new Float32Array(n * F.N2 * 3);
      obj.forEach((o, k) => P2.set(o.pts, k * F.N2 * 3));
      const out = (await box.run({ points: new ort.Tensor('float32', P2, [n, F.N2, 3]), onehot: new ort.Tensor('float32', oh, [n, C]) })).out.data;
      return { out, cen: obj.map((o) => o.cen), nObj: obj.map((o) => o.n) };
    },
    async mtrans(data) {
      const s = await loadMTrans(), n = data.n, S = 112, N = 512, T = (b, ...d) => new ort.Tensor('float32', new Float32Array(b), [n, ...d]);
      const out = await s.run({ image: T(data.image, 3, S, S), overlap: T(data.overlap, 1, S, S), cloud: T(data.cloud, N, 3), cloud2d: T(data.cloud2d, N, 2), real: T(data.real, N) });
      return { box: out.box.data, dir: out.dir.data };
    },
    async heading(data) {
      const h = await loadHeading();
      const out = await h.run({ [h.inputNames[0]]: new ort.Tensor('float32', new Float32Array(data.crops), [data.n, 3, 128, 128]) });
      return { logits: out[h.outputNames[0]].data };
    },
    async detect(data) {
      const s = await load(), size = s.inputMetadata[0].shape[2], t0 = performance.now();
      if (data.size != null && data.size !== size) throw new Error(`input ${data.size} != model ${size}`);
      const x = new ort.Tensor('float32', Detect.tensorFromRGBA(new Uint8ClampedArray(data.rgba), size), [1, 3, size, size]);
      const out = await s.run({ [s.inputNames[0]]: x });
      return { dets: Detect.decode(out[s.outputNames[0]].data, size, data.r, data.opts), ms: performance.now() - t0 };
    },
  };

  let port = null;
  // Only a CVAT page may take the port: this page is web-accessible, so any site could embed it and borrow the GPU.
  const CVAT_ORIGINS = ['https://app.cvat.ai', 'http://localhost:8080', 'http://127.0.0.1:8080'];
  async function fromCvat(origin) {
    if (CVAT_ORIGINS.includes(origin)) return true;
    const { origins = [] } = await chrome.storage.local.get('origins');
    return origins.includes(origin);
  }
  window.addEventListener('message', async (e) => {
    if (port || e.source !== window.parent || !e.data || e.data.type !== 'lidar-cam-detector' || !e.ports[0]) return;
    if (!(await fromCvat(e.origin)) || port) return;
    port = e.ports[0];
    port.onmessage = ({ data }) => serial(async () => {
      try { port.postMessage({ id: data.id, ok: true, ...(await handlers[data.kind || 'detect'](data)) }); }
      catch (err) { port.postMessage({ id: data.id, ok: false, error: String((err && err.message) || err) }); }
    });
    port.postMessage({ ready: true });
  });
})();
