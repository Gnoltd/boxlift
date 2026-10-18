// node tests/pairs.test.js -> calibration from clicked 3D<->2D pairs: a camera whose stored calibration
// is off by known slider deltas is recovered from ~15 noisy clicks (pinhole + fisheye), a few wrong
// clicks do not drag it, and points never clicked (held out) land within ~1-2 px.
const P = require('../extension/function/projection.js');
const PS = require('../extension/function/pairs.js');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const calib = {
  pcd_frame: 'lidar', lidar: { sensor2ego: I4 },
  cameras: {
    PIN: { model: 'pinhole', K: [[1840, 0, 955], [0, 1838, 780], [0, 0, 1]], dist: [-0.3, 0.1, 0, 0, 0], image_size: [1920, 1536],
      ego2cam: [[0, -1, 0, 0], [0, 0, -1, 1.6], [1, 0, 0, -1.2], [0, 0, 0, 1]] },               // looks forward (+x)
    FE: { model: 'fisheye', K: [[720, 0, 959.5], [0, 718, 767.5], [0, 0, 1]], dist: [0.03, -0.01, 0.004, -0.001], image_size: [1920, 1536],
      ego2cam: [[1, 0, 0, 0], [0, 0, -1, 1.6], [0, 1, 0, -0.9], [0, 0, 0, 1]] },                 // looks left (+y)
  },
};
const truth = { pan: 0.8, tilt: -0.6, roll: 0.4, dx: 0.06, dy: -0.04, dz: 0.03, fscale: 1.012 };

function scene(cam, n) {                      // static structure points the true camera sees
  const out = [];
  while (out.length < n) {
    const a = rnd(), b = rnd(), c = rnd(), d = 4 + 36 * a, s = -1 + 2 * b, h = -1.5 + 6 * c;
    const p = cam === 'PIN' ? [d, s * d * 0.5, h] : [s * d * 0.9, d, h];
    const r = P.projectCloud(new Float32Array(p), calib, cam, truth);
    if (r.u.length) out.push({ xyz: p, uv: [r.u[0], r.v[0]] });
  }
  return out;
}
/** n clicks spread over the image (the guide: cover the 3x3 grid, edges included), farthest-point. */
function spread(pts, n) {
  const out = [pts[0]];
  while (out.length < n) {
    let best = null, bd = -1;
    for (const p of pts) {
      const d = Math.min(...out.map((q) => Math.hypot(p.uv[0] - q.uv[0], p.uv[1] - q.uv[1])));
      if (d > bd) { bd = d; best = p; }
    }
    out.push(best);
  }
  return out;
}
const err = (cam, adj, pts) => { const r = PS.residuals(calib, cam, adj, pts), e = [];
  for (let i = 0; i < r.length; i += 2) e.push(Math.hypot(r[i], r[i + 1])); return e.sort((a, b) => a - b); };

for (const cam of ['PIN', 'FE']) {
  const clicks = spread(scene(cam, 80), 15).map((p) => ({ xyz: p.xyz, uv: [p.uv[0] + 0.7 * gauss(), p.uv[1] + 0.7 * gauss()] }));
  const held = scene(cam, 40);
  const start = err(cam, null, held);
  const res = PS.solve(calib, cam, null, clicks);
  const e = err(cam, res.adj, held);
  check(`${cam}: held-out median ${start[20].toFixed(1)} -> ${e[20].toFixed(2)} px, max ${e[39].toFixed(2)} px`, e[20] < 1.0 && e[39] < 2.5);
  check(`${cam}: clicked rms ${res.before.rms.toFixed(1)} -> ${res.after.rms.toFixed(2)} px`, res.after.rms < 1.5);

  // two wrong clicks (40 px off): Huber keeps the fit
  const bad = clicks.map((p, i) => (i < 2 ? { xyz: p.xyz, uv: [p.uv[0] + 40, p.uv[1] - 25] } : p));
  const rb = PS.solve(calib, cam, null, bad), eb = err(cam, rb.adj, held);
  const worst = rb.errors.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, i]) => i).sort();
  check(`${cam}: 2 wrong clicks -> held-out median ${eb[20].toFixed(2)} px, flagged pairs ${worst}`, eb[20] < 1.5 && worst.join() === '0,1');

  // starting from the current sliders works the same (solution is absolute, not a further delta)
  const rs = PS.solve(calib, cam, { pan: 0.5, tilt: 0, roll: 0, dx: 0, dy: 0, dz: 0, fscale: 1 }, clicks);
  check(`${cam}: start from slider state`, Math.abs(rs.adj.pan - res.adj.pan) < 0.02);
}
// guardrails
for (const cam of ['PIN', 'FE']) {
  const clicks = spread(scene(cam, 80), 15).map((p) => ({ xyz: p.xyz, uv: [p.uv[0] + 0.7 * gauss(), p.uv[1] + 0.7 * gauss()] }));
  const res = PS.solve(calib, cam, null, clicks);
  check(`${cam}: good clicks -> full solve accepted`, res.mode === 'full' && res.ok && res.loo.median < 1.5, `(loo ${res.loo.median.toFixed(2)} px, ${res.reasons})`);

  // measuring changes nothing and matches the true error
  const m = PS.measure(calib, cam, truth, clicks), m0 = PS.measure(calib, cam, null, clicks);
  check(`${cam}: measure true calib ${m.median.toFixed(2)} px, stored ${m0.median.toFixed(1)} px, ${m.cells}/9 cells`, m.median < 1.5 && m0.median > 5 && m.n === 15 && m.cells >= 4);

  // already right: solving is refused as no better
  const rg = PS.solve(calib, cam, truth, clicks);
  check(`${cam}: already-calibrated camera -> refused`, !rg.ok, `(${rg.reasons})`);

  // 6 pairs bunched in one cell -> rotation only, position and f untouched
  const cell = (p) => Math.floor(p.uv[0] / 640) * 3 + Math.floor(p.uv[1] / 512), all = scene(cam, 400);
  const corner = all.filter((p) => cell(p) === cell(all[0])).slice(0, 6);
  const rc = PS.solve(calib, cam, null, corner);
  check(`${cam}: bunched pairs -> rotation-only`, rc.mode === 'rot' && rc.adj.dx === 0 && rc.adj.fscale === 1, `(${rc.cells}/9 cells)`);

  // pairs joining different points (e.g. front of a car clicked to its rear, 150-350 px) -> refused
  const wrong = clicks.map((p, i) => (i % 2 ? p : { xyz: p.xyz, uv: [p.uv[0] + 150 + 15 * i, p.uv[1] - 40] }));
  const rw = PS.solve(calib, cam, null, wrong);
  check(`${cam}: half the pairs wrong -> refused`, !rw.ok, `(${rw.reasons.join('; ')})`);
}
// a camera really 50 cm off from the stored one is not something clicks should fix
{
  const far = { ...truth, dx: 0.5 };
  const pts = spread(scene('PIN', 80), 15).map((p) => {
    const r = P.projectCloud(new Float32Array(p.xyz), calib, 'PIN', far);
    return r.u.length ? { xyz: p.xyz, uv: [r.u[0], r.v[0]] } : null;
  }).filter(Boolean);
  const rf = PS.solve(calib, 'PIN', null, pts, { priorW: 1e-3 });
  check('implausible move flagged', !rf.ok && rf.reasons.some((x) => /dời/.test(x)), `(${rf.reasons})`);
}
try { PS.solve(calib, 'PIN', null, scene('PIN', 3)); check('too few pairs rejected', false); } catch (e) { check('too few pairs rejected', /ít nhất/.test(e.message)); }

if (fail) { console.error(`FAIL (${fail})`); process.exit(1); }
console.log('PASS');
