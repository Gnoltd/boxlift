// node tests/anchors.test.js — which keyframes of a track count as "set by hand" (anchors): the ones that differ from what the
// extension wrote. "Khoá frame" removes a frame from what is remembered as written, so it becomes an anchor; the retrack
// of a later edit stops at anchors and never rewrites them.
const TJ = require('../extension/function/trajectory.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const pts = (x) => [x, 0, 0, 0, 0, 0, 4, 2, 1.5];
const sig = (p) => p.slice(0, 9).map((v) => v.toFixed(3)).join(',');
const shapes = [0, 1, 2, 3, 4, 5].map((f) => ({ frame: f, outside: false, keyframe: true, points: pts(f) }));
const written = shapes.map((s) => ({ frame: s.frame, sig: sig(s.points) }));

ok('nothing set by hand: no anchors', TJ.anchorsFrom(shapes, written).length === 0);
const edited = shapes.map((s) => (s.frame === 3 ? { ...s, points: pts(3.4) } : s));
ok('an edited keyframe is an anchor', TJ.anchorsFrom(edited, written).map((a) => a.frame).join() === '3');
const locked = written.filter((w) => w.frame !== 1);
ok('a locked frame (dropped from what was written) is an anchor although its box did not change', TJ.anchorsFrom(shapes, locked).map((a) => a.frame).join() === '1');
ok('lock + edit: both are anchors, in order', TJ.anchorsFrom(edited, locked).map((a) => a.frame).join() === '1,3');
const withOut = [...shapes, { frame: 6, outside: true, keyframe: true, points: pts(5) }];
ok('an outside keyframe the extension wrote is not an anchor; one set by hand is', TJ.anchorsFrom(withOut, [...written, { frame: 6, sig: 'outside' }]).length === 0 && TJ.anchorsFrom(withOut, written).some((a) => a.frame === 6 && a.outside));
ok('no memory at all: every keyframe counts as set by hand', TJ.anchorsFrom(shapes, null).length === shapes.length);
const unheld = [...locked, { frame: 1, sig: sig(shapes[1].points) }];
ok('"Tự tính" again (the frame\'s current signature written back): not an anchor, and the keyframe is still in the track', TJ.anchorsFrom(shapes, unheld).length === 0 && shapes.some((x) => x.frame === 1 && x.keyframe));
const heldEdited = shapes.map((x) => (x.frame === 2 ? { ...x, points: pts(2.5) } : x));
ok('"Giữ keyframe" on an edited frame (saved without a retrack): the edited keyframe is an anchor', TJ.anchorsFrom(heldEdited, written).map((a) => a.frame).join() === '2');
const still = [0, 1].map((f) => ({ frame: f, points: 50, box: { x: 10 + 0.01 * f, y: 0 } }));
ok('an anchor and the LiDAR on one frame (still object): no Infinity speed, still classified static',
  TJ.classify([...still, { frame: 1, anchor: true, box: { x: 10.2, y: 0 } }]) === 'static');
if (fails) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
