// node tests/labelmap.test.js — model class -> job label (PLAN 4.1): suggested from the label names, confirmed by the
// user, several classes may share one label (car + truck + bus -> vehicles); the 3D model follows the class, not the name.
const LM = require('../extension/function/labelmap.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };

// a job with one label for every vehicle (job 18126 style)
const job1 = [{ id: 1, name: 'vehicles' }, { id: 2, name: 'pedestrian' }];
let m = LM.suggest(job1);
check(m.car === 1 && m.truck === 1 && m.bus === 1 && m.pedestrian === 2, `vehicles takes car/truck/bus: ${JSON.stringify(m)}`);
check(m.motorcycle === null && m.bicycle === null, 'no label for two-wheelers');

// nuScenes-style names
const job2 = [{ id: 10, name: 'car' }, { id: 11, name: 'truck' }, { id: 12, name: 'bus' }, { id: 13, name: 'motorcycle' }, { id: 14, name: 'bicycle' }, { id: 15, name: 'pedestrian' }];
m = LM.suggest(job2);
check(m.car === 10 && m.truck === 11 && m.bus === 12 && m.motorcycle === 13 && m.bicycle === 14 && m.pedestrian === 15, 'one label per class');
// 'car' must not swallow a label named "cargo truck" before truck does
m = LM.suggest([{ id: 1, name: 'cargo truck' }, { id: 2, name: 'car' }]);
check(m.car === 2 && m.truck === 1, `exact name first: ${JSON.stringify(m)}`);
// Vietnamese names
m = LM.suggest([{ id: 5, name: 'xe con' }, { id: 6, name: 'xe tải' }, { id: 7, name: 'người' }, { id: 8, name: 'xe máy' }]);
check(m.car === 5 && m.truck === 6 && m.pedestrian === 7 && m.motorcycle === 8, `vietnamese: ${JSON.stringify(m)}`);

// classes of a label, and the one a drawn box most likely is
const map = { car: 1, truck: 1, bus: 1, motorcycle: null, bicycle: null, pedestrian: 2 };
check(JSON.stringify(LM.classesOf(map, 1)) === '["car","truck","bus"]', 'classes of vehicles');
check(LM.classFor(map, 1, { l: 4.5, w: 1.9, h: 1.5 }) === 'car', 'car-sized');
check(LM.classFor(map, 1, { l: 7.5, w: 2.4, h: 3.0 }) === 'truck', 'long and high: truck');
check(LM.classFor(map, 1, { l: 11.5, w: 2.5, h: 3.2 }) === 'bus', 'very long: bus');
check(LM.classFor(map, 2, { l: 0.6, w: 0.6, h: 1.7 }) === 'pedestrian', 'single class');
check(LM.classFor(map, 99, { l: 4, w: 2, h: 1.5 }) === null, 'unmapped label: no class');
check(LM.classFor({ car: 1, truck: 1 }, 1, null) === 'car', 'no box yet: first class');

// stored record: confirmed only after the user said so; labels that vanished from the job drop out
const rec = LM.confirm(map);
check(rec.confirmed && rec.map.car === 1, 'confirm');
const clean = LM.valid(rec, [{ id: 1, name: 'vehicles' }]);
check(clean.map.pedestrian === null && clean.map.car === 1 && clean.confirmed, 'label removed from job -> unmapped');

console.log(fail ? `${fail} FAILED` : 'labelmap: all passed');
process.exit(fail ? 1 : 0);
