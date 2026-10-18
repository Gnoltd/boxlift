// In-browser stand-in for the CVAT REST endpoints the extension uses (web demo).
// Routes and payloads follow tools/dev/mock_cvat.py; annotations persist in `storage` (getItem/setItem) across reloads.
(function (root) {
  'use strict';

  const KEY = 'demo:annotations', TOKEN = 'mocktoken123';

  function create({ manifest, storage, fetchBin }) {
    const frames = manifest.frames, last = frames.length - 1;
    const empty = () => ({ version: 0, tags: [], shapes: [], tracks: [] });
    let ann = empty();
    try { const s = storage && storage.getItem(KEY); if (s) ann = { ...empty(), ...JSON.parse(s) }; } catch (e) { /* start empty */ }
    let nextId = 1 + Math.max(0, ...ann.shapes.map((s) => s.id), ...ann.tracks.map((t) => t.id));
    const save = () => { try { storage.setItem(KEY, JSON.stringify(ann)); } catch (e) { /* quota / private mode: memory only */ } };
    const ok = (json) => ({ status: 200, json });
    const err = (status, detail) => ({ status, json: { detail } });
    const header = (h, k) => { for (const n in h || {}) if (n.toLowerCase() === k) return h[n]; };

    async function patch(action, body, onChange) {
      const shapes = body.shapes || [], tracks = body.tracks || [];
      const find = (list, x) => list.findIndex((y) => y.id === x.id);
      if (action === 'create') {
        const so = shapes.map((s) => ({ ...s, id: nextId++ })), to = tracks.map((t) => ({ ...t, id: nextId++ }));
        ann.shapes.push(...so); ann.tracks.push(...to);
        onChange(so.length, to.length);
        return ok({ version: 0, tags: [], shapes: so, tracks: to });
      }
      if (action !== 'update' && action !== 'delete') return err(400, 'bad action');
      if (shapes.some((s) => find(ann.shapes, s) < 0) || tracks.some((t) => find(ann.tracks, t) < 0)) return err(404, 'object not found');
      for (const [list, key] of [[shapes, 'shapes'], [tracks, 'tracks']]) {
        for (const x of list) { const k = find(ann[key], x); if (k < 0) continue; if (action === 'update') ann[key][k] = x; else ann[key].splice(k, 1); }
      }
      onChange(shapes.length, tracks.length);
      return ok({ version: 0, tags: [], shapes, tracks });
    }

    async function handle(method, path, headers, body, onChange = () => {}) {
      const q = path.indexOf('?'), p = q < 0 ? path : path.slice(0, q), qs = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));
      if (method === 'PATCH') {
        if (header(headers, 'x-csrftoken') !== TOKEN) return err(403, 'CSRF Failed');
        if (p !== '/jobs/1/annotations') return err(404, 'not found');
        const action = qs.get('action');
        const r = await patch(action, body || {}, (s, t) => { save(); onChange(action, s, t); });
        return r;
      }
      if (method !== 'GET') return err(405, 'method not allowed');
      if (p === '/jobs/1') return ok({ id: 1, task_id: manifest.task.id, dimension: '3d', start_frame: 0, stop_frame: last, data_chunk_size: 0 });
      if (p === '/tasks/1') return ok({ id: 1, name: manifest.task.name, dimension: '3d', size: frames.length });
      if (p === '/jobs') return ok({ count: 1, results: [{ id: 1, task_id: 1, start_frame: 0, stop_frame: last }] });
      if (p === '/jobs/1/data/meta') return ok({ chunk_size: 0, frames: frames.map((f) => ({ name: f.fid + '.pcd', related_files: 6 })) });
      if (p === '/labels') return ok({ count: manifest.labels.length, results: manifest.labels });
      if (p === '/jobs/1/annotations') return ok(ann);
      if (p === '/jobs/1/data') {
        const t = qs.get('type'), f = frames[Number(qs.get('number'))];
        if (!f || (t !== 'frame' && t !== 'context_image')) return err(404, 'no such frame');
        return { status: 200, bin: await fetchBin(t === 'frame' ? f.pcd : f.ctx) };
      }
      return err(404, 'not found');
    }
    return { handle };
  }

  function install(win, mock) {
    const orig = win.fetch.bind(win), base = win.location.origin + '/api';
    const emit = (action, shapes, tracks) => win.dispatchEvent(new CustomEvent('demo:annotation', { detail: { action, shapes, tracks } }));
    win.fetch = async function (url, init = {}) {
      const u = String(url && url.url || url);
      if (!u.startsWith(base) || !/^[/?]|^$/.test(u.slice(base.length))) return orig(url, init);
      const r = await mock.handle((init.method || 'GET').toUpperCase(), u.slice(base.length) || '/', init.headers || {},
        init.body ? JSON.parse(init.body) : undefined, emit);
      if (r.bin) return new Response(r.bin, { status: r.status, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(r.bin.byteLength) } });
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    };
  }

  const api = { create, install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MockCvat = api;
})(typeof self !== 'undefined' ? self : this);
