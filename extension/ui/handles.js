/*
 * Edit a 3D box directly on a camera image. Every handle is a 3D point of the box; dragging it solves
 * for the box parameter whose projection follows the mouse (Gauss-Newton on the camera model, so it
 * works the same on pinhole and fisheye images):
 *   move  (bottom centre)  -> x, y on the ground; with Shift -> z
 *   face  (6 face centres) -> that face moves along its normal, the opposite face stays (l / w / h)
 *   yaw   (arrow tip)      -> heading
 * proj(p) -> [u, v] in image pixels, or null when the point is not visible in this camera.
 */
(function (root) {
  'use strict';
  const BF = root.BoxFit || (typeof require !== 'undefined' ? require('../function/boxfit.js') : null);

  function handles(b) {
    const R = BF.rotMat(b), col = (j) => [R[0][j], R[1][j], R[2][j]];
    const out = [{ id: 'move', p: BF.toWorld(b, 0, 0, -b.h / 2) }];
    for (const [axis, j, size] of [['l', 0, b.l], ['w', 1, b.w], ['h', 2, b.h]]) {
      for (const side of [-1, 1]) {
        const off = [0, 0, 0]; off[j] = side * size / 2;
        out.push({ id: 'face', axis, side, n: col(j).map((v) => v * side), p: BF.toWorld(b, ...off) });
      }
    }
    out.push({ id: 'yaw', p: BF.toWorld(b, b.l / 2 + 1.2, 0, -b.h / 2) });
    return out;
  }

  /** Gauss-Newton: params x (array) so that f(x) (an image point) reaches target. */
  function follow(f, x0, target, maxStep) {
    let x = x0.slice();
    for (let it = 0; it < 10; it++) {
      const p = f(x); if (!p) return null;
      const r = [target[0] - p[0], target[1] - p[1]];
      if (Math.hypot(r[0], r[1]) < 0.3) break;
      const J = x.map((_, k) => { const e = x.slice(); e[k] += 1e-3; const q = f(e); return q ? [(q[0] - p[0]) / 1e-3, (q[1] - p[1]) / 1e-3] : [0, 0]; });
      let d;
      if (x.length === 1) { const g = J[0], gg = g[0] * g[0] + g[1] * g[1]; if (gg < 1e-9) break; d = [(g[0] * r[0] + g[1] * r[1]) / gg]; }
      else {
        const a = J[0][0] * J[0][0] + J[0][1] * J[0][1], bb = J[0][0] * J[1][0] + J[0][1] * J[1][1], c = J[1][0] * J[1][0] + J[1][1] * J[1][1];
        const g0 = J[0][0] * r[0] + J[0][1] * r[1], g1 = J[1][0] * r[0] + J[1][1] * r[1], det = a * c - bb * bb;
        if (Math.abs(det) < 1e-12) break;
        d = [(c * g0 - bb * g1) / det, (a * g1 - bb * g0) / det];
      }
      const n = Math.hypot(...d); if (n > maxStep) d = d.map((v) => v * maxStep / n);
      x = x.map((v, k) => v + d[k]);
    }
    return x;
  }

  /** New box for handle `h` (from handles(box0)) dragged to image point `m`. */
  function drag(box0, h, m, proj, opts = {}) {
    if (h.id === 'move' && opts.vertical) {
      const x = follow(([dz]) => proj([h.p[0], h.p[1], h.p[2] + dz]), [0], m, 1); if (!x) return box0;
      return { ...box0, z: box0.z + x[0] };
    }
    if (h.id === 'move') {
      const x = follow(([dx, dy]) => proj([h.p[0] + dx, h.p[1] + dy, h.p[2]]), [0, 0], m, 2); if (!x) return box0;
      return { ...box0, x: box0.x + x[0], y: box0.y + x[1] };
    }
    if (h.id === 'face') {
      const x = follow(([t]) => proj(h.p.map((v, k) => v + h.n[k] * t)), [0], m, 1); if (!x) return box0;
      const size0 = box0[h.axis], t = Math.max(x[0], 0.1 - size0);       // never thinner than 10 cm
      return { ...box0, [h.axis]: size0 + t, x: box0.x + h.n[0] * t / 2, y: box0.y + h.n[1] * t / 2, z: box0.z + h.n[2] * t / 2 };
    }
    if (h.id === 'yaw') {
      const x = follow(([yaw]) => proj(BF.toWorld({ ...box0, yaw }, box0.l / 2 + 1.2, 0, -box0.h / 2)), [box0.yaw], m, 0.3); if (!x) return box0;
      return { ...box0, yaw: BF.wrap(x[0]) };
    }
    return box0;
  }

  const api = { handles, drag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxHandles = api;
})(typeof self !== 'undefined' ? self : this);
