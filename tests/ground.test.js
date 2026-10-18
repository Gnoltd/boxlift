// node tests/ground.test.js — ground mask on synthetic sweeps: flat road, 4° slope, a raised planter
// (35 cm) one metre from the road with a car parked next to it, and a long median planter beside the car.
const fs = require('fs'), path = require('path');
const BF = require('../extension/function/boxfit.js');
const { U, GROUND, scan, iou3d } = require('./synth.js');
const calib = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rig.json'), 'utf8'));
let fail = 0;
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';

for (const slopeDeg of [0, 4]) {
  const boxes = [];
  for (let k = 0; k < 12; k++) { const h = U(1.4, 1.8); boxes.push({ x: U(-30, 40), y: U(-12, 12), yaw: U(-3, 3), l: 4.5, w: 1.85, h, z: GROUND + h / 2 }); }
  const flat = scan(boxes.filter((b) => Math.hypot(b.x, b.y) > 5));
  const t = slopeDeg * Math.PI / 180, xyz = new Float32Array(flat.length);
  for (let i = 0; i < flat.length / 3; i++) { xyz[3 * i] = flat[3 * i]; xyz[3 * i + 1] = flat[3 * i + 1]; xyz[3 * i + 2] = flat[3 * i + 2] + flat[3 * i] * Math.tan(t); }
  const t0 = Date.now(), g = BF.groundMask(xyz), ms = Date.now() - t0;
  let gT = 0, gH = 0, oT = 0, oK = 0;
  for (let i = 0; i < flat.length / 3; i++) {
    if (flat[3 * i + 2] < GROUND + 0.05) { gT++; if (g[i]) gH++; }
    if (flat[3 * i + 2] > GROUND + 0.4) { oT++; if (!g[i]) oK++; }
  }
  console.log(`slope ${slopeDeg}°: road removed ${pct(gH, gT)}, object points kept ${pct(oK, oT)}, ${ms} ms`);
  if (gH / gT < 0.95 || oK / oT < 0.99) fail++;
}

// planters / kerbs 15-35 cm high, one metre from the road: their top must not be ground
for (const ph of [0.15, 0.25, 0.35]) {
  const pl = { x: 15, y: 5.2, z: GROUND + ph / 2, yaw: 0, l: 14, w: 2.0, h: ph };
  const pts = scan([pl, { x: 15, y: 3.0, z: GROUND + 0.78, yaw: 0.02, l: 4.5, w: 1.85, h: 1.55 }]), m = BF.groundMask(pts);
  let tT = 0, tG = 0;
  for (let i = 0; i < pts.length / 3; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
    if (Math.abs(x - pl.x) < pl.l / 2 - 0.1 && Math.abs(y - pl.y) < pl.w / 2 - 0.1 && z > GROUND + ph - 0.05) { tT++; if (m[i]) tG++; }
  }
  console.log(`planter ${ph} m: top counted as ground ${pct(tG, tT)} (${tT} pts)`);
  if (tG / tT > 0.05) fail++;
}
// a long median planter right beside the car, the other carriageway behind it: the planter top must not
// become road (it used to: seeded from the median level near the car, or climbed onto from far away),
// and the road height on the far lane must stay at road level
for (const [w, h] of [[1.5, 0.2], [3, 0.25], [5, 0.3]]) {
  const med = { x: 0, y: 3.5 + w / 2, z: GROUND + h / 2, yaw: 0, l: 160, w, h };
  const pts = scan([med, { x: -3, y: 3.5 + w + 3, z: GROUND + 0.93, yaw: Math.PI, l: 4.05, w: 1.86, h: 1.86 }]), m = BF.groundMask(pts);
  let tT = 0, tG = 0;
  for (let i = 0; i < pts.length / 3; i++) {
    const y = pts[3 * i + 1], z = pts[3 * i + 2];
    if (y > 3.6 && y < 3.4 + w && z > GROUND + h - 0.05) { tT++; if (m[i]) tG++; }
  }
  const far = [2, 7, 17].map((x) => m.height(x, 3.5 + w + 3) - GROUND), worst = Math.max(...far.map(Math.abs));
  console.log(`median planter ${w} m x ${h} m: top counted as ground ${pct(tG, tT)}, far-lane road height off by ≤ ${(100 * worst).toFixed(1)} cm`);
  if (tG / tT > 0.05 || worst > 0.05) fail++;
}
const planter = { x: 15, y: 5.2, z: GROUND + 0.175, yaw: 0, l: 14, w: 2.0, h: 0.35 };
const car = { x: 15, y: 3.0, z: GROUND + 0.78, yaw: 0.02, l: 4.5, w: 1.85, h: 1.55 };
const xyz = scan([planter, car, { x: 30, y: -4, z: GROUND + 0.75, yaw: 0, l: 4.5, w: 1.8, h: 1.5 }]);
const g = BF.groundMask(xyz);
// the car beside it: box from a drawn rectangle, with and without the road mask
const pr = BF.projectBox(car, calib, 'CAM_FRONT', null, 4).flat();
const rect = { u0: Math.min(...pr.map((p) => p[0])), u1: Math.max(...pr.map((p) => p[0])), v0: Math.min(...pr.map((p) => p[1])), v1: Math.max(...pr.map((p) => p[1])) };
for (const [name, opts] of [['old (lowest points)', {}], ['road mask', { ground: g }]]) {
  const r = BF.fitFromRect(xyz, calib, 'CAM_FRONT', null, rect, { label: 'car', ...opts });
  const bottom = r.box.z - r.box.h / 2;
  console.log(`car beside planter, ${name}: IoU ${iou3d(r.box, car).toFixed(2)}, bottom ${(100 * (bottom - GROUND)).toFixed(1)} cm from the road`);
  if (opts.ground && (Math.abs(bottom - GROUND) > 0.06 || iou3d(r.box, car) < 0.7)) fail++;
}
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
