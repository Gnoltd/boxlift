// node tests/web_tour.test.js — pure state machine + helpers of the web demo spotlight tour (DOM mount is checked in a browser).
const assert = require('assert');
const Tour = require('../web/tour/tour.js');
const S = require('../web/tour/strings.js');

assert.deepStrictEqual(Tour.STEPS, ['scene', 'open', 'camera', 'box', 'auto', 'track']);
assert.strictEqual(Tour.TOTAL, 7, '6 steps + the final "free to explore" card');
const I = (name) => Tour.STEPS.indexOf(name);

// full happy path: 3D screen -> open BoxLift -> camera -> draw -> auto -> track -> done
let m = Tour.createMachine();
assert.deepStrictEqual({ ...m.state }, { index: 0, done: false });
const seen = [];
m.onChange((s) => seen.push(s.index + ':' + s.done));
m.notify('auto-key'); m.notify('track-key'); m.notify('bogus');   // arms/unknown do nothing on step 1
assert.strictEqual(m.state.index, 0);
assert.strictEqual(seen.length, 0);
m.notify('next');                     // scene -> open
assert.strictEqual(m.state.index, I('open'));
m.notify('next');                     // Tiếp on "open" only clicks the launcher; the machine waits for the panel
assert.strictEqual(m.state.index, I('open'));
m.notify('panel-open');               // open -> camera
assert.strictEqual(m.state.index, I('camera'));
m.notify('panel-open');               // reopening later does not move on
assert.strictEqual(m.state.index, I('camera'));
m.notify('next');                     // camera -> box
assert.strictEqual(m.state.index, I('box'));
m.notify('next');                     // box needs a saved box, next ignored
assert.strictEqual(m.state.index, I('box'));
m.notify('shape-created');            // box -> auto
assert.strictEqual(m.state.index, I('auto'));
m.notify('shape-created');            // a repeat save does not jump (auto needs the T arm first)
assert.strictEqual(m.state.index, I('auto'));
m.notify('auto-key');                 // pressing T alone must NOT advance
assert.strictEqual(m.state.index, I('auto'));
m.notify('shape-created');            // proposal approved after T -> track
assert.strictEqual(m.state.index, I('track'));
m.notify('track-created');            // no Shift+K yet: a plain Track-mode save is ignored
assert.strictEqual(m.state.index, I('track'));
m.notify('track-key'); m.notify('track-created');
assert.strictEqual(m.state.done, true);
assert.deepStrictEqual(seen, ['1:false', '2:false', '3:false', '4:false', '5:false', '5:true']);
m.notify('next'); m.notify('auto-key'); m.notify('panel-open');   // after done: no change, no emit
assert.strictEqual(seen.length, 6);

// the visitor clicks "Mở BoxLift" while step 1 is shown: straight to the camera step
m = Tour.createMachine(); m.notify('panel-open'); assert.strictEqual(m.state.index, I('camera'));
// a saved box (or a restore of saved boxes after reload) lands past the draw step, from any step before it
for (const s of ['scene', 'open', 'camera', 'box']) for (const ev of ['shape-created', 'track-created']) {
  m = Tour.createMachine(undefined, { index: I(s), done: false }); m.notify(ev); assert.strictEqual(m.state.index, I('auto'), s + ' + ' + ev);
}

// auto: armed by T, any saved annotation advances; track-created too (Track save mode); arm is lost when the step changes
m = Tour.createMachine(undefined, { index: I('auto'), done: false });
m.notify('track-created'); assert.strictEqual(m.state.index, I('auto'));
m.notify('auto-key'); m.notify('track-created'); assert.strictEqual(m.state.index, I('track'));
m = Tour.createMachine(undefined, { index: I('auto'), done: false });
m.notify('auto-key'); m.notify('next'); assert.strictEqual(m.state.index, I('track'));
m.notify('track-created'); assert.strictEqual(m.state.index, I('track'), 'arm of the previous step does not leak');

// track: shape-created never finishes it; Shift+K arms track-created / track-updated
m = Tour.createMachine(undefined, { index: I('track'), done: false });
m.notify('shape-created'); m.notify('auto-key'); m.notify('track-created'); assert.strictEqual(m.state.index, I('track'));
m.notify('track-key'); m.notify('shape-created'); assert.strictEqual(m.state.done, false);
m.notify('track-updated'); assert.strictEqual(m.state.done, true);   // Track save mode: Shift+K updates the existing track
m = Tour.createMachine(undefined, { index: I('track'), done: false }); m.notify('track-updated'); assert.strictEqual(m.state.index, I('track'), 'unarmed update ignored');
for (const s of ['scene', 'open', 'camera', 'box', 'auto']) { m = Tour.createMachine(undefined, { index: I(s), done: false }); m.notify('track-key'); m.notify('track-updated'); assert.strictEqual(m.state.index, I(s)); }

// next on auto and track
m = Tour.createMachine(undefined, { index: I('auto'), done: false });
m.notify('next'); assert.strictEqual(m.state.index, I('track'));
m.notify('next'); assert.strictEqual(m.state.done, true);

// never stuck: every step can be skipped; every step but "box" (needs a save) and "open" (needs the panel) has next
for (let i = 0; i < Tour.STEPS.length; i++) { m = Tour.createMachine(undefined, { index: i, done: false }); m.notify('skip'); assert.strictEqual(m.state.done, true); }
for (const s of ['scene', 'camera', 'auto', 'track']) { m = Tour.createMachine(undefined, { index: I(s), done: false }); m.notify('next'); assert.ok(m.state.index > I(s) || m.state.done, s + ' next'); }

// restore from storage, including garbage
m = Tour.createMachine(undefined, { index: 4, done: false });
assert.strictEqual(m.state.index, 4);
m = Tour.createMachine(undefined, { index: 0, done: true });
assert.strictEqual(m.state.done, true);
for (const bad of [null, undefined, 'x', { index: 99 }, { index: -1 }, { index: 1.5 }]) assert.strictEqual(Tour.createMachine(undefined, bad).state.index, 0);
assert.strictEqual(Tour.createMachine(undefined, { index: 99, done: true }).state.done, true);

// restart
m = Tour.createMachine(undefined, { index: 0, done: true });
m.notify('restart'); assert.deepStrictEqual({ ...m.state }, { index: 0, done: false });

// view: what the overlay shows for (machine state, is the BoxLift panel open). After a reload the panel is closed, so a
// step that lives inside BoxLift shows the "open BoxLift" card (same counter as step 2) until the panel is open again.
const V = (index, done, open) => Tour.view({ index, done }, open);
assert.deepStrictEqual(V(0, false, false), { key: 'scene', n: 1, total: 7, reopen: false });
assert.deepStrictEqual(V(0, false, true), { key: 'sceneBehind', n: 1, total: 7, reopen: false }, 'restart with the panel open: point at its close button');
assert.deepStrictEqual(V(1, false, false), { key: 'open', n: 2, total: 7, reopen: false });
assert.deepStrictEqual(V(1, false, true), { key: 'open', n: 2, total: 7, reopen: false });
for (const s of ['camera', 'box', 'auto', 'track']) {
  assert.deepStrictEqual(V(I(s), false, true), { key: s, n: I(s) + 1, total: 7, reopen: false });
  assert.deepStrictEqual(V(I(s), false, false), { key: 'open', n: 2, total: 7, reopen: true }, s + ' with the panel closed');
}
assert.deepStrictEqual(V(3, true, true), { key: 'done', n: 7, total: 7, reopen: false });
assert.deepStrictEqual(V(3, true, false), { key: 'done', n: 7, total: 7, reopen: false });

// targets per view: host selectors or {shadow, selector} inside BoxLift's open shadow root; box step follows Draw mode
const SH = '#lidar-cam-panel-host', sh = (selector) => ({ shadow: SH, selector });
assert.deepStrictEqual(Tour.targetFor('scene'), ['#canvas']);
assert.deepStrictEqual(Tour.targetFor('sceneBehind'), [sh('#close')]);
assert.deepStrictEqual(Tour.targetFor('open'), [sh('#fab')]);
assert.deepStrictEqual(Tour.targetFor('camera'), [sh('#vp')], 'the image only: the full-width tab bar would make the ring cover the whole window');
assert.deepStrictEqual(Tour.targetFor('box', { drawing: false }), [sh('#drawBtn')]);
assert.deepStrictEqual(Tour.targetFor('box', { drawing: true }), [sh('#vp')]);
assert.deepStrictEqual(Tour.targetFor('auto'), [sh('#autoBtn')]);
assert.deepStrictEqual(Tour.targetFor('track'), [sh('#trackBtn')]);
assert.deepStrictEqual(Tour.targetFor('done'), [sh('#side')]);
assert.deepStrictEqual(Tour.targetFor('nope'), []);

// resolveTarget: never throws; null when absent, hidden or zero-sized
const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h });
const node = (r, extra) => ({ getBoundingClientRect: () => r, hidden: false, ...extra });
const shadowEls = { '#fab': node(rect(1250, 840, 130, 40)), '#vp': node(rect(100, 80, 900, 600)), '#gone': node(rect(0, 0, 0, 0)), '#hid': node(rect(1, 1, 5, 5), { hidden: true }) };
const doc = {
  querySelector: (s) => (s === '#canvas' ? node(rect(0, 0, 1400, 900)) : s === SH ? { shadowRoot: { querySelector: (q) => shadowEls[q] || null } } : null)
};
assert.ok(Tour.resolveTarget('#canvas', doc));
assert.strictEqual(Tour.resolveTarget(sh('#fab'), doc), shadowEls['#fab']);
assert.strictEqual(Tour.resolveTarget(sh('#nope'), doc), null);
assert.strictEqual(Tour.resolveTarget(sh('#gone'), doc), null, 'zero-sized (display:none / [hidden] panel) = not there');
assert.strictEqual(Tour.resolveTarget(sh('#hid'), doc), null);
assert.strictEqual(Tour.resolveTarget({ shadow: '#nohost', selector: '#fab' }, doc), null);
assert.strictEqual(Tour.resolveTarget({ shadow: '#x', selector: '#fab' }, { querySelector: () => ({ shadowRoot: null }) }), null, 'closed / no shadow root');
assert.strictEqual(Tour.resolveTarget('#canvas', { querySelector: () => { throw new Error('bad selector'); } }), null);
assert.strictEqual(Tour.resolveTarget(null, doc), null);
assert.strictEqual(Tour.resolveTarget(sh('#fab'), null), null);

// union of the found targets' rects (camera tabs + image); empty -> null
assert.deepStrictEqual(Tour.unionRect([rect(100, 50, 900, 30), rect(100, 80, 900, 600)]), rect(100, 50, 900, 630));
assert.strictEqual(Tour.unionRect([]), null);

// callout placement: beside the target (below, above, right, left, first that fits), arrow pointing at the target's centre,
// always inside the viewport; a target with no room around it (the full-screen 3D view, the big camera image) gets the
// callout inside its lower part; no target -> centred, no arrow.
const vp = { width: 1400, height: 900 }, size = { width: 320, height: 160 };
const inVp = (p) => p.left >= 12 && p.top >= 12 && p.left + size.width <= vp.width - 12 && p.top + size.height <= vp.height - 12;
let p = Tour.placeCallout(rect(80, 200, 120, 40), size, vp);          // a rail button on the left: below fits
assert.strictEqual(p.side, 'below'); assert.ok(inVp(p)); assert.ok(p.top >= 240);
assert.ok(Math.abs(p.left + p.arrow - 140) <= 1, 'arrow at the target centre');
p = Tour.placeCallout(rect(1250, 840, 130, 40), size, vp);             // the launcher at the bottom right: above
assert.strictEqual(p.side, 'above'); assert.ok(inVp(p)); assert.ok(p.top + size.height <= 840);
assert.ok(p.arrow >= 16 && p.arrow <= size.width - 16, 'arrow clamped inside the bubble');
p = Tour.placeCallout(rect(20, 20, 200, 860), size, vp);               // tall narrow: right
assert.strictEqual(p.side, 'right'); assert.ok(inVp(p)); assert.ok(p.left >= 220);
p = Tour.placeCallout(rect(1100, 20, 280, 860), size, vp);             // tall narrow on the right edge: left
assert.strictEqual(p.side, 'left'); assert.ok(inVp(p)); assert.ok(p.left + size.width <= 1100);
p = Tour.placeCallout(rect(0, 0, 1400, 900), size, vp);                // full screen
assert.strictEqual(p.side, 'inside'); assert.ok(inVp(p)); assert.ok(p.top > 450, 'lower part');
p = Tour.placeCallout(rect(-50, -50, 1600, 1100), size, vp);           // larger than the viewport: still inside
assert.strictEqual(p.side, 'inside'); assert.ok(inVp(p));
p = Tour.placeCallout(null, size, vp);
assert.strictEqual(p.side, 'center'); assert.ok(inVp(p)); assert.strictEqual(p.arrow, null);
p = Tour.placeCallout(rect(80, 200, 120, 40), size, { width: 300, height: 200 });   // tiny viewport: clamped, never negative
assert.ok(p.left >= 0 && p.top >= 0);

// ring: target rect + padding, clipped to the viewport
assert.deepStrictEqual(Tour.ringRect(rect(100, 100, 50, 20), vp, 6), { left: 94, top: 94, width: 62, height: 32 });
assert.deepStrictEqual(Tour.ringRect(rect(0, 0, 1400, 900), vp, 6), { left: 3, top: 3, width: 1394, height: 894 });

// helpers kept from the card tour
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

// strings: both languages have identical keys, non-empty; one title + body per view key
assert.deepStrictEqual(Object.keys(S.vi).sort(), Object.keys(S.en).sort());
for (const l of ['vi', 'en']) for (const k in S[l]) assert.ok(String(S[l][k]).length > 0, l + '.' + k);
for (const k of ['scene', 'sceneBehind', 'open', 'camera', 'box', 'auto', 'track', 'done']) for (const l of ['vi', 'en']) assert.ok(S[l][k + 'Title'] && S[l][k + 'Body'], l + ' ' + k);
for (const k of Object.keys(S.vi)) assert.ok(!/^step\d/.test(k), 'old step<n> keys removed: ' + k);
for (const l of ['vi', 'en']) {
  const s = S[l];
  assert.ok(/LiDAR/.test(s.sceneBody) && /xoay|rotate/i.test(s.sceneBody) && /cuộn|wheel|scroll/i.test(s.sceneBody), l + ' scene: drag rotates, wheel zooms');
  assert.ok(/✕|Esc/.test(s.sceneBehindBody), l + ' sceneBehind names the close button');
  assert.ok(/Mở BoxLift|Open BoxLift/.test(s.openBody), l + ' open names the launcher label');
  assert.ok(/1.?-?.?7/.test(s.cameraBody) && /\bH\b/.test(s.cameraBody), l + ' camera mentions camera keys and H');
  assert.ok(/\bN\b/.test(s.boxBody) && /Enter/.test(s.boxBody) && s.boxBody.search(/\bN\b/) < s.boxBody.search(/kéo|drag/i), l + ' box: N, then drag, Enter');
  assert.ok(/3D/.test(s.autoBody) && /\bT\b/.test(s.autoBody) && /Enter/.test(s.autoBody) && /\bX\b/.test(s.autoBody), l + ' auto: 3D screen + T/Enter/X');
  assert.ok(/trên bên phải|top right/.test(s.autoBody), l + ' auto: the model chip is at the top right');
  assert.ok(/T lại|T again/.test(s.autoBody), l + ' auto: a T pressed too early is lost, press it again (QA round 3)');
  assert.ok(/Shift\+K/.test(s.trackBody) && /\bD\b/.test(s.trackBody) && /\bF\b/.test(s.trackBody), l + ' track');
  assert.ok(/chọn|select/i.test(s.trackBody) && s.trackBody.search(/chọn|select/i) < s.trackBody.search(/Shift\+K/), l + ' track: select a saved box first (Shift+K needs a selection)');
  assert.ok(/Làm lại hướng dẫn|Restart tour/.test(s.doneBody) && /Đặt lại demo|Reset demo/.test(s.doneBody), l + ' done names restart/reset');
  for (const k of ['sceneBody', 'cameraBody', 'boxBody']) assert.ok(!/hộp chào|welcome/i.test(s[k]), l + ' ' + k + ' has no welcome-box text');
  assert.ok(!/đã bật sẵn|already on/i.test(s.boxBody), l + ' box does not claim Draw mode is on');
  assert.ok(/CC BY-NC-SA 4\.0/.test(s.footer) && s.creditsToggle, l + ' credits in tour card');
  assert.ok(/Argoverse 2 Sensor Dataset \(CC BY-NC-SA 4\.0\)/.test(s.footer), l + ' footer credits Argoverse 2');
  assert.ok(!/nuScenes/i.test(JSON.stringify(s)), l + ' has no nuScenes text');
  assert.ok(!('creditsClose' in s), l + ' unused creditsClose removed');
  assert.ok(s.noticeUrl === '/demo-data/NOTICE.md' && s.noticeLabel, l + ' links to NOTICE.md');
  assert.ok(/YOLOX/.test(s.footer) && /Apache/.test(s.footer) && /MTrans/.test(s.footer), l + ' footer names per-model licences');
  assert.ok(/phi thương mại|non-commercial/.test(s.footer), l + ' free non-commercial demo');
  assert.ok(/\{n\}/.test(s.stepOf) && /\{total\}/.test(s.stepOf));
}
assert.ok(/github\.com\/Gnoltd\/boxlift/.test(S.en.repoUrl));
console.log('web_tour OK');
