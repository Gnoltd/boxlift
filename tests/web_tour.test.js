// node tests/web_tour.test.js — pure state machine + helpers of the web demo guided tour (DOM mount is checked in a browser).
const assert = require('assert');
const Tour = require('../web/tour/tour.js');
const S = require('../web/tour/strings.js');

// full happy path
let m = Tour.createMachine();
assert.deepStrictEqual({ ...m.state }, { index: 0, done: false });
const seen = [];
m.onChange((s) => seen.push(s.index + ':' + s.done));
m.notify('shape-created');            // wrong step: ignored
m.notify('auto-key');
m.notify('track-created');
assert.strictEqual(m.state.index, 0);
assert.strictEqual(seen.length, 0);
m.notify('next');                     // lidar -> box
assert.strictEqual(m.state.index, 1);
m.notify('next');                     // box needs a shape, next ignored
assert.strictEqual(m.state.index, 1);
m.notify('shape-created');            // box -> auto
assert.strictEqual(m.state.index, 2);
m.notify('shape-created');            // repeat does not jump
assert.strictEqual(m.state.index, 2);
m.notify('auto-key');                 // auto -> track
assert.strictEqual(m.state.index, 3);
m.notify('track-created');
assert.strictEqual(m.state.done, true);
assert.deepStrictEqual(seen, ['1:false', '2:false', '3:false', '3:true']);
m.notify('next'); m.notify('auto-key');   // after done: no change, no emit
assert.strictEqual(seen.length, 4);

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
assert.strictEqual(Tour.resetKeys(['ext:a', 'demo:tour', 'other', 'ext:b', 'xdemo:z']).join(), 'ext:a,demo:tour,ext:b');
assert.strictEqual(Tour.pickLang(JSON.stringify({ lang: 'en' })), 'en');
assert.strictEqual(Tour.pickLang('{bad'), 'vi');
assert.strictEqual(Tour.pickLang(null), 'vi');
assert.strictEqual(Tour.pickLang(JSON.stringify({ lang: 'fr' })), 'vi');

// strings: both languages have identical keys, non-empty
assert.deepStrictEqual(Object.keys(S.vi).sort(), Object.keys(S.en).sort());
for (const l of ['vi', 'en']) for (const k in S[l]) assert.ok(String(S[l][k]).length > 0, l + '.' + k);
for (const k of ['step0', 'step1', 'step2', 'step3']) assert.ok(S.vi[k + 'Title'] && S.vi[k + 'Body']);
assert.ok(/CC BY-NC-SA 4\.0/.test(S.en.footer) && /github\.com\/Gnoltd\/boxlift/.test(S.en.footer + S.en.repoUrl));
for (const l of ['vi', 'en']) {
  assert.ok(/Argoverse 2 Sensor Dataset \(CC BY-NC-SA 4\.0\)/.test(S[l].footer), l + ' footer credits Argoverse 2');
  assert.ok(!/nuScenes/i.test(JSON.stringify(S[l])), l + ' has no nuScenes text');
}
console.log('web_tour OK');
