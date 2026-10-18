/* Guided tour for the web demo: pure state machine (createMachine) + thin DOM mount. Never touches extension internals. */
(function (root, factory) {
  const v = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = v; else root.Tour = v;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const STEPS = ['lidar', 'box', 'auto', 'track'];
  // Per step: which events move the tour on, and which only ARM it (an arm is remembered until the step changes).
  //  - lidar: 'next', or a saved box (visitor already drew one) which jumps straight to the auto step (-> index 2).
  //  - box: any saved box, whichever save mode (shape-created / track-created).
  //  - auto: merely pressing T must not advance (T can fail). T arms; the next saved annotation (a proposal approved with Enter) advances.
  //  - track: Shift+K arms; the next track-created advances. A plain box save in Track mode also yields track-created, so without
  //    the Shift+K arm it is ignored (shape-created never finishes this step). In Track save mode the box is already a track, so
  //    Shift+K re-saves it with an update (observed live: "track 1 thay doi"): armed 'track-updated' counts as well.
  const SAVED = ['shape-created', 'track-created'];
  const RULES = {
    lidar: { go: { next: 1, 'shape-created': 2, 'track-created': 2 } },
    box: { go: { 'shape-created': 1, 'track-created': 1 } },
    auto: { arm: 'auto-key', go: { next: 1 }, armedGo: { 'shape-created': 1, 'track-created': 1 } },
    track: { arm: 'track-key', go: { next: 1 }, armedGo: { 'track-created': 1, 'track-updated': 1 } }
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
        const jump = rule.go[ev] != null ? rule.go[ev] : (armed && rule.armedGo && rule.armedGo[ev]);
        if (!jump) return;
        armed = false;
        state.index += jump;
        if (state.index >= steps.length) { state.index = steps.length - 1; state.done = true; }
        emit();
      }
    };
  }

  // ---- pure helpers (unit-tested) ----
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

    const layer = el('div', 'demo-tour-layer'), card = el('div', 'demo-tour-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
    layer.append(card);
    doc.body.appendChild(layer);
    // Stacking: the BoxLift window (#lidar-cam-panel-host, appended to <body> later by the extension) uses z-index 2147483000 and wins
    // over any equal z-index that comes earlier in the DOM. A popover is rendered in the browser's TOP LAYER, which paints above ALL
    // normal stacking contexts whatever their z-index or DOM order, so the card stays visible and clickable above BoxLift without
    // depending on append order. Browsers without the Popover API fall back to the max z-index in tour.css.
    try { layer.setAttribute('popover', 'manual'); layer.showPopover(); } catch (e) { layer.removeAttribute('popover'); }
    let hidden = false, creditsOpen = false;

    function reset() {
      if (!win.confirm(t('resetConfirm'))) return;
      const s = ls(); try { if (s) { const ks = []; for (let i = 0; i < s.length; i++) ks.push(s.key(i)); resetKeys(ks).forEach((k) => s.removeItem(k)); } } catch (e) { /* storage blocked */ }
      win.location.reload();
    }
    // Credits live inside the card (one click on "i"), so nothing of the extension window is covered by a footer bar.
    function creditsBlock() {
      const box = el('div', 'credits');
      const a = el('a', '', t('repoLabel')); a.href = t('repoUrl'); a.target = '_blank'; a.rel = 'noopener';
      box.append(el('span', '', t('footer') + ' '), a);
      return box;
    }
    function creditsBtn() {
      const b = btn('i ' + t('creditsToggle'), () => { creditsOpen = !creditsOpen; render(); }, 'link credits-toggle');
      b.setAttribute('aria-expanded', String(creditsOpen)); return b;
    }
    function render() {
      const st = machine.state;
      card.textContent = '';
      card.classList.toggle('mini', st.done || hidden);
      if (creditsOpen) card.append(creditsBlock());
      if (hidden && !st.done) {
        const row = el('div', 'row');
        row.append(btn(S[lang()].stepOf.replace('{n}', st.index + 1).replace('{total}', STEPS.length), () => { hidden = false; render(); }, 'link'), creditsBtn());
        card.append(row);
      } else if (st.done) {
        card.append(el('strong', '', t('doneTitle')), el('p', '', t('doneBody')));
        const row = el('div', 'row');
        row.append(btn(t('restartTour'), () => machine.notify('restart')), btn(t('resetDemo'), reset, 'danger'), creditsBtn());
        card.append(row);
      } else {
        const k = 'step' + st.index;
        card.append(el('small', '', t('stepOf').replace('{n}', st.index + 1).replace('{total}', STEPS.length)), el('strong', '', t(k + 'Title')), el('p', '', t(k + 'Body')));
        const row = el('div', 'row');
        if (st.index !== 1) row.append(btn(t('next'), () => machine.notify('next'), 'primary'));
        row.append(btn(t('skip'), () => machine.notify('skip')), btn(t('hide'), () => { hidden = true; render(); }, 'link'), creditsBtn());
        card.append(row);
      }
    }
    machine.onChange((s) => { hidden = false; try { ls().setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } render(); });
    win.addEventListener('demo:annotation', (e) => annotationEvents(e.detail).forEach((x) => machine.notify(x)));
    win.addEventListener('keydown', (e) => { if (isTourKey(e)) machine.notify('auto-key'); else if (isTrackKey(e)) machine.notify('track-key'); }, true);
    let lastLang = lang();
    // Poll: the extension's language switch is a same-window localStorage write (no 'storage' event fires for those).
    win.setInterval(() => { const l = lang(); if (l !== lastLang) { lastLang = l; render(); } }, 1000);
    render();
    return { render };
  }

  function loadSaved(win) { try { return JSON.parse(win.localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function start(win) { return mount(win, createMachine(undefined, loadSaved(win))); }

  return { createMachine, mount, start, isTourKey, isTrackKey, annotationEvents, resetKeys, pickLang, STEPS };
});
