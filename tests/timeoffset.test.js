// node tests/timeoffset.test.js -> camera-LiDAR time offset: JS egoAt must match joint.py ego_at, and a
// static point projected with a time offset must land where the shifted point lands without one.
const P = require('../extension/function/projection.js');
const fx = require('./time_fixture.json');

let fail = 0;
const check = (name, err, tol) => { const ok = err <= tol; if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${err.toExponential(2)}`); };
const maxDiff = (A, B) => Math.max(...A.flat().map((v, i) => Math.abs(v - B.flat()[i])));

// 1. parity with Python ego_at (forward, backward, first and last frame fallbacks)
let worst = 0;
for (const c of fx.cases) worst = Math.max(worst, maxDiff(P.egoAt({ fwd: c.fwd, bwd: c.bwd }, c.dt / fx.period), c.expected));
check(`egoAt vs joint.ego_at (${fx.cases.length} cases)`, worst, 1e-9);

// 2. posePow: a = 1 gives T, a = 0 gives I, two half steps rotate like one full step
const T = fx.cases[3].fwd, I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
check('posePow(T, 1) = T', maxDiff(P.posePow(T, 1), T), 1e-12);
check('posePow(T, 0) = I', maxDiff(P.posePow(T, 0), I4), 1e-15);
const h = P.posePow(T, 0.5), hh = P.matMul(h, h);
check('half step twice = full rotation', maxDiff(hh.slice(0, 3).map((r) => r.slice(0, 3)), T.slice(0, 3).map((r) => r.slice(0, 3))), 1e-12);

// 3. 2D sweep motion (pcd frame) -> ego frame: S (T_l p) == T_ego (S p)
const S = [[0.999848, -0.017452, 0, 0.9], [0.017452, 0.999848, 0, -0.1], [0, 0, 1, 1.8], [0, 0, 0, 1]];
const m2 = { th: 0.03, tx: -1.7, ty: 0.12 };
const Te = P.motionFromSweep2D(m2, S);
const Tl = [[Math.cos(m2.th), -Math.sin(m2.th), 0, m2.tx], [Math.sin(m2.th), Math.cos(m2.th), 0, m2.ty], [0, 0, 1, 0], [0, 0, 0, 1]];
check('motionFromSweep2D conjugation', maxDiff(P.matMul(S, Tl), P.matMul(Te, S)), 1e-12);

// 4. projection: static point with time offset == shifted point without it (pinhole + fisheye)
const calib = {
  pcd_frame: 'lidar', lidar: { sensor2ego: S },
  cameras: {
    PIN: { model: 'pinhole', K: [[1840, 0, 955], [0, 1838, 780], [0, 0, 1]], dist: [-0.3, 0.1, 0, 0, 0], image_size: [1920, 1536],
      ego2cam: [[0, -1, 0, 0], [0, 0, -1, 1.6], [1, 0, 0, -1.2], [0, 0, 0, 1]] },
    FE: { model: 'fisheye', K: [[720, 0, 959.5], [0, 718, 767.5], [0, 0, 1]], dist: [0.03, -0.01, 0.004, -0.001], image_size: [1920, 1536],
      ego2cam: [[1, 0, 0, 0], [0, 0, -1, 1.6], [0, 1, 0, -0.9], [0, 0, 0, 1]] },
  },
};
const motion = { fwd: Te, bwd: Te };
calib.sweep_period_s = 0.2;
const pts = [];
for (let i = 0; i < 400; i++) pts.push(-30 + (i % 20) * 3, -30 + Math.floor(i / 20) * 3, -1 + (i % 7) * 0.8);
for (const dt of [-0.04, 0.03]) {
  const G = P.egoAt(motion, dt / 0.2), M = P.matMul(P.matMul(P.inv4(S), G), S);   // same motion in the pcd frame
  const moved = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) for (let r = 0; r < 3; r++) moved[i + r] = M[r][0] * pts[i] + M[r][1] * pts[i + 1] + M[r][2] * pts[i + 2] + M[r][3];
  for (const cam of ['PIN', 'FE']) {
    const a = P.projectCloud(new Float32Array(pts), calib, cam, { dt: dt * 1000 }, motion);
    const b = P.projectCloud(moved, calib, cam, null);
    const got = new Map(); b.idx.forEach((i, j) => got.set(i, [b.u[j], b.v[j]]));
    let e = 0, miss = 0;
    a.idx.forEach((i, j) => { const g = got.get(i); if (!g) { miss++; return; } e = Math.max(e, Math.abs(g[0] - a.u[j]), Math.abs(g[1] - a.v[j])); });
    check(`${cam} dt ${dt * 1000} ms: ${a.idx.length} pts, ${miss} missing, max px`, miss > 2 ? Infinity : e, 1e-2);
  }
}

// 5. zero offset or no motion changes nothing; bake stores the offset
check('egoAt dt = 0 is identity', maxDiff(P.egoAt(motion, 0), I4), 1e-15);
const still = P.projectCloud(new Float32Array(pts), calib, 'PIN', null), noMotion = P.projectCloud(new Float32Array(pts), calib, 'PIN', { dt: 30 });
check('time offset without motion = no offset', Math.max(...noMotion.u.map((u, j) => Math.abs(u - still.u[j]))), 0);
const cal2 = { ...calib, cameras: { PIN: { ...calib.cameras.PIN, time_offset_s: 0.01 } } };
check('timeOffset = stored + slider', Math.abs(P.timeOffset(cal2.cameras.PIN, { dt: 15 }) - 0.025), 1e-12);
const baked = P.bakeCalib(cal2, { PIN: { dt: 15 } });
check('bake: time_offset_s', Math.abs(baked.cameras.PIN.time_offset_s - 0.025), 1e-12);
check('bake: ego2cam unchanged by Δt', maxDiff(baked.cameras.PIN.ego2cam, calib.cameras.PIN.ego2cam), 1e-12);

if (fail) { console.error(`FAIL (${fail})`); process.exit(1); }
console.log('PASS');
