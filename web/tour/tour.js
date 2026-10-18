/* Spotlight tour for the web demo: pure state machine (createMachine), pure view / target / placement helpers, thin DOM mount.
   Never touches extension internals: it only reads BoxLift's open shadow root to find (and measure) the elements it points at. */
(function (root, factory) {
  const v = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = v; else root.Tour = v;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const STEPS = ['scene', 'open', 'camera', 'box', 'auto', 'track'];
  const TOTAL = STEPS.length + 1;   // + the final "free to explore" card
  // Per step: which events move the tour on (to a named step, 'done' = finished), and which only ARM it (an arm is remembered
  // until the step changes).
  //  - scene (3D screen): 'next'; opening the panel straight away skips to camera; saved boxes (also the restore after a
  //    reload) land past the draw step, on auto. Same for open and camera.
  //  - open: the panel opening ('panel-open', seen by the DOM); its "Next" button only clicks the launcher.
  //  - box: any saved box, whichever save mode (shape-created / track-created).
  //  - auto: merely pressing T must not advance (T can fail). T arms; the next saved annotation (a proposal approved with Enter) advances.
  //  - track: Shift+K arms; the next track-created advances. A plain box save in Track mode also yields track-created, so without
  //    the Shift+K arm it is ignored. In Track save mode Shift+K re-saves the box with an update: armed 'track-updated' counts too.
  const SAVED = { 'shape-created': 'auto', 'track-created': 'auto' };
  const RULES = {
    scene: { go: { next: 'open', 'panel-open': 'camera', ...SAVED } },
    open: { go: { 'panel-open': 'camera', ...SAVED } },
    camera: { go: { next: 'box', ...SAVED } },
    box: { go: SAVED },
    auto: { arm: 'auto-key', go: { next: 'track' }, armedGo: { 'shape-created': 'track', 'track-created': 'track' } },
    track: { arm: 'track-key', go: { next: 'done' }, armedGo: { 'track-created': 'done', 'track-updated': 'done' } }
  };
  const STORE_KEY = 'demo:tour';

  function sanitize(saved, n) {
    const ok = saved && typeof saved === 'object';
    const index = ok && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < n ? saved.index : 0;
    return { index, done: !!(ok && saved.done) };
  }

  function createMachine(steps, saved) {
    steps = steps || STEPS;
    const state = sanitize(saved, steps.length);
    const subs = [];
    let armed = false;
    const emit = () => subs.forEach((fn) => fn({ index: state.index, done: state.done }));
    return {
      state,
      onChange(fn) { subs.push(fn); },
      notify(ev) {
        if (ev === 'restart') { state.index = 0; state.done = false; armed = false; emit(); return; }
        if (state.done) return;
        if (ev === 'skip') { state.done = true; emit(); return; }
        const rule = RULES[steps[state.index]];
        if (!rule) return;
        if (ev === rule.arm) { armed = true; return; }
        const to = rule.go[ev] || (armed && rule.armedGo && rule.armedGo[ev]);
        if (!to) return;
        armed = false;
        if (to === 'done') state.done = true; else state.index = steps.indexOf(to);
        emit();
      }
    };
  }

  // ---- pure helpers (unit-tested) ----
  // What the overlay shows. Steps from camera on live inside BoxLift: while the panel is closed (always the case right after a
  // reload) they show the "open BoxLift" card instead (reopen), without changing the machine. Step 1 with the panel open
  // (restart from the end) points at BoxLift's close button, since the 3D screen is behind it.
  function view(state, panelOpen) {
    if (state.done) return { key: 'done', n: TOTAL, total: TOTAL, reopen: false };
    const name = STEPS[state.index];
    if (name === 'scene') return { key: panelOpen ? 'sceneBehind' : 'scene', n: 1, total: TOTAL, reopen: false };
    if (state.index > STEPS.indexOf('open') && !panelOpen) return { key: 'open', n: 2, total: TOTAL, reopen: true };
    return { key: name, n: state.index + 1, total: TOTAL, reopen: false };
  }

  const PANEL_HOST = '#lidar-cam-panel-host';
  const inPanel = (selector) => ({ shadow: PANEL_HOST, selector });
  // Elements each view points at (rects are united): a host selector, or {shadow, selector} inside BoxLift's open shadow root
  // (ids from extension/cvat.js buildUI). The draw step points at "Draw box (N)" until Draw mode is on, then at the image.
  function targetFor(key, opts) {
    switch (key) {
      case 'scene': return ['#canvas'];
      case 'sceneBehind': return [inPanel('#close')];
      case 'open': return [inPanel('#fab')];
      case 'camera': return [inPanel('#vp')];   // not + #tabs: the tab bar spans the whole window
      case 'box': return [inPanel(opts && opts.drawing ? '#vp' : '#drawBtn')];
      case 'auto': return [inPanel('#autoBtn')];
      case 'track': return [inPanel('#trackBtn')];
      case 'done': return [inPanel('#side')];
      default: return [];
    }
  }
  // The element for a spec, or null when absent, [hidden] or zero-sized (inside the hidden panel). Never throws.
  function resolveTarget(spec, doc) {
    try {
      let el = null;
      if (typeof spec === 'string') el = doc.querySelector(spec);
      else if (spec && spec.shadow) { const host = doc.querySelector(spec.shadow), sr = host && host.shadowRoot; el = sr ? sr.querySelector(spec.selector) : null; }
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? el : null;
    } catch (e) { return null; }
  }
  function unionRect(rects) {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top, right, bottom };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  // Callout position {left, top, side, arrow}: below / above / right / left of the target (first that fits in the viewport),
  // arrow = offset of the target's centre along the bubble's edge; 'inside' (lower part of the target, no arrow) for a target
  // with no room around it; 'center' without a target.
  function placeCallout(t, size, vp, gap, margin) {
    gap = gap == null ? 14 : gap; margin = margin == null ? 12 : margin;
    const w = size.width, h = size.height, maxL = vp.width - margin - w, maxT = vp.height - margin - h;
    if (!t) return { left: Math.max(0, (vp.width - w) / 2), top: Math.max(0, (vp.height - h) / 2), side: 'center', arrow: null };
    const c = { left: Math.max(0, t.left), top: Math.max(0, t.top), right: Math.min(vp.width, t.right), bottom: Math.min(vp.height, t.bottom) };
    const cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2;
    const hx = () => clamp(cx - w / 2, margin, maxL), vy = () => clamp(cy - h / 2, margin, maxT);
    const arrowX = (l) => clamp(cx - l, 16, w - 16), arrowY = (tp) => clamp(cy - tp, 16, h - 16);
    if (c.bottom + gap + h <= vp.height - margin) { const l = hx(); return { left: l, top: c.bottom + gap, side: 'below', arrow: arrowX(l) }; }
    if (c.top - gap - h >= margin) { const l = hx(); return { left: l, top: c.top - gap - h, side: 'above', arrow: arrowX(l) }; }
    if (c.right + gap + w <= vp.width - margin) { const tp = vy(); return { left: c.right + gap, top: tp, side: 'right', arrow: arrowY(tp) }; }
    if (c.left - gap - w >= margin) { const tp = vy(); return { left: c.left - gap - w, top: tp, side: 'left', arrow: arrowY(tp) }; }
    return { left: hx(), top: clamp(c.bottom - h - 24, margin, maxT), side: 'inside', arrow: null };
  }
  // Ring = target + padding, kept inside the viewport (its outline must stay visible for a full-screen target).
  function ringRect(r, vp, pad) {
    const e = pad / 2, left = Math.max(r.left - pad, e), top = Math.max(r.top - pad, e);
    const right = Math.min(r.right + pad, vp.width - e), bottom = Math.min(r.bottom + pad, vp.height - e);
    return { left, top, width: right - left, height: bottom - top };
  }

  function plainKey(e, keys) {
    if (!e || !keys.includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = (e.composedPath && e.composedPath()[0]) || e.target || {};
    const tag = String(t.tagName || '').toUpperCase();
    return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable);
  }
  const isTourKey = (e) => plainKey(e, ['t', 'T']);          // T = auto proposals
  const isTrackKey = (e) => !!(e && e.shiftKey) && plainKey(e, ['k', 'K']);   // Shift+K = track
  function annotationEvents(detail) {
    const out = [];
    if (detail && detail.action === 'delete') return out;
    if (detail && detail.action === 'update') { if (detail.tracks > 0) out.push('track-updated'); return out; }   // edits are not 'created'
    if (detail && detail.shapes > 0) out.push('shape-created');
    if (detail && detail.tracks > 0) out.push('track-created');
    return out;
  }
  const resetKeys = (keys) => keys.filter((k) => k.startsWith('ext:') || k.startsWith('demo:'));
  function pickLang(raw) {   // the extension keeps its view options (incl. lang) as JSON under chrome.storage -> localStorage['ext:viewOpts']
    try { const l = JSON.parse(raw).lang; return l === 'en' || l === 'vi' ? l : 'vi'; } catch (e) { return 'vi'; }
  }

  // ---- DOM (not unit-tested) ----
  function mount(win, machine) {
    const doc = win.document, S = root.TourStrings || (typeof require === 'function' ? require('./strings.js') : null);
    const ls = () => { try { return win.localStorage; } catch (e) { return null; } };
    const lang = () => { try { return pickLang(ls().getItem('ext:viewOpts')); } catch (e) { return 'vi'; } };
    const t = (k) => S[lang()][k];
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const btn = (label, fn, cls) => { const b = el('button', cls || '', label); b.type = 'button'; b.addEventListener('click', fn); return b; };

    // Layer = full viewport, pointer-events none: the dim (the ring's huge box-shadow) never blocks the highlighted target or
    // anything else; only the callout takes clicks.
    const layer = el('div', 'demo-tour-layer'), ring = el('div', 'demo-tour-ring'), card = el('div', 'demo-tour-card'), arrow = el('div', 'demo-tour-arrow');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
    layer.append(ring, card, arrow);
    doc.body.appendChild(layer);
    // Stacking: the BoxLift window (#lidar-cam-panel-host, appended to <html> later by the extension) uses z-index 2147483000 and
    // wins over any equal z-index earlier in the DOM. A popover is rendered in the browser's TOP LAYER, which paints above ALL
    // normal stacking contexts whatever their z-index or DOM order, so ring and callout stay above BoxLift. Browsers without the
    // Popover API fall back to the max z-index in tour.css.
    try { layer.setAttribute('popover', 'manual'); layer.showPopover(); } catch (e) { layer.removeAttribute('popover'); }
    let hidden = !!machine.state.done, creditsOpen = false, panelOpen = false, drawing = false, lastLang = lang(), lastGeom = '';

    const probe = () => {
      const panel = resolveTarget(inPanel('#panel'), doc), draw = resolveTarget(inPanel('#drawBtn'), doc);
      return { open: !!panel, drawing: !!(draw && draw.classList && draw.classList.contains('on')) };
    };
    function openBoxLift() {
      if (root.Boot && root.Boot.openPanel) { root.Boot.openPanel(win, 3000); return; }
      const fab = resolveTarget(inPanel('#fab'), doc); if (fab) fab.click();
    }
    function reset() {
      if (!win.confirm(t('resetConfirm'))) return;
      // The extension may write a key back before the page unloads; this flag makes the next boot clear everything again (Boot.cleanStart).
      try { win.sessionStorage.setItem('demo:reset', '1'); } catch (e) { /* storage blocked: the clear below still runs */ }
      const s = ls(); try { if (s) { const ks = []; for (let i = 0; i < s.length; i++) ks.push(s.key(i)); resetKeys(ks).forEach((k) => s.removeItem(k)); } } catch (e) { /* storage blocked */ }
      win.location.reload();
    }
    // Credits live inside the callout (one click on "i"), so no footer bar covers the extension window.
    function creditsBlock() {
      const box = el('div', 'credits');
      const a = el('a', '', t('repoLabel')); a.href = t('repoUrl'); a.target = '_blank'; a.rel = 'noopener';
      const n = el('a', '', t('noticeLabel')); n.href = t('noticeUrl'); n.target = '_blank'; n.rel = 'noopener';
      box.append(el('span', '', t('footer') + ' '), n, doc.createTextNode(' · '), a);
      return box;
    }
    function creditsBtn() {
      const b = btn('i ' + t('creditsToggle'), () => { creditsOpen = !creditsOpen; render(); }, 'link credits-toggle');
      b.setAttribute('aria-expanded', String(creditsOpen)); return b;
    }
    const counter = (v) => t('stepOf').replace('{n}', v.n).replace('{total}', v.total);
    function render() {
      const v = view(machine.state, panelOpen);
      card.textContent = '';
      card.classList.toggle('mini', hidden);
      if (creditsOpen) card.append(creditsBlock());
      const row = el('div', 'row');
      if (hidden) {
        if (v.key === 'done') row.append(btn(t('restartTour'), () => machine.notify('restart')), btn(t('resetDemo'), reset, 'danger'));
        else row.append(btn(counter(v), () => { hidden = false; render(); }, 'link'));
        row.append(creditsBtn());
      } else {
        card.append(el('small', '', counter(v)), el('strong', '', t(v.key + 'Title')), el('p', '', t(v.key + 'Body')));
        if (v.key === 'done') row.append(btn(t('restartTour'), () => machine.notify('restart'), 'primary'), btn(t('resetDemo'), reset, 'danger'), btn(t('hide'), () => { hidden = true; render(); }, 'link'));
        else {
          if (v.key === 'open') row.append(btn(t('next'), openBoxLift, 'primary'));
          else if (v.key !== 'box') row.append(btn(t('next'), () => machine.notify('next'), 'primary'));
          row.append(btn(t('skip'), () => machine.notify('skip')), btn(t('hide'), () => { hidden = true; render(); }, 'link'));
        }
        row.append(creditsBtn());
      }
      card.append(row);
      lastGeom = ''; place();
    }
    // Measure the target(s) and move ring + callout; cheap, and a no-op when nothing moved.
    function place() {
      const vp = { width: win.innerWidth, height: win.innerHeight };
      const v = view(machine.state, panelOpen);
      const rects = hidden ? [] : targetFor(v.key, { drawing }).map((s) => resolveTarget(s, doc)).filter(Boolean).map((e) => e.getBoundingClientRect());
      const target = unionRect(rects), size = { width: card.offsetWidth, height: card.offsetHeight };
      const geom = JSON.stringify([target, size, vp, hidden]);
      if (geom === lastGeom) return;
      lastGeom = geom;
      if (hidden) { ring.hidden = true; arrow.hidden = true; card.style.left = card.style.top = ''; card.dataset.side = 'mini'; return; }
      ring.hidden = !target;
      if (target) { const r = ringRect(target, vp, 6); Object.assign(ring.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); }
      const p = placeCallout(target, size, vp);
      card.style.left = p.left + 'px'; card.style.top = p.top + 'px'; card.dataset.side = p.side;
      arrow.hidden = p.arrow == null;
      if (p.arrow != null) {
        arrow.dataset.side = p.side;
        const ax = p.side === 'below' || p.side === 'above' ? p.left + p.arrow : p.side === 'right' ? p.left : p.left + size.width;
        const ay = p.side === 'below' ? p.top : p.side === 'above' ? p.top + size.height : p.top + p.arrow;
        arrow.style.left = ax + 'px'; arrow.style.top = ay + 'px';
      }
    }
    // Light poll (150 ms) instead of observers inside a shadow root we do not own: panel open/closed, Draw mode, language,
    // and any layout change of the target (resize, panel layout) re-place the ring.
    function tick() {
      const p = probe();
      const opened = p.open && !panelOpen;
      const changed = p.open !== panelOpen || p.drawing !== drawing;
      panelOpen = p.open; drawing = p.drawing;
      if (opened || (panelOpen && !machine.state.done && STEPS[machine.state.index] === 'open')) machine.notify('panel-open');
      const l = lang();
      if (changed || l !== lastLang) { lastLang = l; render(); } else place();
    }
    machine.onChange((s) => { hidden = false; try { ls().setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } render(); });
    win.addEventListener('demo:annotation', (e) => annotationEvents(e.detail).forEach((x) => machine.notify(x)));
    win.addEventListener('keydown', (e) => { if (isTourKey(e)) machine.notify('auto-key'); else if (isTrackKey(e)) machine.notify('track-key'); }, true);
    win.addEventListener('resize', place);
    win.setInterval(tick, 150);
    render();
    return { render, place };
  }

  function loadSaved(win) { try { return JSON.parse(win.localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function start(win) { return mount(win, createMachine(undefined, loadSaved(win))); }

  return { createMachine, view, targetFor, resolveTarget, unionRect, placeCallout, ringRect, mount, start, isTourKey, isTrackKey, annotationEvents, resetKeys, pickLang, STEPS, TOTAL };
});
