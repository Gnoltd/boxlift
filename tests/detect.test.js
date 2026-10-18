// node tests/detect.test.js -> YOLOX output decoding (extension/detect.js): grid / stride / exp decoding,
// letterbox scale back to image pixels, class filter, score threshold, NMS within a class and across vehicles.
const DT = require('../extension/function/detect.js');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
const SIZE = 416, N = [8, 16, 32].reduce((a, s) => a + (SIZE / s) ** 2, 0);
const out = new Float32Array(N * 85);
/** put a detection at grid cell (gx, gy) of a stride: centre offset (ox, oy), size w x h px, class c, scores */
function put(stride, gx, gy, ox, oy, w, h, c, obj, cls) {
  let a = 0;
  for (const s of [8, 16, 32]) { if (s === stride) break; a += (SIZE / s) ** 2; }
  a += gy * (SIZE / stride) + gx;
  const o = a * 85;
  out.set([ox, oy, Math.log(w / stride), Math.log(h / stride), obj], o);
  out[o + 5 + c] = cls;
}
const r = SIZE / 1600;                                       // 1600x900 image letterboxed into 416
put(16, 10, 5, 0.5, 0.25, 64, 40, 2, 0.9, 0.95);             // car: centre (168, 84) in the input
put(8, 30, 20, 0, 0, 16, 40, 0, 0.8, 0.9);                   // pedestrian
put(32, 3, 3, 0, 0, 50, 50, 14, 0.99, 0.99);                 // bird: not a wanted class
put(8, 2, 2, 0, 0, 20, 20, 2, 0.2, 0.5);                     // weak car: below threshold
put(16, 11, 5, -0.4, 0.3, 66, 41, 7, 0.9, 0.5);              // the same car scored as truck by the next cell -> NMS across vehicles
const d = DT.decode(out, SIZE, r, { scoreThr: 0.3 });
const car = d.find((x) => x.label === 'car');
check('wanted classes only, weak / duplicate dropped', d.length === 2 && d.some((x) => x.label === 'pedestrian') && !d.some((x) => x.label === 'truck'), JSON.stringify(d.map((x) => x.label)));
check('car centre / size back in image px', car && Math.abs((car.u0 + car.u1) / 2 - 168 / r) < 0.01 && Math.abs((car.v0 + car.v1) / 2 - 84 / r) < 0.01 &&
  Math.abs((car.u1 - car.u0) - 64 / r) < 0.01 && Math.abs((car.v1 - car.v0) - 40 / r) < 0.01, car && JSON.stringify([car.u0, car.v0, car.u1, car.v1].map(Math.round)));
check('score = objectness x class', car && Math.abs(car.score - 0.855) < 1e-6);
const lb = DT.letterbox(1600, 900, SIZE);
check('letterbox 1600x900 -> 416', lb.nw === 416 && lb.nh === 234 && Math.abs(lb.r - 0.26) < 1e-9);
const px = new Uint8ClampedArray(4 * SIZE * SIZE); px[0] = 10; px[1] = 20; px[2] = 30; px[3] = 255;
const t = DT.tensorFromRGBA(px, SIZE);
check('RGBA -> BGR planes', t[0] === 30 && t[SIZE * SIZE] === 20 && t[2 * SIZE * SIZE] === 10);

// rider + bicycle merging test
const bikeDets = [
  { u0: 100, v0: 200, u1: 200, v1: 300, score: 0.8, cls: 1, label: 'bicycle' },
  { u0: 120, v0: 140, u1: 180, v1: 240, score: 0.85, cls: 0, label: 'pedestrian' },
];
const merged = DT.mergeRiders(bikeDets);
check('cyclist: pedestrian merged into bicycle', merged.length === 1 && merged[0].label === 'bicycle' && merged[0].v0 === 140 && merged[0].v1 === 300);

// bystander pedestrian beside bicycle: not merged
const bystanderDets = [
  { u0: 100, v0: 200, u1: 200, v1: 300, score: 0.8, cls: 1, label: 'bicycle' },
  { u0: 220, v0: 140, u1: 260, v1: 280, score: 0.85, cls: 0, label: 'pedestrian' },
];
const notMerged = DT.mergeRiders(bystanderDets);
check('bystander pedestrian beside bicycle not merged', notMerged.length === 2);

if (fail) { console.error(`FAIL (${fail})`); process.exit(1); }
console.log('PASS');
