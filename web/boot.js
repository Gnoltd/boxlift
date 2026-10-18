/* Web demo bootstrap: browser gate (Boot.supported, pure), then shim + mock CVAT + extension scripts + tour. */
(function (root, factory) {
  const v = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = v; else root.Boot = v;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MIN_WIDTH = 1000, ANN_KEY = 'demo:annotations';

  // Chromium-based browsers (Chrome, Edge, Brave, Opera) carry 'Chrome/' in the UA; Firefox and Safari do not (or add 'Firefox/').
  function supported(ua, width) {
    ua = String(ua || '');
    if (!/Chrome\//.test(ua) || /Firefox\//.test(ua)) return { ok: false, reason: 'browser' };
    if (!(width >= MIN_WIDTH)) return { ok: false, reason: 'width' };
    return { ok: true };
  }

  // Detail for a synthetic demo:annotation event after reload, or null when nothing was saved.
  function restoreDetail(raw) {
    let a; try { a = raw && JSON.parse(raw); } catch (e) { return null; }
    const shapes = a && Array.isArray(a.shapes) ? a.shapes.length : 0, tracks = a && Array.isArray(a.tracks) ? a.tracks.length : 0;
    return shapes || tracks ? { action: 'restore', shapes, tracks } : null;
  }

  // cvat.js does new URL(chrome.runtime.getURL('')).origin, so the bases handed to the shim must be absolute.
  function absBase(base, origin) { return new URL(String(base), origin).href; }

  // First-run storage the extension would otherwise ask the visitor for. Keys live under the shim prefix 'ext:'; existing values win.
  // origins: detector.js accepts only listed origins; saveMode: demo starts in Shape (cvat.js defaults to track); labelMap: identity, confirmed.
  function seedEntries(origin, manifest) {
    const map = {};
    for (const l of manifest.labels) map[l.name] = l.id;
    return {
      origins: [origin],
      [`saveMode:${origin}:${manifest.task.id}`]: 'shape',
      [`labelMap:${origin}:t${manifest.task.id}`]: { map, confirmed: true, at: 0 }
    };
  }
  function seedStorage(ls, origin, manifest, prefix) {
    prefix = prefix || 'ext:';
    const e = seedEntries(origin, manifest), written = [];
    for (const k of Object.keys(e)) {
      try { if (ls.getItem(prefix + k) == null) { ls.setItem(prefix + k, JSON.stringify(e[k])); written.push(k); } } catch (err) { /* storage blocked */ }
    }
    return written;
  }

  // D / F are CVAT's own previous / next frame shortcuts; the fake host page has to provide them.
  function frameKeyAction(ev) {
    const t = ev && ev.target;
    if (!ev || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return null;
    const k = String(ev.key || '').toLowerCase();
    return k === 'd' ? 'previous' : k === 'f' ? 'next' : null;
  }
  // The extension window stops key events at its panel, so a bubble listener on window never sees them. Listen in the
  // capture phase and decide after dispatch (a timeout later), once the extension has had its chance to preventDefault.
  function wireFrameKeys(win) {
    win.addEventListener('keydown', (e) => {
      const snap = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, target: e.composedPath()[0] };
      win.setTimeout(() => {
        const a = frameKeyAction({ ...snap, defaultPrevented: e.defaultPrevented });
        const b = a && win.document.querySelector('.cvat-player-' + a + '-button');
        if (b) b.click();
      }, 0);
    }, true);
  }

  // Poll fn until it returns a truthy value or timeoutMs passes; resolves with the value or null (never rejects).
  function waitFor(fn, timeoutMs, intervalMs) {
    intervalMs = intervalMs || 50;
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        let v = null; try { v = fn(); } catch (e) { /* not ready */ }
        if (v) resolve(v);
        else if (Date.now() - t0 >= timeoutMs) resolve(null);
        else setTimeout(poll, intervalMs);
      })();
    });
  }
  // Open the BoxLift panel by clicking its launcher in the shadow root; warns (no throw) when it never shows up.
  async function openPanel(win, timeoutMs) {
    const fab = await waitFor(() => {
      const host = win.document.getElementById('lidar-cam-panel-host');
      return host && host.shadowRoot && host.shadowRoot.getElementById('fab');
    }, timeoutMs || 10000);
    if (!fab) { win.console.warn('BoxLift: launcher #fab not found, panel not opened automatically'); return false; }
    fab.click();
    return true;
  }

  // Service Worker (web/sw.js) caches the models under their stable URL; the model base rides on the registration URL.
  const swUrl = (modelBase) => '/sw.js?base=' + encodeURIComponent(modelBase);
  // Register and wait (bounded) until the SW controls this page, so the prefetch and the detector iframe go through it.
  // Resolves false (never rejects) without SW support, when registration fails or times out: the demo then works uncached.
  function controlPage(nav, url, timeoutMs) {
    return new Promise((resolve) => {
      let sw;
      try { sw = nav && nav.serviceWorker; } catch (e) { sw = null; }
      if (!sw || typeof sw.register !== 'function') { resolve(false); return; }
      let t = null;
      const end = (v) => { if (t !== null) clearTimeout(t); try { sw.removeEventListener('controllerchange', onChange); } catch (e) { /* ignore */ } resolve(v); };
      const onChange = () => end(true);
      try { sw.register(url, { scope: '/' }).catch(() => end(false)); } catch (e) { end(false); return; }
      if (sw.controller) { end(true); return; }
      sw.addEventListener('controllerchange', onChange);
      t = setTimeout(() => end(!!sw.controller), timeoutMs || 3000);
    });
  }

  const CHIP = {
    vi: { loading: 'Đang tải mô hình AI {a}/{b} MB', done: 'Đã tải xong mô hình AI', error: 'Không tải được mô hình AI ({n} tệp)', retry: 'Thử lại' },
    en: { loading: 'Loading AI models {a}/{b} MB', done: 'AI models ready', error: 'Could not load AI models ({n} files)', retry: 'Retry' }
  };
  function chipLang(raw) { try { return JSON.parse(raw).lang === 'en' ? 'en' : 'vi'; } catch (e) { return 'vi'; } }
  // state: {phase:'loading'|'done'|'error', loaded, total (bytes), failed (count)} -> label text
  function chipText(st, lang) {
    const t = CHIP[lang] || CHIP.vi, mb = (n) => (n / 1e6).toFixed(1);
    if (st.phase === 'done') return t.done;
    if (st.phase === 'error') return t.error.replace('{n}', st.failed);
    return t.loading.replace('{a}', mb(st.loaded)).replace('{b}', mb(st.total));
  }
  // Non-blocking chip; prefetch starts after the extension scripts so it never delays first paint of the canvas.
  async function startModels(win, modelBase) {
    const doc = win.document, ML = win.ModelLoader;
    const chip = doc.createElement('div'); chip.id = 'model-chip';
    // Top layer (Popover API) for the same reason as the tour card: BoxLift's backdrop and the Tay/Tool chip paint over any z-index.
    try { chip.setAttribute('popover', 'manual'); } catch (e) { /* fallback: z-index in index.html */ }
    const label = doc.createElement('span'), btn = doc.createElement('button');
    btn.type = 'button'; btn.hidden = true; chip.append(label, btn); doc.body.appendChild(chip);
    try { chip.showPopover(); } catch (e) { chip.removeAttribute('popover'); }
    const lang = () => { try { return chipLang(win.localStorage.getItem('ext:viewOpts')); } catch (e) { return 'vi'; } };
    let st = { phase: 'loading', loaded: 0, total: 0, failed: 0 };
    const render = () => {
      label.textContent = chipText(st, lang()); chip.className = st.phase;
      btn.hidden = st.phase !== 'error'; btn.textContent = CHIP[lang()].retry;
    };
    let failed = [];
    const finish = (r) => {
      failed = r.failed; st = { phase: r.ok ? 'done' : 'error', loaded: st.loaded, total: st.total, failed: failed.length }; render();
      if (r.ok) win.setTimeout(() => chip.remove(), 4000);
    };
    const onProgress = (e) => { st = { phase: 'loading', loaded: e.loaded, total: e.total, failed: 0 }; render(); };
    btn.addEventListener('click', () => {
      st = { phase: 'loading', loaded: 0, total: 0, failed: 0 }; render();
      ML.retry(failed, onProgress).then(finish).catch(() => { st = { phase: 'error', loaded: st.loaded, total: st.total, failed: failed.length }; render(); });
    });
    render();
    const gpu = await ML.hasGpu(win.navigator);
    finish(await ML.prefetch(ML.urlsFor(modelBase, gpu), onProgress));
  }

  function show(doc, html) {
    let box = doc.getElementById('boot-msg');
    if (!box) { box = doc.createElement('div'); box.id = 'boot-msg'; doc.body.appendChild(box); }
    box.innerHTML = html;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fail = (doc, url, why) => show(doc, `<b>Không tải được / Failed to load</b><br><code>${esc(url)}</code><br>${esc(why || '')}`);

  // Until boot finishes, a runtime exception in an extension script shows the banner instead of a silent blank page. Returns dispose().
  function guardBoot(win) {
    const h = (ev) => fail(win.document, ev.filename || '', ev.message || 'error');
    win.addEventListener('error', h);
    return () => win.removeEventListener('error', h);
  }

  function loadScript(doc, src) {
    return new Promise((resolve, reject) => {
      const s = doc.createElement('script'); s.src = src; s.async = false;
      s.onload = resolve; s.onerror = () => reject(Object.assign(new Error('script error'), { url: src }));
      doc.head.appendChild(s);
    });
  }
  function loadCss(doc, href) {
    const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = href; doc.head.appendChild(l);
  }
  async function getJson(url) {
    let r;
    try { r = await fetch(url); } catch (e) { throw Object.assign(e, { url }); }
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { url });
    try { return await r.json(); } catch (e) { throw Object.assign(e, { url }); }
  }

  function wireFrameControls(doc, last) {
    const input = doc.querySelector('.cvat-player-frame-selector input');
    input.min = 0; input.max = last;
    const go = (n) => {
      input.value = Math.max(0, Math.min(last, n));
      history.replaceState(null, '', '?frame=' + input.value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('change', () => history.replaceState(null, '', '?frame=' + input.value));
    doc.querySelector('.cvat-player-next-button').addEventListener('click', () => go(+input.value + 1));
    doc.querySelector('.cvat-player-previous-button').addEventListener('click', () => go(+input.value - 1));
  }

  async function run(win) {
    const doc = win.document;
    const sup = supported(win.navigator.userAgent, win.innerWidth);
    if (!sup.ok) {
      show(doc, '<b>Cần Chrome trên máy tính</b><br>Desktop Chrome (or another Chromium browser, window width ≥ 1000 px) is required.' +
        (sup.reason === 'width' ? '<br>Hãy mở rộng cửa sổ / widen the window.' : ''));
      return;
    }
    let url = '', dispose = () => {};
    try {
      dispose = guardBoot(win);
      url = '/demo-data/demo-manifest.json'; const manifest = await getJson(url);
      url = '/build-info.json'; const info = await getJson(url);
      const origin = win.location.origin, modelBase = absBase(info.modelBase, origin);
      const swReady = controlPage(win.navigator, swUrl(modelBase), 3000);
      wireFrameControls(doc, manifest.frames.length - 1);
      for (const s of ['/shim/chrome-shim.js', '/shim/mock-cvat.js', '/shim/model-loader.js', '/tour/strings.js', '/tour/tour.js']) { url = s; await loadScript(doc, s); }
      loadCss(doc, '/tour/tour.css');
      seedStorage(win.localStorage, origin, manifest);
      wireFrameKeys(win);
      win.ChromeShim.install(win, { extBase: absBase('/ext/', origin), modelBase });
      const mock = win.MockCvat.create({
        manifest, storage: win.localStorage,
        fetchBin: async (p) => { const u = '/' + String(p).replace(/^\//, ''); const r = await fetch(u); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { url: u }); return r.arrayBuffer(); }
      });
      win.MockCvat.install(win, mock);
      await swReady;   // before cvat.js creates the detector iframe and before the prefetch
      for (const s of info.scripts) { url = '/ext/' + s; await loadScript(doc, url); }
      win.Tour.start(win);
      dispose();
      openPanel(win);
      startModels(win, modelBase).catch(() => { /* chip is best-effort; the extension reports a missing model itself */ });
      let raw = null; try { raw = win.localStorage.getItem(ANN_KEY); } catch (e) { /* storage blocked */ }
      const d = restoreDetail(raw);
      if (d) win.dispatchEvent(new win.CustomEvent('demo:annotation', { detail: d }));
    } catch (e) { dispose(); fail(doc, e.url || url, e.message); }
  }

  return { supported, restoreDetail, absBase, seedEntries, seedStorage, frameKeyAction, wireFrameKeys, waitFor, openPanel, guardBoot, chipText, chipLang, swUrl, controlPage, run, MIN_WIDTH };
});
