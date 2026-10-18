/*
 * Small floating comparison on the CVAT 3D page (also with the panel closed): Làm tay vs 2D track + tool.
 * Nothing to press. While the annotator works on the 3D data in CVAT itself (pointer / wheel / key on the 3D views or the
 * object list, panel closed) the manual clock runs; objects CVAT gains meanwhile (bridge.js `count`) are manual objects.
 * It goes into the session (SessionManager.addManual): at once when one is open, otherwise kept per job until the tool opens one.
 * Tool = the extension (labelling 2D): its clock runs from the moment the panel opens (not only while a model runs or a box is saved)
 * and stops after PANEL_GRACE_SEC without a click / key in the panel; objects = boxes saved through the extension.
 */
(function (root) {
  'use strict';
  const CT = root.CompareTimer;
  const CSS = `
  :host { all: initial; }
  .bar { position: fixed; left: 12px; bottom: 12px; z-index: 2147483000; display: flex; align-items: stretch; gap: 1px; border-radius: 10px; overflow: hidden;
    font: 12px/1.3 system-ui, sans-serif; background: #2b303a; color: #e6e8ee; box-shadow: 0 2px 10px rgba(0,0,0,.35); user-select: none; }
  .seg, button { padding: 6px 10px; background: #1b1f27; color: inherit; white-space: nowrap; }
  button { all: unset; cursor: pointer; padding: 6px 8px; background: #1b1f27; color: #9aa3b2; }
  button:hover { background: #262b36; color: #e6e8ee; }
  button:focus-visible { outline: 2px solid #4c8dff; outline-offset: -2px; }
  .seg.live { background: #17653a; }
  .num { font-variant-numeric: tabular-nums; font-weight: 600; }
  .sub { color: #9aa3b2; margin-left: 4px; }
  .live .sub { color: #bfe8cf; }
  .res { padding: 6px 10px; background: #1b1f27; font-weight: 600; color: #30d158; }
  @media (prefers-color-scheme: light) { .bar { background: #d9dde5; color: #1b1f27; } .seg, button, .res { background: #f4f6fa; } button:hover { background: #e6e9f0; color: #1b1f27; } }`;
  const WORK = '[class*="canvas3d"], .cvat-objects-sidebar';       // the 3D views and the object list of CVAT

  function mount({ ask, getJob, getSession, getFrame = () => null, saveSession, isBusy, getDeviceId = async () => '', getRecords = () => [], toast = () => {} }) {
    const SM = root.SessionManager;
    const host = document.createElement('div');
    host.id = 'lidar-cam-compare-host';
    document.documentElement.appendChild(host);
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `<style>${CSS}</style><div class="bar" id="bar" hidden>
      <span class="seg" id="tay" title="Làm tay trong CVAT (kèm box tay vẽ qua extension): thời gian tự tính khi bạn thao tác trên dữ liệu 3D"></span>
      <span class="seg" id="tool" title="2D track + tool của phiên hiện tại"></span>
      <span class="res" id="res" hidden></span>
      <button id="md" title="Tải báo cáo thời gian (Markdown) của job này để gửi lại">MD</button></div>`;
    const $ = (id) => sh.getElementById(id);
    let s = CT.create(), p = CT.create(), wasOpen = false, jobId = null, n = 0, saving = null, lastDrain = 0;
    const key = () => `compare:${location.origin}:${jobId}`;
    const store = chrome.storage.local;

    const inPanel = (e) => e.composedPath().some((x) => x.id === 'lidar-cam-panel-host');
    const onAction = (e) => {
      if (inPanel(e)) { if (e.type !== 'pointermove' || e.buttons) CT.activity(p, Date.now(), CT.PANEL_GRACE_SEC); return; }
      if (e.composedPath().includes(host)) return;
      if (e.type === 'pointermove' && !e.buttons) return;                                  // hovering is not working on the data
      if (e.type === 'keydown') { const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; }
      else if (!(e.target.closest && e.target.closest(WORK))) return;
      CT.activity(s, Date.now());
    };
    for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown']) document.addEventListener(t, onAction, { capture: true, passive: true });

    async function load(id) {
      jobId = id; s = CT.create();
      try { const v = (await store.get(key()))[key()]; if (v) { s.sec = +v.sec || 0; s.count = +v.count || 0; } } catch (e) { /* start empty */ }
    }
    // After the extension is reloaded this page's old script has no extension any more: chrome.storage throws instead of returning a promise
    const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
    const save = () => {
      clearTimeout(saving);
      saving = setTimeout(() => { try { if (alive()) store.set({ [key()]: { sec: s.sec, count: s.count } }).catch(() => {}); } catch (e) { /* page needs a reload */ } }, 300);
    };
    async function total() {
      try { const v = await ask('count', { jobId }, 4000); return Number.isFinite(v) ? v : null; } catch (e) { return null; }
    }
    /** Measured time and objects go into the open session (once every few seconds, a session write is a storage write). */
    function flush(now, force = false) {
      const session = getSession();
      if (!session || !SM || !SM.addManual || (!force && now - lastDrain < 5000)) return;
      lastDrain = now;
      const d = CT.drain(s), pd = CT.drain(p);
      if (d.sec > 0 || d.count > 0 || pd.sec > 0) { const fr = getFrame(); SM.addManual(session, d.sec, d.count, fr); SM.addPanel(session, pd.sec, fr); saveSession(session); save(); }
    }
    const figures = () => {
      const a = getSession() || {};
      return { manual: { sec: (a.manual_time_seconds || 0) + s.sec, count: (a.manual_count || 0) + s.count },
        tool: { sec: (a.panel_seconds || 0) + p.sec, count: a.saved_boxes || 0 }, session: !!a.session_id };
    };
    function render(now) {
      root.CompareChip.pendingPanelSec = p.sec;                       // not yet written to the session: the top chip adds it
      const f = figures(), r = CT.summary(f.manual, f.tool), live = now < s.activeUntil;
      const part = (el, name, v, per, on) => {
        el.className = 'seg' + (on ? ' live' : '');
        el.innerHTML = `${name} <span class="num">${CT.mmss(v.sec)}</span><span class="sub">· ${v.count} obj${per != null ? ` · ${per.toFixed(0)}s/obj` : ''}</span>`;
      };
      part($('tay'), 'Tay', f.manual, r.tay, live);
      part($('tool'), 'Tool', f.tool, r.tool, now < p.activeUntil && wasOpen);
      $('res').hidden = !r.speedup;
      if (r.speedup) $('res').textContent = `${r.speedup.toFixed(1)}×`;
    }
    $('md').onclick = async () => {
      const job = getJob(), f = figures(), a = getSession();
      if (!job) return;
      flush(Date.now(), true);
      let dev = ''; try { dev = await getDeviceId(); } catch (e) { /* report without it */ }
      const text = CT.toReport({ task: job.taskName, jobId: job.id, deviceId: dev, sessionId: a && a.session_id, manual: f.manual, tool: f.tool, session: a,
        records: a ? getRecords(a.session_id) : [] });
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `bao-cao-job${job.id}-${(dev || 'device').slice(0, 8)}.md` });
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Đã tải báo cáo thời gian (.md)');
    };

    const timer = setInterval(async () => {
      if (!alive()) { clearInterval(timer); host.remove(); return; }          // old copy of the script: the reloaded extension runs its own
      try { await step(); } catch (e) { console.warn('[lidar-cam] compare:', e.message); }
    }, 1000);
    async function step() {
      const job = getJob(), now = Date.now();
      $('bar').hidden = !job;
      if (!job) return;
      if (job.id !== jobId) { flush(now, true); await load(job.id); }
      const busy = isBusy();                                                              // tool open / saving: not manual
      const t = ++n % 3 === 0 || s.lastCount == null ? await total() : null;              // CVAT is asked every 3 s, the clock redraws every second
      CT.tick(s, now, t, { working: !busy.panel, counting: !busy.tool });
      if (busy.panel && !wasOpen) CT.activity(p, now, CT.PANEL_GRACE_SEC);          // opening the panel starts the tool clock at once
      wasOpen = busy.panel;
      CT.tick(p, now, null, { working: busy.panel && !busy.paused });
      flush(now);
      render(now);
      if (s.sec || s.count) save();
    }
    window.addEventListener('pagehide', () => { try { if (alive()) flush(Date.now(), true); } catch (e) { /* page is going away */ } });
  }

  root.CompareChip = { mount, pendingPanelSec: 0 };
})(typeof self !== 'undefined' ? self : this);
