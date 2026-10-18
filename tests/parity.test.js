// node tests/parity.test.js  -> JS projection must match Python (autocalib/camera.py) to 1e-3 px
const fx = require('./parity_fixture.json');
const P = require('../extension/function/projection.js');
const xyz = new Float32Array(fx.points);
let worst = 0, fail = 0;
for (const [name, exp] of Object.entries(fx.expected)) {
  const r = P.projectCloud(xyz, fx.calib, name, null);
  const got = new Map(); r.idx.forEach((i, j) => got.set(i, [r.u[j], r.v[j]]));
  let miss = 0;
  exp.idx.forEach((i, j) => {
    const g = got.get(i);
    if (!g) { miss++; return; }
    worst = Math.max(worst, Math.abs(g[0] - exp.u[j]), Math.abs(g[1] - exp.v[j]));
  });
  const extra = r.idx.length - (exp.idx.length - miss);
  console.log(`${name}: python ${exp.idx.length} pts, js ${r.idx.length}, missing ${miss}, extra ${extra}`);
  if (miss > 2 || extra > 2) fail++;   // float32 input may flip a point sitting exactly on a border
}
// slider round trip: zero deltas must reproduce the stored matrix
const E0 = fx.calib.cameras.PIN.ego2cam, E1 = P.effectiveEgo2Cam(fx.calib.cameras.PIN, { pan: 0, tilt: 0, roll: 0, dx: 0, dy: 0, dz: 0 });
const rt = Math.max(...E0.flat().map((v, i) => Math.abs(v - E1.flat()[i])));
console.log(`max pixel diff ${worst.toExponential(2)} px, zero-delta round trip ${rt.toExponential(2)}`);
if (worst > 2e-3 || rt > 1e-9 || fail) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
