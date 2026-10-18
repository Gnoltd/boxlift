/* Guided tour for the web demo: pure state machine (createMachine) + thin DOM mount. Never touches extension internals. */
(function (root, factory) {
  const v = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = v; else root.Tour = v;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const STEPS = ['lidar', 'box', 'auto', 'track'];
  const ADVANCE = { lidar: ['next'], box: ['shape-created'], auto: ['auto-key', 'next'], track: ['track-created', 'next'] };
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
    const emit = () => subs.forEach((fn) => fn({ index: state.index, done: state.done }));
    return {
      state,
      onChange(fn) { subs.push(fn); },
      notify(ev) {
        if (ev === 'restart') { state.index = 0; state.done = false; emit(); return; }
        if (state.done) return;
        if (ev === 'skip') { state.done = true; emit(); return; }
        if (!(ADVANCE[steps[state.index]] || []).includes(ev)) return;
        if (state.index >= steps.length - 1) state.done = true; else state.index++;
        emit();
      }
    };
  }

  // ---- pure helpers (unit-tested) ----
  function isTourKey(e) {
    if (!e || (e.key !== 't' && e.key !== 'T') || e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = (e.composedPath && e.composedPath()[0]) || e.target || {};
    const tag = String(t.tagName || '').toUpperCase();
    return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable);
  }
  function annotationEvents(detail) {
    const out = [];
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

    const layer = el('div', 'demo-tour-layer'), card = el('div', 'demo-tour-card'), foot = el('div', 'demo-tour-foot');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
    layer.append(card, foot);
    doc.body.appendChild(layer);
    let hidden = false;

    function reset() {
      if (!win.confirm(t('resetConfirm'))) return;
      const s = ls(); try { if (s) { const ks = []; for (let i = 0; i < s.length; i++) ks.push(s.key(i)); resetKeys(ks).forEach((k) => s.removeItem(k)); } } catch (e) { /* storage blocked */ }
      win.location.reload();
    }
    function render() {
      const st = machine.state;
      card.textContent = '';
      card.classList.toggle('mini', st.done || hidden);
      if (hidden && !st.done) { card.append(btn(S[lang()].stepOf.replace('{n}', st.index + 1).replace('{total}', STEPS.length), () => { hidden = false; render(); }, 'link')); }
      else if (st.done) {
        card.append(el('strong', '', t('doneTitle')), el('p', '', t('doneBody')));
        card.append(el('div', 'row', null));
        card.lastChild.append(btn(t('restartTour'), () => machine.notify('restart')), btn(t('resetDemo'), reset, 'danger'));
      } else {
        const k = 'step' + st.index;
        card.append(el('small', '', t('stepOf').replace('{n}', st.index + 1).replace('{total}', STEPS.length)), el('strong', '', t(k + 'Title')), el('p', '', t(k + 'Body')));
        const row = el('div', 'row');
        if (st.index !== 1) row.append(btn(t('next'), () => machine.notify('next'), 'primary'));
        row.append(btn(t('skip'), () => machine.notify('skip')), btn(t('hide'), () => { hidden = true; render(); }, 'link'));
        card.append(row);
      }
      foot.textContent = '';
      const a = el('a', '', t('repoLabel')); a.href = t('repoUrl'); a.target = '_blank'; a.rel = 'noopener';
      foot.append(el('span', '', t('footer') + ' '), a);
    }
    machine.onChange((s) => { hidden = false; try { ls().setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } render(); });
    win.addEventListener('demo:annotation', (e) => annotationEvents(e.detail).forEach((x) => machine.notify(x)));
    win.addEventListener('keydown', (e) => { if (isTourKey(e)) machine.notify('auto-key'); }, true);
    win.addEventListener('storage', (e) => { if (e.key === 'ext:viewOpts') render(); });
    win.setInterval(() => { if (lang() !== mount._lang) { mount._lang = lang(); render(); } }, 1000);   // language switch happens inside the extension shadow root
    mount._lang = lang();
    render();
    return { render };
  }

  function loadSaved(win) { try { return JSON.parse(win.localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function start(win) { return mount(win, createMachine(undefined, loadSaved(win))); }

  return { createMachine, mount, start, isTourKey, annotationEvents, resetKeys, pickLang, STEPS };
});
