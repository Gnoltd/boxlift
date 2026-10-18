// node tests/objects.test.js — "road users only" view filter on a cluttered synthetic sweep:
// trees (trunk + crown), billboards on poles, lamp poles, a long wall, vs cars, motorbikes, pedestrians.
// Also: a motorbike 60 m away gets its box bottom on the road.
const fs = require('fs'), path = require('path');
const BF = require('../extension/function/boxfit.js');
const { U, GROUND, scan } = require('./synth.js');
const calib = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rig.json'), 'utf8'));
const G = GROUND, box = (x, y, l, w, h, z0 = 0, yaw = 0, kind) => ({ x, y, l, w, h, yaw, z: G + z0 + h / 2, kind });
let fail = 0;
const tally = {};
for (let s = 0; s < 4; s++) {
  const B = [];
  for (let k = 0; k < 8; k++) { const x = U(-30, 50), y = (k % 2 ? 1 : -1) * U(7, 9); B.push(box(x, y, 0.4, 0.4, 3.2, 0, 0, 'tree'), box(x, y, 4, 4, 3, 3, 0, 'tree')); }
  for (let k = 0; k < 3; k++) { const x = U(-20, 40), y = (k % 2 ? 1 : -1) * U(10, 11); B.push(box(x, y, 0.3, 0.3, 5, 0, 0, 'billboard'), box(x, y, 4, 0.3, 2, 4.5, 0, 'billboard')); }
  for (let k = 0; k < 5; k++) B.push(box(U(-30, 50), (k % 2 ? 1 : -1) * 6.5, 0.25, 0.25, 6, 0, 0, 'pole'));
  B.push(box(10, -13, 30, 0.3, 6, 0, 0, 'wall'));   // a building wall (taller than any vehicle)
  for (let k = 0; k < 6; k++) B.push(box(U(-25, 45), U(-4, 4), 4.5, 1.85, 1.55, 0, U(-0.2, 0.2), 'car'));
  for (let k = 0; k < 4; k++) B.push(box(U(-25, 45), U(-5, 5), 1.9, 0.7, 1.5, 0, U(-0.3, 0.3), 'motorbike'));
  for (let k = 0; k < 4; k++) B.push(box(U(-20, 40), (k % 2 ? 1 : -1) * U(5, 6), 0.5, 0.5, 1.7, 0, 0, 'pedestrian'));
  const ok = B.filter((b, i) => Math.hypot(b.x, b.y) > 4 && !B.some((o, j) => j < i && Math.abs(o.x - b.x) < (o.l + b.l) / 2 + 0.3 && Math.abs(o.y - b.y) < (o.w + b.w) / 2 + 0.3 && o.kind !== b.kind));
  const xyz = scan(ok), g = BF.groundMask(xyz), keep = BF.objectMask(xyz, g);
  for (let i = 0; i < xyz.length / 3; i++) {
    if (g[i]) continue;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const b = ok.find((q) => { const c = Math.cos(-q.yaw), sn = Math.sin(-q.yaw), dx = x - q.x, dy = y - q.y; return Math.abs(dx * c - dy * sn) < q.l / 2 + 0.05 && Math.abs(dx * sn + dy * c) < q.w / 2 + 0.05 && Math.abs(z - q.z) < q.h / 2 + 0.05; });
    if (!b) continue;
    const t = (tally[b.kind] ||= [0, 0]); t[0]++; if (keep[i]) t[1]++;
  }
}
const users = ['car', 'motorbike', 'pedestrian'];
for (const [k, [n, kept]] of Object.entries(tally)) {
  const r = kept / n;
  console.log(`${k.padEnd(11)} ${users.includes(k) ? 'kept   ' : 'removed'} ${(100 * (users.includes(k) ? r : 1 - r)).toFixed(1)}%  (${n} pts)`);
  if (users.includes(k) ? r < 0.97 : r > (k === 'tree' ? 0.15 : 0.1)) fail++;   // tree: points at the trunk foot stay
}
// far motorbike: box bottom on the road
const mb = box(60, -3.5, 1.9, 0.7, 1.6, 0, 0.05, 'motorbike');
const xyz = scan([mb, box(20, 3, 4.5, 1.85, 1.55)]), g = BF.groundMask(xyz);
const pr = BF.projectBox(mb, calib, 'CAM_FRONT', null, 4).flat();
const rect = { u0: Math.min(...pr.map((p) => p[0])), u1: Math.max(...pr.map((p) => p[0])), v0: Math.min(...pr.map((p) => p[1])), v1: Math.max(...pr.map((p) => p[1])) };
const r = BF.fitFromRect(xyz, calib, 'CAM_FRONT', null, rect, { label: 'motorbike', ground: g });
const bottom = r.box ? r.box.z - r.box.h / 2 : NaN;
console.log(`motorbike 60 m: box bottom ${(100 * (bottom - G)).toFixed(1)} cm from the road (road height there ${(100 * (g.height(60, -3.5) - G)).toFixed(1)} cm)`);
if (!(Math.abs(bottom - G) < 0.1)) fail++;
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
