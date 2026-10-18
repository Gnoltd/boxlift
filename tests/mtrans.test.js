// node tests/mtrans.test.js -> MTrans input path (extension/mtrans.js): camera-axis frame, the crop (size, padding,
// overlap channel, bilinear with aligned corners), the points' crop positions and the free slots, decode back to pcd.
const MT = require('../extension/function/mtrans.js');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// camera looking along pcd +y (pcd x right, z up; camera x right, y down, z forward): axis yaw = +90 deg
const calib = { pcd_frame: 'ego', cameras: { C: { ego2cam: [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], K: [[500, 0, 320], [0, 500, 240], [0, 0, 1]], image_size: [640, 480] } } };
const th = MT.axisYaw(calib, 'C', null);
check('axis yaw of a camera looking along +y', Math.abs(wrap(th - Math.PI / 2)) < 1e-9, th.toFixed(4));

// image 640 x 480: red ramp along x, green 200, blue 0 left half / 255 right half
const W = 640, H = 480, data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = 4 * (y * W + x); data[o] = x % 256; data[o + 1] = 200; data[o + 2] = x < 320 ? 0 : 255; data[o + 3] = 255; }
const img = { width: W, height: H, data };
const rect = { u0: 100.4, v0: 150.2, u1: 180.6, v1: 190.9 };       // integer box 100..181 x 150..191: 81 x 41
const B = MT.newBatch(1), S = MT.SIZE, SS = S * S;
const cr = MT.crop(img, rect, [{ u0: 170, v0: 0, u1: 400, v1: 170 }], B.image, B.overlap);
const ow = Math.floor(81 * (S / 81)), oh = Math.floor(41 * (S / 81));
check('scaled so the longer side is SIZE, centred', cr.padL === Math.floor((S - ow) / 2) && cr.padT === Math.floor((S - oh) / 2), `pad ${cr.padL}, ${cr.padT} (crop ${ow} x ${oh})`);
check('padding rows are zero', B.image[0] === 0 && B.image[SS + 5] === 0 && B.overlap[0] === 0);
const at = (c, x, y) => B.image[c * SS + (y + cr.padT) * S + x + cr.padL];
check('corners aligned: first / last column = image columns 100 / 180', Math.abs(at(0, 0, 0) * 255 - 100) < 1e-3 && Math.abs(at(0, ow - 1, 0) * 255 - 180) < 1e-3,
  `${(at(0, 0, 0) * 255).toFixed(2)} ${(at(0, ow - 1, 0) * 255).toFixed(2)}`);
check('bilinear in between (red ramp linear in x)', Math.abs(at(0, 56, 10) * 255 - (100 + 56 * 80 / (ow - 1))) < 1e-4);
const ov = (x, y) => B.overlap[(y + cr.padT) * S + x + cr.padL];
check('overlap channel: 0 under the other box, 1 elsewhere', ov(ow - 1, 0) === 0 && ov(0, oh - 1) === 1, `${ov(ow - 1, 0)} ${ov(0, oh - 1)}`);
check('pixels with a zero channel are not free-slot candidates (blue = 0 on the left half)', cr.valid.length === 0);

// points: 3 inside the rectangle, 1 outside; the rest of the 512 slots are free
const xyz = Float32Array.from([0, 10, 0, 1, 12, 0.5, -1, 9, 1, 5, 10, 0]);
const proj = { u: Float32Array.from([120, 150, 170, 300]), v: Float32Array.from([160, 170, 185, 170]), idx: Uint32Array.from([0, 1, 2, 3]) };
const img2 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(90) };
const B2 = MT.newBatch(2), n = MT.prepare(xyz, proj, img2, rect, [], th, B2, 1);
const o = MT.NPTS;
check('only points inside the rectangle', n === 3 && B2.real[o] === 1 && B2.real[o + 2] === 1 && B2.real[o + 3] === 0);
check('points turned to the camera axis: (0, 10) -> (10, 0)', Math.abs(B2.cloud[3 * o] - 10) < 1e-6 && Math.abs(B2.cloud[3 * o + 1]) < 1e-6,
  `${B2.cloud[3 * o].toFixed(3)}, ${B2.cloud[3 * o + 1].toFixed(3)}`);
const c2 = (k) => [B2.cloud2d[2 * (o + k)], B2.cloud2d[2 * (o + k) + 1]];
const sc = S / 81;
check('crop position = (u - l) * scale + padding', Math.abs(c2(0)[0] - ((120 - 100) * sc + cr.padL)) < 1e-4 && Math.abs(c2(0)[1] - ((160 - 150) * sc + cr.padT)) < 1e-4);
const free = c2(100);
check('free slots on crop pixels (not padding)', free[1] >= cr.padT && free[1] < cr.padT + oh && Number.isInteger(free[0]));
check('batch slot 0 untouched', B2.real[0] === 0 && B2.cloud[0] === 0);

// decode: a box in the turned frame back to the pcd frame; odds of the other end
const box = Float32Array.from([10, 0, -0.5, 4.5, 1.9, 1.6, 0.3]);
const d = MT.decode(box, Float32Array.from([0.2, 0.8]), 0, th);
check('decode: centre (10, 0) -> pcd (0, 10), yaw + axis', Math.abs(d.box.x) < 1e-6 && Math.abs(d.box.y - 10) < 1e-6 && Math.abs(wrap(d.box.yaw - (0.3 + Math.PI / 2))) < 1e-6);
check('decode: odds of the other end = 0.2 / 0.8', Math.abs(d.odds - 0.25) < 1e-6);
const sw = MT.decode(Float32Array.from([10, 0, -0.5, 1.9, 4.5, 1.6, 0.3]), Float32Array.from([0.1, 0.9]), 0, th);
check('decode: width > length -> swapped back, heading turned 90 deg, front / back left open (odds 1)',
  Math.abs(sw.box.l - 4.5) < 1e-6 && Math.abs(sw.box.w - 1.9) < 1e-6 && Math.abs(wrap(sw.box.yaw - (0.3 + Math.PI))) < 1e-6 && sw.odds === 1);
check('cars only', MT.useFor('car') && MT.useFor('Car') && !MT.useFor('truck') && !MT.useFor('pedestrian') && !MT.useFor('bus'));

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
