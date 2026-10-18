const C = require('../extension/function/compare.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const t = (sec) => 1_700_000_000_000 + sec * 1000;      // real timestamps, never 0

let s = C.create();
C.tick(s, t(0), 5);
C.activity(s, t(1)); C.tick(s, t(2), 5);
ok('first tick only sets the origin; later time up to the last action + grace counts', near(s.sec, 2));
C.tick(s, t(20), 5);
ok('no action for longer than the grace: the clock stops (1 s + 5 s grace)', near(s.sec, 6));
C.tick(s, t(30), 5);
ok('idle time adds nothing', near(s.sec, 6));
C.activity(s, t(30)); C.tick(s, t(31), 8);
ok('objects gained count as manual', s.count === 3 && near(s.sec, 7));
C.tick(s, t(32), 6);
ok('deleting objects does not count or subtract', s.count === 3 && s.lastCount === 6);
C.tick(s, t(33), 9, { counting: false });
ok('objects the tool saved (counting false) are not manual', s.count === 3 && s.lastCount === 9);
const before = s.sec;
C.activity(s, t(33)); C.tick(s, t(34), 9, { working: false });
ok('panel open (working false): no manual time', near(s.sec, before));
C.activity(s, t(34)); C.tick(s, t(534), 9);
ok('a gap over the idle limit is not counted', near(s.sec, before));
let pn = C.create();
C.tick(pn, t(0), null);
C.activity(pn, t(0), C.PANEL_GRACE_SEC);          // panel opened: counts from this moment
C.tick(pn, t(40), null);
ok('panel clock counts from the moment it opens (no model run, no save needed)', near(pn.sec, 40));
C.tick(pn, t(100), null);
ok('panel clock stops after the panel grace (60 s) without a click', near(pn.sec, 60));

const d = C.drain(s);
ok('drain hands over and resets', near(d.sec, before) && d.count === 3 && s.sec === 0 && s.count === 0 && s.lastCount === 9);

const r = C.summary({ sec: 90, count: 3 }, { sec: 60, count: 6 });
ok('sec/object', near(r.tay, 30) && near(r.tool, 10));
ok('speedup 3x', near(r.speedup, 3));
ok('saved = 30*6 - 60', near(r.savedSec, 120));
const e = C.summary({ sec: 0, count: 0 }, { sec: 0, count: 0 });
ok('no objects: null, no speedup', e.tay === null && e.speedup === null);
ok('text mentions speedup', /3\.0×/.test(C.toText({ sec: 90, count: 3 }, { sec: 60, count: 6 })) && /02:00/.test(C.toText({ sec: 90, count: 3 }, { sec: 60, count: 6 })));
const md = C.toReport({ task: 'scene|1', jobId: 7, deviceId: 'abcd1234-0000', sessionId: 'sess-1', exportedAt: '2026-10-16T08:00:00.000Z',
  manual: { sec: 90, count: 3 }, tool: { sec: 60, count: 6 },
  session: { panel_seconds: 61, saved_boxes: 6, tool_count: 6, edited_count: 1, iou_sum: 5.4, iou_count: 6, yaw_err_sum: 6, yaw_err_count: 6, tool_breakdown: { semi_auto: 2, auto_3d: 3, tracker_3d: 1 } },
  records: [{ action: 'save', frame: 4, label: 'car', how: 'tay', time_spent_seconds: 12.34, edited: false }, { action: 'skip', frame: 5 }, { action: 'save', frame: 6, label: 'truck', how: 'T', time_spent_seconds: 3, edited: true }] });
ok('report: header, device and session', /job 7/.test(md) && /abcd1234-0000/.test(md) && /sess-1/.test(md) && /scene\/1/.test(md));
ok('report: both rows and speedup', /Làm tay trong CVAT \| 3 \| 01:30 \| 30\.0/.test(md) && /Tool \(extension, label 2D\) \| 6 \| 01:00 \| 10\.0/.test(md) && /3\.0×/.test(md));
ok('report: tool details', /bán tự động N: 2/.test(md) && /16\.7% \(1\/6\)/.test(md) && /0\.900/.test(md) && /1\.0°/.test(md));
ok('report: box log has saves only, N shown as semi-auto', /\| 1 \| 4 \| car \| bán tự động \(N\) \| 12\.3 \| không \|/.test(md) && /\| 2 \| 6 \| truck \| auto \(T\) \| 3\.0 \| có \|/.test(md) && md.split('## Log từng box')[1].split('\n').filter((l) => /^\| \d+ \|/.test(l)).length === 2);
const none = C.toReport({ jobId: 1, manual: { sec: 10, count: 1 }, tool: { sec: 0, count: 0 } });
ok('report without a session still works (manual annotator)', /chưa mở extension/.test(none) && /Chưa có box nào/.test(none));
if (fails) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
