// node tests/web_viewer_scene.test.js — pure helpers of the web demo 3D point-cloud screen (web/viewer/scene.js); WebGL is checked in a browser.
const assert = require('assert');
const V = require('../web/viewer/scene.js');
const BF = require('../extension/function/boxfit.js');
const TR = require('../extension/function/tracks.js');
const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

// frame index from the host input value: clamped integer, garbage -> 0
assert.strictEqual(V.frameIndex('3', 9), 3);
assert.strictEqual(V.frameIndex('12', 9), 9);
assert.strictEqual(V.frameIndex('-2', 9), 0);
assert.strictEqual(V.frameIndex('abc', 9), 0);
assert.strictEqual(V.frameIndex('2.7', 9), 2);

// height range: low = ground-ish percentile, span capped so colours spread over cars, not over far-off buildings
const xyz = new Float32Array(3 * 1000);
for (let i = 0; i < 1000; i++) xyz[3 * i + 2] = i < 900 ? -0.3 + (i % 10) * 0.1 : 30;   // 10% tall outliers
const [lo, hi] = V.heightRange(xyz);
assert.ok(lo >= -0.31 && lo <= -0.2, 'low near the ground: ' + lo);
assert.ok(hi > lo && hi - lo <= V.MAX_SPAN + 1e-9, 'span capped: ' + (hi - lo));
assert.deepStrictEqual(V.heightRange(new Float32Array(0)), [0, 1], 'empty cloud -> default range');
const flat = V.heightRange(new Float32Array([0, 0, 2, 1, 1, 2]));
assert.ok(flat[1] > flat[0], 'flat cloud still gives a non-empty range');

// colours: one rgb per point, in [0,1], low and high heights differ, values outside the range are clamped
const c = V.colorize(new Float32Array([0, 0, -5, 0, 0, 0, 0, 0, 2, 0, 0, 99]), 0, 2);
assert.strictEqual(c.length, 12);
assert.ok([...c].every((v) => v >= 0 && v <= 1));
assert.deepStrictEqual([...c.slice(0, 3)], [...c.slice(3, 6)], 'below range = low colour');
assert.deepStrictEqual([...c.slice(6, 9)], [...c.slice(9, 12)], 'above range = high colour');
assert.notDeepStrictEqual([...c.slice(0, 3)], [...c.slice(6, 9)]);

// boxes of a frame: cuboid shapes of that frame + tracks interpolated with the extension's own Tracks.at
const pts = (x, yaw) => [x, 2, 0.5, 0, 0, yaw, 4, 2, 1.5, 0, 0, 0, 0, 0, 0, 0];
const ann = {
  shapes: [{ id: 1, type: 'cuboid', frame: 0, label_id: 3, points: pts(5, 0) }, { id: 2, type: 'cuboid', frame: 1, label_id: 4, points: pts(9, 0) },
    { id: 3, type: 'rectangle', frame: 0, label_id: 3, points: [0, 0, 1, 1] }],
  tracks: [{ id: 4, label_id: 8, frame: 0, shapes: [{ type: 'cuboid', frame: 2, points: pts(10, 0), outside: false }, { type: 'cuboid', frame: 0, points: pts(0, 0), outside: false }] }]
};
const deps = { at: TR.at, fromCvat: BF.fromCvatPoints };
let b = V.frameBoxes(ann, 0, deps);
assert.deepStrictEqual(b.map((x) => [x.kind, x.labelId, x.box.x]), [['shape', 3, 5], ['track', 8, 0]], 'unsorted track shapes are sorted first');
b = V.frameBoxes(ann, 1, deps);
assert.deepStrictEqual(b.map((x) => [x.kind, x.labelId]), [['shape', 4], ['track', 8]]);
assert.ok(close(b[1].box.x, 5), 'track interpolated halfway: ' + b[1].box.x);
assert.strictEqual(V.frameBoxes(ann, 3, deps).filter((x) => x.kind === 'track').length, 1, 'track holds after its last keyframe');
const out = { shapes: [], tracks: [{ id: 5, label_id: 3, shapes: [{ type: 'cuboid', frame: 0, points: pts(0, 0) }, { type: 'cuboid', frame: 1, points: pts(0, 0), outside: true }] }] };
assert.strictEqual(V.frameBoxes(out, 1, deps).length, 0, 'outside track hidden');
for (const bad of [null, undefined, {}, { shapes: 'x', tracks: null }, { tracks: [{ shapes: null }] }]) assert.deepStrictEqual(V.frameBoxes(bad, 0, deps), []);
assert.deepStrictEqual(V.parseAnnotations('{bad'), { shapes: [], tracks: [] });
assert.deepStrictEqual(V.parseAnnotations(null), { shapes: [], tracks: [] });
assert.strictEqual(V.parseAnnotations(JSON.stringify(ann)).shapes.length, 3);

// wireframe: 12 edges = 24 vertices = 72 floats; every vertex is a corner of the box (extension corner order)
const box = BF.fromCvatPoints(pts(5, Math.PI / 6));
const seg = V.boxSegments(box, BF.corners);
assert.strictEqual(seg.length, 72);
const cs = BF.corners(box);
for (let i = 0; i < 24; i++) assert.ok(cs.some((q) => close(q[0], seg[3 * i], 1e-4) && close(q[1], seg[3 * i + 1], 1e-4) && close(q[2], seg[3 * i + 2], 1e-4)), 'vertex ' + i + ' is a corner');
const len = (i) => Math.hypot(seg[6 * i] - seg[6 * i + 3], seg[6 * i + 1] - seg[6 * i + 4], seg[6 * i + 2] - seg[6 * i + 5]);
const lens = Array.from({ length: 12 }, (_, i) => +len(i).toFixed(4)).sort((p, q) => p - q);
assert.deepStrictEqual(lens, [1.5, 1.5, 1.5, 1.5, 2, 2, 2, 2, 4, 4, 4, 4], 'edges = h, w, l x4');

// label colours: stable per name, distinct for the demo labels, fallback for unknown
const names = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian'];
assert.strictEqual(new Set(names.map(V.labelColor)).size, names.length);
assert.strictEqual(V.labelColor('car'), V.labelColor('car'));
assert.strictEqual(typeof V.labelColor('???'), 'number');

// camera: behind and above the ego vehicle (x forward, z up in the AV2 lidar/ego frame), looking forward
assert.ok(V.CAMERA.position[0] < 0 && V.CAMERA.position[2] > 0 && V.CAMERA.target[0] > 0);
assert.deepStrictEqual(V.CAMERA.up, [0, 0, 1]);

// WebGL probe: true only when a context comes back; a throwing or missing getContext -> false
assert.strictEqual(V.hasWebGL({ createElement: () => ({ getContext: (k) => (k === 'webgl2' ? {} : null) }) }), true);
assert.strictEqual(V.hasWebGL({ createElement: () => ({ getContext: () => null }) }), false);
assert.strictEqual(V.hasWebGL({ createElement: () => ({ getContext: () => { throw new Error('x'); } }) }), false);
assert.strictEqual(V.hasWebGL(null), false);
console.log('web_viewer_scene ok');
