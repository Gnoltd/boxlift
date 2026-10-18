/*
 * Content-script side of bridge.js: ask the CVAT page for a frame it already downloaded.
 * ask() resolves null when the bridge is not there (yet) or the page has another job open, so the
 * caller falls back to the REST API; it rejects with {timeout: true} when CVAT is still loading.
 */
(function (root) {
  'use strict';
  const REQ = 'lidar-cam-req', RES = 'lidar-cam-res';

  function create(win) {
    let ready = false, seq = 0;
    const wait = new Map();
    win.addEventListener('message', (e) => {
      if (e.source !== win || !e.data || typeof e.data !== 'object' || !e.data[RES]) return;
      const d = e.data[RES];
      if (d.ready) { ready = true; return; }
      const w = wait.get(d.id);
      if (!w) return;
      wait.delete(d.id); clearTimeout(w.timer);
      if (d.error) w.reject(new Error(d.error)); else w.resolve(d.result ?? null);
    });
    win.postMessage({ [REQ]: { op: 'ping' } }, win.location.origin);      // bridge may have registered first

    function ask(op, args, timeout) {
      if (!ready) return Promise.resolve(null);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wait.delete(id);
          reject(Object.assign(new Error(`CVAT chưa có ${op} sau ${timeout / 1000} s`), { timeout: true }));
        }, timeout);
        wait.set(id, { resolve, reject, timer });
        win.postMessage({ [REQ]: { op, id, ...args } }, win.location.origin);
      });
    }
    return { ask, get ready() { return ready; } };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CvatBridge = api;
})(typeof self !== 'undefined' ? self : this);
