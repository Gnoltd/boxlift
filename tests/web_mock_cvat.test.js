// node tests/web_mock_cvat.test.js — in-browser fake of the CVAT REST API used by the static web demo.
const assert = require('assert');
const MockCvat = require('../web/shim/mock-cvat.js');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const manifest = { task: { id: 1, name: 'nuscenes scene-0061' },
  labels: [{ id: 3, name: 'car', type: 'cuboid' }, { id: 4, name: 'pedestrian', type: 'cuboid' }],
  frames: [0, 1, 2, 3].map((i) => ({ fid: 'f' + i, pcd: `demo-data/pcd/f${i}.pcd`, ctx: `demo-data/ctx/frame-f${i}.ctx` })) };
const H = { 'X-CSRFTOKEN': 'mocktoken123' };
const shape = (f) => ({ type: 'cuboid', frame: f, label_id: 3, points: [0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0] });

(async () => {
  const storage = mem(), fetched = [];
  const fetchBin = async (u) => { fetched.push(u); return new Uint8Array([1, 2, 3, 4]).buffer; };
  const events = [];
  const win = { location: { origin: 'https://demo.test' }, dispatchEvent: (e) => events.push(e), fetch: async (u) => ({ orig: u }) };
  global.CustomEvent = global.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  let m = MockCvat.create({ manifest, storage, fetchBin });

  let r = await m.handle('GET', '/labels?job_id=1&page_size=500', {});
  assert.strictEqual(r.json.results.length, 2);
  assert.strictEqual((await m.handle('GET', '/jobs/1', {})).json.data_chunk_size, 0);
  assert.strictEqual((await m.handle('GET', '/jobs/1', {})).json.stop_frame, 3);
  assert.strictEqual((await m.handle('GET', '/tasks/1', {})).json.name, 'nuscenes scene-0061');
  assert.strictEqual((await m.handle('GET', '/jobs/1/data/meta', {})).json.frames.length, 4);
  assert.strictEqual((await m.handle('GET', '/jobs', {})).json.count, 1);
  assert.strictEqual((await m.handle('GET', '/nope', {})).status, 404);

  // writes
  assert.strictEqual((await m.handle('PATCH', '/jobs/1/annotations?action=create', {}, { shapes: [shape(0)] })).status, 403);
  r = await m.handle('PATCH', '/jobs/1/annotations?action=create', H, { shapes: [shape(0), shape(1)], tracks: [] });
  assert.deepStrictEqual(r.json.shapes.map((s) => s.id), [1, 2]);
  assert.deepStrictEqual((await m.handle('GET', '/jobs/1/annotations', {})).json.shapes.map((s) => s.id), [1, 2]);
  assert.strictEqual((await m.handle('PATCH', '/jobs/1/annotations?action=bad', H, { shapes: [] })).status, 400);
  assert.strictEqual((await m.handle('PATCH', '/jobs/1/annotations?action=delete', H, { shapes: [{ id: 99 }] })).status, 404);
  r = await m.handle('PATCH', '/jobs/1/annotations?action=update', H, { shapes: [{ ...shape(0), id: 1, label_id: 4 }] });
  assert.strictEqual(r.json.shapes[0].label_id, 4);
  r = await m.handle('PATCH', '/jobs/1/annotations?action=delete', H, { shapes: [{ id: 2 }] });
  assert.strictEqual(r.status, 200);

  // duplicate id in one delete batch must not remove an unrelated annotation
  r = await m.handle('PATCH', '/jobs/1/annotations?action=create', H, { shapes: [shape(2), shape(3)], tracks: [] });
  const [da, db] = r.json.shapes.map((s) => s.id);
  assert.strictEqual((await m.handle('PATCH', '/jobs/1/annotations?action=delete', H, { shapes: [{ id: da }, { id: da }] })).status, 200);
  assert.deepStrictEqual((await m.handle('GET', '/jobs/1/annotations', {})).json.shapes.map((s) => s.id).sort(), [1, db].sort());
  await m.handle('PATCH', '/jobs/1/annotations?action=delete', H, { shapes: [{ id: db }] });

  // tracks
  r = await m.handle('PATCH', '/jobs/1/annotations?action=create', H, { shapes: [], tracks: [{ label_id: 3, frame: 0, shapes: [shape(0), shape(2)] }] });
  const tid = r.json.tracks[0].id;
  assert.ok(Number.isInteger(tid) && tid > 2);
  assert.ok((await m.handle('GET', '/jobs/1/annotations', {})).json.tracks.some((t) => t.id === tid && t.shapes.length === 2));
  assert.strictEqual((await m.handle('PATCH', '/jobs/1/annotations?action=delete', H, { shapes: [], tracks: [{ id: tid }] })).status, 200);
  assert.strictEqual((await m.handle('GET', '/jobs/1/annotations', {})).json.tracks.length, 0);

  // reload: same storage, ids keep growing
  m = MockCvat.create({ manifest, storage, fetchBin });
  assert.deepStrictEqual((await m.handle('GET', '/jobs/1/annotations', {})).json.shapes.map((s) => s.id), [1]);
  r = await m.handle('PATCH', '/jobs/1/annotations?action=create', H, { shapes: [shape(3)] });
  assert.ok(r.json.shapes[0].id > 1);

  // binary
  r = await m.handle('GET', '/jobs/1/data?type=frame&quality=original&number=3', {});
  assert.strictEqual(r.bin.byteLength, 4); assert.deepStrictEqual(fetched, ['demo-data/pcd/f3.pcd']);
  await m.handle('GET', '/jobs/1/data?type=context_image&quality=original&number=2', {});
  assert.strictEqual(fetched[1], 'demo-data/ctx/frame-f2.ctx');
  assert.strictEqual((await m.handle('GET', '/jobs/1/data?type=frame&number=9', {})).status, 404);

  // fetch interception
  MockCvat.install(win, m);
  let rr = await win.fetch('https://demo.test/api/jobs/1/data?type=frame&number=1');
  assert.strictEqual(rr.headers.get('Content-Length'), '4');
  const rd = rr.clone().body.getReader(); assert.strictEqual((await rd.read()).value.length, 4);
  assert.strictEqual((await rr.arrayBuffer()).byteLength, 4);
  rr = await win.fetch('https://demo.test/api/labels'); assert.strictEqual((await rr.json()).count, 2);
  rr = await win.fetch('https://demo.test/api/jobs/1/annotations?action=create', { method: 'PATCH', headers: H, body: JSON.stringify({ shapes: [shape(1)], tracks: [] }) });
  assert.strictEqual(rr.status, 200);
  assert.strictEqual(events.length > 0 && events[events.length - 1].detail.action, 'create');
  assert.strictEqual(events[events.length - 1].detail.shapes, 1);
  assert.deepStrictEqual(await win.fetch('https://demo.test/other'), { orig: 'https://demo.test/other' });
  assert.deepStrictEqual(await win.fetch('https://demo.test/apix'), { orig: 'https://demo.test/apix' });
  console.log('web_mock_cvat ok');
})().catch((e) => { console.error(e); process.exit(1); });
