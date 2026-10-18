// node tests/web_boot.test.js — Boot.supported (pure) + helper for restoring a tour after reload.
const assert = require('assert');
const Boot = require('../web/boot.js');

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
