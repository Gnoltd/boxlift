// Synthetic LiDAR (ray-cast, the test rig's sensor geometry: tests/fixtures/rig.json) + rotated-box IoU, shared by the benches.
const BF = require('../extension/function/boxfit.js');

let seed = Number(process.env.SEED || 7);
const setSeed = (s) => { seed = s; };
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const U = (a, b) => a + (b - a) * rnd();
const ORIGIN = [0.9, 0, 1.85], GROUND = -0.1;

// ray / oriented box (yaw only) intersection, returns t or Infinity
function hitBox(o, d, b) {
  const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
  const ox = o[0] - b.x, oy = o[1] - b.y, oz = o[2] - b.z;
  const lo = [ox * c - oy * s, ox * s + oy * c, oz], ld = [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
  const half = [b.l / 2, b.w / 2, b.h / 2];
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) { if (Math.abs(lo[k]) > half[k]) return Infinity; continue; }
    let ta = (-half[k] - lo[k]) / ld[k], tb = (half[k] - lo[k]) / ld[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0 > 0 ? t0 : Infinity;
}

function scan(boxes) {
  const pts = [];
  for (let e = 0; e < 128; e++) {
    const el = (-25 + (40 * e) / 127) * Math.PI / 180;
    for (let a = -180; a < 180; a += 0.2) {
      const az = a * Math.PI / 180, d = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
      let t = d[2] < 0 ? (GROUND - ORIGIN[2]) / d[2] : Infinity;
      if (t > 120) t = Infinity;
      for (const b of boxes) t = Math.min(t, hitBox(ORIGIN, d, b));
      if (!isFinite(t) || t < 1) continue;
      t += (rnd() - 0.5) * 0.04;
      const p = [ORIGIN[0] + d[0] * t, ORIGIN[1] + d[1] * t, ORIGIN[2] + d[2] * t];
      if (Math.hypot(p[0], p[1]) > 2.8) pts.push(...p);
    }
  }
  return new Float32Array(pts);
}

// polygon helpers for rotated-box IoU
function rect(b) { return BF.corners(b).filter((_, i) => i % 2 === 0).map((p) => [p[0], p[1]]); }
function order(poly) { const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length; return poly.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)); }
function area(poly) { let s = 0; for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; }
function clip(subject, clipPoly) {
  let out = subject;
  for (let i = 0; i < clipPoly.length; i++) {
    const A = clipPoly[i], B = clipPoly[(i + 1) % clipPoly.length], inp = out; out = [];
    const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    for (let j = 0; j < inp.length; j++) {
      const P1 = inp[j], P2 = inp[(j + 1) % inp.length], s1 = side(P1), s2 = side(P2);
      if (s1 >= 0) out.push(P1);
      if (s1 * s2 < 0) { const t = s1 / (s1 - s2); out.push([P1[0] + t * (P2[0] - P1[0]), P1[1] + t * (P2[1] - P1[1])]); }
    }
    if (!out.length) return [];
  }
  return out;
}
function iou3d(a, b) {
  const pa = order(rect(a)), pb = order(rect(b));
  const inter = area(clip(pa, pb));
  const zi = Math.max(0, Math.min(a.z + a.h / 2, b.z + b.h / 2) - Math.max(a.z - a.h / 2, b.z - b.h / 2));
  const vi = inter * zi, va = a.l * a.w * a.h, vb = b.l * b.w * b.h;
  return vi / (va + vb - vi);
}

module.exports = { rnd: () => rnd(), U, ORIGIN, GROUND, hitBox, scan, iou3d, setSeed };
