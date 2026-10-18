// node tests/propagate.bench.js [nScenes]
// Two consecutive synthetic sweeps (ego driving, parked + moving cars, walls, poles) with known boxes
// -> accuracy of carrying the frame-A boxes into frame B (extension/propagate.js).
const BF = require('../extension/function/boxfit.js');
const BT = require('../extension/function/propagate.js');
const { rnd, U, GROUND, scan, iou3d } = require('./synth.js');

const DT = 0.2;                       // 5 Hz, as the recording (66 sweeps in ~13 s)
const car = (x, y, yaw) => { const h = U(1.45, 1.7); return { x, y, yaw, l: U(4.2, 4.9), w: U(1.75, 1.95), h, z: GROUND + h / 2 }; };

function makeWorld() {
  const statics = [], parked = [], moving = [];
  for (const side of [-1, 1]) {
    const yw = side * U(9, 14);
    for (let x = -40; x < 60;) { const l = U(3, 10); statics.push({ x: x + l / 2, y: yw, yaw: U(-0.03, 0.03), l, w: 0.3, h: 3, z: GROUND + 1.5 }); x += l + U(0.5, 4); }
    for (let k = 0; k < 6; k++) statics.push({ x: U(-30, 50), y: side * U(7, 8.5), yaw: 0, l: 0.3, w: 0.3, h: 4, z: GROUND + 2 });
    for (let k = 0; k < 3; k++) parked.push(car(U(-25, 40), side * U(4.8, 6.2), (rnd() < 0.5 ? 0 : Math.PI) + U(-0.08, 0.08)));
  }
  for (let k = 0; k < 3; k++) {       // lanes: own lane ahead/behind, neighbour lane, opposite lane
    const lane = [[0, 1], [3.5, 1], [-3.5, -1]][k];
    const x = k === 0 ? (rnd() < 0.5 ? U(10, 35) : U(-30, -10)) : U(-25, 40);
    const c = car(x, lane[0] + U(-0.3, 0.3), (lane[1] > 0 ? 0 : Math.PI) + U(-0.04, 0.04));
    c.v = lane[1] > 0 ? U(4, 14) : U(4, 14);  // m/s along its heading
    moving.push(c);
  }
  // keep physical: drop anything overlapping an earlier box or the ego
  const all = [], keep = (b) => !all.some((a) => iou3d(a, b) > 0) && Math.hypot(b.x, b.y) > 4 && (all.push(b), true);
  return { statics: statics.filter(keep), parked: parked.filter(keep), moving: moving.filter(keep) };
}

const toFrame = (b, e) => {            // world (= frame A) -> ego frame at pose e {x, y, th}
  const c = Math.cos(-e.th), s = Math.sin(-e.th), dx = b.x - e.x, dy = b.y - e.y;
  return { ...b, x: c * dx - s * dy, y: s * dx + c * dy, yaw: b.yaw - e.th };
};
const advance = (b, t) => ({ ...b, x: b.x + Math.cos(b.yaw) * b.v * t, y: b.y + Math.sin(b.yaw) * b.v * t });
const yawErr = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180 / Math.PI;

const N = Number(process.argv[2] || 30);
const rows = [], ego = [];
for (let k = 0; k < N; k++) {
  const w = makeWorld();
  const v = U(3, 12), yr = U(-15, 15) * Math.PI / 180;
  const eB = { x: v * DT * Math.cos(yr * DT / 2), y: v * DT * Math.sin(yr * DT / 2), th: yr * DT };
  const A = [...w.statics, ...w.parked, ...w.moving];
  const Bw = [...w.statics, ...w.parked, ...w.moving.map((m) => advance(m, DT))];
  const xyzA = scan(A), xyzB = scan(Bw.map((b) => toFrame(b, eB)));
  const t0 = Date.now();
  const T = BT.egoMotion(xyzA, xyzB, null);
  const tIcp = Date.now() - t0;
  const truth = { th: -eB.th, tx: -(Math.cos(-eB.th) * eB.x - Math.sin(-eB.th) * eB.y), ty: -(Math.sin(-eB.th) * eB.x + Math.cos(-eB.th) * eB.y) };
  ego.push({ ok: !!T, dt: T ? Math.hypot(T.tx - truth.tx, T.ty - truth.ty) : 99, dth: T ? Math.abs(T.th - truth.th) * 180 / Math.PI : 99, ms: tIcp, inl: T ? T.inlier : 0 });
  if (process.env.DIAG) console.log(`  scene ${k}: v=${v.toFixed(1)} ego err ${ego[ego.length - 1].dt.toFixed(3)} m inl ${ego[ego.length - 1].inl.toFixed(2)}`);
  if (!T) continue;
  const objs = [...w.parked.map((b) => ({ a: b, b: b, kind: 'parked' })),
    ...w.moving.map((m) => ({ a: m, b: advance(m, DT), kind: 'moving' }))];
  for (const o of objs) {
    const src = { ...o.a, x: o.a.x + U(-0.08, 0.08), y: o.a.y + U(-0.08, 0.08), yaw: o.a.yaw + U(-1, 1) * Math.PI / 180 };   // annotator noise
    const gt = toFrame(o.b, eB), r = Math.hypot(gt.x, gt.y);
    if (r > 45) continue;
    const variants = { static: undefined };
    if (o.kind === 'moving') {         // velocity known from the previous frame (chain): its displacement, in frame-B axes
      const d = [Math.cos(o.a.yaw) * o.a.v * DT, Math.sin(o.a.yaw) * o.a.v * DT], c = Math.cos(-eB.th), s = Math.sin(-eB.th);
      variants.vel = [c * d[0] - s * d[1], s * d[0] + c * d[1]];
    }
    for (const [name, vel] of Object.entries(variants)) {
      const t = Date.now();
      const res = BT.propagateBox(src, T, xyzB, { vel });
      const pred = BT.moveBox(src, T); if (vel) { pred.x += vel[0]; pred.y += vel[1]; }
      if (process.env.DIAG && iou3d(res.box, gt) < 0.7) console.log(`    FAIL ${o.kind}/${name} r=${r.toFixed(1)} iou=${iou3d(res.box, gt).toFixed(2)} fitted=${res.fitted} shift=${res.shift.toFixed(2)} pts=${res.points.length} predIoU=${iou3d({ ...pred, z: gt.z }, gt).toFixed(2)} ${res.how} move=${Math.hypot(gt.x - pred.x, gt.y - pred.y).toFixed(2)}`);
      rows.push({ kind: o.kind + (o.kind === 'moving' ? '/' + name : ''), r, iou: iou3d(res.box, gt), iouPred: iou3d({ ...pred, z: gt.z }, gt),
        yawErr: yawErr(res.box.yaw, gt.yaw), fitted: res.fitted, ms: Date.now() - t });
    }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, f) => (100 * a.filter(f).length / a.length).toFixed(0) + '%';
const okE = ego.filter((e) => e.ok);
console.log(`ego motion: ${okE.length}/${ego.length} solved, translation err median ${med(okE.map((e) => e.dt)).toFixed(3)} m (p90 ${okE.map((e) => e.dt).sort((a, b) => a - b)[Math.floor(okE.length * 0.9)].toFixed(3)}), ` +
  `yaw err median ${med(okE.map((e) => e.dth)).toFixed(3)}°, inliers ${med(okE.map((e) => e.inl)).toFixed(2)}, ${med(okE.map((e) => e.ms))} ms`);
for (const kind of ['parked', 'moving/vel', 'moving/static']) {
  for (const [name, f] of [['all', () => true], ['<20m', (x) => x.r < 20], ['>=20m', (x) => x.r >= 20]]) {
    const rs = rows.filter((x) => x.kind === kind && f(x));
    if (!rs.length) continue;
    console.log(`${kind.padEnd(14)} ${name.padEnd(6)} n=${String(rs.length).padStart(3)}  IoU3D median ${med(rs.map((x) => x.iou)).toFixed(2)}  ` +
      `>=0.5 ${pct(rs, (x) => x.iou >= 0.5).padStart(4)}  >=0.7 ${pct(rs, (x) => x.iou >= 0.7).padStart(4)}  ` +
      `(no refit: >=0.7 ${pct(rs, (x) => x.iouPred >= 0.7).padStart(4)})  yaw err ${med(rs.map((x) => x.yawErr)).toFixed(1)}°  ` +
      `refit ${pct(rs, (x) => x.fitted)}  ${med(rs.map((x) => x.ms))} ms`);
  }
}
