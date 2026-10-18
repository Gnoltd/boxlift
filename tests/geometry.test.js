// node tests/geometry.test.js — box orientation matches CVAT / three.js (Euler XYZ: R = Rx*Ry*Rz).
const BF = require('../extension/function/boxfit.js');
const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
let worst = 0, fail = 0;
const check = (name, err, tol) => { worst = Math.max(worst, err); if (!(err < tol)) { fail++; console.log('FAIL', name, err); } };
for (let k = 0; k < 200; k++) {
  const b = { x: 1, y: 2, z: 0.5, l: 4.5, w: 1.8, h: 1.5, rx: (Math.random() - 0.5) * 0.4, ry: (Math.random() - 0.5) * 0.4, yaw: (Math.random() - 0.5) * 6 };
  const R = BF.rotMat(b), ref = mul(mul(Rx(b.rx), Ry(b.ry)), Rz(b.yaw));
  check('rotMat', Math.max(...R.flat().map((v, i) => Math.abs(v - ref.flat()[i]))), 1e-12);
  const back = BF.fromCvatPoints(BF.toCvatPoints(b));
  check('cvat round trip', Math.max(...['x', 'y', 'z', 'rx', 'ry', 'yaw', 'l', 'w', 'h'].map((q) => Math.abs(back[q] - b[q]))), 1e-12);
  const pitch = (Math.random() - 0.5) * 0.3, roll = (Math.random() - 0.5) * 0.3;
  const t = BF.tiltFromPitchRoll(b.yaw, pitch, roll), pr = BF.pitchRollOf({ ...b, ...t });
  check('pitch/roll round trip', Math.max(Math.abs(pr.pitch - pitch), Math.abs(pr.roll - roll)), 2e-3);   // heading coupling is 2nd order
}
// a box stood on a 5% slope: bottom corners on the plane
const plane = [0.05, -0.02, -0.1], b = BF.alignToGround({ x: 10, y: 3, z: 1, yaw: 0.7, l: 4.5, w: 1.8, h: 1.5 }, plane);
const bottom = BF.corners(b).filter((_, i) => i % 2 === 0);
check('on ground', Math.max(...bottom.map((p) => Math.abs(p[2] - (plane[0] * p[0] + plane[1] * p[1] + plane[2])))), 0.01);
// bird's-eye IoU / same-object test used to merge auto boxes from several cameras (error = |got - expected|)
const car = { x: 0, y: 0, yaw: 0.3, l: 4.5, w: 1.9 };
check('BEV IoU identical', Math.abs(BF.bevIoU(car, car) - 1), 1e-9);
check('BEV IoU half shifted', Math.abs(BF.bevIoU({ x: 0, y: 0, yaw: 0, l: 4, w: 2 }, { x: 2, y: 0, yaw: 0, l: 4, w: 2 }) - 1 / 3), 1e-9);
check('BEV IoU crossed', Math.abs(BF.bevIoU({ x: 0, y: 0, yaw: 0, l: 4, w: 2 }, { x: 0, y: 0, yaw: Math.PI / 2, l: 4, w: 2 }) - 1 / 3), 1e-9);
check('two views of one car merge', BF.sameObject(car, { ...car, x: 1.4, y: 0.4, l: 3.2 }) ? 0 : 1, 0.5);
check('cars side by side stay apart', BF.sameObject({ x: 0, y: 0, yaw: 0, l: 4.5, w: 1.9 }, { x: 0, y: 2.4, yaw: 0, l: 4.5, w: 1.9 }) ? 1 : 0, 0.5);
check('bumper to bumper stay apart', BF.sameObject({ x: 0, y: 0, yaw: 0, l: 4.5, w: 1.9 }, { x: 5.2, y: 0, yaw: 0, l: 4.5, w: 1.9 }) ? 1 : 0, 0.5);
console.log(`worst ${worst.toExponential(2)}`, fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
