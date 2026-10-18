// node tests/static_anchor.test.js — a world-static object must not walk away from where the ego pose puts it.
// Real KITTI job 158: following a parked object step by step (each prediction from the previous refit) slid 0.2-1 m per frame,
// 5.7 m after 12 frames. BT.staticAt places it from the start box and the pose f0 -> f and lets the cloud nudge it by <= 0.3 m.
const BT = require('../extension/function/propagate.js');
const { GROUND, scan, setSeed } = require('./synth.js');
setSeed(11);
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };

const car = (x, y, yaw, l = 4.5) => ({ x, y, yaw, l, w: 1.85, h: 1.55, z: GROUND + 1.55 / 2 });
const wall = (x, y) => ({ x, y, yaw: 0, l: 6, w: 0.3, h: 3, z: GROUND + 1.5 });
const parked = car(18, 4.2, 0), decoy = car(22.4, 4.4, 0, 3.2);        // a second object right behind it: a refit can slide onto it
const walls = [];
for (const s of [-1, 1]) for (let x = -20; x < 80; x += 8) walls.push(wall(x + 3, s * 11));
const seed = { ...parked };
const V = 0.35, STEPS = 15;
let worst = 0, worstNudge = 0, chainWorst = 0, chain = { ...seed };
for (let f = 1; f <= STEPS; f++) {
  const e = V * f, toEgo = (b) => ({ ...b, x: b.x - e });                   // straight drive: ego at x = e
  const xyz = scan([...walls, parked, decoy].map(toEgo));
  const T0f = { th: 0, tx: -e, ty: 0 };
  const r = BT.staticAt(seed, T0f, xyz, {});
  const truth = toEgo(parked);
  worst = Math.max(worst, Math.hypot(r.box.x - truth.x, r.box.y - truth.y));
  worstNudge = Math.max(worstNudge, Math.hypot(r.box.x - r.moved.x, r.box.y - r.moved.y));
  const step = BT.propagateStep(chain, { th: 0, tx: -V, ty: 0 }, xyz, { motion: 'static', dt: 0.1 });
  chain = step.box;
  chainWorst = Math.max(chainWorst, Math.hypot(chain.x - truth.x, chain.y - truth.y));
}
ok(`anchored: never more than 0.3 m from the pose-placed box (worst ${worst.toFixed(2)} m)`, worst <= 0.3 + 1e-6);
ok(`the nudge itself is capped (worst ${worstNudge.toFixed(2)} m)`, worstNudge <= 0.3 + 1e-6);
ok('size and height stay those of the seed', (() => { const r = BT.staticAt(seed, { th: 0, tx: -1, ty: 0 }, scan([...walls, parked, decoy].map((b) => ({ ...b, x: b.x - 1 }))), {}); return r.box.l === seed.l && r.box.w === seed.w && r.box.h === seed.h; })());
ok('pose with a matrix (3D) is honoured too', (() => {
  const M = [[1, 0, 0, -2], [0, 1, 0, 0], [0, 0, 1, 0.05], [0, 0, 0, 1]];
  const r = BT.staticAt(seed, { matrix: M, th: 0, tx: -2, ty: 0 }, new Float32Array(0), {});
  return Math.abs(r.box.x - (seed.x - 2)) < 1e-9 && Math.abs(r.box.z - (seed.z + 0.05)) < 1e-9 && !r.fitted;
})());
console.log(`(for reference, the step-by-step chain on this scene: worst ${chainWorst.toFixed(2)} m)`);
if (fails) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
