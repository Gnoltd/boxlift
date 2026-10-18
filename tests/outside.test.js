// node tests/outside.test.js — a track that left the scene (outside keyframe) is listed at that frame with its last box,
// and O on it brings it back.
const TR = require('../extension/function/tracks.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const pts = (x) => [x, 0, 0, 0, 0, 0, 4, 2, 1.5];
const t = { shapes: [{ frame: 0, points: pts(0), outside: false }, { frame: 5, points: pts(5), outside: false }] };
ok('showing: not listed as left', TR.leftAt(t, 3) === null && TR.leftAt(t, 5) === null);
const out = TR.setOutside(t, 7, true);
ok('before it left: not listed', TR.leftAt(out, 6) === null && TR.at(out, 6) !== null);
ok('at and after the outside keyframe: listed with the last box', TR.leftAt(out, 7)[0] === 5 && TR.leftAt(out, 9)[0] === 5 && TR.at(out, 7) === null);
ok('not started yet: not listed', TR.leftAt({ shapes: [{ frame: 4, points: pts(0), outside: false }] }, 2) === null);
const back = TR.setOutside(out, 7, false);
ok('O again: the track is back, not listed', TR.leftAt(back, 7) === null && TR.at(back, 7).points[0] === 5);
if (fails) { console.log('FAIL'); process.exit(1); }
