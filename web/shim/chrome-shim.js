// chrome.runtime / chrome.storage stand-ins so the extension code runs unmodified on a static page (web demo).
// Ported from the STUB in tools/dev/mock_cvat.py; messages follow extension/background.js.
(function (root) {
  'use strict';

  function install(win, opts) {
    const extBase = opts.extBase, modelBase = opts.modelBase, prefix = opts.prefix || 'ext:';
    const ls = win.localStorage;
    const listeners = [];
    const read = (k) => { const v = ls.getItem(prefix + k); return v == null ? undefined : JSON.parse(v); };
    const keysOf = () => { const o = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix)) o.push(k.slice(prefix.length)); } return o; };

    const storage = { local: {
      async get(k) {
        const o = {};
        const ks = k === null || k === undefined ? keysOf() : [].concat(k);
        for (const key of ks) { const v = read(key); if (v !== undefined) o[key] = v; }
        return o;
      },
      async set(o) {
        const ch = {};
        for (const k in o) { ch[k] = { oldValue: read(k), newValue: o[k] }; ls.setItem(prefix + k, JSON.stringify(o[k])); }
        listeners.slice().forEach((fn) => fn(ch, 'local'));
      },
      async remove(ks) {
        const ch = {};
        for (const k of [].concat(ks)) { ch[k] = { oldValue: read(k) }; ls.removeItem(prefix + k); }
        listeners.slice().forEach((fn) => fn(ch, 'local'));
      } },
      onChanged: { addListener: (fn) => { listeners.push(fn); } } };

    const getURL = (p) => (p.startsWith('models/') && p.endsWith('.onnx') ? modelBase + p.slice(7) : extBase + p);
    async function sendMessage(m) {
      let f = null;
      if (m && m.type === 'listCalibs') f = 'calibs/index.json';
      else if (m && m.type === 'getCalib' && /^[\w.-]+$/.test(String(m.id || ''))) f = `calibs/${m.id}.json`;
      if (!f) return { ok: false, error: `unsupported message: ${m && m.type}` };
      try {
        const r = await win.fetch(extBase + f);
        return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `${f}: ${r.status}` };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    const chrome = { runtime: { id: 'boxlift-web-demo', getURL, sendMessage }, storage };
    win.chrome = chrome;
    return chrome;
  }

  const api = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ChromeShim = api;
})(typeof self !== 'undefined' ? self : this);
