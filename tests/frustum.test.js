// node tests/frustum.test.js -> learned box path (extension/frustum.js): frustum turned to +x, object points and their
// centroid from seg logits, a box model output decoded back to the pcd frame (round trip from a known box).
const FR = require('../extension/function/frustum.js');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// a frustum of points around a car 12 m away at azimuth 120 deg
const xyz = [], idx = [];
for (let k = 0; k < 3000; k++) { const a = 2.094 + (k % 50 - 25) * 0.002, r = 12 + (k / 50 | 0) * 0.02; xyz.push(r * Math.cos(a), r * Math.sin(a), -1 + (k % 7) * 0.2); idx.push(k); }
const X = Float32Array.from(xyz);
const p = FR.prepare(X, idx, FR.classOf('Car'));
check('class of a label name', FR.classOf('Car') === 0 && FR.classOf('motorbike') === 3 && FR.classOf('tree') === null);
check('frustum angle = mean azimuth', Math.abs(wrap(p.phi - 2.094)) < 0.01, p.phi.toFixed(3));
let mx = 0, my = 0;
for (let j = 0; j < FR.N1; j++) { mx += p.pts[3 * j] / FR.N1; my += Math.abs(p.pts[3 * j + 1]) / FR.N1; }
check('turned to look along +x (points spread +-0.05 rad: mean |y| ~0.31)', mx > 11 && my < 0.4, `mean x ${mx.toFixed(2)}, |y| ${my.toFixed(2)}`);
check('same input -> same sample', FR.prepare(X, idx, 0).pts.every((v, i) => v === p.pts[i]));
// seg logits: object = points with z > 0
const lg = new Float32Array(FR.N1 * 2);
for (let j = 0; j < FR.N1; j++) lg[2 * j + 1] = p.pts[3 * j + 2] > 0 ? 1 : -1;
const o = FR.objectPoints(p.pts, lg);
let n = 0, cz = 0;
for (let j = 0; j < FR.N1; j++) if (p.pts[3 * j + 2] > 0) { n++; cz += p.pts[3 * j + 2]; }
check('object points: count and centroid', o.n === n && Math.abs(o.cen[2] - cz / n) < 1e-4, `${o.n} pts, z ${o.cen[2].toFixed(3)}`);
// encode a known box (pcd frame) as the box model would output it, decode it back
const box = { x: -6.1, y: 10.4, z: -0.2, l: 4.4, w: 1.8, h: 1.6, yaw: 2.6 };
const c = Math.cos(p.phi), s = Math.sin(p.phi), fx = c * box.x + s * box.y, fy = -s * box.x + c * box.y;
const yawF = ((box.yaw - p.phi) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), bin = Math.floor(yawF / (2 * Math.PI / FR.NH));
const out = new Float32Array(30);
out.set([fx - o.cen[0], fy - o.cen[1], box.z - o.cen[2]]);
out[3 + bin] = 5; out[3 + FR.NH + bin] = (yawF - bin * 2 * Math.PI / FR.NH) / (Math.PI / FR.NH);
out.set([4.4 / 4.6 - 1, 1.8 / 1.95 - 1, 1.6 / 1.7 - 1], 3 + 2 * FR.NH);
const d = FR.decode(out, 0, 0, o.cen, p.phi);
check('decode: box back in the pcd frame', Math.hypot(d.x - box.x, d.y - box.y, d.z - box.z) < 1e-4 && Math.abs(wrap(d.yaw - box.yaw)) < 1e-5 &&
  Math.abs(d.l - 4.4) < 1e-5 && Math.abs(d.w - 1.8) < 1e-5 && Math.abs(d.h - 1.6) < 1e-5, JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, +v.toFixed(3)]))));
const turned = Float32Array.from(out); turned[3 + (bin + FR.NH / 2) % FR.NH] = 4.9;
check('end odds: ~0 when the model is sure of its end, ~1 when the other end is almost as likely', FR.endOdds(out, 0) < 0.05 && FR.endOdds(turned, 0) > 0.5,
  `${FR.endOdds(out, 0).toFixed(4)} / ${FR.endOdds(turned, 0).toFixed(2)}`);
check('prefer: learned box unless the segmentation found too little or a class kept geometric', FR.prefer({}, 20, 0) && !FR.prefer({}, 2, 0) && !FR.prefer(null, 50, 0) && !FR.prefer({}, 50, 3));
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
