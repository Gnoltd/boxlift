/*
 * Learned 2D box -> 3D box (Frustum PointNet, tools/frustum/): the points whose image position is in the drawn box,
 * turned so the frustum looks along +x, go through a segmentation model (which points are the object) and a box
 * model (centre, size, heading of the whole object, the hidden side too). Same steps as tools/frustum/train.py.
 * Pure functions: the detector page runs the two ONNX models between prepare / objectPoints / decode.
 */
(function (root) {
  'use strict';
  const CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian'];
  const MEAN_SIZE = [[4.6, 1.95, 1.7], [7.5, 2.6, 3.1], [11.0, 2.9, 3.4], [2.1, 0.8, 1.5], [1.8, 0.65, 1.4], [0.75, 0.7, 1.75]];
  const N1 = 1024, N2 = 512, NH = 12;
  const SYN = { car: ['car', 'van', 'vehicle'], truck: ['truck', 'lorry', 'construction', 'trailer'], bus: ['bus'],
    motorcycle: ['motorcycle', 'motorbike', 'moto'], bicycle: ['bicycle', 'bike', 'cyclist'], pedestrian: ['pedestrian', 'person', 'people', 'human', 'người'] };

  /** Class index of a label name (null: not a class the model knows). */
  function classOf(label) {
    const k = String(label || '').toLowerCase();
    for (const [c, ws] of Object.entries(SYN)) if (ws.some((w) => k.includes(w))) return CLASSES.indexOf(c);
    return null;
  }
  /** Small deterministic generator: the same box gives the same sample every time. */
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
  function sample(n, k, r) {
    const out = new Int32Array(k);
    if (n >= k) {                                          // without replacement: partial Fisher-Yates
      const a = Int32Array.from({ length: n }, (_, i) => i);
      for (let i = 0; i < k; i++) { const j = i + Math.floor(r() * (n - i)); const t = a[i]; a[i] = a[j]; a[j] = t; out[i] = a[i]; }
    } else for (let i = 0; i < k; i++) out[i] = i < n ? i : Math.floor(r() * n);
    return out;
  }
  /**
   * xyz: cloud (pcd frame, z up); idx: indices of the points in the drawn 2D box; cls: class index.
   * -> {phi, pts: Float32Array(N1 * 3) in the frustum frame, onehot: Float32Array(6)}
   */
  function prepare(xyz, idx, cls) {
    let sx = 0, sy = 0;
    for (const i of idx) { const a = Math.atan2(xyz[3 * i + 1], xyz[3 * i]); sx += Math.cos(a); sy += Math.sin(a); }
    const phi = Math.atan2(sy, sx), c = Math.cos(phi), s = Math.sin(phi);
    const pick = sample(idx.length, N1, rng(idx.length * 2654435761 + idx[0]));
    const pts = new Float32Array(N1 * 3);
    pick.forEach((k, j) => {
      const i = idx[k], x = xyz[3 * i], y = xyz[3 * i + 1];
      pts[3 * j] = c * x + s * y; pts[3 * j + 1] = -s * x + c * y; pts[3 * j + 2] = xyz[3 * i + 2];
    });
    const onehot = new Float32Array(CLASSES.length); onehot[cls] = 1;
    return { phi, pts, onehot };
  }
  /** Seg logits (N1 x 2, at offset) -> object points minus their centroid (N2 x 3) + centroid + count. */
  function objectPoints(pts, logits, off = 0) {
    const obj = [];
    for (let j = 0; j < N1; j++) if (logits[off + 2 * j + 1] > logits[off + 2 * j]) obj.push(j);
    const use = obj.length >= 3 ? obj : Array.from({ length: N1 }, (_, j) => j);
    const cen = [0, 0, 0];
    for (const j of use) for (let d = 0; d < 3; d++) cen[d] += pts[3 * j + d] / use.length;
    const pick = sample(use.length, N2, rng(use.length * 40503 + 7)), out = new Float32Array(N2 * 3);
    pick.forEach((k, m) => { for (let d = 0; d < 3; d++) out[3 * m + d] = pts[3 * use[k] + d] - cen[d]; });
    return { pts: out, cen, n: obj.length };
  }
  /** Box model output (30 values at offset) -> box in the pcd frame {x, y, z, l, w, h, yaw}. */
  function decode(out, off, cls, cen, phi) {
    let k = 0;
    for (let i = 1; i < NH; i++) if (out[off + 3 + i] > out[off + 3 + k]) k = i;
    const yawF = k * (2 * Math.PI / NH) + out[off + 3 + NH + k] * (Math.PI / NH);
    const ms = MEAN_SIZE[cls], cx = cen[0] + out[off], cy = cen[1] + out[off + 1], c = Math.cos(phi), s = Math.sin(phi);
    const yaw = Math.atan2(Math.sin(yawF + phi), Math.cos(yawF + phi));
    return { x: c * cx - s * cy, y: s * cx + c * cy, z: cen[2] + out[off + 2], yaw,
      l: ms[0] * (1 + out[off + 3 + 2 * NH]), w: ms[1] * (1 + out[off + 4 + 2 * NH]), h: ms[2] * (1 + out[off + 5 + 2 * NH]) };
  }
  /**
   * How sure the box model is about front / back: heading-bin probability on the far half-circle (the box turned by
   * 180 deg) over the near half, around the decoded heading. < 1: the model keeps its end. Fused with the image
   * model's odds by the extension (heading step).
   */
  function endOdds(out, off) {
    let k = 0, m = -Infinity;
    for (let i = 0; i < NH; i++) m = Math.max(m, out[off + 3 + i]);
    for (let i = 1; i < NH; i++) if (out[off + 3 + i] > out[off + 3 + k]) k = i;
    const yawF = k * (2 * Math.PI / NH) + out[off + 3 + NH + k] * (Math.PI / NH);
    let near = 0, far = 0;
    for (let i = 0; i < NH; i++) {
      const p = Math.exp(out[off + 3 + i] - m), d = Math.cos(i * (2 * Math.PI / NH) - yawF);
      if (d >= 0) near += p; else far += p;
    }
    return far / Math.max(1e-12, near);
  }

  /**
   * Which box to keep: the learned one for the classes where it measured better than the geometric box (USE),
   * unless its segmentation found almost nothing (MIN_OBJ object points). Measured in tools/public/NHAT-KY-DO.md 4.G
   * (eval_boxes.js --learned): motorcycle stays geometric (the learned box is still a little worse there).
   */
  const MIN_OBJ = 5;
  const USE = [true, true, true, false, true, true];
  const prefer = (learned, nObj, cls) => !!learned && nObj >= MIN_OBJ && USE[cls];

  const api = { CLASSES, N1, N2, NH, MIN_OBJ, USE, classOf, prepare, objectPoints, decode, endOdds, prefer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Frustum = api;
})(typeof self !== 'undefined' ? self : this);
