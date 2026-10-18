// node tests/boxtag.test.js — the tag drawn on a machine box (PLAN 3.2): "car 82%", a level for its colour
// (high ≥ 70 %, mid 50–70 %, low < 50 %) and "kiểm tra" when the box has < 30 LiDAR points or an unsure front.
const BT = require('../extension/function/boxtag.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };

let t = BT.tagOf({ label: 'car', score: 0.823, points: 120, headingConf: 3 });
check(t.text === 'car 82%' && t.level === 'high' && !t.check, JSON.stringify(t));
t = BT.tagOf({ label: 'truck', score: 0.7, points: 120 });
check(t.level === 'high', '70% is high');
t = BT.tagOf({ label: 'bus', score: 0.55, points: 40 });
check(t.level === 'mid' && t.text === 'bus 55%', JSON.stringify(t));
t = BT.tagOf({ label: 'car', score: 0.31, points: 12 });
check(t.level === 'low' && t.check && t.text === 'car 31% · kiểm tra', JSON.stringify(t));
t = BT.tagOf({ label: 'car', score: 0.9, points: 200, headingConf: 1.2 });
check(t.check && /kiểm tra/.test(t.text), 'unsure front -> check');
t = BT.tagOf({ label: 'car', score: null, points: 80 });
check(t.text === 'car' && t.level === null, 'no score (propagated box): label only');
check(BT.COLORS.high && BT.COLORS.mid && BT.COLORS.low, 'one colour per level');

// labels must not cover each other: a later tag moves up until it is free
const placed = [];
const a = BT.place(placed, { x: 100, y: 200, w: 60, h: 18 }), b = BT.place(placed, { x: 110, y: 205, w: 60, h: 18 });
check(a.y === 200 && b.y <= 200 - 18, `second tag moved up (${b.y})`);
const c = BT.place(placed, { x: 400, y: 200, w: 60, h: 18 });
check(c.y === 200, 'far tag stays');

console.log(fail ? `${fail} FAILED` : 'boxtag: all passed');
process.exit(fail ? 1 : 0);
