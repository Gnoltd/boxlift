// node tests/web_boot.test.js — Boot.supported (pure) + helper for restoring a tour after reload.
const assert = require('assert');
const Boot = require('../web/boot.js');
const Tour = require('../web/tour/tour.js');

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE = CHROME + ' Edg/126.0.0.0';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

assert.deepStrictEqual(Boot.supported(CHROME, 1280), { ok: true });
assert.deepStrictEqual(Boot.supported(EDGE, 1000), { ok: true });
assert.deepStrictEqual(Boot.supported(FIREFOX, 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(SAFARI, 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(CHROME, 800), { ok: false, reason: 'width' });
assert.deepStrictEqual(Boot.supported(CHROME, 999), { ok: false, reason: 'width' });
assert.deepStrictEqual(Boot.supported('', 1280), { ok: false, reason: 'browser' });
assert.deepStrictEqual(Boot.supported(FIREFOX, 500), { ok: false, reason: 'browser' });

// restoreDetail: only when saved annotations hold something
assert.strictEqual(Boot.restoreDetail(null), null);
assert.strictEqual(Boot.restoreDetail('not json'), null);
assert.strictEqual(Boot.restoreDetail(JSON.stringify({ shapes: [], tracks: [] })), null);
assert.deepStrictEqual(Boot.restoreDetail(JSON.stringify({ shapes: [{}], tracks: [{}, {}] })), { action: 'restore', shapes: 1, tracks: 2 });

console.log('web_boot ok');

// model chip text (VI/EN) and language pick
assert.strictEqual(Boot.chipText({ phase: 'loading', loaded: 12.34e6, total: 129.2e6 }, 'vi'), 'Đang tải mô hình AI 12.3/129.2 MB');
assert.strictEqual(Boot.chipText({ phase: 'loading', loaded: 0, total: 1e6 }, 'en'), 'Loading AI models 0.0/1.0 MB');
assert.ok(/2/.test(Boot.chipText({ phase: 'error', failed: 2 }, 'vi')));
assert.strictEqual(Boot.chipLang('{"lang":"en"}'), 'en');
assert.strictEqual(Boot.chipLang(null), 'vi');
console.log('web_boot chip ok');

// absolute bases (cvat.js does new URL(getURL('')).origin)
assert.strictEqual(Boot.absBase('/ext/', 'https://d.example'), 'https://d.example/ext/');
assert.strictEqual(Boot.absBase('/models/', 'https://d.example'), 'https://d.example/models/');
assert.strictEqual(Boot.absBase('https://m.example/x/', 'https://d.example'), 'https://m.example/x/');
assert.strictEqual(new URL(Boot.absBase('/ext/', 'http://127.0.0.1:8792')).origin, 'http://127.0.0.1:8792');

// seeded storage: origins, Shape mode, identity label map accepted by LabelMap
const LM = require('../extension/function/labelmap.js');
const manifest = require('../web/demo-data/demo-manifest.json');
const ORIGIN = 'https://d.example';
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const ls = mem();
ls.setItem('ext:saveMode:' + ORIGIN + ':1', '"track"'); // user data must survive
const written = Boot.seedStorage(ls, ORIGIN, manifest);
assert.deepStrictEqual(written.sort(), ['labelMap:' + ORIGIN + ':t1', 'origins'].sort());
assert.deepStrictEqual(JSON.parse(ls.getItem('ext:origins')), [ORIGIN]);
assert.strictEqual(JSON.parse(ls.getItem('ext:saveMode:' + ORIGIN + ':1')), 'track');
const e = Boot.seedEntries(ORIGIN, manifest);
assert.strictEqual(e['saveMode:' + ORIGIN + ':1'], 'shape');
const rec = JSON.parse(ls.getItem('ext:labelMap:' + ORIGIN + ':t1'));
const v = LM.valid(rec, manifest.labels);
assert.strictEqual(v.confirmed, true);
assert.deepStrictEqual(v.map, LM.suggest(manifest.labels));
assert.ok(LM.CLASSES.every((c) => v.map[c] != null && manifest.labels.find((l) => l.id === v.map[c]).name === c));
assert.deepStrictEqual(Boot.seedStorage(ls, ORIGIN, manifest), []); // second boot writes nothing

// D / F frame keys
const k = (o) => Boot.frameKeyAction({ target: { tagName: 'DIV' }, ...o });
assert.strictEqual(k({ key: 'd' }), 'previous');
assert.strictEqual(k({ key: 'F' }), 'next');
assert.strictEqual(k({ key: 'f', shiftKey: true }), null);
assert.strictEqual(k({ key: 'f', ctrlKey: true }), null);
assert.strictEqual(k({ key: 'f', metaKey: true }), null);
assert.strictEqual(k({ key: 'f', altKey: true }), null);
assert.strictEqual(k({ key: 'f', defaultPrevented: true }), null);
assert.strictEqual(k({ key: 'x' }), null);
for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.strictEqual(Boot.frameKeyAction({ key: 'f', target: { tagName } }), null);
assert.strictEqual(Boot.frameKeyAction({ key: 'f', target: { tagName: 'DIV', isContentEditable: true } }), null);

// waitFor + openPanel
(async () => {
  let n = 0;
  assert.strictEqual(await Boot.waitFor(() => (++n >= 3 ? 'ok' : null), 1000, 5), 'ok');
  assert.strictEqual(await Boot.waitFor(() => null, 40, 5), null);
  assert.strictEqual(await Boot.waitFor(() => { throw new Error('x'); }, 20, 5), null);
  let clicked = 0, warned = 0;
  const fab = { click: () => clicked++ };
  const host = { shadowRoot: { getElementById: (id) => (id === 'fab' ? fab : null) } };
  const win = { document: { getElementById: () => host }, console: { warn: () => warned++ } };
  assert.strictEqual(await Boot.openPanel(win, 100), true);
  assert.strictEqual(clicked, 1);
  const none = { document: { getElementById: () => null }, console: { warn: () => warned++ } };
  assert.strictEqual(await Boot.openPanel(none, 30), false);
  assert.strictEqual(warned, 1);
  // boot error guard: runtime exceptions during boot become a visible banner; after dispose they are ignored
  const mkWin = () => {
    const boxes = {}, ls = {};
    const doc = { body: { appendChild: (b) => { boxes[b.id] = b; } }, getElementById: (id) => boxes[id] || null, createElement: () => ({}) };
    return { document: doc, boxes, addEventListener: (t, f) => { ls[t] = f; }, removeEventListener: (t, f) => { if (ls[t] === f) delete ls[t]; }, ls };
  };
  const gw = mkWin(), dispose = Boot.guardBoot(gw);
  assert.strictEqual(typeof gw.ls.error, 'function');
  gw.ls.error({ message: 'boom <b>', filename: '/ext/cvat.js' });
  assert.ok(/boom &lt;b&gt;/.test(gw.boxes['boot-msg'].innerHTML) && /cvat\.js/.test(gw.boxes['boot-msg'].innerHTML));
  dispose(); assert.strictEqual(gw.ls.error, undefined);
  // static wiring in index.html
  const html = require('fs').readFileSync(require('path').join(__dirname, '../web/index.html'), 'utf8');
  assert.ok(/<script src="\/boot\.js"[^>]*onerror=/.test(html), 'boot.js script tag has onerror');
  assert.ok(/try\s*\{\s*Boot\.run\(window\)/.test(html) && /catch/.test(html), 'Boot.run guarded');
  console.log('web_boot seed/keys/openPanel ok');
})().catch((err) => { console.error(err); process.exit(1); });

// service worker: registration URL carries the absolute model base; controlPage is bounded and never throws
assert.deepStrictEqual(Boot.SW_OPTIONS, { scope: '/', updateViaCache: 'none' });
assert.strictEqual(Boot.swUrl('https://huggingface.co/u/m/resolve/main/'), '/sw.js?base=' + encodeURIComponent('https://huggingface.co/u/m/resolve/main/'));
(async () => {
  const mkNav = (o) => {
    const ls = {}, reg = [];
    const sw = { controller: o.controller || null, register: (u, opt) => { reg.push([u, opt]); return o.reject ? Promise.reject(new Error('blocked')) : Promise.resolve({}); },
      addEventListener: (t, f) => { ls[t] = f; }, removeEventListener: (t, f) => { if (ls[t] === f) delete ls[t]; } };
    return { nav: o.none ? {} : { serviceWorker: sw }, sw, ls, reg };
  };
  let n = mkNav({ none: true });
  assert.strictEqual(await Boot.controlPage(n.nav, '/sw.js?base=x', 50), false, 'no SW support: false, no throw');
  n = mkNav({ controller: {} });
  assert.strictEqual(await Boot.controlPage(n.nav, '/sw.js?base=x', 50), true, 'already controlled (reload)');
  assert.deepStrictEqual(n.reg, [['/sw.js?base=x', { scope: '/', updateViaCache: 'none' }]], 'still registers (update check)');
  n = mkNav({});
  const p = Boot.controlPage(n.nav, '/sw.js?base=x', 1000);
  setTimeout(() => { n.sw.controller = {}; n.ls.controllerchange(); }, 10);
  assert.strictEqual(await p, true, 'first load: resolves on controllerchange');
  n = mkNav({});
  const t0 = Date.now();
  assert.strictEqual(await Boot.controlPage(n.nav, '/sw.js?base=x', 40), false, 'never claims: times out');
  assert.ok(Date.now() - t0 < 500);
  n = mkNav({ reject: true });
  assert.strictEqual(await Boot.controlPage(n.nav, '/sw.js?base=x', 1000), false, 'register rejected: false quickly');
  const thrower = { get serviceWorker() { throw new Error('SecurityError'); } };
  assert.strictEqual(await Boot.controlPage(thrower, '/sw.js?base=x', 40), false, 'access throws: false');
  console.log('web_boot sw ok');
})().catch((err) => { console.error(err); process.exit(1); });

// clean start: the stored ACTIVE session is dropped on every load (no resume modal, counter from 0); boxes stay.
// After "Đặt lại demo" (sessionStorage flag) every ext:/demo: key is cleared again, beating any write-back before unload.
{
  const O = 'https://d.example';
  const mk = (o) => { const m = new Map(Object.entries(o)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, m }; };
  assert.strictEqual(Boot.activeSessionKey(O), 'ext:active_session:' + O);
  let ls = mk({ ['ext:active_session:' + O]: '{"session_id":"s1","saved_boxes":2}', 'demo:annotations': '{"shapes":[{}]}', 'ext:viewOpts': '{"lang":"en"}', 'demo:tour': '{"index":2}' });
  let ss = mk({});
  assert.deepStrictEqual(Boot.cleanStart(ls, ss, O, Tour.resetKeys), ['ext:active_session:' + O]);
  assert.strictEqual(ls.getItem('ext:active_session:' + O), null);
  assert.ok(ls.getItem('demo:annotations') && ls.getItem('ext:viewOpts') && ls.getItem('demo:tour'), 'plain reload keeps boxes, settings, tour');
  ls = mk({ ['ext:active_session:' + O]: '{}', 'demo:annotations': '{"shapes":[{}]}', 'ext:viewOpts': '{}', 'other': 'x' });
  ss = mk({ [Boot.RESET_FLAG]: '1' });
  assert.deepStrictEqual(Boot.cleanStart(ls, ss, O, Tour.resetKeys).sort(), ['demo:annotations', 'ext:active_session:' + O, 'ext:viewOpts'].sort());
  assert.deepStrictEqual([...ls.m.keys()], ['other'], 'after reset: only foreign keys survive');
  assert.strictEqual(ss.getItem(Boot.RESET_FLAG), null, 'flag consumed');
  const blocked = { getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.deepStrictEqual(Boot.cleanStart(blocked, blocked, O, Tour.resetKeys), [], 'storage blocked: no throw');
  assert.deepStrictEqual(Boot.cleanStart(mk({}), null, O, Tour.resetKeys), []);
  // the reset path uses the tour's own key predicate (one definition for both reset paths)
  let asked = null;
  ls = mk({ 'ext:a': '1', 'demo:b': '2' }); ss = mk({ [Boot.RESET_FLAG]: '1' });
  Boot.cleanStart(ls, ss, O, (ks) => { asked = ks.slice(); return ['ext:a']; });
  assert.deepStrictEqual(asked.sort(), ['demo:b', 'ext:a']); assert.deepStrictEqual([...ls.m.keys()], ['demo:b']);
  console.log('web_boot cleanStart ok');
}

// welcome box ("Bắt đầu với BoxLift") is marked seen so the first screen is the camera image + the tour card
{
  const mk = (o) => { const m = new Map(Object.entries(o)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
  let ls = mk({});
  assert.strictEqual(Boot.seedWelcomeSeen(ls), true);
  assert.deepStrictEqual(JSON.parse(ls.getItem('ext:viewOpts')), { qsDone: true });
  ls = mk({ 'ext:viewOpts': '{"lang":"en","qsDone":false,"size":3}' });
  assert.strictEqual(Boot.seedWelcomeSeen(ls), true);
  assert.deepStrictEqual(JSON.parse(ls.getItem('ext:viewOpts')), { lang: 'en', qsDone: true, size: 3 }, 'other view options kept');
  assert.strictEqual(Boot.seedWelcomeSeen(ls), false, 'already seen: nothing written');
  ls = mk({ 'ext:viewOpts': '{bad' });
  assert.strictEqual(Boot.seedWelcomeSeen(ls), false, 'unreadable value left alone');
  assert.strictEqual(ls.getItem('ext:viewOpts'), '{bad');
  assert.strictEqual(Boot.seedWelcomeSeen({ getItem: () => { throw new Error('x'); } }), false);
  console.log('web_boot welcome ok');
}

// model chip follows the extension language (VI and EN, every phase) and re-renders when it changes
{
  const vi = Boot.chipView({ phase: 'loading', loaded: 1e6, total: 2e6 }, 'vi'), en = Boot.chipView({ phase: 'loading', loaded: 1e6, total: 2e6 }, 'en');
  assert.deepStrictEqual(vi, { text: 'Đang tải mô hình AI 1.0/2.0 MB', retry: 'Thử lại', cls: 'loading', showRetry: false });
  assert.deepStrictEqual(en, { text: 'Loading AI models 1.0/2.0 MB', retry: 'Retry', cls: 'loading', showRetry: false });
  assert.strictEqual(Boot.chipView({ phase: 'done' }, 'en').text, 'AI models ready');
  assert.strictEqual(Boot.chipView({ phase: 'done' }, 'vi').text, 'Đã tải xong mô hình AI');
  assert.deepStrictEqual(Boot.chipView({ phase: 'error', failed: 2 }, 'en'), { text: 'Could not load AI models (2 files)', retry: 'Retry', cls: 'error', showRetry: true });
  assert.deepStrictEqual(Boot.chipView({ phase: 'error', failed: 1 }, 'vi'), { text: 'Không tải được mô hình AI (1 tệp)', retry: 'Thử lại', cls: 'error', showRetry: true });
  assert.strictEqual(Boot.chipView({ phase: 'done' }, 'fr').text, 'Đã tải xong mô hình AI', 'unknown language: Vietnamese');
  let lang = 'vi'; const seen = [];
  const tick = Boot.langWatcher(() => lang, (l) => seen.push(l));
  tick(); assert.deepStrictEqual(seen, []);
  lang = 'en'; tick(); tick(); assert.deepStrictEqual(seen, ['en'], 'one re-render per change');
  lang = 'vi'; tick(); assert.deepStrictEqual(seen, ['en', 'vi']);
  console.log('web_boot chip lang ok');
}
