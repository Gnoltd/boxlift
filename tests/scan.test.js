// node tests/scan.test.js — detections of a stretch of frames grouped into objects (spec 2026-10-13): one parked car
// seen in 20 frames is one object, two cars 2.5 m apart are two, a driving car is one; boxes already there are found.
const SC = require('../extension/function/scan.js');
const EL = require('../extension/function/editlog.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
let seed = 5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const car = (x, y) => ({ x, y, z: 0.75, yaw: 0, l: 4.5, w: 1.9, h: 1.5 });
const det = (frame, b, points = 100, score = 0.8, label = 'car') => ({ frame, label, score, points, box: { ...b, x: b.x + 0.15 * rnd(), y: b.y + 0.15 * rnd() } });
const dets = [];
for (let f = 0; f < 20; f++) dets.push(det(f, car(10, 3), f === 12 ? 300 : 100), det(f, car(10, 5.5)));   // two parked side by side
for (let f = 5; f < 25; f++) dets.push(det(f, car(-20 + 1.2 * f, -3), 80, 0.6 + 0.01 * f));               // one driving
dets.push(det(7, car(10, 3), 50, 0.9, 'truck'));                                                           // another label
const objs = SC.group(dets);
check(objs.filter((o) => o.label === 'car').length === 3, `three cars: ${objs.filter((o) => o.label === 'car').length}`);
check(objs.filter((o) => o.label === 'truck').length === 1, 'labels never merge');
const a = objs.find((o) => o.label === 'car' && Math.abs(o.best.box.y - 3) < 0.5);
check(a.dets.length === 20 && a.best.frame === 12, `parked car: 20 detections, best frame 12 (most points): ${a.dets.length} / ${a.best.frame}`);
const d = objs.find((o) => o.label === 'car' && o.best.box.y < 0);
check(d.dets.length === 20 && Math.abs(d.score - 0.84) < 1e-9, `driving car: one object, top score: ${d.dets.length} ${d.score}`);
// boxes already there: the parked car at y=3 has a box at frames 3..6
const existing = new Map([3, 4, 5, 6].map((f) => [f, [car(10, 3)]]));
SC.overlap(objs, existing, EL.iou3d);
check(a.overlap > 0.5 && d.overlap === 0, `overlap with what is there: ${a.overlap.toFixed(2)} / ${d.overlap}`);

// a detection that is the same object as a box already there (sameObject in the run) makes its object "already there"
const dupObjs = SC.overlap(SC.group([det(30, car(50, 0)), { ...det(31, car(50, 0)), dup: true }, det(32, car(50, 0))]), new Map(), EL.iou3d);
check(dupObjs.length === 1 && dupObjs[0].overlap === 1, `one detection matched a box already there: overlap 1 (${dupObjs.map((o) => o.overlap)})`);

// one car seen by two cameras in the same frames: one object, the detection with more points stays, the top score counts
const twin = [];
for (let f = 0; f < 8; f++) twin.push(det(f, car(20, 0), 120, 0.7), { ...det(f, car(20.4, 0.3), 60, 0.9), cam: 'CAM_FRONT_LEFT' });
const tw = SC.group(twin);
check(tw.length === 1 && tw[0].dets.length === 8 && tw[0].dets.every((x) => x.points === 120) && Math.abs(tw[0].score - 0.9) < 1e-9,
  `two cameras, one car: ${tw.length} objects, ${tw[0].dets.length} detections, score ${tw[0].score}`);
check(SC.overlap(SC.group([det(40, car(60, 0), 120), { ...det(40, car(60.3, 0), 60), dup: true }]), new Map(), EL.iou3d)[0].overlap === 1, 'a twin matched to a box already there counts');

const ped = (x) => ({ x, y: 9, z: 0.9, yaw: 0, l: 0.6, w: 0.6, h: 1.8 });
const walkers = [];
for (let f = 0; f < 6; f++) walkers.push({ frame: f, label: 'pedestrian', score: 0.7, points: 40, box: ped(0.3 * f) }, { frame: f, label: 'pedestrian', score: 0.7, points: 30, box: ped(0.3 * f + 0.9) });
check(SC.group(walkers).length === 2, `two people walking side by side 0.9 m apart stay two: ${SC.group(walkers).length}`);

// a parked car seen at 0, 1 and 10 (missed in between), its box jittering 0.3 m: one object
const jit = [[0, 0.3], [1, -0.3], [10, 0.3]].map(([f, dx]) => ({ frame: f, label: 'car', score: 0.8, points: 100, box: { ...car(10 + dx, -8), y: -8 - dx } }));
check(SC.group(jit).length === 1, `parked car with a gap: ${SC.group(jit).length} objects`);

console.log(fail ? `${fail} FAILED` : 'scan: all passed');
process.exit(fail ? 1 : 0);
