// node tests/supalog_privacy.test.js — what SupaLog sends to Supabase: numbers and opaque ids only (no task / file names, no boxes,
// no pose, no calibration), columns the project does not have yet are dropped instead of failing, and a pose row belongs to the
// device that pushed it, and the device is known by its Supabase sign-in (JWT), not by a header it declares itself.
const assert = require('assert');
const store = new Map([['supalog:config', { url: 'https://x.supabase.co', anonKey: 'k' }], ['supalog:deviceId', 'dev-1']]);
global.chrome = { storage: { local: {
  get: async (k) => { const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => store.has(x)).map((x) => [x, store.get(x)])); },
  set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
  remove: async () => {},
} }, runtime: {} };
const calls = [];
let rejectColumn = null, authFails = false, signups = 0, emptyBody = false;
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), headers: init && init.headers, body });
  if (String(url).includes('/auth/v1/')) {           // Supabase Auth: anonymous sign-in and token refresh
    if (authFails) return new Response(JSON.stringify({ msg: 'Anonymous sign-ins are disabled' }), { status: 422 });
    const refresh = String(url).includes('grant_type=refresh_token');
    if (!refresh) signups++;
    return new Response(JSON.stringify({ access_token: refresh ? 'jwt-2' : 'jwt-1', refresh_token: 'r-1', expires_in: 3600, user: { id: 'uid-1' } }), { status: 200 });
  }
  if (rejectColumn && body && Object.keys(Array.isArray(body) ? body[0] : body).includes(rejectColumn)) {
    return new Response(JSON.stringify({ message: `Could not find the '${rejectColumn}' column of 'x' in the schema cache` }), { status: 400 });
  }
  return emptyBody ? new Response(null, { status: 201 }) : new Response('[]', { status: 201 });   // return=minimal: 201, no body
};
const SL = require('../extension/function/supalog.js');
const SM = require('../extension/function/session.js');
let fail = 0;
const test = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, e.message); } };
const FORBIDDEN = /task_name|scene|sample|token|file|path|pose|calib|machine|saved_box|\bbox\b|"x"|"yaw"|"l"|"w"|"h"/;

(async () => {
  await test('push (edit_logs): only numbers and opaque ids, never the boxes', async () => {
    calls.length = 0;
    await SL.push({ time: new Date().toISOString(), job: 12, frame: 4, camera: 'CAM_FRONT', action: 'save', how: 'T', model: 'frustum', labelName: 'car', label: 'car',
      score: 0.9, points: 120, edited: true, iou: 0.8, dyaw: 3, labelChanged: false, time_spent_seconds: 9, trackId: 77, nAdjust: 3,
      machine: [{ x: 1, y: 2, z: 3, yaw: 0, l: 4, w: 2, h: 1.5 }], saved: { x: 1, y: 2, z: 3, yaw: 0.1, l: 4, w: 2, h: 1.5 }, filename: 'n015-2018-LIDAR_TOP.pcd', taskName: 'scene-0061' }, 'sess-1');
    const row = calls.find((c) => c.url.includes('/edit_logs')).body[0];
    assert.equal(row.track_id, '77'); assert.equal(row.n_adjust, 3); assert.equal(row.arm, null);
    assert.equal(JSON.stringify(row).match(FORBIDDEN), null);
    assert.equal(JSON.stringify(row).includes('scene-0061') || JSON.stringify(row).includes('.pcd'), false);
  });

  await test('pushSession: no task name, status / reason / frame_times / params go, ended_at is null while paused', async () => {
    calls.length = 0;
    const s = SM.createSession({ jobId: 12, taskName: 'scene-0061' });
    SM.recordAction(s, { action: 'save', how: 'T', label: 'car', frame: 4, edited: false, iou: 0.95 }, s.start_ts + 8000);
    SM.pauseSession(s, s.start_ts + 9000);
    await SL.pushSession(SM.snapshot(s, s.start_ts + 9000));
    const row = calls.find((c) => c.url.includes('/annotation_sessions')).body;
    assert.equal(row.task_name, null);
    assert.equal(row.status, 'paused'); assert.equal(row.ended_at, null);
    assert.deepEqual(row.frame_times['4'], { tool_s: 8, manual_s: 0, panel_s: 0, boxes: 1 });
    assert.equal(row.params.idle_sec, 120);
    assert.equal(JSON.stringify(row).includes('scene-0061'), false);
    assert.equal(JSON.stringify(row).match(/pose|calib|machine|"yaw"/), null);
    const fin = SM.finishSession(s, { reason: 'saved' }, s.start_ts + 20000);
    calls.length = 0; await SL.pushSession(fin);
    const row2 = calls.find((c) => c.url.includes('/annotation_sessions')).body;
    assert.equal(row2.status, 'completed'); assert.equal(row2.ended_reason, 'saved'); assert.ok(row2.ended_at);
    assert.equal(row2.speedup_factor, null);                       // no manual measurement: nothing invented
  });

  await test('a project that has not run the migration: the unknown columns are dropped and the row still goes', async () => {
    calls.length = 0; rejectColumn = 'track_id';
    await SL.push({ time: new Date().toISOString(), job: 1, frame: 1, action: 'save', trackId: 5, nAdjust: 1 }, 'sess-2');
    rejectColumn = null;
    const posts = calls.filter((c) => c.url.includes('/edit_logs'));
    assert.equal(posts.length, 2);
    assert.ok('track_id' in posts[0].body[0]);
    assert.equal('track_id' in posts[1].body[0], false);
    assert.equal(posts[1].body[0].n_adjust, 1);
  });

  await test('pose: pushed with the signed-in id as owner, keyed (task, owner); read back filtered by the same owner', async () => {
    calls.length = 0;
    assert.equal(await SL.upsertTaskPose({ taskName: 't1', taskId: 3, source: 'p.json', rawPose: { frames: [] }, frameCount: 0 }), true);
    const up = calls.find((c) => c.url.includes('/task_poses'));
    assert.equal(new URL(up.url).searchParams.get('on_conflict'), 'task_name,owner_device_id');
    assert.equal(up.body.owner_device_id, 'uid-1');
    calls.length = 0;
    await SL.getTaskPose('t1');
    const rd = calls.find((c) => c.url.includes('/task_poses'));
    assert.ok(rd.url.includes('owner_device_id=eq.uid-1'));
  });

  await test('identity: requests carry the device JWT, never the bare anon key or a self-declared x-device-id', async () => {
    calls.length = 0;
    await SL.push({ time: new Date().toISOString(), job: 1, frame: 1, action: 'save' }, 'sess-3');
    const post = calls.find((c) => c.url.includes('/edit_logs'));
    assert.equal(post.headers['Authorization'], 'Bearer jwt-1');
    assert.equal(post.headers['apikey'], 'k');
    assert.equal('x-device-id' in post.headers, false);
    assert.equal(post.body[0].device_id, 'uid-1');       // not the local random id 'dev-1'
  });

  await test('identity: one anonymous sign-in serves many requests, even started together', async () => {
    store.delete('supalog:auth'); signups = 0; calls.length = 0;
    await Promise.all([1, 2, 3].map((i) => SL.push({ time: new Date().toISOString(), job: i, frame: i, action: 'save' }, 'sess-4')));
    assert.equal(signups, 1);
  });

  await test('identity: an expired token is refreshed, not replaced by a new sign-in', async () => {
    const st = store.get('supalog:auth'); store.set('supalog:auth', { ...st, expires_at: Date.now() - 1000 });
    signups = 0; calls.length = 0;
    await SL.push({ time: new Date().toISOString(), job: 9, frame: 9, action: 'save' }, 'sess-5');
    assert.equal(signups, 0);
    assert.ok(calls.some((c) => c.url.includes('grant_type=refresh_token')));
    assert.equal(calls.find((c) => c.url.includes('/edit_logs')).headers['Authorization'], 'Bearer jwt-2');
  });

  await test('identity: a row cannot name another owner; the signed-in id always wins', async () => {
    calls.length = 0;
    const store2 = store.get('supalog:queue');
    store.set('supalog:queue', [{ device_id: 'someone-else', session_id: 'x', action: 'save', job: '1', frame: '1' }]);
    await SL.push({ time: new Date().toISOString(), job: 2, frame: 2, action: 'save' }, 'sess-6');
    const flushed = calls.filter((c) => c.url.includes('/edit_logs')).flatMap((c) => c.body);
    assert.ok(flushed.length >= 2 && flushed.every((r) => r.device_id === 'uid-1'));
    store.set('supalog:queue', store2 || []);
  });

  await test('identity: sign-in refused (anonymous sign-ins off): nothing throws, the row waits in the queue', async () => {
    store.delete('supalog:auth'); store.set('supalog:queue', []); authFails = true; calls.length = 0;
    await SL.push({ time: new Date().toISOString(), job: 3, frame: 3, action: 'save' }, 'sess-7');
    authFails = false;
    assert.equal(calls.some((c) => c.url.includes('/rest/v1/')), false);
    assert.equal(store.get('supalog:queue').length, 1);
    store.set('supalog:queue', []);
  });

  await test('pushSession: an insert answered 201 with an empty body (return=minimal) is a success, not a failure', async () => {
    const warns = []; const w = console.warn; console.warn = (...x) => warns.push(x.join(' '));
    emptyBody = true; calls.length = 0;
    try { await SL.pushSession({ session_id: 'sess-9', job_id: 1, status: 'completed' }); } finally { emptyBody = false; console.warn = w; }
    assert.ok(calls.some((c) => c.url.includes('/annotation_sessions')));
    assert.deepEqual(warns.filter((x) => x.includes('pushSession failed')), []);
  });

  // ── identity under stress: refresh trouble and several tabs ──
  const expire = () => { const st = store.get('supalog:auth'); store.set('supalog:auth', { ...st, expires_at: Date.now() - 1000 }); };
  const realFetch = global.fetch;
  const failRefresh = (how) => { global.fetch = async (url, init) => (String(url).includes('grant_type=refresh_token') ? how(url) : realFetch(url, init)); };
  const attempt = async () => { try { await SL.push({ time: new Date().toISOString(), job: 5, frame: 5, action: 'save' }, 'sess-8'); } catch (e) { return e; } };

  await test('refresh: a network error keeps the identity, no new sign-in, the row is queued', async () => {
    store.delete('supalog:auth'); store.set('supalog:queue', []); await SL.push({ time: new Date().toISOString(), job: 1, frame: 1, action: 'save' }, 's');
    expire(); signups = 0; const before = store.get('supalog:auth').refresh_token;
    failRefresh(() => { throw new TypeError('Failed to fetch'); });
    await attempt();
    global.fetch = realFetch;
    assert.equal(signups, 0);
    assert.equal(store.get('supalog:auth').refresh_token, before);       // still there for the next try
    assert.ok(store.get('supalog:queue').length >= 1);
    store.set('supalog:queue', []);
  });

  await test('refresh: a 5xx or 429 keeps the identity too', async () => {
    for (const status of [500, 503, 429]) {
      expire(); signups = 0;
      failRefresh(() => new Response('{}', { status }));
      await attempt();
      global.fetch = realFetch;
      assert.equal(signups, 0, `status ${status}`);
    }
    store.set('supalog:queue', []);
  });

  await test('refresh: a rejected refresh token (400) is the one case that signs in again', async () => {
    expire(); signups = 0;
    failRefresh(() => new Response(JSON.stringify({ msg: 'Invalid Refresh Token: Already Used' }), { status: 400 }));
    await attempt();
    global.fetch = realFetch;
    assert.equal(signups, 1);
  });

  await test('refresh: rejected, but another tab already stored a fresh token: that one is used, no sign-in', async () => {
    expire(); signups = 0;
    failRefresh(() => { store.set('supalog:auth', { ...store.get('supalog:auth'), access_token: 'jwt-other-tab', expires_at: Date.now() + 3600e3 }); return new Response('{}', { status: 400 }); });
    calls.length = 0;
    await attempt();
    global.fetch = realFetch;
    assert.equal(signups, 0);
    assert.equal(calls.find((c) => c.url.includes('/edit_logs')).headers['Authorization'], 'Bearer jwt-other-tab');
  });

  await test('two tabs at once (Web Locks): one sign-in in total', async () => {
    let tail = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (name, fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; } } } });
    const path = require.resolve('../extension/function/supalog.js');
    delete require.cache[path]; const tabA = require(path);
    delete require.cache[path]; const tabB = require(path);          // a second copy of the module: its own in-memory state, the same storage
    store.delete('supalog:auth'); store.set('supalog:queue', []); signups = 0;
    const rec = (n) => ({ time: new Date().toISOString(), job: n, frame: n, action: 'save' });
    await Promise.all([tabA.push(rec(1), 'a'), tabB.push(rec(2), 'b'), tabA.push(rec(3), 'a'), tabB.push(rec(4), 'b')]);
    delete globalThis.navigator;
    assert.equal(signups, 1);
    assert.equal(new Set(calls.filter((c) => c.url.includes('/edit_logs')).slice(-4).map((c) => c.body[0].device_id)).size, 1);
  });

  console.log(fail ? `FAIL (${fail})` : 'all ok');
  process.exit(fail ? 1 : 0);
})();
