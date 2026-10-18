// node tests/supalog_queue.test.js — the offline queue of SupaLog: records pushed while offline at the same time are all kept, the
// queue is capped at ~1 MB in one pass (oldest go first), a full storage keeps the newer half, and one flush sends them all.
const assert = require('assert');
const store = new Map([['supalog:config', { url: 'https://x.supabase.co', anonKey: 'k' }], ['supalog:deviceId', 'dev-1']]);
let quotaFull = false;
const tick = () => new Promise((r) => setTimeout(r, 0));
global.chrome = { storage: { local: {
  get: async (k) => { await tick(); const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => store.has(x)).map((x) => [x, store.get(x)])); },
  set: async (o) => {
    await tick();
    if (quotaFull && o['supalog:queue'] && o['supalog:queue'].length > 2) throw new Error('QUOTA_BYTES quota exceeded');
    for (const [k, v] of Object.entries(o)) store.set(k, v);
  },
  remove: async () => {},
} }, runtime: {} };
let online = false, authDown = false, posted = [], sessions = [];
global.fetch = async (url, init) => {
  if (String(url).includes('/auth/v1/')) {
    if (authDown) return new Response(JSON.stringify({ msg: 'Anonymous sign-ins are disabled' }), { status: 422 });
    return new Response(JSON.stringify({ access_token: 'jwt', refresh_token: 'r', expires_in: 3600, user: { id: 'uid-1' } }), { status: 200 });
  }
  if (!online) throw new Error('offline');
  if (String(url).includes('/annotation_sessions')) { sessions.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  posted.push(...JSON.parse(init.body));
  return new Response(null, { status: 201 });
};
const SL = require('../extension/function/supalog.js');
let fail = 0;
const test = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, e.message); } };
const queue = () => store.get('supalog:queue') || [];
const rec = (i, extra) => ({ time: new Date().toISOString(), job: 1, frame: i, action: 'save', ...extra });
const quiet = console.warn; console.warn = () => {};

(async () => {
  await test('records pushed together while offline are all queued', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => SL.push(rec(i), 's')));
    assert.equal(queue().length, 20);
    assert.deepEqual(queue().map((r) => r.frame), Array.from({ length: 20 }, (_, i) => String(i)));
  });

  await test('one flush sends the whole queue and empties it', async () => {
    online = true; posted = [];
    await SL.push(rec(99), 's');
    assert.equal(queue().length, 0);
    assert.equal(posted.length, 21);
    online = false;
  });

  await test('a full queue of small records is trimmed in one pass (no O(N²) re-serializing)', async () => {
    const small = Array.from({ length: 20000 }, (_, i) => ({ frame: String(i), action: 'save', job: '1', session_id: 'sess-abcdef' }));
    store.set('supalog:queue', small);
    const t0 = Date.now();
    await SL.push(rec(20000), 's');
    const q = queue();
    assert.ok(Date.now() - t0 < 500, (Date.now() - t0) + ' ms');
    assert.ok(JSON.stringify(q).length <= 1_000_000);
    assert.equal(q[q.length - 1].frame, '20000');
    assert.equal(+q[0].frame, 20000 - q.length + 1);           // only the oldest were dropped, in order
  });

  await test('queue stays under ~1 MB however large the records are', async () => {
    store.set('supalog:queue', Array.from({ length: 400 }, (_, i) => ({ frame: String(i), pad: 'x'.repeat(5000) })));
    await SL.push(rec(400), 's');
    const q = queue();
    assert.ok(JSON.stringify(q).length <= 1_000_000, 'size ' + JSON.stringify(q).length);
    assert.ok(q.length < 401 && q.length > 150);
    assert.equal(q[q.length - 1].frame, '400');
  });

  await test('storage full: the newer half is kept instead of throwing', async () => {
    store.set('supalog:queue', [{ frame: 'a' }, { frame: 'b' }, { frame: 'c' }]); store.delete('supalog:status');
    quotaFull = true;
    await SL.push(rec(5), 's');
    quotaFull = false;
    assert.deepEqual(queue().map((r) => r.frame), ['c', '5']);
    assert.equal((await SL.syncStatus()).dropped, 2);            // 'a', 'b' dropped: the Log page says so
  });

  await test('sign-in fails: the log is queued and syncStatus names the error, a later success clears it', async () => {
    store.set('supalog:queue', []); store.delete('supalog:auth');
    online = true; authDown = true;
    await SL.push(rec(1), 's');
    let st = await SL.syncStatus();
    assert.equal(st.queued, 1);
    assert.match(st.error, /Anonymous sign-ins are disabled/);
    authDown = false; posted = [];
    await SL.push(rec(2), 's');
    st = await SL.syncStatus();
    assert.equal(st.queued, 0); assert.equal(st.error, null);
    assert.deepEqual(posted.map((r) => r.frame), ['1', '2']);
    online = false;
  });

  await test('a session summary that fails is kept and sent again with the next push', async () => {
    sessions = [];
    await SL.pushSession({ session_id: 'sess-9', job_id: 3, status: 'completed', started_at: new Date().toISOString() });
    assert.equal((await SL.syncStatus()).sessionsPending, 1);
    online = true;
    await SL.push(rec(3), 's');
    assert.equal(sessions.length, 1); assert.equal(sessions[0].session_id, 'sess-9');
    assert.equal((await SL.syncStatus()).sessionsPending, 0);
    online = false;
  });

  console.warn = quiet;
  process.exit(fail ? 1 : 0);
})();
