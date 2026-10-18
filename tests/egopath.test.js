// node tests/egopath.test.js — ego poses along a stretch of frames (spec 2026-10-13): world = the sweep of the frame
// the track starts from; a failed ICP step reuses the last one (marked unsure), 3 in a row stop that direction.
const EP = require('../extension/function/egopath.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const same = (p, q) => close(p.x, q.x) && close(p.y, q.y) && close(Math.atan2(Math.sin(p.yaw - q.yaw), Math.cos(p.yaw - q.yaw)), 0);

const A = { th: 0.3, tx: 1, ty: -2 }, B = { th: -0.1, tx: 0.5, ty: 0.2 };
const box = { x: 2, y: 1, z: 0.7, yaw: 0.2, l: 4, w: 2, h: 1.5 };
check(same(EP.apply(EP.compose(A, B), box), EP.apply(A, EP.apply(B, box))), 'compose: b first, then a');
check(same(EP.apply(EP.invert(A), EP.apply(A, box)), box), 'invert undoes');
const moved = EP.apply(A, box);
check(moved.z === 0.7 && moved.l === 4 && moved.w === 2 && moved.h === 1.5, 'height and size untouched');

(async () => {
  // a still object, world = sweep of frame 5; the car moves: sweep k+1 = T(sweep k)
  const T = { th: 0.01, tx: -2, ty: 0.1 };
  const obj = { x: 10, y: 3, z: 0, yaw: 0.4, l: 4, w: 2, h: 1.5 };
  const inSweep = (k) => { let b = obj; for (let i = 5; i < k; i++) b = EP.apply(T, b); for (let i = 5; i > k; i--) b = EP.apply(EP.invert(T), b); return b; };
  const fwd = [];
  const r1 = await EP.walk(5, 1, 9, () => T, (k, pose) => { fwd.push(k); check(same(EP.apply(pose, inSweep(k)), obj), `forward pose ${k}`); });
  check(r1.end === 9 && r1.why === 'bound' && fwd.join() === '6,7,8,9', `forward to the bound: ${JSON.stringify(r1)} ${fwd}`);
  const r2 = await EP.walk(5, -1, 1, () => T, (k, pose) => check(same(EP.apply(pose, inSweep(k)), obj), `backward pose ${k}`));
  check(r2.end === 1 && r2.why === 'bound', 'backward to the bound');

  // failures: a failed step reuses the last good one (unsure); 3 in a row stop
  const unsure = [];
  const r3 = await EP.walk(0, 1, 20, (a) => ([0, 1, 3].includes(a) ? T : null), (k, p, u) => { if (u) unsure.push(k); });
  check(r3.why === 'ego' && r3.end === 6 && unsure.join() === '3,5,6', `3 failures stop: ${JSON.stringify(r3)} unsure ${unsure}`);
  const r4 = await EP.walk(0, 1, 9, () => null, () => {});
  check(r4.end === 0 && r4.why === 'ego', 'first step failing: no motion known, stop at once');
  const r5 = await EP.walk(0, 1, 9, () => T, (k) => k < 3);
  check(r5.end === 3 && r5.why === 'visit', 'visit returning false stops there');
  const r6 = await EP.walk(0, 1, 9, (a) => { if (a === 2) throw new Error('404'); return T; }, () => {});
  check(r6.end === 2 && r6.why === 'load' && r6.error === '404', 'a frame that cannot be loaded stops with why load');

  console.log(fail ? `${fail} FAILED` : 'egopath: all passed');
  process.exit(fail ? 1 : 0);
})();
