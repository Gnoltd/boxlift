// node tests/autofilter.test.js — PLAN 4.2 + 4.3: the detector runs once at a low score; every detection is kept with
// why it was dropped (or not). Moving the threshold only re-filters (no model run); "Lưu tất cả" saves what passes.
const AF = require('../extension/function/autofilter.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
const cand = (label, score, points, reason = null) => ({ det: { label, score }, points: new Array(points).fill(0), reason });

const cands = [
  cand('car', 0.92, 300), cand('car', 0.45, 80), cand('car', 0.22, 40), cand('truck', 0.6, 15),
  cand('bus', 0.8, 0, 'nofit'), cand('car', 0.7, 100, 'dup'), cand('bicycle', 0.9, 50, 'off'), cand('car', 0.5, 60, 'merged'),
];
const thr = { car: 0.3, truck: 0.3, bus: 0.3, motorcycle: 0.3, bicycle: 0.3, pedestrian: 0.3 };
let r = AF.split(cands, { thr, minPoints: 0 });
check(r.items.length === 3, `3 pass at 30% (got ${r.items.length})`);
check(r.rejected.length === 5, 'the rest are rejected');
check(r.rejected.find((x) => x.cand === cands[2]).reason === 'low', 'below threshold -> low');
check(r.rejected.find((x) => x.cand === cands[4]).reason === 'nofit', 'reasons from the run are kept');

// threshold per class, no model run: only filtering
r = AF.split(cands, { thr: { ...thr, car: 0.5 }, minPoints: 0 });
check(r.items.length === 2 && r.items.every((c) => c.det.label !== 'car' || c.det.score >= 0.5), 'car threshold 50%');
r = AF.split(cands, { thr: { ...thr, car: 0.2 }, minPoints: 0 });
check(r.items.length === 4, 'lower car threshold brings the 22% car back');

// minimum LiDAR points
r = AF.split(cands, { thr, minPoints: 20 });
check(r.items.length === 2 && r.rejected.find((x) => x.cand === cands[3]).reason === 'few', 'truck with 15 points -> few');

// done (saved / skipped in review) never comes back when the threshold moves
cands[0].done = true;
r = AF.split(cands, { thr, minPoints: 0 });
check(!r.items.includes(cands[0]) && !r.rejected.some((x) => x.cand === cands[0]), 'reviewed ones are out');

// counts per reason, for the "why no box" line
const c = AF.counts(r.rejected);
check(c.low === 1 && c.nofit === 1 && c.dup === 1 && c.off === 1 && c.merged === 1, JSON.stringify(c));
check(AF.REASONS.low && AF.REASONS.few && AF.REASONS.nofit && AF.REASONS.dup && AF.REASONS.off && AF.REASONS.merged, 'every reason has words');

// overlap with boxes already there: at or above the threshold -> "đã có"; moving it re-filters, no model run
const ov = [cand('car', 0.9, 100), cand('car', 0.9, 100), cand('car', 0.9, 100)];
ov[0].overlap = 0.1; ov[1].overlap = 0.35; ov[2].overlap = 0.6;
r = AF.split(ov, { thr, overlap: 0.3 });
check(r.items.length === 1 && r.rejected.every((x) => x.reason === 'dup'), `30%: one new, two already there (${r.items.length})`);
r = AF.split(ov, { thr, overlap: 0.5 });
check(r.items.length === 2, 'raised to 50%: the 35% one comes back');
check(AF.split(ov, { thr }).items.length === 1 && AF.OVERLAP === 0.3, 'default 30%');

// one object seen by two cameras: already there on one camera = already there (the other twin is not proposed)
const A = cand('car', 0.9, 100), B = cand('car', 0.6, 100);
A.group = B.group = 1; A.overlap = 0.5; B.overlap = 0.1;
r = AF.split([A, B], { thr, overlap: 0.3 });
check(r.items.length === 0 && r.rejected.every((x) => x.reason === 'dup'), `30%: A already there, so B too (${r.items.length} items)`);
const L = cand('car', 0.2, 100); L.group = 3; const L2 = cand('car', 0.6, 100); L2.group = 3;
check(AF.split([L, L2], { thr }).items[0] === L2, 'a twin dropped for another reason (low) does not hide the other');
r = AF.split([A, B], { thr, overlap: 0.6 });
check(r.items.length === 1 && r.items[0] === A && r.rejected[0].cand === B && r.rejected[0].reason === 'merged', '60%: A back, B merged');
const A2 = cand('car', 0.9, 100), B2 = cand('car', 0.6, 100); A2.group = B2.group = 2;
r = AF.split([B2, A2], { thr });
check(r.items.length === 1 && r.items[0] === A2 && r.rejected[0].reason === 'merged', 'both pass: higher score stays, other merged');

console.log(fail ? `${fail} FAILED` : 'autofilter: all passed');
process.exit(fail ? 1 : 0);
