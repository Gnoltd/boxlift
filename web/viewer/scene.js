/* Pure helpers of the web demo 3D point-cloud screen (no three.js, no DOM): frame index, height colours, boxes of a frame,
   wireframe segments, label colours, initial camera. web/viewer/viewer.js turns these into three.js objects. */
(function (root, factory) {
  const v = factory();
  if (typeof module === 'object' && module.exports) module.exports = v; else root.ViewerScene = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_SPAN = 4;   // m of height the colour ramp spans: ground .. roofs of trucks; buildings/trees saturate

  function frameIndex(value, last) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(0, Math.min(last, n)) : 0;
  }

  // [low, high] of the colour ramp: low = a ground-level percentile, high capped at low + MAX_SPAN. Strided sample, sorted.
  function heightRange(xyz) {
    const n = Math.floor((xyz && xyz.length) / 3) || 0;
    if (!n) return [0, 1];
    const step = Math.max(1, Math.floor(n / 20000)), z = [];
    for (let i = 0; i < n; i += step) z.push(xyz[3 * i + 2]);
    z.sort((a, b) => a - b);
    const q = (p) => z[Math.min(z.length - 1, Math.floor(p * (z.length - 1)))];
    const lo = q(0.03);
    let hi = Math.min(q(0.97), lo + MAX_SPAN);
    if (!(hi - lo > 0.5)) hi = lo + 1;
    return [lo, hi];
  }

  const RAMP = [[0.18, 0.35, 0.95], [0.1, 0.8, 0.95], [0.25, 0.9, 0.35], [0.98, 0.85, 0.2], [0.95, 0.3, 0.2]];   // blue, cyan, green, yellow, red
  function rampAt(t) {
    t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function colorize(xyz, lo, hi) {
    const n = Math.floor(xyz.length / 3), out = new Float32Array(3 * n), span = hi - lo || 1;
    for (let i = 0; i < n; i++) { const c = rampAt((xyz[3 * i + 2] - lo) / span); out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2]; }
    return out;
  }

  function parseAnnotations(raw) {
    try { const a = JSON.parse(raw); if (a && typeof a === 'object') return { shapes: Array.isArray(a.shapes) ? a.shapes : [], tracks: Array.isArray(a.tracks) ? a.tracks : [] }; } catch (e) { /* none */ }
    return { shapes: [], tracks: [] };
  }
  // Boxes shown at `frame`, like cvat.js boxesAt: cuboid shapes of that frame + each track as Tracks.at shows it (interpolated
  // between keyframes, held after the last, hidden once outside). deps = { at: Tracks.at, fromCvat: BoxFit.fromCvatPoints }.
  function frameBoxes(ann, frame, deps) {
    const out = [];
    if (!ann || typeof ann !== 'object') return out;
    for (const s of Array.isArray(ann.shapes) ? ann.shapes : []) {
      if (s && s.type === 'cuboid' && s.frame === frame && Array.isArray(s.points)) out.push({ kind: 'shape', labelId: s.label_id, box: deps.fromCvat(s.points) });
    }
    for (const t of Array.isArray(ann.tracks) ? ann.tracks : []) {
      if (!t || !Array.isArray(t.shapes)) continue;
      const shapes = t.shapes.filter((s) => s && s.type === 'cuboid' && Array.isArray(s.points)).sort((p, q) => p.frame - q.frame);
      if (!shapes.length) continue;
      const a = deps.at({ ...t, shapes }, frame);
      if (a) out.push({ kind: 'track', labelId: t.label_id, box: deps.fromCvat(a.points) });
    }
    return out;
  }

  // 12 edges as line-segment pairs over the extension's corner order (BoxFit.corners: dx, dy, dz loops = -1/+1).
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  function boxSegments(box, corners) {
    const cs = corners(box), out = new Float32Array(EDGES.length * 6);
    EDGES.forEach(([a, b], i) => { out.set(cs[a], 6 * i); out.set(cs[b], 6 * i + 3); });
    return out;
  }

  const LABEL_COLORS = { car: 0x4c9aff, truck: 0xff9f43, bus: 0xc56cf0, motorcycle: 0xff5e7e, bicycle: 0x2ed1a2, pedestrian: 0xffe066 };
  const labelColor = (name) => (Object.prototype.hasOwnProperty.call(LABEL_COLORS, name) ? LABEL_COLORS[name] : 0xffffff);

  // AV2 lidar = ego frame here (calib lidar.sensor2ego is identity): x forward, y left, z up, origin at the ego vehicle.
  const CAMERA = { position: [-16, -6, 11], target: [14, 0, 0], up: [0, 0, 1], fov: 55 };
  const EGO = { x: 1.4, y: 0, z: 0.45, yaw: 0, l: 4.6, w: 1.9, h: 1.6 };   // marker box roughly where the car is (origin near the rear axle)

  function hasWebGL(doc) {
    try { const c = doc.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

  return { frameIndex, heightRange, colorize, parseAnnotations, frameBoxes, boxSegments, labelColor, hasWebGL, CAMERA, EGO, MAX_SPAN, EDGES };
});
