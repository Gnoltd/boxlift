// node tests/undo.test.js — Ctrl+Z for what was already sent to CVAT (P-017): the inverse of each confirmed outbox item,
// one step per user action, newest first, and ids remapped when a deleted shape / track comes back under a new id.
const U = require('../extension/function/undo.js');
const BF = require('../extension/function/boxfit.js');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };

const pts = (x) => [x, 2, 0.8, 0, 0, 0.3, 4.2, 1.8, 1.5, 0, 0, 0, 0, 0, 0, 0];
const shape = (id, x, frame = 3) => ({ id, type: 'cuboid', frame, label_id: 7, points: pts(x), attributes: [{ spec_id: 1, value: 'a' }] });
const track = (id) => ({ id, label_id: 7, frame: 0, group: 0, source: 'semi-auto', attributes: [],
  shapes: [{ id: 50, type: 'cuboid', frame: 0, points: pts(1), outside: false }, { id: 51, type: 'cuboid', frame: 4, points: pts(5), outside: true }], elements: [] });

// shapes
let inv = U.inverse({ op: 'create', frame: 3, labelId: 7 }, null, shape(11, 1), BF.fromCvatPoints);
check(inv.length === 1 && inv[0].op === 'delete' && inv[0].shape.id === 11 && inv[0].undo, 'create -> delete the new shape');
inv = U.inverse({ op: 'update', shape: shape(11, 1) }, shape(11, 1), shape(11, 9), BF.fromCvatPoints);
check(inv[0].op === 'update' && inv[0].shape.id === 11 && inv[0].box.x === 1 && inv[0].labelId === 7, 'update -> the box as it was');
inv = U.inverse({ op: 'delete', shape: shape(11, 1) }, shape(11, 1), null, BF.fromCvatPoints);
check(inv[0].op === 'create' && inv[0].box.x === 1 && inv[0].frame === 3 && inv[0].restores === 11 && inv[0].attrs.length === 1, 'delete -> create again, attributes kept');
check(U.inverse({ op: 'create' }, null, null, BF.fromCvatPoints).length === 0, 'create without a server id: nothing to undo');

// tracks
inv = U.inverse({ op: 'track-create', frame: 0 }, null, track(20), BF.fromCvatPoints);
check(inv[0].op === 'track-delete' && inv[0].trackId === 20, 'track-create -> delete the track');
inv = U.inverse({ op: 'track-set', trackId: null, frame: 0 }, null, track(21), BF.fromCvatPoints);
check(inv[0].op === 'track-delete' && inv[0].trackId === 21, 'track-set that created a track -> delete it');
const memo = { keys: [{ frame: 0 }], size: null, own: [] };
inv = U.inverse({ op: 'track-delete', trackId: 20, frame: 2 }, track(20), null, BF.fromCvatPoints, memo);
check(inv[0].op === 'track-create' && inv[0].restores === 20 && inv[0].track.id === undefined, 'track-delete -> create again');
check(inv[0].track.shapes.every((x) => x.id === undefined) && inv[0].track.shapes.length === 2 && inv[0].track.shapes[1].outside, 'every keyframe, outside kept, no ids');
check(inv[0].memo && inv[0].memo.keys.length === 1 && inv[0].memo !== memo, 'what was remembered of the track comes back (a copy)');
for (const op of ['track-key', 'track-size', 'track-outside', 'track-keyframe', 'track-set', 'track-update']) {
  inv = U.inverse({ op, trackId: 20, frame: 4 }, track(20), track(20), BF.fromCvatPoints, memo);
  check(inv.length === 1 && inv[0].op === 'track-update' && inv[0].track.id === 20 && inv[0].track.shapes.length === 2, `${op} -> the whole track as it was`);
}
const before = track(20); inv = U.inverse({ op: 'track-key', trackId: 20 }, before, null, BF.fromCvatPoints);
before.shapes[0].points[0] = 99;
check(inv[0].track.shapes[0].points[0] === 1, 'the copy does not change with the live track');
check(U.inverse({ op: 'track-key', trackId: 20 }, null, null, BF.fromCvatPoints).length === 0, 'track gone meanwhile: nothing to undo');

// steps: newest first, inverses in reverse order
const S = U.create();
const a = U.open(S, 'save'), b = U.open(S, 'batch');
check(U.add(S, b, [{ op: 'delete', shape: { id: 1 } }]) && U.add(S, b, [{ op: 'delete', shape: { id: 2 } }]), 'inverses kept in their step');
check(!U.add(S, 'nope', [{ op: 'x' }]) && !U.add(S, null, [{ op: 'x' }]), 'no step (an undo itself): not kept');
let step = U.takeLast(S);
check(step.id === b && U.plan(S, step).map((x) => x.shape.id).join() === '2,1', 'last step first, its items newest first');
check(U.takeLast(S).id === a && U.takeLast(S) === null, 'then the step before');
for (let i = 0; i < U.MAX_STEPS + 5; i++) U.open(S);
check(S.steps.length === U.MAX_STEPS, 'bounded history');

// ids: a track deleted then brought back, an older step names it by its old id
const R = U.create();
const s1 = U.open(R); U.add(R, s1, [{ op: 'track-update', trackId: 20, track: { id: 20 } }]);
U.moved(R, 'track', 20, 31); U.moved(R, 'track', 31, 44); U.moved(R, 'shape', 11, 12);
const p = U.plan(R, U.takeLast(R))[0];
check(p.trackId === 44 && p.track.id === 44, `old track id followed to the newest (${p.trackId})`);
check(U.remap(R, { op: 'delete', shape: { id: 11 } }).shape.id === 12, 'shape id remapped');
check(U.remap(R, { op: 'delete', shape: { id: 5 } }).shape.id === 5, 'other ids untouched');

console.log(fail ? `${fail} FAILED` : 'undo: all passed');
process.exit(fail ? 1 : 0);
