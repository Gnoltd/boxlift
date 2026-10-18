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
    const label = doc.createElement('span'), btn = doc.createElement('button');
    btn.type = 'button'; btn.hidden = true; chip.append(label, btn); doc.body.appendChild(chip);
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
      ML.retry(failed, onProgress).then(finish);
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
    let url = '';
    try {
      url = '/demo-data/demo-manifest.json'; const manifest = await getJson(url);
      url = '/build-info.json'; const info = await getJson(url);
      wireFrameControls(doc, manifest.frames.length - 1);
      for (const s of ['/shim/chrome-shim.js', '/shim/mock-cvat.js', '/shim/model-loader.js', '/tour/strings.js', '/tour/tour.js']) { url = s; await loadScript(doc, s); }
      loadCss(doc, '/tour/tour.css');
      win.ChromeShim.install(win, { extBase: '/ext/', modelBase: info.modelBase });
      const mock = win.MockCvat.create({
        manifest, storage: win.localStorage,
        fetchBin: async (p) => { const u = '/' + String(p).replace(/^\//, ''); const r = await fetch(u); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { url: u }); return r.arrayBuffer(); }
      });
      win.MockCvat.install(win, mock);
      for (const s of info.scripts) { url = '/ext/' + s; await loadScript(doc, url); }
      win.Tour.start(win);
      startModels(win, info.modelBase).catch(() => { /* chip is best-effort; the extension reports a missing model itself */ });
      let raw = null; try { raw = win.localStorage.getItem(ANN_KEY); } catch (e) { /* storage blocked */ }
      const d = restoreDetail(raw);
      if (d) win.dispatchEvent(new win.CustomEvent('demo:annotation', { detail: d }));
    } catch (e) { fail(doc, e.url || url, e.message); }
  }

  return { supported, restoreDetail, chipText, chipLang, run, MIN_WIDTH };
});
