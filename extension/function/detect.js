/*
 * 2D object detection for auto-labelling: pre/post-processing of YOLOX (Megvii, Apache 2.0, COCO-trained,
 * official ONNX export: input "images" 1x3xSxS BGR 0..255 letterboxed top-left with grey 114, output
 * 1xNx85 = [x, y, w, h (grid units, raw), objectness, 80 class scores (both after sigmoid)]).
 * Pure functions: the extension's detector page (detector.js) and the offline evaluation
 * (tools/public/eval_auto.js) run exactly this code around the same model.
 */
(function (root) {
  'use strict';
  // COCO class -> label used by the box tool (boxfit.js priors); other classes are ignored
  const COCO = { 0: 'pedestrian', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' };
  const STRIDES = [8, 16, 32];

  /** Scale and size of the image inside the SxS model input (top-left, YOLOX preproc). */
  function letterbox(w, h, size) {
    const r = Math.min(size / w, size / h);
    return { r, nw: Math.round(w * r), nh: Math.round(h * r) };
  }
  /** RGBA pixels (SxS, letterboxed) -> Float32 CHW planes in BGR order, 0..255. */
  function tensorFromRGBA(rgba, size) {
    const n = size * size, out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { out[i] = rgba[4 * i + 2]; out[n + i] = rgba[4 * i + 1]; out[2 * n + i] = rgba[4 * i]; }
    return out;
  }
  /** BGR pixels (SxS, letterboxed, interleaved) -> Float32 CHW planes (offline, from OpenCV). */
  function tensorFromBGR(bgr, size) {
    const n = size * size, out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { out[i] = bgr[3 * i]; out[n + i] = bgr[3 * i + 1]; out[2 * n + i] = bgr[3 * i + 2]; }
    return out;
  }
  const iou = (a, b) => {
    const iw = Math.max(0, Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0)), ih = Math.max(0, Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0));
    const i = iw * ih;
    return i / ((a.u1 - a.u0) * (a.v1 - a.v0) + (b.u1 - b.u0) * (b.v1 - b.v0) - i);
  };
  /**
   * Model output -> detections in original image pixels, wanted classes only.
   * opts: scoreThr (objectness x class), nms (same class), nmsAny (across vehicle classes: a car also
   * scored as truck), minSize (px, shorter side).
   */
  function decode(out, size, r, { scoreThr = 0.3, nms = 0.45, nmsAny = 0.7, minSize = 12 } = {}) {
    const dets = [];
    let a = 0;
    for (const s of STRIDES) {
      const g = size / s;
      for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++, a++) {
        const o = a * 85, obj = out[o + 4];
        if (obj < scoreThr) continue;
        let best = -1, bs = 0;
        for (const c in COCO) { const sc = obj * out[o + 5 + Number(c)]; if (sc > bs) { bs = sc; best = Number(c); } }
        if (best < 0 || bs < scoreThr) continue;
        const cx = (out[o] + gx) * s, cy = (out[o + 1] + gy) * s, w = Math.exp(out[o + 2]) * s, h = Math.exp(out[o + 3]) * s;
        const d = { u0: (cx - w / 2) / r, v0: (cy - h / 2) / r, u1: (cx + w / 2) / r, v1: (cy + h / 2) / r, score: bs, cls: best, label: COCO[best] };
        if (Math.min(d.u1 - d.u0, d.v1 - d.v0) >= minSize) dets.push(d);
      }
    }
    dets.sort((p, q) => q.score - p.score);
    const keep = [];
    const vehicle = (d) => d.cls === 2 || d.cls === 5 || d.cls === 7;
    for (const d of dets) {
      if (keep.some((k) => (k.cls === d.cls ? iou(k, d) > nms : vehicle(k) && vehicle(d) && iou(k, d) > nmsAny))) continue;
      keep.push(d);
    }
    return mergeRiders(keep);
  }

  /**
   * Merge a rider (pedestrian) into a bicycle or motorcycle when overlapping (cyclist/motorcyclist).
   * Autonomous driving 3D annotation requires the rider and two-wheeler as one bounding box labeled as vehicle.
   */
  function mergeRiders(dets) {
    const bikes = dets.filter((d) => d.cls === 1 || d.cls === 3);
    const people = dets.filter((d) => d.cls === 0);
    if (!bikes.length || !people.length) return dets;
    const mergedPeople = new Set();
    for (const b of bikes) {
      const bw = b.u1 - b.u0, bh = b.v1 - b.v0;
      let bestP = null, bestScore = 0;
      for (const p of people) {
        if (mergedPeople.has(p)) continue;
        const pw = p.u1 - p.u0, ph = p.v1 - p.v0;
        const iw = Math.max(0, Math.min(b.u1, p.u1) - Math.max(b.u0, p.u0));
        const ih = Math.max(0, Math.min(b.v1, p.v1) - Math.max(b.v0, p.v0));
        const inter = iw * ih;
        if (inter <= 0) continue;
        const horizOverlap = iw / Math.min(bw, pw);
        const personCentroidX = (p.u0 + p.u1) / 2;
        const bikeCentroidX = (b.u0 + b.u1) / 2;
        if (horizOverlap > 0.35 && p.v1 > b.v0 && p.v0 < b.v1 + bh * 0.2 && Math.abs(personCentroidX - bikeCentroidX) < Math.max(bw, pw) * 0.6) {
          const score = inter / (pw * ph);
          if (score > bestScore) { bestScore = score; bestP = p; }
        }
      }
      if (bestP && bestScore > 0.2) {
        mergedPeople.add(bestP);
        b.u0 = Math.min(b.u0, bestP.u0);
        b.v0 = Math.min(b.v0, bestP.v0);
        b.u1 = Math.max(b.u1, bestP.u1);
        b.v1 = Math.max(b.v1, bestP.v1);
        b.score = Math.max(b.score, bestP.score);
        b.hasRider = true;
      }
    }
    return dets.filter((d) => !mergedPeople.has(d));
  }

  const api = { COCO, letterbox, tensorFromRGBA, tensorFromBGR, decode, iou, mergeRiders };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Detect = api;
})(typeof self !== 'undefined' ? self : this);
