/*
 * Range scan (spec 2026-10-13): every detection of a stretch of frames as a 3D box in world coordinates, grouped into
 * objects — a parked car seen in 20 frames is one object, two cars side by side stay two, a driving car is followed
 * along its speed. Each object is proposed once, at the frame it was seen best. Pure.
 */
(function (root) {
  'use strict';
  const GATE = 1.5, STATIC_SPEED = 0.25;
  const dist = (p, d) => Math.hypot(p.x - d.box.x, p.y - d.box.y);
  /** Where an object should be at frame f: straight on at the speed over its last (up to) three detections; slower than
   *  a still object's jitter, or one detection: where it was last seen. */
  function where(o, f) {
    const n = o.dets.length, a = o.dets[n - 1], c = o.dets[Math.max(0, n - 3)];
    if (c === a) return a.box;
    const dt = a.frame - c.frame, vx = (a.box.x - c.box.x) / dt, vy = (a.box.y - c.box.y) / dt;
    if (Math.hypot(vx, vy) < STATIC_SPEED) return a.box;
    return { x: a.box.x + vx * (f - a.frame), y: a.box.y + vy * (f - a.frame) };
  }
  /** Detections -> objects: same label, nearest to where an object should be or where it was last seen (< gate m), one
   *  detection per object per frame: another one of the same frame within the gate (a second camera) is a twin, kept
   *  aside (its score and overlap count; the detection with more points stays). */
  function group(dets, gate = GATE) {
    const objs = [];
    for (const d of dets.slice().sort((a, b) => a.frame - b.frame || b.points - a.points)) {
      let pick = null, best = gate, twin = null, twinAt = gate;
      for (const o of objs) {
        if (o.label !== d.label) continue;
        const last = o.dets[o.dets.length - 1];
        if (last.frame === d.frame) {                             // a twin lies on the object: closer than its width (two people side by side stay two)
          const e = dist(last.box, d);
          if (e < twinAt && e < Math.max(last.box.w || gate, d.box.w || gate)) { twinAt = e; twin = o; }
          continue;
        }
        const e = Math.min(dist(where(o, d.frame), d), dist(last.box, d));
        if (e < best) { best = e; pick = o; }
      }
      if (twin) twin.twins.push(d);
      else if (pick) pick.dets.push(d);
      else objs.push({ label: d.label, dets: [d], twins: [] });
    }
    return objs.map((o) => ({ ...o, best: o.dets.reduce((a, b) => (b.points > a.points ? b : a)), score: Math.max(...[...o.dets, ...o.twins].map((x) => x.score)) }));
  }
  /** o.overlap: the highest 3D overlap of any of its detections (twins too) with a box already there at that frame; one
   *  the run found to be the same object as a box already there (dup) counts as 1. */
  function overlap(objs, existing, iou) {
    for (const o of objs) {
      o.overlap = [...o.dets, ...(o.twins || [])].reduce((m, d) => (d.dup ? 1 : Math.max(m, ...(existing.get(d.frame) || []).map((b) => iou(d.box, b)))), 0);
    }
    return objs;
  }

  const api = { GATE, group, overlap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scan = api;
})(typeof self !== 'undefined' ? self : this);
