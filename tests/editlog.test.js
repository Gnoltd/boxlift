// node tests/editlog.test.js — "box đã sửa" (PLAN 2.3): a machine box counts as edited when the saved box
// has 3D IoU < 0.9 with it, or its heading moved > 5°, or its label changed. 10 boxes, 3 edited -> 3 / 10.
const EL = require('../extension/function/editlog.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const car = (o = {}) => ({ x: 10, y: 2, z: -1, yaw: 0.3, l: 4.5, w: 1.9, h: 1.6, rx: 0, ry: 0, ...o });

// IoU 3D
check(near(EL.iou3d(car(), car()), 1), 'same box: IoU 1');
check(near(EL.iou3d(car({ yaw: 0 }), car({ yaw: 0, x: 10 + 2.25 })), 0.5 / 1.5), 'half overlap along l: IoU 1/3');
check(near(EL.iou3d(car(), car({ z: -1 + 0.8 })), 0.5 / 1.5), 'half overlap in height: IoU 1/3');
check(EL.iou3d(car(), car({ x: 30 })) === 0, 'far apart: IoU 0');

// heading difference, wrapped
check(near(EL.yawDiffDeg(car({ yaw: 0 }), car({ yaw: 2 * Math.PI - 0.01 })), 0.01 * 180 / Math.PI), 'yaw wraps');
check(near(EL.yawDiffDeg(car({ yaw: 0 }), car({ yaw: Math.PI })), 180), 'flipped front: 180°');

// judge
const j0 = EL.judge({ machine: [car()], saved: car({ x: 10.03 }), machineLabel: 1, savedLabel: 1 });
check(!j0.edited && j0.iou > 0.9, 'nudged 3 cm: not edited');
check(EL.judge({ machine: [car()], saved: car({ yaw: 0.3 + 6 * Math.PI / 180 }), machineLabel: 1, savedLabel: 1 }).edited, 'turned 6°: edited');
check(EL.judge({ machine: [car()], saved: car(), machineLabel: 1, savedLabel: 2 }).labelChanged, 'other label: edited');
check(!EL.judge({ machine: [car({ x: 0 }), car()], saved: car(), machineLabel: 1, savedLabel: 1 }).edited, 'matches the other machine candidate (P): not edited');

// 10 boxes, 3 edited
const recs = [];
for (let i = 0; i < 10; i++) {
  const m = car({ x: 5 * i });
  const s = i === 2 ? car({ x: 5 * i + 1 }) : i === 5 ? car({ x: 5 * i, yaw: 0.3 + Math.PI }) : car({ x: 5 * i });
  recs.push(EL.record({ action: 'save', job: 7, frame: i, camera: 'CAM_FRONT', how: 'T', model: 'mtrans', score: 0.8, points: 120,
    machine: [m], saved: s, machineLabel: 1, savedLabel: i === 8 ? 2 : 1, labelName: i === 8 ? 'truck' : 'car', time: '2026-10-13T00:00:00Z' }));
}
recs.push(EL.record({ action: 'skip', job: 7, frame: 0, camera: 'CAM_FRONT', how: 'T', machine: [car()], machineLabel: 1, labelName: 'car' }));
const s = EL.summary(recs);
check(s.saved === 10 && s.edited === 3 && s.skipped === 1, `summary 3 / 10 edited, 1 skipped (got ${JSON.stringify(s)})`);
check(near(s.pct, 30), 'pct 30');

// a hand-drawn box the user never touched is not a machine box with an edit, but is still counted
const hand = EL.record({ action: 'save', how: 'tay', machine: [car()], saved: car(), machineLabel: 1, savedLabel: 1 });
check(hand.edited === false, 'hand box unchanged');

// CSV
const csv = EL.toCsv([...recs, EL.record({ action: 'save', how: 'tay', labelName: 'xe "con", lớn', machine: [car()], saved: car(), machineLabel: 1, savedLabel: 1 })]);
const lines = csv.trim().split('\n');
check(lines[0] === EL.COLUMNS.join(','), 'header');
check(lines.length === recs.length + 2, 'one row per record');
check(csv.includes('"xe ""con"", lớn"'), 'quotes and commas escaped');
check(lines[3].split(',')[EL.COLUMNS.indexOf('edited')] === '1', 'edited column 1 for box 2');

// CVAT attributes: only names that exist on the label, select values must be allowed
const label = { attributes: [
  { id: 11, name: 'source', input_type: 'select', values: ['tay', 'T', 'lan'] },
  { id: 12, name: 'edited', input_type: 'checkbox', values: ['false'] },
  { id: 13, name: 'score', input_type: 'text', values: [''] },
  { id: 14, name: 'color', input_type: 'select', values: ['red'] }] };
const at = EL.cvatAttributes(label, recs[2]);
check(at.length === 3 && at.find((a) => a.spec_id === 12).value === 'true' && at.find((a) => a.spec_id === 11).value === 'T'
  && at.find((a) => a.spec_id === 13).value === '0.80', `attributes ${JSON.stringify(at)}`);
check(EL.cvatAttributes({ attributes: [{ id: 11, name: 'source', input_type: 'select', values: ['manual'] }] }, recs[2]).length === 0, 'value not in select list: skipped');
check(EL.cvatAttributes({}, recs[2]).length === 0, 'label without attributes');

console.log(fail ? `${fail} FAILED` : 'editlog: all passed');
process.exit(fail ? 1 : 0);
