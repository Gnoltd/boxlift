// node tests/split.test.js -> a car whose returns have a gap (bonnet split from the body, dense LiDAR): the drawn box
// still gets one 3D box over the whole car; a pole beside a car is not merged into it.
const BF = require('../extension/function/boxfit.js');
const { scan, GROUND: G, setSeed } = require('./synth.js');
const calib = require('./fixtures/rig.json');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
const rectOf = (b) => {
  const pr = BF.projectBox(b, calib, 'CAM_FRONT', null, 4).flat();
  return { u0: Math.min(...pr.map((p) => p[0])), u1: Math.max(...pr.map((p) => p[0])), v0: Math.min(...pr.map((p) => p[1])), v1: Math.max(...pr.map((p) => p[1])) };
};
const full = { x: 17.95, y: 4, z: G + 0.75, yaw: 0, l: 4.7, w: 1.85, h: 1.5 };   // front at x = 15.6
for (const gap of [0.4, 0.6, 0.8]) {
  setSeed(7);
  const f0 = 15.6 + 0.9 + gap;
  const body = { x: (f0 + 20.3) / 2, y: 4, z: G + 0.75, yaw: 0, l: 20.3 - f0, w: 1.85, h: 1.5 };
  const hood = { x: 16.05, y: 4, z: G + 0.5, yaw: 0, l: 0.9, w: 1.85, h: 1.0 };
  const b = BF.fitFromRect(scan([body, hood]), calib, 'CAM_FRONT', null, rectOf(full), { label: 'car' }).box;
  check(`gap ${gap} m: box reaches the bonnet`, b && Math.abs(b.x - b.l / 2 - 15.6) < 0.2 && b.l > 4.0, b && `front ${(b.x - b.l / 2).toFixed(2)} l ${b.l.toFixed(2)}`);
}
setSeed(7);
const car = { x: 17.95, y: 4, z: G + 0.75, yaw: 0, l: 4.5, w: 1.85, h: 1.5 }, pole = { x: 18, y: 5.6, z: G + 2, yaw: 0, l: 0.3, w: 0.3, h: 4 };
const b = BF.fitFromRect(scan([car, pole]), calib, 'CAM_FRONT', null, rectOf(car), { label: 'car' }).box;
check('pole 0.6 m beside the car: not merged', b && b.w < 2.1, b && `w ${b.w.toFixed(2)}`);
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
