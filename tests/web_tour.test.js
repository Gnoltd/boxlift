// node tests/web_tour.test.js — pure state machine + helpers of the web demo guided tour (DOM mount is checked in a browser).
const assert = require('assert');
const Tour = require('../web/tour/tour.js');
const S = require('../web/tour/strings.js');

// full happy path
let m = Tour.createMachine();
assert.deepStrictEqual({ ...m.state }, { index: 0, done: false });
const seen = [];
m.onChange((s) => seen.push(s.index + ':' + s.done));
m.notify('auto-key'); m.notify('track-key'); m.notify('bogus');   // arms/unknown do nothing on step 1
assert.strictEqual(m.state.index, 0);
assert.strictEqual(seen.length, 0);
m.notify('next');                     // lidar -> box
assert.strictEqual(m.state.index, 1);
m.notify('next');                     // box needs a saved box, next ignored
assert.strictEqual(m.state.index, 1);
m.notify('shape-created');            // box -> auto
assert.strictEqual(m.state.index, 2);
m.notify('shape-created');            // a repeat save does not jump (auto needs the T arm first)
assert.strictEqual(m.state.index, 2);
m.notify('auto-key');                 // pressing T alone must NOT advance
assert.strictEqual(m.state.index, 2);
m.notify('shape-created');            // proposal approved after T -> track
assert.strictEqual(m.state.index, 3);
m.notify('track-created');            // no Shift+K yet: a plain Track-mode save is ignored
assert.strictEqual(m.state.index, 3);
m.notify('track-key'); m.notify('track-created');
assert.strictEqual(m.state.done, true);
assert.deepStrictEqual(seen, ['1:false', '2:false', '3:false', '3:true']);
m.notify('next'); m.notify('auto-key');   // after done: no change, no emit
assert.strictEqual(seen.length, 4);

// lidar: a box drawn before "Next" skips straight to auto (either save mode); box accepts track-created too
m = Tour.createMachine(); m.notify('shape-created'); assert.strictEqual(m.state.index, 2);
m = Tour.createMachine(); m.notify('track-created'); assert.strictEqual(m.state.index, 2);
m = Tour.createMachine(undefined, { index: 1, done: false }); m.notify('track-created'); assert.strictEqual(m.state.index, 2);

// auto: armed by T, any saved annotation advances; track-created too (Track save mode); arm is lost when the step changes
m = Tour.createMachine(undefined, { index: 2, done: false });
m.notify('track-created'); assert.strictEqual(m.state.index, 2);
m.notify('auto-key'); m.notify('track-created'); assert.strictEqual(m.state.index, 3);
m = Tour.createMachine(undefined, { index: 2, done: false });
m.notify('auto-key'); m.notify('next'); assert.strictEqual(m.state.index, 3);
m.notify('track-created'); assert.strictEqual(m.state.index, 3, 'arm of the previous step does not leak');

// track: shape-created never finishes it; Shift+K arms track-created
m = Tour.createMachine(undefined, { index: 3, done: false });
m.notify('shape-created'); m.notify('auto-key'); m.notify('track-created'); assert.strictEqual(m.state.index, 3);
m.notify('track-key'); m.notify('shape-created'); assert.strictEqual(m.state.done, false);
m.notify('track-updated'); assert.strictEqual(m.state.done, true);   // Track save mode: Shift+K updates the existing track
m = Tour.createMachine(undefined, { index: 3, done: false }); m.notify('track-updated'); assert.strictEqual(m.state.index, 3, 'unarmed update ignored');
for (const i of [0, 1, 2]) { m = Tour.createMachine(undefined, { index: i, done: false }); m.notify('track-key'); m.notify('track-updated'); assert.strictEqual(m.state.index, i); }

// next on auto and track
m = Tour.createMachine(undefined, { index: 2, done: false });
m.notify('next'); assert.strictEqual(m.state.index, 3);
m.notify('next'); assert.strictEqual(m.state.done, true);

// skip anywhere
for (const i of [0, 1, 2, 3]) { m = Tour.createMachine(undefined, { index: i, done: false }); m.notify('skip'); assert.strictEqual(m.state.done, true); }

// restore from storage, including garbage
m = Tour.createMachine(undefined, { index: 1, done: false });
assert.strictEqual(m.state.index, 1);
m = Tour.createMachine(undefined, { index: 0, done: true });
assert.strictEqual(m.state.done, true);
for (const bad of [null, undefined, 'x', { index: 99 }, { index: -1 }, { index: 1.5 }]) {
  assert.strictEqual(Tour.createMachine(undefined, bad).state.index, 0);
}
assert.strictEqual(Tour.createMachine(undefined, { index: 99, done: true }).state.done, true);

// restart
m = Tour.createMachine(undefined, { index: 0, done: true });
m.notify('restart'); assert.deepStrictEqual({ ...m.state }, { index: 0, done: false });

// unknown events ignored
m = Tour.createMachine(); m.notify('bogus'); assert.strictEqual(m.state.index, 0);

// helpers
const ev = (key, over, path0) => ({ key, ctrlKey: false, metaKey: false, altKey: false, composedPath: () => [path0 || { tagName: 'DIV' }], ...over });
assert.strictEqual(Tour.isTourKey(ev('t')), true);
assert.strictEqual(Tour.isTourKey(ev('T')), true);
assert.strictEqual(Tour.isTourKey(ev('x')), false);
assert.strictEqual(Tour.isTourKey(ev('t', { ctrlKey: true })), false);
assert.strictEqual(Tour.isTourKey(ev('t', { metaKey: true })), false);
assert.strictEqual(Tour.isTourKey(ev('t', { altKey: true })), false);
assert.strictEqual(Tour.isTourKey(ev('t', {}, { tagName: 'INPUT' })), false);
assert.strictEqual(Tour.isTourKey(ev('t', {}, { tagName: 'TEXTAREA' })), false);
assert.strictEqual(Tour.isTourKey(ev('t', {}, { tagName: 'DIV', isContentEditable: true })), false);
assert.strictEqual(Tour.annotationEvents({ shapes: 1, tracks: 0 }).join(), 'shape-created');
assert.strictEqual(Tour.annotationEvents({ shapes: 2, tracks: 1 }).join(), 'shape-created,track-created');
assert.strictEqual(Tour.annotationEvents({ shapes: 0, tracks: 0 }).length, 0);
assert.strictEqual(Tour.annotationEvents(null).length, 0);
assert.strictEqual(Tour.annotationEvents({ action: 'update', shapes: 1, tracks: 0 }).length, 0);   // edits/deletes are not 'created'
assert.strictEqual(Tour.annotationEvents({ action: 'update', shapes: 0, tracks: 1 }).join(), 'track-updated');
assert.strictEqual(Tour.annotationEvents({ action: 'delete', shapes: 1, tracks: 0 }).length, 0);
assert.strictEqual(Tour.annotationEvents({ action: 'create', shapes: 0, tracks: 1 }).join(), 'track-created');
assert.strictEqual(Tour.annotationEvents({ action: 'restore', shapes: 1, tracks: 0 }).join(), 'shape-created');
assert.strictEqual(Tour.isTrackKey(ev('K', { shiftKey: true })), true);
assert.strictEqual(Tour.isTrackKey(ev('k', { shiftKey: true })), true);
assert.strictEqual(Tour.isTrackKey(ev('k')), false);
assert.strictEqual(Tour.isTrackKey(ev('K', { shiftKey: true, ctrlKey: true })), false);
assert.strictEqual(Tour.isTrackKey(ev('K', { shiftKey: true }, { tagName: 'INPUT' })), false);
assert.strictEqual(Tour.isTourKey(ev('T', { shiftKey: true })), true);
assert.strictEqual(Tour.resetKeys(['ext:a', 'demo:tour', 'other', 'ext:b', 'xdemo:z']).join(), 'ext:a,demo:tour,ext:b');
assert.strictEqual(Tour.pickLang(JSON.stringify({ lang: 'en' })), 'en');
assert.strictEqual(Tour.pickLang('{bad'), 'vi');
assert.strictEqual(Tour.pickLang(null), 'vi');
assert.strictEqual(Tour.pickLang(JSON.stringify({ lang: 'fr' })), 'vi');

// strings: both languages have identical keys, non-empty
assert.deepStrictEqual(Object.keys(S.vi).sort(), Object.keys(S.en).sort());
for (const l of ['vi', 'en']) for (const k in S[l]) assert.ok(String(S[l][k]).length > 0, l + '.' + k);
for (const k of ['step0', 'step1', 'step2', 'step3']) assert.ok(S.vi[k + 'Title'] && S.vi[k + 'Body']);
for (const l of ['vi', 'en']) {
  assert.ok(/1.?-?.?7/.test(S[l].step0Body) && /\bH\b/.test(S[l].step0Body), l + ' step 1 mentions camera keys and H');
  assert.ok(/\bN\b/.test(S[l].step1Body) && /Enter/.test(S[l].step1Body), l + ' step 2');
  assert.ok(/\bT\b/.test(S[l].step2Body) && /Enter/.test(S[l].step2Body) && /\bX\b/.test(S[l].step2Body), l + ' step 3');
  assert.ok(/Shift\+K/.test(S[l].step3Body) && /\bD\b/.test(S[l].step3Body) && /\bF\b/.test(S[l].step3Body), l + ' step 4');
  assert.ok(!/xoay|rotate/i.test(S[l].step0Body), l + ' no stale rotate text');
  assert.ok(/CC BY-NC-SA 4\.0/.test(S[l].footer) && S[l].creditsToggle, l + ' credits in tour card');
}
assert.ok(/CC BY-NC-SA 4\.0/.test(S.en.footer) && /github\.com\/Gnoltd\/boxlift/.test(S.en.footer + S.en.repoUrl));
for (const l of ['vi', 'en']) {
  assert.ok(/Argoverse 2 Sensor Dataset \(CC BY-NC-SA 4\.0\)/.test(S[l].footer), l + ' footer credits Argoverse 2');
  assert.ok(!/nuScenes/i.test(JSON.stringify(S[l])), l + ' has no nuScenes text');
}
console.log('web_tour OK');
