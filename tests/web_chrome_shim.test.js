// node tests/web_chrome_shim.test.js — chrome.runtime / chrome.storage stand-ins for the static web demo.
const assert = require('assert');
const ChromeShim = require('../web/shim/chrome-shim.js');

const mem = () => { const m = new Map(); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i], get length() { return m.size; } }; };
const calls = [];
const win = { localStorage: mem(), fetch: async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ u }) }; } };
const chrome = ChromeShim.install(win, { extBase: 'https://x.example/extension/', modelBase: 'https://m.example/' });

(async () => {
  assert.strictEqual(win.chrome, chrome);
  assert.strictEqual(chrome.runtime.getURL('models/mtrans.onnx'), 'https://m.example/mtrans.onnx');
  assert.strictEqual(chrome.runtime.getURL('ort/'), 'https://x.example/extension/ort/');
  assert.strictEqual(chrome.runtime.getURL(''), 'https://x.example/extension/');

  await chrome.storage.local.set({ a: { x: 1 }, b: 2 });
  assert.deepStrictEqual(await chrome.storage.local.get('a'), { a: { x: 1 } });
  assert.strictEqual(win.localStorage.getItem('ext:a'), '{"x":1}');
  win.localStorage.setItem('other', '1');
  assert.deepStrictEqual(await chrome.storage.local.get(null), { a: { x: 1 }, b: 2 });
  assert.deepStrictEqual(await chrome.storage.local.get(['a', 'zz']), { a: { x: 1 } });
  await chrome.storage.local.remove(['a']);
  assert.deepStrictEqual(await chrome.storage.local.get(null), { b: 2 });

  const seen = [];
  chrome.storage.onChanged.addListener((ch, area) => seen.push([ch, area]));
  await chrome.storage.local.set({ b: 3 });
  assert.deepStrictEqual(seen[0], [{ b: { oldValue: 2, newValue: 3 } }, 'local']);

  const r = await chrome.runtime.sendMessage({ type: 'getDbConfig' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual((await chrome.runtime.sendMessage({ type: 'nope' })).ok, false);
  assert.strictEqual((await chrome.runtime.sendMessage({ type: 'getCalib', id: '../x' })).ok, false);
  const c = await chrome.runtime.sendMessage({ type: 'getCalib', id: 'nuscenes-scene-0061' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(calls.pop(), 'https://x.example/extension/calibs/nuscenes-scene-0061.json');
  await chrome.runtime.sendMessage({ type: 'listCalibs' });
  assert.strictEqual(calls.pop(), 'https://x.example/extension/calibs/index.json');
  console.log('web_chrome_shim: ok');
})().catch((e) => { console.error(e); process.exit(1); });
