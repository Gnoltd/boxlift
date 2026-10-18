/* Content script for CVAT pages (3D jobs): "LiDAR ↔ Camera" window.
 *  - follows the current frame, downloads its point cloud + context images through the CVAT API
 *    using the user's own session, projects the cloud on any camera, lets the user nudge the calibration;
 *  - 2D -> 3D: drag a box on any camera image, a 3D cuboid is fitted from the LiDAR points (boxfit.js),
 *    drawn back on the image, and written to THIS job only when the user presses Save / Enter;
 *  - propagation: the boxes of the previous frame are carried into this one (ego motion by ICP,
 *    then re-fitted on the new sweep) and offered one by one for review before saving.
 * Security: requests go only to location.origin (the CVAT the user is logged in to); nothing else is
 * contacted; strings from the server or from a calib file are never inserted as HTML. */
(() => {
  'use strict';
  if (window.__lidarCamPanel) return;
  window.__lidarCamPanel = true;
  const P = self.LidarProjection, PM = self.PoseMetadata, PCD = self.PCD, ZIP = self.MiniZip, BF = self.BoxFit, EL = self.EditLog, TAG = self.BoxTag, TR = self.Tracks, CT = self.CvatTracks || self.Tracks, LM = self.LabelMap, AF = self.AutoFilter, BT = self.BoxTrack, BV = self.BoxViews, BH = self.BoxHandles, EP = self.EgoPath, TJ = self.Trajectory, SC = self.Scan, AO = self.AutoOdometry, I18N = self.I18n, UD = self.Undo;
  const CVAT = self.CvatBridge.create(window);
  const PS = self.CalibPairs;      // frames CVAT itself already downloaded (bridge.js)
  const SLIDERS = [
    ['pan', 'pan °', -5, 5, 0.01], ['tilt', 'tilt °', -5, 5, 0.01], ['roll', 'roll °', -5, 5, 0.01],
    ['dx', 'x m', -0.5, 0.5, 0.005], ['dy', 'y m', -0.5, 0.5, 0.005], ['dz', 'z m', -0.5, 0.5, 0.005],
    ['fscale', 'f ×', 0.9, 1.1, 0.001],
  ];
  const defAdj = () => ({ pan: 0, tilt: 0, roll: 0, dx: 0, dy: 0, dz: 0, fscale: 1 });
  const DEG = Math.PI / 180;

  const st = {
    calib: null, calibSrc: '', calibHash: '', profile: null, adj: {}, cams: [], cam: null,   // profile: bundled calib id (null: a loaded file)
    job: null, frame: null, data: new Map(), open: false,
    opts: { size: 2, alpha: 0.8, maxR: 40, hideGround: true, show: true, views: true, autoSave: true, trackGap: 10, mono: false, theme: 'dark', lang: 'vi', railOpen: true, sideTab: 'box', cardCollapsed: false, qsDone: false, autoOff: {},   // autoOff: classes unticked for auto
      pts: {} },                        // per camera (H sets them all alike): 'all' | 'box' (only around the selected box) | 'off'   // remembered per browser
    mode: 'view', labelId: null, proposal: null, saved: [], scores: [], trackInfo: new Map(), held: new Map(), kindOverride: new Map(), trackQueue: [], existing: null, editlog: [], activeSession: null, saveMode: 'shape', objectTab: 'all',
    batch: null,                      // proposals to review {kind: 'auto' | propagated, frame, from, items, idx}
    parked: new Map(),                // frame -> unsaved proposals set aside (Esc, other box, other frame): drawn faintly, resumable
    progress: new Map(),              // frame downloads in flight (for the loading message)
    outbox: [], saveError: null,      // boxes accepted but not yet confirmed by CVAT
    undo: UD.create(), undone: new Set(),   // Ctrl+Z for what was sent to CVAT (undo.js): one step per action; steps already undone
    ego: new Map(), lastT: null,      // ego motion per frame pair, last one (ICP start)
    poseMeta: null, poseSrc: '', poseCoverage: null, poseError: null, savedTrackIds: new Set(),
    clouds: new Map(),                // point clouds of neighbour sweeps (no images), for that ego motion
    siblings: null,                   // Promise<jobs of the same task>: neighbour sweeps of one-frame jobs
    nbCtl: new AbortController(),     // aborts neighbour-sweep downloads when the job changes
    pairs: {},                        // per camera: [{xyz (pcd frame), uv (px), job, frame}] clicked 3D<->2D pairs
    pending: null,                    // pair being clicked: the LiDAR point, waiting for its pixel
    pairRes: null,                    // last solve {cam, before, after} (median px)
    measured: null,                   // last 'Đo sai số' {cam, text}
  };

  // ---------------------------------------------------------------- CVAT API (user's session, same origin)
  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function headers(as, write) {
    // CVAT's REST renderer serves application/vnd.cvat+json (plain application/json -> 406)
    const h = { Accept: as === 'json' ? 'application/vnd.cvat+json, */*;q=0.1' : '*/*' };
    try { const t = localStorage.getItem('token'); if (t) h.Authorization = 'Token ' + JSON.parse(t); } catch (e) { /* cookie session */ }
    if (write) { h['Content-Type'] = 'application/json'; const c = cookie('csrftoken'); if (c) h['X-CSRFTOKEN'] = c; }
    return h;
  }
  /** onBytes(n): download progress for binary bodies. A request that gets no answer within
   *  `timeout` ms is aborted (a hung request would otherwise leave the window loading forever). */
  async function api(path, as = 'json', method = 'GET', body = undefined, { timeout = 120000, onBytes, signal } = {}) {
    if (!path.startsWith('/')) throw new Error('bad path');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
    try {
      const r = await fetch(location.origin + '/api' + path, {
        method, credentials: 'include', headers: headers(as, method !== 'GET'), signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`CVAT ${r.status} ${method} ${path.split('?')[0]}`);
      if (as === 'json') return await r.json();
      if (!onBytes || !r.body) return await r.arrayBuffer();
      const parts = [], rd = r.body.getReader();
      let n = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; onBytes(n); }
      const out = new Uint8Array(n); let o = 0;
      for (const v of parts) { out.set(v, o); o += v.length; }
      return out.buffer;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error(`CVAT không trả lời sau ${timeout / 1000} s: ${path.split('?')[0]}`), { timeout: true });
      throw e;
    } finally { clearTimeout(timer); }
  }
  const routeJob = () => { const m = location.pathname.match(/\/tasks\/(\d+)\/jobs\/(\d+)/); return m ? Number(m[2]) : null; };
  function currentFrame() {
    const e = document.querySelector('.cvat-player-frame-selector input');
    const v = e ? Number(e.value) : NaN;
    if (Number.isFinite(v)) return v;
    const q = new URLSearchParams(location.search).get('frame');
    return q !== null ? Number(q) : null;
  }

  async function loadJob(jid) {
    const job = await api(`/jobs/${jid}`);
    if (job.dimension !== '3d') return null;
    const [meta, labels, taskName] = await Promise.all([
      api(`/jobs/${jid}/data/meta`),
      api(`/labels?job_id=${jid}&page_size=500`)
        .then((res) => (res.results || []).filter((l) => !l.type || l.type === 'any' || l.type === 'cuboid')
          .map((l) => ({ id: Number(l.id), name: String(l.name), attributes: l.attributes || [] })))
        .catch((e) => { console.warn('[lidar-cam] labels:', e.message); return []; }),
      // picks the bundled calibration (calibs/index.json "match")
      api(`/tasks/${job.task_id}`).then((t) => String(t.name || ''))
        .catch((e) => { console.warn('[lidar-cam] task name:', e.message); return ''; }),
    ]);
    return { id: jid, taskId: job.task_id, projectId: job.project_id ?? null, taskName, start: job.start_frame, stop: job.stop_frame, meta, labels,
      chunkSize: Number(job.data_chunk_size || meta.chunk_size) || 0 };
  }

  async function loadExisting() {
    try {
      const a = await api(`/jobs/${st.job.id}/annotations`);
      const shapes = (a.shapes || []).filter((x) => x.type === 'cuboid')
        .map((x) => ({ frame: x.frame, box: BF.fromCvatPoints(x.points), labelId: x.label_id, shape: x }));
      const tracks = (a.tracks || []).filter((t) => (t.shapes || []).some((x) => x.type === 'cuboid'))
        .map((t) => ({ id: t.id, labelId: t.label_id, track: { ...t, shapes: t.shapes.filter((x) => x.type === 'cuboid').sort((p, q) => p.frame - q.frame) } }));
      st.existing = { shapes, tracks };
      for (const sh of shapes) {
        const scAttr = (sh.shape.attributes || []).find((at) => {
          const l = st.job && st.job.labels.find((lb) => lb.id === sh.labelId);
          const spec = l && l.attributes.find((sp) => sp.id === at.spec_id);
          return spec && /score|confidence|conf/i.test(spec.name);
        });
        if (scAttr && !isNaN(parseFloat(scAttr.value))) {
          recordScore({ frame: sh.frame, box: sh.box, score: parseFloat(scAttr.value), labelId: sh.labelId, shapeId: sh.shape.id });
        }
      }
    } catch (e) { st.existing = { shapes: [], tracks: [] }; console.warn('[lidar-cam] annotations:', e.message); }
  }
  /** Boxes visible at `frame`: shapes of that frame + tracks interpolated like CVAT (linear on the
   *  cuboid numbers between keyframes; a track holds its last state until a keyframe marks it outside). live: without
   *  that hold past a track's last keyframe (where nothing says the object still is). */
  function boxesAt(frame, live = false) {
    if (!st.existing) return [];
    const out = st.existing.shapes.filter((x) => x.frame === frame).map((x) => ({ box: x.box, interp: false, rec: x }));
    for (const rec of trackRecsAt(frame, live)) out.push({ box: rec.box, interp: !rec.key, rec });
    return out;
  }
  /** Tracks with a delete waiting in the outbox. */
  const goneTracks = () => new Set(st.outbox.filter((o) => o.op === 'track-delete').map((o) => o.trackId));
  /** Tracks shown at `frame` as editable records {frame, box, labelId, trackId, key (a keyframe here)}; tracks with a
   *  delete waiting in the outbox are left out. */
  function trackRecsAt(frame, live = false) {
    if (!st.existing) return [];
    const gone = goneTracks(), out = [];
    for (const t of st.existing.tracks) {
      if (gone.has(t.id) || (live && frame > t.track.shapes[t.track.shapes.length - 1].frame)) continue;
      const a = TR.at(t.track, frame);
      if (a) out.push({ frame, box: BF.fromCvatPoints(a.points), labelId: t.labelId, trackId: t.id, key: a.key });
    }
    return out;
  }
  /** Tracks outside at `frame` (they left the scene, O in CVAT) as records like trackRecsAt's, with their last box: the
   *  object list shows them so O / a click can bring them back, as CVAT lists them. */
  function outsideRecsAt(frame) {
    if (!st.existing) return [];
    const gone = goneTracks(), out = [];
    for (const t of st.existing.tracks) {
      const pts = !gone.has(t.id) && TR.leftAt(t.track, frame);
      if (pts) out.push({ frame, box: BF.fromCvatPoints(pts), labelId: t.labelId, trackId: t.id, key: false, outside: true });
    }
    return out;
  }
  /** Every box shown at `frame`: the job's (boxesAt, live: see there) + those saved in this session. */
  const knownBoxes = (frame, live = false) => [...boxesAt(frame, live).map((e) => e.box), ...st.saved.filter((x) => x.frame === frame).map((x) => x.box)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- point cloud of one frame. Asking CVAT for a single frame (type=frame) makes the server cut it
  // out of the source data, which can take minutes; its own 3D view instead loads whole data chunks,
  // which the server has prepared and the browser often has cached. So: same chunk the view uses,
  // unzip only the needed frame; the single-frame endpoint stays as the fallback.
  // CVAT prepares 3D data on demand and can take minutes: give up late, and after a timeout do NOT ask
  // again in another form (the server is still working on the first request; a second one only queues).
  const SLOW = { cloud: 180000, images: 300000 };
  /**
   * A frame of the open job from CVAT's own cache (bridge.js), so nothing is downloaded twice.
   * null -> use the REST API (bridge not there, or the page shows another job); a timeout is thrown
   * (CVAT is still loading it: asking the server again would only queue the same work).
   */
  async function fromCvat(op, frame) {
    try { return await CVAT.ask(op, { jobId: st.job.id, frame }, SLOW[op === 'cloud' ? 'cloud' : 'images']); } catch (e) {
      if (e.timeout) throw e;
      console.warn(`[lidar-cam] CVAT cache ${op} frame ${frame}: ${e.message}; dùng REST API`);
      return null;
    }
  }
  const IMG_NAME = /(?:image|cam|camera)?_?(\d+)(?:\.\w+)?$/i;       // ZIP entries "…/image_3.jpg", "…/00.jpg", "…/cam_1.png"
  const chunkCache = new Map();       // url -> Promise<zip entries>
  /** Query of CVAT's own latest `/jobs/<this job>/data?type=<type>` request, or null. */
  function lastDataQuery(type) {
    for (const e of performance.getEntriesByType('resource').reverse()) {
      const m = e.name.match(/\/api\/jobs\/(\d+)\/data\?(.*)$/);
      if (!m || Number(m[1]) !== st.job.id) continue;
      const q = new URLSearchParams(m[2]);
      if (q.get('type') === type) return q;
    }
    return null;
  }
  function chunkStyle() {
    // how this CVAT version asks for chunks (param name + quality), learnt from its own requests
    const q = lastDataQuery('chunk');
    if (q) return [{ param: q.has('index') ? 'index' : 'number', quality: q.get('quality') || 'compressed' }];
    return [{ param: 'index', quality: 'compressed' }, { param: 'number', quality: 'compressed' }];
  }
  async function pcdFromChunk(frame, prog) {
    const cs = st.job.chunkSize;
    if (!cs) return null;
    for (const { param, quality } of chunkStyle()) {
      const rel = param === 'index' ? frame - st.job.start : frame;      // index: per job, number: per task
      const url = `/jobs/${st.job.id}/data?type=chunk&quality=${quality}&${param}=${Math.floor(rel / cs)}`;
      try {
        let entries = chunkCache.get(url);
        if (!entries) {
          entries = api(url, 'buf', 'GET', undefined, { timeout: SLOW.cloud, onBytes: (n) => { prog.pcd = n; } }).then((b) => ZIP.listZip(b));
          chunkCache.set(url, entries);
          if (chunkCache.size > 2) chunkCache.delete(chunkCache.keys().next().value);
          entries.catch(() => chunkCache.delete(url));
        }
        const clouds = (await entries).filter((e) => /\.(pcd|bin)$/i.test(e.name));
        const item = st.job.meta.frames && st.job.meta.frames[frame - st.job.start];
        const base = item ? String(item.name).replace(/^.*\//, '') : '';
        const e = clouds.find((x) => base && x.name.replace(/^.*\//, '') === base) || clouds[rel % cs];
        if (!e) continue;
        const u = await e.get();
        prog.src = `chunk ${Math.floor(rel / cs)}`;
        return { buf: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), bin: /\.bin$/i.test(e.name) };
      } catch (err) {
        console.warn('[lidar-cam] chunk', url, err.message);
        if (err.timeout) throw err;                // slow server, not an unsupported chunk style
      }
    }
    return null;
  }
  async function loadPcd(frame, prog) {
    const own = await fromCvat('cloud', frame);
    if (own) { prog.src = 'CVAT'; prog.pcd = own.buf.byteLength; return /\.bin$/i.test(own.name || '') ? kittiBin(own.buf) : PCD.parsePCD(own.buf); }
    const c = await pcdFromChunk(frame, prog);
    if (c) return c.bin ? kittiBin(c.buf) : PCD.parsePCD(c.buf);
    prog.src = 'frame'; prog.pcd = 0;
    return PCD.parsePCD(await api(`/jobs/${st.job.id}/data?type=frame&quality=original&number=${frame}`, 'buf', 'GET', undefined,
      { timeout: SLOW.cloud, onBytes: (n) => { prog.pcd = n; } }));
  }
  function kittiBin(buf) {             // x y z intensity float32
    const f = new Float32Array(buf), n = Math.floor(f.length / 4), xyz = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { xyz[3 * i] = f[4 * i]; xyz[3 * i + 1] = f[4 * i + 1]; xyz[3 * i + 2] = f[4 * i + 2]; }
    return xyz;
  }

  /** URL for a frame's context images, in the exact form CVAT's own view uses (same URL -> the server's
   *  prepared copy / the browser cache answer it instead of a fresh, slow extraction). */
  function contextUrl(frame) {
    const q = lastDataQuery('context_image') || new URLSearchParams({ type: 'context_image' });
    q.set('number', String(frame));
    return `/jobs/${st.job.id}/data?${q}`;
  }
  /** Context images arrive separately from the cloud: the point cloud is shown as soon as it is in,
   *  the images fill in when ready (or say why not, and are retried). */
  function loadImages(data, prog) {
    data.img = { state: 'loading', t0: performance.now(), bytes: 0 };
    const st0 = data.img;
    data.imgPending = (async () => {
      try {
        const images = {}, names = [];
        const own = await fromCvat('images', data.frame);
        if (own) {
          for (const [name, bmp] of own) {
            names.push(name);
            const m = name.match(IMG_NAME);
            if (m) { const idx = parseInt(m[1], 10); if (!images[idx]) images[idx] = bmp; }
          }
          st0.src = 'CVAT';
        } else {
          const buf = await api(contextUrl(data.frame), 'buf', 'GET', undefined,
            { timeout: SLOW.images, onBytes: (n) => { st0.bytes = n; if (prog) prog.img = n; } });
          for (const [name, bytes] of await ZIP.readZip(buf)) {
            names.push(name);
            const m = name.match(IMG_NAME);
            if (m) {
              const idx = parseInt(m[1], 10);
              if (!images[idx]) images[idx] = await createImageBitmap(new Blob([bytes], { type: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg' }));
            }
          }
        }
        data.images = images;
        data.img = Object.keys(images).length ? { state: 'ok', bytes: st0.bytes }
          : { state: 'error', error: `ZIP ảnh không có file image_N (có: ${names.slice(0, 4).join(', ') || 'rỗng'})`, retryAt: Infinity };
        if (!st.calib && Object.keys(images).length) {
          const nCams = Object.keys(images).length;
          const guessId = nCams === 8 ? '8cam-rig' : nCams === 6 ? 'nuscenes-scene-0061' : nCams <= 4 ? 'kitti-2011_09_26' : null;
          if (guessId) chooseProfile(guessId).catch((err) => console.warn('[lidar-cam] auto calib:', err.message));
        }
        console.info(`[lidar-cam] frame ${data.frame}: ảnh camera ${st0.src === 'CVAT' ? 'từ cache CVAT' : (st0.bytes / 1e6).toFixed(1) + ' MB'}, ${((performance.now() - st0.t0) / 1000).toFixed(1)} s`);
      } catch (e) {
        data.imgTries = (data.imgTries || 0) + 1;                 // back off: 30 s, 60 s, 120 s
        data.img = { state: 'error', error: e.message, retryAt: performance.now() + Math.min(120000, 15000 * 2 ** data.imgTries) };
        console.warn('[lidar-cam] context images:', e.message);
      }
      if (current === data) {
        if (ui.root) buildTabs();
        draw();
      }
    })();
    return data.imgPending;
  }

  async function loadFrame(frame) {
    const key = `${st.job.id}:${frame}`;
    if (st.data.has(key)) return st.data.get(key);
    const prog = { frame, t0: performance.now(), pcd: 0, img: 0, pcdDone: false };
    st.progress.set(key, prog);
    const pending = (async () => {
      const item = st.job.meta.frames && st.job.meta.frames[frame - st.job.start];
      const data = { frame, images: {}, name: item ? String(item.name) : String(frame) };
      loadImages(data, prog);
      data.xyz = await loadPcd(frame, prog);
      prog.pcdDone = true;
      data.ground = BF.groundMask(data.xyz);
      console.info(`[lidar-cam] frame ${frame}: ${(prog.pcd / 1e6).toFixed(1)} MB point cloud (${prog.src}), ${((performance.now() - prog.t0) / 1000).toFixed(1)} s`);
      return data;
    })();
    st.data.set(key, pending);
    if (st.data.size > 6) st.data.delete(st.data.keys().next().value);
    pending.catch(() => st.data.delete(key)).finally(() => st.progress.delete(key));
    return pending;
  }

  // ---------------------------------------------------------------- calibration
  /** Short content hash of a calibration (pair exports record which calibration they were measured with). */
  function hashOf(obj) {
    const t = JSON.stringify(obj, (k, v) => (k === '_fold' ? undefined : v));     // cache field older versions left in stored calibs
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16);
  }
  // Calibration per CVAT task: the bundled profile whose pattern matches the task name (calibs/index.json),
  // or what was chosen / loaded / adjusted for this task before (chrome.storage 'calibTask:<origin>:<task>').
  const taskKey = (job) => `calibTask:${location.origin}:${job.taskId}`;
  // keyed by task name: task ids restart after a Docker reset, the scene name does not
  const poseKey = (job) => `poseTask:${location.origin}:${job.taskName || job.taskId}`;
  const ask = async (msg) => {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res || !res.ok) throw new Error((res && res.error) || 'service worker không trả lời');
    return res.data;
  };
  let profilesP = null;
  const profiles = () => (profilesP ??= ask({ type: 'listCalibs' }).then((d) => d.profiles || []).catch((e) => { profilesP = null; throw e; }));
  async function loadCalibFor(job) {
    st.calib = null; st.profile = null; st.calibError = null;
    const list = await profiles();
    const saved = (await chrome.storage.local.get(taskKey(job)))[taskKey(job)];
    if (saved && saved.calib) setCalib(saved.calib, saved.src || 'file đã nạp', saved.adj, null);
    else {
      let p = list.find((x) => x.id === (saved && saved.profile)) || list.find((x) => new RegExp(x.match, 'i').test(job.taskName));
      if (!p && /8[-_]?cam|8[-_]?camera|surround|rig[-_]?8/i.test(job.taskName || '')) {
        p = list.find((x) => x.id === '8cam-rig');
      }
      if (!p) {
        st.calibError = `Task "${job.taskName || job.taskId}" chưa có calib: chọn trong Chỉnh calib → Bộ calib, hoặc Nạp calib.json.`;
        st.cams = []; if (ui.root) { ui.tabs.replaceChildren(); buildProfiles(); }
        return;
      }
      setCalib(await ask({ type: 'getCalib', id: p.id }), `${p.name} (${p.dataset}, ${p.licence})`, saved && saved.profile === p.id ? saved.adj : null, p.id);
    }
    await loadPairs();
  }
  function parseImgIdx(s) {
    const m = String(s).match(/(?:image|cam|camera)?_?(\d+)/i);
    return m ? parseInt(m[1], 10) : NaN;
  }
  /** profile: bundled calib id, or null for a calibration loaded from a file. */
  function setCalib(c, src, adj, profile) {
    if (!c || typeof c !== 'object' || !c.cameras) throw new Error('calib không hợp lệ');
    st.calib = c; st.calibSrc = String(src); st.calibError = null; st.profile = profile; st.calibHash = hashOf(c);
    const map = c.camera_map || { image_1: Object.keys(c.cameras)[0] };
    const seenIdx = new Set(), seenName = new Set();
    st.cams = [];
    for (const [img, name] of Object.entries(map)) {
      const idx = parseImgIdx(img);
      const camName = String(name);
      if (!c.cameras[camName] || !Number.isFinite(idx)) continue;
      if (seenIdx.has(idx) || seenName.has(camName)) continue; // Không trùng camera và không trùng ảnh
      seenIdx.add(idx);
      seenName.add(camName);
      st.cams.push({ img: String(img), idx, name: camName });
    }
    st.cams.sort((a, b) => a.idx - b.idx);
    st.adj = Object.fromEntries(st.cams.map((x) => [x.name, { ...defAdj(), ...((adj || {})[x.name] || {}) }]));
    if (!st.cam || !c.cameras[st.cam]) st.cam = (st.cams.find((x) => x.idx === 1) || st.cams[0])?.name || Object.keys(c.cameras)[0];
    if (ui.root) { buildTabs(); buildSliders(); buildProfiles(); draw(); }
  }
  /** Remember the calibration of this task: the profile (or the loaded file) and the slider adjustments. */
  async function saveCalib(quiet) {
    if (!st.job || !st.calib) return;
    const rec = { src: st.calibSrc, adj: st.adj, at: Date.now(), ...(st.profile ? { profile: st.profile } : { calib: st.calib }) };
    await chrome.storage.local.set({ [taskKey(st.job)]: rec });
    if (!quiet) toast(`Đã lưu calib cho task ${st.job.taskName || st.job.taskId}`);
  }
  async function chooseProfile(id) {
    if (!st.job) return;
    const p = (await profiles()).find((x) => x.id === id);
    if (!p) return;
    setCalib(await ask({ type: 'getCalib', id }), `${p.name} (${p.dataset}, ${p.licence})`, null, id);
    await saveCalib(true); await loadPairs(); await loadPoseFor(st.job); toast('Task này dùng calib ' + p.name);
  }
  function buildProfiles() {
    if (!ui.profile) return;
    profiles().then((list) => {
      ui.profile.innerHTML = '';
      ui.profile.append(el('option', { value: '', textContent: st.calib && !st.profile ? '(file đã nạp)' : '— chọn —' }));
      for (const p of list) ui.profile.append(el('option', { value: p.id, textContent: p.name }));
      ui.profile.value = st.profile || '';
    }).catch((e) => console.warn('[lidar-cam] calibs:', e.message));
  }
  function exportCalib() {
    const out = P.bakeCalib(st.calib, st.adj);
    out.edited = { from: st.calibSrc, at: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'calib.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------- per-frame ego pose
  function frameName(job, frame) {
    const item = job && job.meta.frames && job.meta.frames[frame - job.start];
    return item ? String(item.name) : String(frame);
  }
  function poseInfoUpdate() {
    if (!ui.poseInfo) return;
    if (st.poseError) { ui.poseInfo.textContent = `Ego pose lỗi: ${st.poseError}`; return; }
    if (!st.poseMeta) { ui.poseInfo.textContent = I18N.t('setup.pose.none'); return; }
    const c = st.poseCoverage, scene = st.poseMeta.scene ? `${st.poseMeta.scene} · ` : '';
    ui.poseInfo.textContent = `${scene}${st.poseSrc} · khớp ${c.matched}/${c.total} frame` +
      (c.matched < c.total ? ` · ${c.total - c.matched} frame thiếu pose sẽ dùng ICP` : ' · propagation dùng pose, không chạy ICP');
  }
  function setPoseMeta(raw, src) {
    if (!st.job) throw new Error('chưa mở job 3D');
    const meta = PM.parse(raw), names = (st.job.meta.frames || []).map((x) => String(x.name));
    const coverage = PM.coverage(meta, names);
    if (!coverage.total) throw new Error('CVAT không trả tên frame để ghép metadata');
    if (!coverage.matched) throw new Error('không có filename/timestamp nào khớp task CVAT');
    st.poseMeta = meta; st.poseSrc = String(src); st.poseCoverage = coverage; st.poseError = null;
    st.ego.clear(); st.lastT = null; poseInfoUpdate();
  }
  /** A KISS-ICP pose saved by an older revision of autoodometry.js used the wrong convention: it is worked out again. */
  const stalePose = (raw) => !!raw && raw.mode === 'kiss-icp-auto' && raw.rev !== (AO ? AO.AUTO_REV : 2);
  async function loadPoseFor(job) {
    st.poseMeta = null; st.poseSrc = ''; st.poseCoverage = null; st.poseError = null;
    const saved = (await chrome.storage.local.get(poseKey(job)))[poseKey(job)];
    if (saved && saved.raw && !stalePose(saved.raw)) {
      try { setPoseMeta(saved.raw, saved.src || 'metadata đã lưu'); }
      catch (e) { st.poseError = e.message; }
    } else if (st.calib && Array.isArray(st.calib.frames) && st.calib.frames.length) {
      try { setPoseMeta(st.calib, st.calibSrc ? `${st.calibSrc} (kèm pose)` : 'calib kèm ego pose'); }
      catch (e) { st.poseError = e.message; }
    } else {
      // Pose do chính thiết bị này đã đẩy lên Supabase (owner_device_id): pose của người khác không bao giờ đọc được
      const SL = typeof SupaLog !== 'undefined' ? SupaLog : (typeof root !== 'undefined' ? root.SupaLog : null);
      if (SL && SL.getTaskPose && job) {
        try {
          const cloudRecord = await SL.getTaskPose(job.taskName);
          if (cloudRecord && cloudRecord.raw_pose && !stalePose(cloudRecord.raw_pose)) {
            setPoseMeta(cloudRecord.raw_pose, `${cloudRecord.source || 'quỹ đạo'} (Supabase)`);
            try {
              await chrome.storage.local.set({
                [poseKey(job)]: {
                  raw: cloudRecord.raw_pose,
                  src: `${cloudRecord.source || 'quỹ đạo'} (Supabase)`,
                  at: Date.now()
                }
              });
            } catch (err) {}
          }
        } catch (e) { /* quiet fallback */ }
      }
      if (!st.poseMeta && st.profile) {
        try {
          const poseRes = await ask({ type: 'getPose', id: st.profile });
          if (poseRes && Array.isArray(poseRes.frames) && poseRes.frames.length) {
            setPoseMeta(poseRes, `bundle ${st.profile}`);
          }
        } catch (e) { /* profile không có pose riêng, fallback */ }
      }
    }
    poseInfoUpdate();
  }

  /** KISS-ICP trajectory of the job when no pose is loaded; one run at a time (L pressed twice waits for the same one). */
  let poseRun = null;
  function ensurePose() {
    if (st.poseMeta || !st.job) return Promise.resolve(!!st.poseMeta);
    return poseRun || (poseRun = runAutoOdometry(true).finally(() => { poseRun = null; }));
  }
  async function runAutoOdometry(quiet = false) {
    if (!st.job) { if (!quiet) toast(I18N.t('toast.noJob')); return false; }
    const ao = AO || self.AutoOdometry || (typeof AutoOdometry !== 'undefined' ? AutoOdometry : (typeof root !== 'undefined' ? root.AutoOdometry : null));
    if (!ao || !ao.computeTrajectory) {
      if (!quiet) toast('Chưa nạp module AutoOdometry');
      return false;
    }
    const frames = [];
    for (let f = st.job.start; f <= st.job.stop; f++) {
      frames.push({
        index: f,
        name: frameName(st.job, f),
        timestamp: PM.timestampFromName ? PM.timestampFromName(frameName(st.job, f)) : null
      });
    }

    const btn = ui.poseAutoBtn;
    if (btn) { btn.disabled = true; btn.textContent = 'Đang tính…'; }
    if (!quiet) toast(`Đang tự động giải quỹ đạo cho ${frames.length} frames (KISS-ICP)…`);

    try {
      const res = await ao.computeTrajectory({
        frames,
        loadCloud,
        sensor2ego: st.calib && st.calib.lidar && st.calib.lidar.sensor2ego,
        onProgress: (cur, tot, ms) => {
          trackProgress(`KISS-ICP: ${cur}/${tot} frames (${Math.round((cur / tot) * 100)}%) · ${(ms / 1000).toFixed(1)}s`);
        }
      });
      trackProgress('');
      const raw = res.raw;
      setPoseMeta(raw, 'Tự tính (KISS-ICP)');
      try {
        await chrome.storage.local.set({ [poseKey(st.job)]: { raw, src: 'Tự tính (KISS-ICP)', at: Date.now() } });
      } catch (saveErr) { /* storage quota */ }

      // Đẩy lên Supabase: chỉ chính thiết bị này đọc lại được (owner_device_id)
      const SL = typeof SupaLog !== 'undefined' ? SupaLog : (typeof root !== 'undefined' ? root.SupaLog : null);
      if (SL && SL.upsertTaskPose && st.job) {
        SL.upsertTaskPose({
          origin: location.origin,
          taskId: st.job.taskId,
          taskName: st.job.taskName,
          source: 'Tự tính (KISS-ICP)',
          rawPose: raw,
          frameCount: res.summary.totalFrames
        }).catch((err) => console.warn('[lidar-cam] sync pose to supabase failed', err.message));
      }
      const sec = (res.summary.durationMs / 1000).toFixed(1);
      toast(`Đã tính xong quỹ đạo ${res.summary.totalFrames} frames trong ${sec}s (${res.summary.fps} FPS)! Đã lưu vĩnh viễn.`);
      return true;
    } catch (err) {
      trackProgress('');
      if (!quiet) toast('Lỗi tự tính quỹ đạo: ' + err.message);
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Tự tính quỹ đạo (KISS-ICP)'; }
    }
  }

  // ---------------------------------------------------------------- 2D -> 3D
  function labelName(id) { const l = st.job && st.job.labels.find((x) => x.id === id); return l ? l.name : ''; }
  /** Open a box for editing. p.edit = the server record when it is an existing box (saved -> update). */
  function setProposal(p) {
    st.proposal = p;
    if (p) st.sizeAsk = null;
    if (p) { p.hist = []; p.redo = []; p.last = { ...p.box }; p.orig = { ...p.box }; }
  }
  const sameBox = (a, b) => ['x', 'y', 'z', 'yaw', 'l', 'w', 'h', 'rx', 'ry'].every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-6);
  /** Record an edit step (for Ctrl+Z / Ctrl+Y): call after every change that the user made. */
  function commit() {
    const p = st.proposal; if (!p) return;
    if (!sameBox(p.box, p.last)) { const tgt = p.item || p; tgt.nAdjust = (tgt.nAdjust || 0) + 1; p.hist.push(p.last); if (p.hist.length > 100) p.hist.shift(); p.last = { ...p.box }; p.redo = []; }
  }
  function undoEdit() {
    const p = st.proposal; if (!p || !p.hist.length) return false;
    commit(); if (!p.hist.length) return false;
    p.redo.push({ ...p.box }); Object.assign(p.box, p.hist.pop()); p.last = { ...p.box };
    draw(); buildBoxPanel(); return true;
  }
  function redoEdit() {
    const p = st.proposal; if (!p || !p.redo.length) return false;
    p.hist.push({ ...p.box }); Object.assign(p.box, p.redo.pop()); p.last = { ...p.box };
    draw(); buildBoxPanel(); return true;
  }
  /** Server boxes (shapes) of a frame: loaded with the job + saved in this session, minus pending deletes. */
  function serverBoxesAt(frame) {
    const gone = new Set(st.outbox.filter((o) => o.op === 'delete').map((o) => o.shape.id));
    return [...(st.existing ? st.existing.shapes : []), ...st.saved].filter((r) => r.frame === frame && r.shape && !gone.has(r.shape.id))
      .concat(trackRecsAt(frame));
  }
  const recKey = (r) => (r.trackId != null ? `t${r.trackId}` : r.shape ? `s${r.shape.id}` : null);
  /** Points of the cloud inside a box (+ margin), for highlighting. */
  function pointsInBox(b, m = 0.1) {
    if (!current) return [];
    const out = [], xyz = current.xyz, R = BF.rotMat(b);
    for (let i = 0, n = xyz.length / 3; i < n; i++) {
      const dx = xyz[3 * i] - b.x, dy = xyz[3 * i + 1] - b.y, dz = xyz[3 * i + 2] - b.z;
      if (Math.abs(dx) > b.l + 2 || Math.abs(dy) > b.l + 2) continue;
      const u = R[0][0] * dx + R[1][0] * dy + R[2][0] * dz, v = R[0][1] * dx + R[1][1] * dy + R[2][1] * dz, w = R[0][2] * dx + R[1][2] * dy + R[2][2] * dz;
      if (Math.abs(u) <= b.l / 2 + m && Math.abs(v) <= b.w / 2 + m && Math.abs(w) <= b.h / 2 + m) out.push(i);
    }
    return out;
  }
  /** Points inside any cuboid of the shown frame (job boxes, saved here, the one being edited): only
   *  what is labelled, no buildings / trees. Cached until a box changes. */
  function boxesCloud(hideGround) {
    const bs = knownBoxes(st.frame);
    if (st.proposal && st.proposal.frame === st.frame) bs.push(st.proposal.box);
    const key = `${hideGround}|${JSON.stringify(bs)}`;
    if (current.inBoxes && current.inBoxes.key === key) return current.inBoxes;
    const sel = new Set();
    for (const b of bs) for (const i of pointsInBox(b, 0.2)) if (!hideGround || !current.ground[i]) sel.add(i);
    const cloud = new Float32Array(sel.size * 3);
    let j = 0;
    for (const i of sel) { cloud[j++] = current.xyz[3 * i]; cloud[j++] = current.xyz[3 * i + 1]; cloud[j++] = current.xyz[3 * i + 2]; }
    return (current.inBoxes = { key, cloud });
  }
  /** Select a saved box (from CVAT or this session) to edit it; the open one is auto-saved first. */
  function selectServerBox(rec, reveal) {
    if (st.proposal && st.proposal.edit === rec) return;
    if (rec && reveal) showOnCamera(rec.box);
    if (st.batch) parkBatch(false);                 // editing a saved box: the review waits (nothing lost)
    autoSave();
    if (!rec) { setProposal(null); draw(); buildBoxPanel(); return; }
    setProposal({ box: { rx: 0, ry: 0, ...rec.box }, points: pointsInBox(rec.box), cam: st.cam, frame: rec.frame, ms: 0, edit: rec });
    if (rec.labelId != null && st.job.labels.some((l) => l.id === rec.labelId)) { st.labelId = rec.labelId; ui.label.value = String(rec.labelId); }
    draw(); buildBoxPanel();
  }
  /** Where a box shows best: how far its centre falls inside a camera image (0 = edge, 1 = centre), -1 = not seen. */
  function seenBy(cam, box) {
    const r = P.projectCloud(new Float32Array([box.x, box.y, box.z]), st.calib, cam, st.adj[cam]);
    if (!r.u.length) return -1;
    const [W, H] = st.calib.cameras[cam].image_size || [1920, 1536];
    return Math.min(r.u[0] / W, 1 - r.u[0] / W, r.v[0] / H, 1 - r.v[0] / H) * 2;
  }
  /** Keep the shown camera when it sees the box well enough, else the camera that sees it best (prefer `cam`). */
  function showOnCamera(box, cam) {
    if (!st.calib || !box) return;
    if (seenBy(st.cam, box) > 0.1) return;
    const best = (cam && seenBy(cam, box) > 0 ? [cam] : []).concat(st.cams.map((c) => c.name).sort((a, b) => seenBy(b, box) - seenBy(a, box)))[0];
    if (best && best !== st.cam && seenBy(best, box) >= 0) { st.cam = best; view.zoom = 1; view.ox = 0; view.oy = 0; buildTabs(); buildSliders(); }
  }
  const runFit = (rect) => fitProposal(BF.fitFromRect, { rect });
  const runClick = (click) => fitProposal(BF.fitFromClick, { click });
  /** A new box from a dragged rectangle ({rect}, BF.fitFromRect) or a click ({click}, BF.fitFromClick) on the shown camera. */
  function fitProposal(fit, input) {
    if (!current) return;
    const t0 = performance.now();
    const res = fit(current.xyz, st.calib, st.cam, st.adj[st.cam], input.rect || input.click, { label: classOfLabel(st.labelId, null), ground: current.ground });
    if (!res.box) { st.proposal = null; toast('Không tạo được box: ' + res.reason); draw(); buildBoxPanel(); return; }
    setProposal({ ...res, ...input, cam: st.cam, ms: performance.now() - t0, frame: st.frame });
    draw(); buildBoxPanel(); headingForProposal();
  }
  /**
   * A box just fitted by hand: the frustum models re-estimate it (whole object, hidden side too), then the image decides
   * its front (async; left alone if the user changed the box meanwhile).
   */
  async function headingForProposal() {
    const p = st.proposal, entry = p && st.cams.find((c) => c.name === p.cam), bmp = entry && current && current.images[entry.idx];
    if (!p) return;
    const before = JSON.stringify(p.box), xyz = current && current.xyz;
    const lb = p.frustum && xyz ? await learnedBoxes([{ res: p, label: classOfLabel(st.labelId, p.box), xyz, rect: p.rect, cam: p.cam, bmp }]) : null;
    if (st.proposal !== p || JSON.stringify(p.box) !== before) return;
    if (lb && lb[0]) { p.geo = p.box; p.box = { rx: 0, ry: 0, ...lb[0].box }; p.how = 'learned'; p.model = lb[0].model; }
    if (!bmp) { if (lb && lb[0]) { p.last = { ...p.box }; p.orig = { ...p.box }; draw(); buildBoxPanel(); } return; }
    const b = { ...p.box }, yaw0 = p.box.yaw;
    const d = await headingFix([{ box: b, cam: p.cam, bmp, odds: lb && lb[0] ? lb[0].odds : 1 }]);
    if (st.proposal !== p) return;
    if (d && d[0]) { p.heading = d[0]; if (d[0].flip && p.box.yaw === yaw0) Object.assign(p.box, { yaw: b.yaw, rx: b.rx, ry: b.ry }); }
    p.last = { ...p.box }; p.orig = { ...p.box }; draw(); buildBoxPanel();
  }
  /** Whole camera image as RGBA, once per image (crops for the heading model and MTrans). */
  const pixelCache = new WeakMap();
  function pixelsOf(bmp) {
    if (!pixelCache.has(bmp)) {
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0); pixelCache.set(bmp, g.getImageData(0, 0, bmp.width, bmp.height));
    }
    return pixelCache.get(bmp);
  }
  /**
   * MTrans (mtrans.js + models/mtrans.onnx, GPU only) on cars drawn / detected as a rectangle: list [{res, label, xyz,
   * rect, cam, bmp, others (rectangles of the other boxes in that image)}] -> per item {box, odds, model: 'mtrans'} or null.
   */
  async function mtransBoxes(list) {
    const out = list.map(() => null);
    if (typeof MTrans === 'undefined') return out;
    const jobs = list.map((it, k) => ({ k, it })).filter(({ it }) => it.rect && it.bmp && it.res && it.res.box && MTrans.useFor(it.label));
    if (!jobs.length) return out;
    const B = MTrans.newBatch(jobs.length), proj = new Map(), th = [], n = [];
    jobs.forEach(({ it }, k) => {
      if (!proj.has(it.cam)) proj.set(it.cam, P.projectCloud(it.xyz, st.calib, it.cam, st.adj[it.cam]));
      th[k] = MTrans.axisYaw(st.calib, it.cam, st.adj[it.cam]);
      n[k] = MTrans.prepare(it.xyz, proj.get(it.cam), pixelsOf(it.bmp), it.rect, it.others || [], th[k], B, k);
    });
    const bufs = [B.image.buffer, B.overlap.buffer, B.cloud.buffer, B.cloud2d.buffer, B.real.buffer];
    let r;
    try { r = await (await detector()).run({ kind: 'mtrans', image: bufs[0], overlap: bufs[1], cloud: bufs[2], cloud2d: bufs[3], real: bufs[4], n: jobs.length }, bufs); }
    catch (e) { console.warn('[lidar-cam] MTrans:', e.message); return out; }
    jobs.forEach(({ k: i }, k) => {
      if (n[k] < MTrans.MIN_PTS) return;
      const d = MTrans.decode(r.box, r.dir, k, th[k]), b = d.box;
      if ([b.x, b.y, b.z, b.l, b.w, b.h, b.yaw].every(Number.isFinite)) out[i] = { box: b, odds: d.odds, model: 'mtrans' };
    });
    return out;
  }
  /**
   * Learned whole-object boxes: MTrans for cars (mtransBoxes), the frustum models (frustum.js + models/frustum_*.onnx)
   * for the other classes or when MTrans cannot run: list [{res (fitFromRect result: .frustum), label, xyz, rect?, cam?,
   * bmp?, others?}] -> per item {box, odds, model} when a learned box is kept (Frustum.prefer), else null; null overall
   * when nothing is available.
   */
  async function learnedBoxes(list) {
    const mt = await mtransBoxes(list);
    if (typeof Frustum === 'undefined') return mt.some(Boolean) ? mt : null;
    const jobs = list.map((it, k) => ({ k, cls: Frustum.classOf(it.label), it })).filter((j) => !mt[j.k] && j.cls != null && Frustum.USE[j.cls] && j.it.res.frustum && j.it.res.frustum.length >= 8);
    if (!jobs.length) return mt;
    const prep = jobs.map((j) => Frustum.prepare(j.it.xyz, j.it.res.frustum, j.cls));
    const pts = new Float32Array(jobs.length * Frustum.N1 * 3), oh = new Float32Array(jobs.length * 6);
    prep.forEach((q, k) => { pts.set(q.pts, k * Frustum.N1 * 3); oh.set(q.onehot, k * 6); });
    let r;
    try { r = await (await detector()).run({ kind: 'frustum', pts: pts.buffer, onehot: oh.buffer, n: jobs.length }, [pts.buffer, oh.buffer]); }
    catch (e) { console.warn('[lidar-cam] frustum models:', e.message); return mt.some(Boolean) ? mt : null; }
    const out = mt;
    jobs.forEach((j, k) => {
      if (!Frustum.prefer(true, r.nObj[k], j.cls)) return;
      const b = Frustum.decode(r.out, k * 30, j.cls, r.cen[k], prep[k].phi);
      if ([b.x, b.y, b.z, b.l, b.w, b.h, b.yaw].every(Number.isFinite)) out[j.k] = { box: b, odds: Frustum.endOdds(r.out, k * 30), model: 'frustum' };
    });
    return out;
  }
  function refit() {
    const p = st.proposal; if (!p || p.cam !== st.cam) return;
    if (p.rect) runFit(p.rect); else if (p.click) runClick(p.click);
  }
  function tweak(fn) {
    if (!st.proposal) return;
    const b = st.proposal.box, pr = BF.pitchRollOf(b); fn(b);
    BF.setYaw(b, b.yaw, pr);                                   // tilt follows the heading
    commit(); draw(); buildBoxPanel();
  }
  /** Set the heading; with refit the box re-hugs the object's LiDAR points at that heading. */
  function setYaw(yaw, refit, rebuild = true) {
    const p = st.proposal; if (!p) return;
    yaw = BF.wrap(yaw);
    // a carried box keeps its size (set on an earlier frame): rotate only, no re-hug to this sweep's points
    const pr = BF.pitchRollOf(p.box);
    if (refit && current && !p.item && !p.edit) Object.assign(p.box, BF.refitAtYaw(current.xyz, p.points, p.box, yaw, { label: classOfLabel(st.labelId, p.box), calib: st.calib }));
    BF.setYaw(p.box, yaw, pr);
    draw();
    if (rebuild) { commit(); buildBoxPanel(); } else syncFields();
  }
  /** Snap to the ego's axes (parallel / perpendicular to the lane), then re-hug the points. */
  function snapYaw() { const p = st.proposal; if (p) setYaw(Math.round(p.box.yaw / (Math.PI / 2)) * (Math.PI / 2), true); }

  // ---- saving: every accepted box goes through an outbox that is kept in chrome.storage until CVAT
  // confirms it (created ids in the answer). A reload / network error / CVAT timeout loses nothing: the
  // outbox is retried, and after an uncertain failure the job is re-read first so nothing is created twice.
  const outboxKey = () => `outbox:${location.origin}:${st.job.id}`;
  function persistOutbox() { if (st.job) putStore({ [outboxKey()]: st.outbox }); updateSaveChip(); }
  async function restoreOutbox() {
    try { st.outbox = (await chrome.storage.local.get(outboxKey()))[outboxKey()] || []; } catch (e) { st.outbox = []; }
    if (st.outbox.length) { toast(`Đang tải lên ${st.outbox.length} box chưa lưu từ lần trước…`); flushOutbox(); }
  }
  function shapeOf(o) {
    return { type: 'cuboid', frame: o.frame, label_id: o.labelId, points: BF.toCvatPoints(o.box), occluded: false, outside: false,
      z_order: 0, rotation: 0, attributes: o.attrs || [], group: 0, source: 'semi-auto', elements: [] };
  }
  const samePlace = (sh, o) => sh.type === 'cuboid' && sh.frame === o.frame && sh.label_id === o.labelId &&
    Math.hypot(sh.points[0] - o.box.x, sh.points[1] - o.box.y, sh.points[2] - o.box.z) < 0.02 && Math.abs(sh.points[6] - o.box.l) < 0.02;
  /** items: {op: 'create' (default) | 'update' | 'delete', frame, labelId, box, shape (server copy, for update/delete)}.
   *  One call is one Ctrl+Z step; an item with `step` joins that step (a run started by it), one with `undo` is not undone in turn.
   *  Returns the step id. */
  function enqueue(items) {
    const live = items.filter((it) => !(it.step && st.undone.has(it.step)));      // a run that finished after its action was undone
    if (live.length < items.length) toast(I18N.t('toast.undo.late'));
    if (!live.length) return null;
    const step = (live.find((it) => it.step) || {}).step || (live.every((it) => it.undo) ? null : UD.open(st.undo, live[0].op || 'create'));
    for (const it of live) {
      if (it.op === 'update') st.outbox = st.outbox.filter((o) => !(o.op === 'update' && o.shape.id === it.shape.id));   // newest edit wins
      if (it.op === 'track-key') st.outbox = st.outbox.filter((o) => !(o.op === 'track-key' && o.trackId === it.trackId && o.frame === it.frame && !o.tries));
      if (it.op === 'track-create' && !it.undo && st.activeSession) st.activeSession.tracks_created = (st.activeSession.tracks_created || 0) + 1;
      st.outbox.push({ uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tries: 0, op: 'create', ...it, step: it.undo ? null : step, box: { ...it.box } });
    }
    persistOutbox(); draw(); buildBoxPanel(); flushOutbox();
    return step;
  }
  /** Ctrl+Z with no box edit to take back: drop a box just drawn, else take back the newest action sent to CVAT (P-017). */
  function undoAction() {
    const p = st.proposal;
    if (p && !p.edit && !p.item) { setProposal(null); draw(); buildBoxPanel(); toast(I18N.t('toast.undo.drop')); return; }
    const step = st.undo.steps[st.undo.steps.length - 1];
    if (!step) { toast(I18N.t('toast.nothing.undo')); return; }
    const mine = st.outbox.filter((o) => o.step === step.id);
    if (mine.some((o) => o.tries > 0)) { toast(I18N.t('toast.undo.busy')); return; }
    UD.takeLast(st.undo); st.undone.add(step.id);
    if (p && p.edit) setProposal(null);                 // the box it shows may change or go
    st.outbox = st.outbox.filter((o) => o.step !== step.id);
    const back = UD.plan(st.undo, step);
    if (back.length) enqueue(back); else { persistOutbox(); draw(); buildBoxPanel(); }
    toast(I18N.t('toast.undo.done', { n: back.length + mine.length }));
  }
  const copyOf = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  /** A track as CVAT has it before a confirmed item changes it, with what is remembered of it (for Ctrl+Z). */
  const undoSnap = async (t) => (t ? { track: copyOf(t), memo: await trackMemo(t.id) } : { track: null, memo: null });
  const keepUndo = (o, snap, after) => {
    if (o.step) UD.add(st.undo, o.step, UD.inverse(o, snap.track, after, BF.fromCvatPoints, snap.memo));
  };
  let flushing = false, retryTimer = null;
  async function flushOutbox() {
    if (flushing || !st.job || !st.outbox.length) return;
    flushing = true; clearTimeout(retryTimer);
    const jobId = st.job.id, batch = st.outbox.slice();
    const patch = (action, shapes, tracks = []) => api(`/jobs/${jobId}/annotations?action=${action}`, 'json', 'PATCH', { version: 0, tags: [], shapes, tracks });
    const isTrack = (o) => o.op.startsWith('track-');
    try {
      let todo = batch.filter((o) => !isTrack(o));
      if (todo.some((o) => o.tries > 0)) {            // a previous try may have reached CVAT: skip what is already done
        const have = (await api(`/jobs/${jobId}/annotations`)).shapes || [];
        const byId = new Map(have.map((x) => [x.id, x]));
        todo = todo.filter((o) => {
          if (o.op === 'create') { const sh = have.find((x) => samePlace(x, o)); if (sh) { confirmed(o, sh); return false; } return true; }
          const cur = byId.get(o.shape.id);
          if (o.op === 'delete' && !cur) { confirmed(o, null); return false; }
          if (o.op === 'update' && !cur) { st.outbox = st.outbox.filter((x) => x.uid !== o.uid); toast('Box đã bị xoá trong CVAT, bỏ bản sửa'); return false; }
          if (o.op === 'update' && samePlace(cur, o)) { confirmed(o, cur); return false; }
          return true;
        });
      }
      todo.forEach((o) => { o.tries++; });
      persistOutbox();
      const creates = todo.filter((o) => o.op === 'create'), updates = todo.filter((o) => o.op === 'update'), deletes = todo.filter((o) => o.op === 'delete');
      if (creates.length) {
        const created = ((await patch('create', creates.map(shapeOf))).shapes || []).filter((x) => x.id != null);
        for (const o of creates) {
          const sh = created.find((x) => samePlace(x, o));
          if (!sh) throw new Error('CVAT trả lời nhưng không có box vừa gửi (đã gửi, sẽ kiểm tra lại)');
          confirmed(o, sh);
        }
      }
      if (updates.length) {
        const res = await patch('update', updates.map((o) => ({ ...o.shape, label_id: o.labelId, points: BF.toCvatPoints(o.box) })));
        for (const o of updates) confirmed(o, (res.shapes || []).find((x) => x.id === o.shape.id) || { ...o.shape, label_id: o.labelId, points: BF.toCvatPoints(o.box) });
      }
      if (deletes.length) { await patch('delete', deletes.map((o) => o.shape)); for (const o of deletes) confirmed(o, null); }
      const tracksTodo = batch.filter(isTrack);
      if (tracksTodo.length) { await flushTracks(tracksTodo, patch); await loadExisting(); }
      st.saveError = null;
      const n = (k) => batch.filter((o) => o.op === k).length, nt = batch.filter(isTrack).length;
      toast(`CVAT (job ${jobId}) ✓ ${[n('create') && `lưu ${n('create')}`, n('update') && `sửa ${n('update')}`, n('delete') && `xoá ${n('delete')}`].filter(Boolean).join(' · ')}${n('create') + n('update') + n('delete') ? ' box' : ''}${nt ? `${n('create') + n('update') + n('delete') ? ' · ' : ''}track ${nt} thay đổi` : ''}`);
    } catch (e) {
      st.saveError = e.message;
      toast(I18N.t('toast.save.err', { err: e.message }));
      retryTimer = setTimeout(flushOutbox, 10000);
    } finally {
      flushing = false; persistOutbox(); draw(); buildBoxPanel();
      if (!st.saveError && st.outbox.length) flushOutbox();   // boxes added while this request was running
    }
  }
  /**
   * Track operations, in order: each reads the track as CVAT has it now (so a retry after an uncertain failure
   * applies the same change again, not twice) and sends the whole track back (PATCH update / create / delete).
   */
  /** What is remembered of a track: {keys: what the extension wrote into it (a later run tells these from keyframes set
   *  by hand: anchors) | null, size: the ID's size the user set ("Áp cho mọi frame") | null, own: frames given a size of
   *  their own ("Chỉ frame này")}. An entry from before sizes were remembered is the keys list alone. */
  const keysKey = () => `trackKeys:${location.origin}:${st.job.id}`;
  const memoOf = (e) => (Array.isArray(e) ? { keys: e, size: null, own: [] } : { keys: null, size: null, own: [], ...e });
  async function trackMemo(trackId) { try { return memoOf(((await chrome.storage.local.get(keysKey()))[keysKey()] || {})[trackId]); } catch (e) { return memoOf(null); } }
  async function reviseMemo(trackId, fn) {
    try {
      const all = (await chrome.storage.local.get(keysKey()))[keysKey()] || {};
      all[trackId] = fn(memoOf(all[trackId]));
      await chrome.storage.local.set({ [keysKey()]: all });
    } catch (e) { /* only a hint: without it every keyframe counts as set by hand */ }
  }
  // `motion`: how the track was followed (static / moving). A later automatic run (after a hand edit) must follow it the same way:
  // a static track re-run as moving chases points and ground and jumps.
  const rememberKeys = (trackId, o) => reviseMemo(trackId, (m) => ({ ...m, keys: TJ.writtenAfter(m.keys, o.keys, o.range, o.anchorFrames || []), ...(o.motion ? { motion: o.motion } : {}) }));
  /** The anchors of a track (TJ.anchorsFrom) with what is remembered of it. */
  const anchorsOf = (shapes, memo) => TJ.anchorsFrom(shapes, memo.keys, memo.own);
  async function flushTracks(ops, patch) {
    const have = (await api(`/jobs/${st.job.id}/annotations`)).tracks || [];
    for (const o of ops) {
      o.tries++; persistOutbox();
      const pts = o.box ? BF.toCvatPoints(o.box) : null;
      if (o.op === 'track-create' || (o.op === 'track-set' && o.trackId == null)) {
        if (o.track) {
          const res = await patch('create', [], [o.track]);
          const id = ((res && res.tracks) || []).map((t) => t.id).find((v) => v != null) ?? null;
          const tr = ((res && res.tracks) || []).find((t) => t.id === id) || { ...o.track, id };
          if (o.memo && id != null) await reviseMemo(id, () => o.memo);      // a track brought back by Ctrl+Z: what was remembered of it too
          keepUndo(o, { track: null, memo: null }, tr);
          confirmed(o, tr);
          st.outbox = st.outbox.filter((x) => x.uid !== o.uid);
          st.cvatStale = true;
          persistOutbox();
          continue;
        }
        const first = o.keys ? o.keys[0] : { frame: o.frame, points: pts };
        const same = o.tries > 1 && have.find((t) => t.label_id === o.labelId && t.shapes.some((sh) => sh.frame === first.frame && samePlace({ ...sh, label_id: t.label_id }, { ...o, frame: first.frame, box: BF.fromCvatPoints(first.points) })));
        let id = same ? same.id : null;
        if (!same) {
          const fresh = TR.newTrack({ frame: first.frame, labelId: o.labelId, points: first.points, attributes: o.attrs || [] });
          const res = await patch('create', [], [o.keys ? TR.fromFrames(fresh, o.keys) : fresh]);
          id = ((res && res.tracks) || []).map((t) => t.id).find((v) => v != null) ?? null;
          if (id != null && o.keys) await rememberKeys(id, o);
        }
        if (id != null) keepUndo(o, { track: null, memo: null }, { id, label_id: o.labelId });
        if (o.follow && id != null) trackRun({ trackId: id, frame: o.frame, box: o.box, labelId: o.labelId, lo: o.lo, hi: o.hi, motion: o.motion || 'moving', base: keySig([{ frame: first.frame, outside: false, points: first.points }]), step: o.step });
      } else if (o.op === 'track-update' && o.track) {
        const snap = await undoSnap(have.find((x) => x.id === o.track.id));
        const res = await patch('update', [], [o.track]);
        const tr = ((res && res.tracks) || []).find((t) => t.id === o.track.id) || o.track;
        if (o.memo) await reviseMemo(tr.id, () => o.memo);
        keepUndo(o, snap, tr);
        confirmed(o, tr);
        st.outbox = st.outbox.filter((x) => x.uid !== o.uid);
        st.cvatStale = true;
        persistOutbox();
        continue;
      } else if (o.op === 'track-set') {
        const t = have.find((x) => x.id === o.trackId);
        const inRange = (l) => l.filter((x) => x.frame >= o.range[0] && x.frame <= o.range[1]);
        if (!t) toast('Track đã bị xoá trong CVAT, bỏ thay đổi');
        else if (o.base && JSON.stringify(inRange(keySig(t.shapes.filter((x) => x.type === 'cuboid')))) !== JSON.stringify(inRange(o.base))) {
          toast(`Track #${o.trackId} đã đổi trong lúc tính: bấm Shift+K để tính lại`);      // an edit made meanwhile is not overwritten
        } else {
          const cub = { ...t, shapes: t.shapes.filter((x) => x.type === 'cuboid').sort((a, b) => a.frame - b.frame) };
          let keys = o.keys, anchorFrames = o.anchorFrames || [];
          if (o.bound) {                  // keyframes set by hand while this run was computing are kept exactly as they are
            const memo = await trackMemo(t.id), hand = memo.keys ? anchorsOf(cub.shapes, memo) : [];
            if (hand.length) {
              const at = new Map(cub.shapes.map((x) => [x.frame, x]));
              keys = keys.filter((k) => !at.has(k.frame) || !hand.some((a) => a.frame === k.frame));
              for (const a of hand) if (a.frame >= o.range[0] && a.frame <= o.range[1]) keys.push({ frame: a.frame, outside: !!a.outside, points: at.get(a.frame).points });
              anchorFrames = [...anchorFrames, ...hand.map((a) => a.frame)];
            }
          }
          const nt = TR.fromFrames(cub, keys, o.range);
          const snap = await undoSnap(t);
          await patch('update', [], [nt]);
          await rememberKeys(t.id, { ...o, keys, anchorFrames });
          keepUndo(o, snap, nt);
          Object.assign(t, nt);
        }
      } else {
        const t = have.find((x) => x.id === o.trackId);
        const snap = await undoSnap(t);
        if (!t) { toast('Track đã bị xoá trong CVAT, bỏ thay đổi'); }
        else if (o.op === 'track-delete') { await patch('delete', [], [t]); keepUndo(o, snap, null); }
        else {
          const cub = { ...t, shapes: t.shapes.filter((x) => x.type === 'cuboid').sort((a, b) => a.frame - b.frame) };
          let nt = o.op === 'track-key' ? TR.upsertKey(cub, o.frame, pts)
            : o.op === 'track-size' ? TR.upsertKey(TR.setSize(cub, o.size), o.frame, pts)
              : o.op === 'track-outside' ? await outsideAt(cub, o.frame, t.id)
                : TR.toggleKey(cub, o.frame);
          if (o.labelId != null && o.op === 'track-key') nt = { ...nt, label_id: o.labelId };
          await patch('update', [], [nt]);
          if (o.op === 'track-size') {          // the ID's size from now on (every run keeps it); the machine's keyframes are still the machine's; the edited frame is a hand anchor
            const i = st.trackInfo.get(o.trackId); if (i) i.size = o.size;
            await reviseMemo(t.id, (m) => ({ ...m, keys: m.keys && TJ.resignedAfterSize(m.keys, cub.shapes, nt.shapes, o.frame), size: { ...o.size }, own: [] }));
          }
          if (o.op === 'track-key' && o.lock) await reviseMemo(t.id, (m) => ({ ...m, keys: m.keys && m.keys.filter((w) => w.frame !== o.frame) }));   // no longer the machine's: a hand keyframe
          if (o.op === 'track-key' && o.own) await reviseMemo(t.id, (m) => ({ ...m, own: [...m.own.filter((f) => f !== o.frame), o.frame] }));
          keepUndo(o, snap, nt);
          Object.assign(t, nt);
        }
      }
      st.outbox = st.outbox.filter((x) => x.uid !== o.uid);
      st.cvatStale = true;
      persistOutbox();
    }
    // the runs changed what is kept: the open card asks CVAT again at once, the others when they are opened
    const cur = st.proposal && st.proposal.edit ? st.proposal.edit.trackId : null;
    for (const id of [...st.held.keys()]) if (id !== cur) st.held.delete(id);
    if (cur != null) refreshHeld(cur);
  }
  /** O: the track leaves the scene at `frame` (or comes back when it was outside). Leaving also drops the keyframes the
   *  extension wrote after it: every tracked frame is a keyframe, so they would show the box again the next frame.
   *  Keyframes set by hand stay (the object re-enters there), as do outside keyframes. */
  async function outsideAt(cub, frame, trackId) {
    const leaving = !!TR.at(cub, frame), nt = TR.setOutside(cub, frame, leaving);
    if (!leaving) return nt;
    const memo = await trackMemo(trackId);
    if (!memo.keys) return nt;                                    // nothing remembered: all keyframes count as set by hand
    const hand = new Set(anchorsOf(nt.shapes, memo).map((a) => a.frame));
    const dropped = new Set(nt.shapes.filter((x) => x.frame > frame && !x.outside && !hand.has(x.frame)).map((x) => x.frame));
    if (!dropped.size) return nt;
    await reviseMemo(trackId, (m) => ({ ...m, keys: m.keys && m.keys.filter((w) => !dropped.has(w.frame)) }));
    return { ...nt, shapes: nt.shapes.filter((x) => !dropped.has(x.frame)) };
  }
  /** CVAT confirmed an outbox item: update the local records (sh = server copy, null for a delete). */
  function confirmed(o, sh) {
    st.outbox = st.outbox.filter((x) => x.uid !== o.uid);
    st.cvatStale = true;
    if (o.restores != null && sh) UD.moved(st.undo, o.op.startsWith('track-') ? 'track' : 'shape', o.restores, sh.id);   // brought back by Ctrl+Z under a new id
    if (!o.op.startsWith('track-')) keepUndo(o, { track: o.op === 'create' ? null : o.shape, memo: null }, sh);
    if (o.op === 'track-create' || o.op === 'track-update') {
      const rec = { id: sh.id, labelId: sh.label_id, track: sh,
        keys: (sh.shapes || []).filter((x) => x.type === 'cuboid').sort((a, b) => a.frame - b.frame)
          .map((x) => ({ frame: x.frame, outside: !!x.outside, points: x.points, shape: x })) };
      const tracks = st.existing ? st.existing.tracks : [];
      const i = tracks.findIndex((t) => t.id === rec.id);
      if (i < 0) tracks.push(rec); else tracks[i] = rec;
      st.savedTrackIds.add(rec.id);
      if (o.op === 'track-create' && o.sourceShape) enqueue([{ op: 'delete', shape: o.sourceShape, frame: o.sourceFrame, labelId: o.labelId, box: o.sourceBox, step: o.step }]);
      return;
    }
    if (sh && sh.id != null) {
      const s = st.scores.find((x) => x.frame === o.frame && Math.hypot(x.box.x - o.box.x, x.box.y - o.box.y) < 0.5);
      if (s) { s.shapeId = sh.id; saveScores(); }
    }
    if (o.op === 'create') { st.saved.push({ shape: sh, box: o.box, frame: o.frame, labelId: o.labelId, vel: o.vel || null, reviewId: o.reviewId ?? null }); return; }
    for (const list of [st.existing ? st.existing.shapes : [], st.saved]) {
      const k = list.findIndex((r) => r.shape && r.shape.id === o.shape.id);
      if (k < 0) continue;
      if (o.op === 'delete') {
        list.splice(k, 1);
        const sk = st.scores.findIndex((x) => (sh && x.shapeId === sh.id) || (x.frame === o.frame && Math.hypot(x.box.x - o.box.x, x.box.y - o.box.y) < 0.5));
        if (sk >= 0) { st.scores.splice(sk, 1); saveScores(); }
      }
      else Object.assign(list[k], { shape: sh, box: { ...o.box }, labelId: o.labelId });
    }
  }
  // ---- "box đã sửa" (PLAN 2.3): every machine box that is saved or thrown away gets a line in a log kept in
  // chrome.storage (all jobs of this CVAT), exported as CSV; see editlog.js for what counts as edited.
  const editlogKey = () => `editlog:${location.origin}`;
  async function loadEditlog() { try { st.editlog = (await chrome.storage.local.get(editlogKey()))[editlogKey()] || []; } catch (e) { st.editlog = []; } }
  function saveEditlog() { putStore({ [editlogKey()]: st.editlog }); }
  const scoresKey = () => (st.job ? `scores:${location.origin}:${st.job.id}` : null);
  async function loadScores() {
    const k = scoresKey(); if (!k) { st.scores = []; return; }
    try { st.scores = (await chrome.storage.local.get(k))[k] || []; } catch (e) { st.scores = []; }
  }
  function saveScores() {
    const k = scoresKey(); if (!k) return;
    putStore({ [k]: st.scores });
  }
  function recordScore({ frame, box, score, manual = false, labelId, shapeId, trackId }) {
    if (!box) return;
    const k = st.scores.findIndex((x) => x.frame === frame && Math.hypot(x.box.x - box.x, x.box.y - box.y) < 0.5);
    const entry = {
      frame,
      box: { x: box.x, y: box.y, z: box.z, l: box.l, w: box.w, h: box.h, yaw: box.yaw },
      score: score != null ? score : null,
      manual: !!manual,
      labelId: labelId ?? null,
      shapeId: shapeId ?? null,
      trackId: trackId ?? null,
    };
    if (k >= 0) st.scores[k] = { ...st.scores[k], ...entry };
    else st.scores.push(entry);
    saveScores();
  }
  /** What the machine offered for the boxes of a review batch, frozen before the annotator touches them. */
  function stampMachine(items, how) {
    for (const it of items) it.src = { how, label: it.labelId, machine: [it.fit, it.pred, it.box].filter(Boolean).map((b) => ({ ...b })) };
  }
  /** A box fitted from a drawn rectangle / click: the machine's box is the one the fit (and the models) gave. */
  function machineOf(p) {
    return { nAdjust: p.nAdjust || 0, src: { how: 'tay', label: st.labelId, machine: [{ ...p.orig }] }, model: p.model || (p.how === 'learned' ? 'frustum' : ''), points: p.points, cam: p.cam, frame: p.frame };
  }
  /** it: a batch item or machineOf(p). Returns the record (also kept in the log). */
  function logBox(action, it, box, labelId, frame) {
    if (!it.src) return null;
    const det = it.det, model = it.model || (it.how === 'learned' ? 'frustum' : it.src.how === 'lan' ? '' : 'hình học');
    const r = EL.record({ action, job: st.job && st.job.id, frame: frame ?? it.frame ?? st.frame, camera: it.cam || st.cam, how: it.src.how, model,
      score: det ? det.score : null, points: it.points ? it.points.length : null, labelName: labelName(labelId ?? it.src.label),
      machine: it.src.machine, saved: box, machineLabel: it.src.label, savedLabel: labelId,
      trackId: it.trackId ?? null, nAdjust: it.nAdjust ?? 0 });   // numbers and opaque ids only: the boxes themselves are not logged
    if (!st.activeSession && !ui.sessDlg) newSession();
    if (st.activeSession && typeof SessionManager !== 'undefined') {
      SessionManager.recordAction(st.activeSession, r);
      SessionManager.saveActiveSession(location.origin, st.activeSession);
      updateSessionLiveChip();
    }
    st.editlog.push(r); saveEditlog();
    return r;
  }
  function attrsFor(labelId, r) {
    const l = r && st.job.labels.find((x) => x.id === labelId);
    return l ? EL.cvatAttributes(l, r) : [];
  }
  function exportEditlog() {
    const a = el('a', { href: URL.createObjectURL(new Blob([EL.toCsv(st.editlog)], { type: 'text/csv' })), download: `box-da-sua-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function clearEditlog() {
    if (!window.confirm(`Xoá ${st.editlog.length} dòng log box đã sửa? (Xuất CSV trước nếu cần)`)) return;
    st.editlog = []; saveEditlog(); buildBoxPanel();
  }
  /** A box that is not in CVAT yet: carried from a track -> keyframe of that track; an object of a range scan -> a new
   *  track, tracked over the frames it was seen in (spec: Quét đoạn 5); else a shape or a new track (save mode of the task, PLAN 2.1). */
  // NOTE: Đã tắt tự động chạy track cả job bằng ICP để tránh đơ/lag 15-30s. Sẽ cập nhật bằng 3D IoU Tracker sau.
  function newBoxOp(o, item) {
    const base = item && item.reviewId != null ? { ...o, reviewId: item.reviewId } : o;
    if (item && item.trackId != null) return { ...base, op: 'track-key', trackId: item.trackId };
    if (item && item.span) return { ...base, op: 'track-create' };
    return st.saveMode === 'track' ? { ...base, op: 'track-create' } : base;
  }
  /** O / K on the selected track box: outside from this frame / keyframe on-off (CVAT's own keys). */
  function trackCmd(kind) {
    const p = st.proposal, t = p && p.edit && p.edit.trackId != null ? p.edit : null;
    if (!t) { toast(kind === 'outside' ? I18N.t('toast.pickTrack.O') : I18N.t('toast.pickTrack.K')); return; }
    setProposal(null);
    enqueue([{ op: kind === 'outside' ? 'track-outside' : 'track-keyframe', trackId: t.trackId, frame: t.frame, labelId: t.labelId, box: { ...t.box } }]);
    toast(kind === 'outside' ? I18N.t('toast.kf.out', { f: t.frame }) : t.key ? I18N.t('toast.kf.off', { f: t.frame }) : I18N.t('toast.kf.on', { f: t.frame }));
  }
  // ---- keyframes the annotator keeps. Every frame the tool tracks is a keyframe too, so "Keyframe" alone says nothing; the card says:
  //   green  "Đang giữ keyframe"  : set by hand (kept): the automatic runs after an edit elsewhere stop at it and never rewrite it
  //   blue   "Tool tự tính"       : written by the tool: a later run may recompute it (Enter keeps it)
  //   red    "Lưu keyframe mới"   : the box was edited: saving makes it a new kept keyframe and recomputes the frames around it
  const markHeld = (trackId, frame) => { const h = st.held.get(trackId) || new Set(); h.add(frame); st.held.set(trackId, h); };
  const heldBusy = new Set();
  /** Frames of a track that are kept (set by hand), from CVAT as it is now and what the extension remembers it wrote. */
  async function refreshHeld(trackId) {
    if (heldBusy.has(trackId) || !st.job) return;
    heldBusy.add(trackId);
    let frames = new Set();
    try {
      const tr = ((await api(`/jobs/${st.job.id}/annotations`)).tracks || []).find((x) => x.id === trackId);
      const shapes = tr ? tr.shapes.filter((x) => x.type === 'cuboid').sort((a, b) => a.frame - b.frame) : [], memo = await trackMemo(trackId);
      frames = new Set((memo.keys ? anchorsOf(shapes, memo) : shapes.filter((x) => x.keyframe !== false && !x.outside).map((x) => ({ frame: x.frame }))).filter((a) => !a.outside).map((a) => a.frame));
    } catch (e) { /* unknown: shown as not kept */ }
    heldBusy.delete(trackId);
    st.held.set(trackId, frames);
    const p = st.proposal;
    if (p && p.edit && p.edit.trackId === trackId) applyKeyframeState(p);
  }
  const keptOf = (p) => st.held.get(p.edit.trackId) || new Set();
  // Three colours, one button (the old main button) and the badge:
  //   red   "Keyframe mới" / "Keyframe của bạn" : your keyframes (the frame the track started from, and every frame you finished):
  //                                              they have priority, automatic runs never rewrite them
  //   blue  "Track ngược"                       : a frame BETWEEN two red keyframes: the tool traces it back/forth between them. Editing
  //                                              one makes it red and splits the stretch in two: only those two are computed again
  //   green "3D Track"                          : a frame the 3D track wrote that needed no edit (outside those stretches, e.g. after the last red)
  // The colour comes from where the frame sits, nothing to switch. Enter on an unedited frame makes it a red keyframe.
  function keyframeState(p) {
    const kept = keptOf(p), f = p.frame, edited = !sameBox(p.box, p.orig);
    if (edited) return { cls: 'err', btn: 'kf-new', key: 'Enter', text: 'Keyframe mới', title: 'Enter: lưu thành keyframe đỏ. Chỉ đoạn giữa 2 keyframe đỏ kề nó được tính lại' };
    if (kept.has(f)) return { cls: 'err', btn: 'kf-new', key: '', text: 'Keyframe', title: 'Keyframe đỏ của bạn (ưu tiên): tool không ghi đè' };
    if ([...kept].some((a) => a < f) && [...kept].some((a) => a > f)) return { cls: 'info', btn: 'kf-back', key: 'K', text: 'Track ngược', title: 'Giữa 2 keyframe đỏ, do tool track. Sửa box, hoặc nhấn K nếu đúng, để thành keyframe đỏ' };
    return { cls: 'ok', btn: 'kf-hold', key: 'K', text: '3D Track', title: 'Do 3D Track tạo, không cần sửa. Nhấn K để giữ làm keyframe đỏ' };
  }
  /** Badge and main button follow the frame live (also while the box is dragged), without rebuilding the card. */
  function applyKeyframeState(p) {
    renderFrameMarks();
    if (!p || !p.edit || p.edit.trackId == null) return;
    const k = keyframeState(p), out = !!p.edit.outside;
    if (ui.card) ui.card.dataset.kf = out ? 'out' : k.btn;                                   // the stripe on the card's left edge
    if (ui.cardStar) ui.cardStar.classList.toggle('on', keptOf(p).has(p.frame));
    if (ui.kvBadge) { ui.kvBadge.className = `cv-tag ${k.cls}`; ui.kvBadge.textContent = out ? I18N.t('obj.left') : k.text; ui.kvBadge.title = k.title; }
    if (ui.saveBox && ui.saveBox.firstChild) {
      ui.saveBox.className = `pri ${k.btn}`; ui.saveBox.title = k.title;
      ui.saveBox.firstChild.textContent = k.text;
      const kb = ui.saveBox.lastChild;
      if (kb && kb !== ui.saveBox.firstChild) { kb.textContent = k.key; kb.hidden = !k.key; }      // the shortcut that does what the colour says
    }
  }
  /** Enter / K on a track frame that was not edited (explicit only: moving to another frame does nothing to it): it becomes a red keyframe
   *  and the stretches next to it are computed again. A frame that already is one has nothing to do. */
  function makeKeyframe(p, labelId) {
    if (keptOf(p).has(p.frame)) { toast(I18N.t('toast.kf.already', { f: p.frame })); return; }
    const step = holdFrame(p, labelId, false);
    retrackAfter(p.edit.trackId, p.frame, p.box, labelId, step);
  }
  /** K: the open track frame becomes a red keyframe (the same as Enter). */
  function keyframeKey() {
    const p = st.proposal;
    if (!p || !p.edit || p.edit.trackId == null) { toast(I18N.t('toast.pickTrack.K')); return; }
    if (sameBox(p.box, p.orig)) makeKeyframe(p, p.edit.labelId); else saveProposal(true);
  }
  function holdFrame(p, labelId, say = true) {
    markHeld(p.edit.trackId, p.frame);   // before enqueue: it redraws the card, which must already show it as kept
    const step = enqueue([{ op: 'track-key', trackId: p.edit.trackId, frame: p.frame, labelId, box: { ...p.box }, lock: true }]);
    if (say) toast(`Đã giữ keyframe ở frame ${p.frame}: tự tính lại sẽ dừng ở đây và không ghi đè`);
    return step;
  }
  /**
   * Modal dialog to configure 3D tracking: select frame count/range and motion type (moving vs static).
   * Triggered by Shift+K, L, clicking track button, or #trackGo.
   */
  function openTrackDialog(defaultLo, defaultHi) {
    const p = st.proposal;
    if (!p || !st.job) {
      toast(I18N.t('trk.pick'));
      return;
    }
    const f0 = p.frame ?? st.frame;
    const isTrk = !!(p.edit && p.edit.trackId != null);
    const trackId = isTrk ? p.edit.trackId : null;
    const info = trackId != null ? st.trackInfo.get(trackId) : null;
    const minFrame = st.job.start, maxFrame = st.job.stop;

    let loVal = Number.isFinite(defaultLo) ? defaultLo : (isTrk && info ? info.first : f0);
    let hiVal = Number.isFinite(defaultHi) ? defaultHi : (isTrk && info ? Math.max(info.last, f0 + 20) : Math.min(maxFrame, f0 + 20));
    loVal = Math.max(minFrame, Math.min(maxFrame, loVal));
    hiVal = Math.max(loVal, Math.min(maxFrame, hiVal));

    const objName = trackId != null ? `Track #${trackId}` : (p.edit ? `Box #${p.edit.shape?.id || '?'}` : `Box ${I18N.t('obj.new')}`);
    const lblId = p.labelId ?? (p.edit && p.edit.labelId) ?? (p.item && p.item.labelId) ?? st.labelId;
    const lblName = labelName(lblId);

    // Inputs
    const loInp = el('input', { type: 'number', min: minFrame, max: maxFrame, value: loVal, style: 'width:70px;text-align:center;' });
    const hiInp = el('input', { type: 'number', min: minFrame, max: maxFrame, value: hiVal, style: 'width:70px;text-align:center;' });
    const countInp = el('input', { type: 'number', min: 1, max: Math.max(1, maxFrame - f0), value: Math.max(1, hiVal - f0), style: 'width:70px;text-align:center;' });

    // Sync count and hi
    countInp.oninput = () => {
      const c = Number(countInp.value) || 0;
      hiInp.value = Math.min(maxFrame, f0 + c);
    };
    hiInp.oninput = () => {
      const h = Number(hiInp.value) || f0;
      countInp.value = Math.max(0, h - f0);
    };

    // Quick range buttons
    const makeQuickBtn = (label, frames) => el('button', {
      type: 'button',
      className: 'sm ghost',
      textContent: label,
      onclick: () => {
        countInp.value = frames;
        hiInp.value = Math.min(maxFrame, f0 + frames);
      }
    });

    const radioMoving = el('input', { type: 'radio', name: 'track-motion', value: 'moving', checked: true });
    const radioStatic = el('input', { type: 'radio', name: 'track-motion', value: 'static' });

    const close = () => { ui.trackDlg?.remove(); ui.trackDlg = null; };
    const go = async () => {
      const lo = Number(loInp.value), hi = Number(hiInp.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < minFrame || hi > maxFrame) {
        toast(I18N.t('trk.badrange', { a: minFrame, b: maxFrame }));
        return;
      }
      const motion = radioStatic.checked ? 'static' : 'moving';
      close();
      await ensurePose();
      trackFollow({ lo, hi, motion });
    };

    const autoPoseNotice = !st.poseMeta ? el('div', {
      style: 'margin-top:10px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb, var(--accent) 8%, var(--surface));border:1px dashed var(--line-hi);display:flex;align-items:center;justify-content:space-between;gap:8px;'
    },
      el('span', { style: 'font-size:11.5px;color:var(--text-2);', textContent: I18N.t('trk.nopose') }),
      el('button', {
        type: 'button',
        className: 'sm pri',
        textContent: I18N.t('trk.nopose.go'),
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await runAutoOdometry();
          if (ok && autoPoseNotice) autoPoseNotice.remove();
        }
      })
    ) : '';

    const dlg = el('div', { className: 'rangeDlg trackDlg', role: 'dialog', ariaLabel: 'Track 3D Cuboid' },
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;' },
        el('b', { style: 'font-size:15px;color:var(--text);', textContent: `${I18N.t('tool.track')}: ${objName}` }),
        el('span', { className: 'chip', textContent: lblName || 'cuboid' })
      ),
      el('div', { className: 'muted', style: 'font-size:12px;margin-bottom:12px;', textContent: I18N.t('trk.origin', { f: f0 }) }),

      el('div', { style: 'display:flex;flex-direction:column;gap:8px;background:var(--raised);padding:10px;border-radius:6px;border:1px solid var(--line);' },
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;' },
          el('span', { style: 'font-size:13px;font-weight:500;color:var(--text);', textContent: I18N.t('trk.count') }),
          el('div', { style: 'display:flex;align-items:center;gap:6px;' },
            countInp,
            el('span', { className: 'muted', textContent: I18N.t('trk.frames') })
          )
        ),
        el('div', { style: 'display:flex;align-items:center;gap:6px;justify-content:flex-end;flex-wrap:wrap;' },
          makeQuickBtn('+5', 5),
          makeQuickBtn('+10', 10),
          makeQuickBtn('+20', 20),
          makeQuickBtn('+50', 50),
          makeQuickBtn(I18N.t('trk.tojob'), Math.max(1, maxFrame - f0))
        ),
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:4px;padding-top:6px;border-top:1px dashed var(--line);font-size:12px;' },
          el('span', { className: 'muted', textContent: I18N.t('trk.range') }),
          el('div', { style: 'display:flex;align-items:center;gap:4px;' },
            el('span', { className: 'muted', textContent: I18N.t('trk.from') }), loInp,
            el('span', { className: 'muted', textContent: I18N.t('trk.to') }), hiInp
          )
        )
      ),

      el('div', { className: 'motionChoice', role: 'radiogroup', style: 'margin-top:12px;' },
        el('b', { style: 'font-size:13px;margin-bottom:2px;color:var(--text);', textContent: I18N.t('trk.motion') }),
        el('label', { style: 'padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--surface);cursor:pointer;' },
          radioMoving,
          el('span', {},
            el('div', { style: 'font-weight:600;color:var(--accent);', textContent: I18N.t('trk.moving') }),
            el('div', { className: 'muted', style: 'font-size:11px;', textContent: I18N.t('trk.moving.d') })
          )
        ),
        el('label', { style: 'padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--surface);cursor:pointer;' },
          radioStatic,
          el('span', {},
            el('div', { style: 'font-weight:600;color:var(--ok);', textContent: I18N.t('trk.static') }),
            el('div', { className: 'muted', style: 'font-size:11px;', textContent: I18N.t('trk.static.d') })
          )
        )
      ),

      autoPoseNotice,

      el('div', { className: 'row', style: 'margin-top:16px;display:flex;gap:8px;justify-content:flex-end;' },
        el('button', { type: 'button', textContent: I18N.t('trk.cancel'), onclick: close }),
        el('button', { type: 'button', className: 'pri', textContent: I18N.t('trk.start'), onclick: go })
      )
    );

    const back = el('div', { className: 'rangeBack', onclick: (e) => { if (e.target === back) close(); } }, dlg);
    back.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      if (e.key === 'Enter') { go(); e.preventDefault(); }
    });
    ui.trackDlg = back;
    ui.root.append(back);
    countInp.focus();
    countInp.select();
  }

  /** Shift+K: track the selected box/track along subsequent frames. Accepts options object { lo, hi, motion } or (lo, hi). */
  async function trackFollow(options = {}, hiArg) {
    let lo, hi, motion = 'moving';
    if (typeof options === 'object' && options !== null) {
      lo = options.lo;
      hi = options.hi;
      motion = options.motion || 'moving';
    } else if (typeof options === 'number') {
      lo = options;
      hi = hiArg;
    }
    const p = st.proposal;
    if (!p) { toast(I18N.t('toast.pickBox.track')); return; }
    const f0 = p.frame ?? st.frame;
    const isTrk = !!(p.edit && p.edit.trackId != null);
    const trackId = isTrk ? p.edit.trackId : null;
    const info = trackId != null ? st.trackInfo.get(trackId) : null;
    const loInp = ui.root && ui.root.querySelector('#trackLo'), hiInp = ui.root && ui.root.querySelector('#trackHi');
    lo = Number.isFinite(lo) ? lo : (loInp ? Number(loInp.value) : (isTrk && info ? info.first : f0));
    hi = Number.isFinite(hi) ? hi : (hiInp ? Number(hiInp.value) : (isTrk && info ? Math.max(info.last, f0 + 20) : Math.min(st.job.stop, f0 + 20)));
    const labelId = p.labelId ?? (p.edit && p.edit.labelId) ?? (p.item && p.item.labelId) ?? st.labelId;

    if (p.edit && p.edit.shape && trackId == null) {
      enqueue([{ op: 'delete', shape: p.edit.shape, frame: f0, labelId, box: p.box }]);
    }
    const box = { ...p.box };
    setProposal(null);
    trackRun({ trackId, frame: f0, box, labelId, lo, hi, motion });
  }
  /** Frame `frame` of the track was edited by hand (it is a keyframe now): the frames up to the previous keyframe set by
   *  hand (or the track's first) are worked out again from it, blended into that keyframe's side; the frames after it up to
   *  the next hand keyframe, or a few past the track's last, are followed on from it. Hand keyframes are never rewritten. */
  async function retrackAfter(trackId, frame, box, labelId, step = null) {
    const memo = await trackMemo(trackId);
    trackRun({ trackId, frame, box: { ...box }, labelId, bound: true, motion: memo.motion || 'moving', step });   // one Ctrl+Z takes back the edit and this run
    toast(`Track #${trackId}: tính lại đoạn giữa keyframe đỏ trước và sau frame ${frame}…`);
  }
  /** Size asked after a track box changed size: every frame of the ID (the ID's size from now on), or this frame only. */
  function answerSize(all) {
    const a = st.sizeAsk; st.sizeAsk = null;
    if (!a) return;
    markHeld(a.trackId, a.frame);
    if (all) enqueue([{ op: 'track-size', trackId: a.trackId, size: a.size, frame: a.frame, box: a.box, labelId: a.labelId }]);
    else enqueue([{ op: 'track-key', trackId: a.trackId, frame: a.frame, labelId: a.labelId, box: a.box, own: true }]);
    buildBoxPanel();
  }
  /** Accept the open box: new -> create, an existing one -> update (only if it changed). */
  function saveProposal(explicit = false) {
    const p = st.proposal;
    if (!p || !st.job) return;
    if (st.labelId == null) { toast('Job không có nhãn dùng được cho cuboid'); return; }
    if (!BF.toCvatPoints(p.box).every(Number.isFinite)) { toast('Box không hợp lệ'); return; }
    const labelId = st.labelId;                     // before moving on: the next box selects its own label
    setProposal(null);
    if (p.item) { if (st.batch) st.batch.savedCount = (st.batch.savedCount || 0) + 1; nextInBatch(p.item); }
    if (p.edit) {
      if (sameBox(p.box, p.orig) && p.edit.labelId === labelId) {   // nothing changed
        if (explicit && p.edit.trackId != null) makeKeyframe(p, labelId); else { draw(); buildBoxPanel(); }
        return;
      }
      if (p.edit.trackId != null) {
        const resized = ['l', 'w', 'h'].some((k) => Math.abs(p.box[k] - p.orig[k]) > 0.005);
        if (resized) {
          const o = p.orig, dyaw = Math.abs(Math.atan2(Math.sin(p.box.yaw - o.yaw), Math.cos(p.box.yaw - o.yaw)));
          const moved = Math.hypot(p.box.x - o.x, p.box.y - o.y, p.box.z - o.z) > 0.01 || dyaw > 0.1 * DEG;
          st.sizeAsk = { trackId: p.edit.trackId, frame: p.frame, box: { ...p.box }, labelId, size: { l: p.box.l, w: p.box.w, h: p.box.h }, moved };
          draw(); buildBoxPanel(); return;
        }
        markHeld(p.edit.trackId, p.frame);
        const step = enqueue([{ op: 'track-key', trackId: p.edit.trackId, frame: p.frame, labelId, box: p.box }]);   // edited frame -> keyframe (anchor)
        retrackAfter(p.edit.trackId, p.frame, p.box, labelId, step);
      }
      else enqueue([{ op: 'update', shape: p.edit.shape, frame: p.frame, labelId, box: p.box }]);
    } else {
      const r = logBox('save', p.item || machineOf(p), p.box, labelId, p.frame);
      if (p.item && p.item.det) {
        recordScore({ frame: p.frame, box: p.box, score: p.item.det.score, labelId });
      } else {
        recordScore({ frame: p.frame, box: p.box, manual: true, labelId });
      }
      enqueue([newBoxOp({ frame: p.frame, labelId, box: p.box, vel: p.item ? velocityOf(p.item) : null, attrs: attrsFor(labelId, r) }, p.item)]);
    }
  }
  /** Auto-save: the open box is accepted when the user moves on (new box, other box, other frame). Esc discards. */
  function autoSave() {
    const p = st.proposal;
    if (st.opts.autoSave && p && !p.item && st.labelId != null) { saveProposal(); return true; }
    return false;
  }
  /** Del: an existing box is deleted in CVAT (Ctrl+Z brings it back); a new one is just dropped. */
  function deleteSelected() {
    const p = st.proposal; if (!p) return;
    setProposal(null);
    if (p.item) { if (st.batch) st.batch.skippedCount = (st.batch.skippedCount || 0) + 1; logBox('skip', p.item); nextInBatch(p.item); return; }
    if (p.edit && p.edit.trackId != null) { enqueue([{ op: 'track-delete', trackId: p.edit.trackId, frame: p.frame, labelId: p.edit.labelId }]); toast(I18N.t('toast.del.track')); }
    else if (p.edit) { enqueue([{ op: 'delete', shape: p.edit.shape, frame: p.frame, labelId: p.edit.labelId, box: p.orig }]); toast(I18N.t('toast.del.box')); }
    draw(); buildBoxPanel();
  }

  // ---------------------------------------------------------------- sweeps of other jobs of the task
  /**
   * Id of a job of the same task that holds `frame` (jobs are often one frame each, and an annotator
   * may see the task's other jobs but not the task itself), or null.
   */
  async function jobFor(frame) {
    if (frame >= st.job.start && frame <= st.job.stop) return st.job;
    st.siblings ??= api(`/jobs?task_id=${st.job.taskId}&page_size=500`).then((r) => r.results || [])
      .catch((e) => { console.warn('[lidar-cam] jobs of task', st.job.taskId, e.message); return []; });
    const j = (await st.siblings).find((x) => x.start_frame <= frame && frame <= x.stop_frame);
    return j ? { id: j.id } : null;
  }
  /**
   * Point cloud of a frame in another job, only for the ego motion: one file request (no chunk, no
   * images), aborted when the shown frame changes. Only on request (button).
   */
  async function neighbourPcd(frame, job) {
    const t0 = performance.now();
    const buf = await api(`/jobs/${job.id}/data?type=frame&quality=original&number=${frame}`, 'buf', 'GET', undefined,
      { timeout: SLOW.cloud, signal: st.nbCtl.signal });
    console.info(`[lidar-cam] neighbour frame ${frame} via job ${job.id}: ${(buf.byteLength / 1e6).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return PCD.parsePCD(buf);
  }
  /** Point cloud of a sweep: the loaded frame if any, else the cloud alone (no camera images),
   *  through whichever job of the task holds it. Null if no visible job has that frame. */
  async function loadCloud(frame) {
    const key = `${st.job.id}:${frame}`;
    if (st.data.has(key)) return (await st.data.get(key)).xyz;
    if (!st.clouds.has(key)) {
      const p = jobFor(frame).then((job) => {
        if (!job) { console.warn(`[lidar-cam] frame ${frame}: no visible job of task ${st.job.taskId} has it`); return null; }
        return job === st.job ? loadPcd(frame, {}) : neighbourPcd(frame, job);
      });
      st.clouds.set(key, p);
      if (st.clouds.size > 12) st.clouds.delete(st.clouds.keys().next().value);
      p.catch(() => st.clouds.delete(key));
    }
    return st.clouds.get(key);
  }

  // ---------------------------------------------------------------- propagation (previous frame -> this one)
  /** Own displacement per frame of a carried box (current-sweep axes), for the next propagation. */
  function velocityOf(item) {
    if (item.vel && Math.hypot(item.vel[0], item.vel[1]) > 0.2) return item.vel;
    if (!item.moved || !item.fitted || item.box !== item.fit) return item.vel || null;   // not propagated / re-fitted: nothing learned
    const d = [item.fit.x - item.moved.x, item.fit.y - item.moved.y];
    return Math.hypot(d[0], d[1]) > 0.3 ? d : null;                         // below that: parked / noise
  }
  /** Wait until a frame change asked with D / F is done and the panel shows the frame CVAT shows (L or T pressed right
   *  after F must act on the new frame, not the old one). */
  async function settled() {
    await stepping.catch(() => {});
    for (let k = 0; k < 100; k++) {
      const f = currentFrame();
      if (f == null || (f === st.frame && current && current.frame === f)) return;
      await tick(false); await sleep(100);
    }
  }
  /** Why the shown frame cannot be used yet (no calib first: without it nothing projects), or null. */
  function notReady() {
    if (!st.job) return 'Chưa mở job 3D';
    if (!st.calib) return st.calibError || 'Đang nạp calib…';
    if (!current || st.frame == null || current.frame !== st.frame) return 'Frame chưa tải xong';
    return null;
  }
  // ---- save mode (PLAN 2.1): what a NEW box becomes. Remembered per task; first time: track when the job already
  // labels with tracks only, else shape (as before). Boxes of existing tracks are always edited as track keyframes.
  const modeKey = () => `saveMode:${location.origin}:${st.job.taskId}`;
  function updateSaveModeUI() {
    if (ui.drawModeShape && ui.drawModeTrack) {
      ui.drawModeShape.setAttribute('aria-pressed', String(st.saveMode === 'shape'));
      ui.drawModeTrack.setAttribute('aria-pressed', String(st.saveMode === 'track'));
    }
    if (ui.saveMode) ui.saveMode.value = st.saveMode;
  }
  async function loadSaveMode() {
    let m = null;
    try { m = (await chrome.storage.local.get(modeKey()))[modeKey()]; } catch (e) { /* default */ }
    if (m !== 'shape' && m !== 'track') m = 'track';
    setSaveMode(m, true);
  }
  function setSaveMode(m, silent = false) {
    st.saveMode = m; putStore({ [modeKey()]: m });
    updateSaveModeUI();
    if (!silent) {
      toast(m === 'track' ? I18N.t('toast.mode.track') : I18N.t('toast.mode.shape'));
    }
  }
  /** The car's forward axis in the point cloud's axes: ego x seen from the LiDAR (row 0 of sensor2ego) when the cloud
   *  is in the LiDAR frame (nuScenes: +y), else x. */
  function forwardInCloud() {
    const S = st.calib && st.calib.lidar && st.calib.lidar.sensor2ego;
    return (st.calib && (st.calib.pcd_frame || 'lidar') === 'lidar' && S) ? [S[0][0], S[0][1]] : [1, 0];
  }
  async function egoBetween(a, b) {
    const key = `${st.job.id}:${a}->${b}`;
    if (st.ego.has(key)) return st.ego.get(key);
    if (st.poseMeta) {
      try {
        const T = PM.between(st.poseMeta, frameName(st.job, a), frameName(st.job, b), st.calib && st.calib.lidar && st.calib.lidar.sensor2ego);
        if (T) { st.ego.set(key, T); return T; }
        console.warn(`[lidar-cam] ego pose thiếu frame ${a} hoặc ${b}; fallback ICP`);
      } catch (e) {
        st.poseError = e.message; poseInfoUpdate(); console.warn('[lidar-cam] ego pose:', e.message, '— fallback ICP');
      }
    }
    const [A, B] = await Promise.all([loadCloud(a), loadCloud(b)]);
    if (!A || !B) return null;
    const T = BT.egoMotion(A, B, st.lastT);
    if (T) { T.source = 'icp'; st.ego.set(key, T); st.lastT = { th: T.th, tx: T.tx, ty: T.ty }; }
    return T;
  }

  async function propagateFromPrev() {
    if (!current || !st.job || st.frame == null || current.frame !== st.frame) { toast(I18N.t('toast.frameNotLoaded')); return; }
    const from = st.frame - 1;
    if (from < st.job.start) { toast(I18N.t('toast.firstFrame')); return; }
    const sources = [
      ...st.existing.shapes.filter((x) => x.frame === from).map((x) => ({ box: x.box, labelId: x.labelId, vel: null, source: x })),
      ...st.saved.filter((x) => x.frame === from).map((x) => ({ box: x.box, labelId: x.labelId ?? x.shape?.label_id, vel: x.vel, source: x })),
      ...boxesAt(from).filter((x) => x.rec && x.rec.trackId != null).map((x) => ({ box: x.box, labelId: x.rec.labelId, vel: null, source: x.rec, track: x.rec })),
    ];
    if (!sources.length) { toast(`Frame ${from} không có cuboid nào để lan.`); return; }
    const frame = st.frame, t0 = performance.now();
    if (!st.poseMeta) { ui.msg.textContent = 'Đang tính quỹ đạo xe (KISS-ICP, 1 lần cho cả job)…'; await ensurePose(); if (st.frame !== frame) { ui.msg.textContent = ''; return; } }
    ui.msg.textContent = st.poseMeta ? 'Đang lấy ego pose…' : 'Đang ước lượng ego-motion bằng ICP…';
    let T;
    try { T = await egoBetween(from, frame); } catch (e) { ui.msg.textContent = ''; toast('Không tải được frame trước: ' + e.message); return; }
    ui.msg.textContent = '';
    if (st.frame !== frame) return;
    if (!T || T.inlier < 0.4) { toast('Không ước lượng được chuyển động xe giữa hai frame (ít cấu trúc tĩnh): vẽ tay frame này'); return; }
    const here = knownBoxes(frame);
    const items = [];
    let dup = 0;
    for (const src of sources) {
      const ground = current && current.ground ? current.ground : BF.groundMask(current.xyz);
      const r = BT.propagateBox(src.box, T, current.xyz, { vel: src.vel, calib: st.calib, ground });
      if (here.some((b) => Math.hypot(b.x - r.box.x, b.y - r.box.y) < 1.0)) { dup++; continue; }
      const moved = BT.moveBox(src.box, T);                       // static: ego motion only
      const pred = { ...moved, z: r.box.z };
      if (src.vel) { pred.x += src.vel[0]; pred.y += src.vel[1]; }
      items.push({ labelId: src.labelId, vel: src.vel, fitted: r.fitted, shift: r.shift, how: r.how,
        fit: r.box, pred, moved, box: r.box, points: r.points, source: src.source, track: src.track });
    }
    if (!items.length) { toast(`Mọi box của frame ${from} đã có ở frame này (${dup})`); return; }
    st.batch = { frame, from, items, ms: performance.now() - t0, T };
    selectInBatch(0);
    toast(`Lan ${items.length} box từ frame ${from}${dup ? ` (bỏ ${dup} box đã có)` : ''} · ego ${T.source === 'pose' ? 'pose' : 'ICP'}: ${Math.hypot(T.tx, T.ty).toFixed(2)} m, ${(T.th / DEG).toFixed(2)}°`);
  }

  async function moveFrame(direction) {
    const next = direction > 0;
    const btn = document.querySelector(next ? '.cvat-player-next-button' : '.cvat-player-previous-button');
    if (!btn) { stepFrame(direction); return true; }
    const before = st.frame;
    btn.click();
    for (let k = 0; k < 50 && st.frame === before; k++) { await sleep(100); await tick(false); }
    if (st.frame === before) { toast('CVAT chưa chuyển frame'); return false; }
    for (let k = 0; k < 100 && (!current || current.frame !== st.frame); k++) await sleep(100);
    return true;
  }
  const nextFrame = () => moveFrame(1);
  const previousFrame = () => moveFrame(-1);
  async function nextFrameAndPropagate() {
    if (!await nextFrame()) return;
    propagateFromPrev();
  }

  /** Propagate one selected, saved shape over a chosen range and save every result as a keyframe of one track. */
  async function propagateSelectedRange(source, first, last, motion) {
    if (!st.job || first <= source.frame || last < first) return;
    const keys = [];
    let box = { ...source.box }, previous = source.frame, vel = null, poseSteps = 0, icpSteps = 0;
    const motionText = motion === 'moving' ? 'đang di chuyển' : 'đứng yên';
    ui.msg.textContent = `Đang lan vật ${motionText}, frame ${first}–${last}…`;
    try {
      for (let frame = source.frame + 1; frame <= last; frame++) {
        if (frame + 1 <= last) loadCloud(frame + 1);
        const [T, xyz] = await Promise.all([egoBetween(previous, frame), loadCloud(frame)]);
        if (!T || T.inlier < 0.4 || !xyz) throw new Error(`không ước lượng được chuyển động ở ${previous} → ${frame}`);
        if (T.source === 'pose') poseSteps++; else icpSteps++;
        const ground = current && current.frame === frame ? current.ground : null;
        const next = BT.propagateStep(box, T, xyz, { motion, vel, dt: T.dt, calib: st.calib, ground });
        box = next.box; vel = next.vel; previous = frame;
        if (frame >= first) keys.push({ frame, points: BF.toCvatPoints(box) });
        ui.msg.textContent = `Đang lan vật ${motionText}: ${frame}/${last}…`;
      }
    } catch (e) {
      ui.msg.textContent = ''; toast('Dừng lan: ' + e.message); return;
    }
    ui.msg.textContent = '';
    const labelId = source.edit ? source.edit.labelId : st.labelId;
    if (labelId == null) { toast('Chọn nhãn cho cuboid trước khi lan'); return; }
    enqueue([{ op: 'track-create', frame: last, labelId, box,
      sourceFrame: source.frame, sourceShape: source.edit?.shape, sourceBox: source.box,
      track: CT.createRange(labelId, source.frame, BF.toCvatPoints(source.box), keys, st.job.stop) }]);
    const egoSource = icpSteps ? `${poseSteps} pose + ${icpSteps} ICP` : `${poseSteps} pose`;
    setProposal(null); toast(`Đã lan vật ${motionText} từ frame ${first} đến ${last}: ${keys.length} keyframe · ego ${egoSource}`);
  }

  function choosePropagationRange() {
    openTrackDialog();
  }

  async function reopenInCvat() {
    if (st.outbox.length) { toast('Còn box đang lưu, đợi xong rồi mở lại'); return; }
    if (!window.confirm('Mở lại job trong CVAT để hiện shape/track vừa lưu.\nThay đổi chưa lưu trong CVAT sẽ mất: bấm Ctrl+S trong CVAT trước nếu có. Tiếp tục?')) return;
    const back = location.pathname + '?frame=' + (st.frame ?? '');
    const m = location.pathname.match(/^(.*\/tasks\/\d+)\/jobs\/\d+/);
    togglePanel(false);
    const go = (url) => { history.pushState(history.state, '', url); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })); };
    go(m ? m[1] : '/jobs');
    await sleep(400);
    go(back);
    await sleep(3000);
    if (!document.querySelector('.cvat-player-frame-selector')) location.assign(back);
  }
  // ---------------------------------------------------------------- track along the object (spec 2026-10-13)
  // Walk both ways from the frame the track starts at: ego pose (egopath), the object looked for where its path says
  // (propagateBox, its size kept), then one solution for the whole stretch (trajectory) written as a few keyframes.
  let tracking = null;                                   // the run in progress: {trackId, cancel}
  /** Points within r metres (plan) of a box: all a frame keeps for the second pass. */
  function cropNear(xyz, box, r = 10) {
    const out = [];
    for (let i = 0; i < xyz.length; i += 3) if (Math.hypot(xyz[i] - box.x, xyz[i + 1] - box.y) < r) out.push(xyz[i], xyz[i + 1], xyz[i + 2]);
    return new Float32Array(out);
  }
  /** One ICP step a -> a + 1 for the walk: null when it is unreliable; a frame that does not load is tried 3 times. */
  async function egoStep(a) {
    for (let t = 0; ; t++) {
      try { const T = await egoBetween(a, a + 1); return T && T.inlier >= 0.4 ? T : null; }
      catch (e) { if (t >= 2) throw e; }
    }
  }
  /** Boxes of other objects at frame f (this frame's sweep), each with a name for the message: the job's, minus this
   *  track, tracks still waiting for their own run, and boxes only held past a track's last keyframe. */
  const othersAt = (f, trackId) => [
    ...boxesAt(f, true).filter((e) => !(e.rec && (e.rec.trackId === trackId || (e.rec.trackId != null && st.trackQueue.some((q) => q.trackId === e.rec.trackId)))))
      .map((e) => ({ ...e.box, name: e.rec && e.rec.trackId != null ? `Track #${e.rec.trackId}` : `box #${e.rec && e.rec.shape ? e.rec.shape.id : '?'}` })),
    ...st.saved.filter((x) => x.frame === f).map((x) => ({ ...x.box, name: `box #${x.shape.id}` }))];
  function trackProgress(text) { ui.trackBar.hidden = !text; ui.trackTxt.textContent = text || ''; updateHint(); }
  /** Queue a run: one at a time (saving several boxes in Track mode tracks them one after the other). */
  function trackRun(req) {
    if (req.trackId != null) st.trackQueue = st.trackQueue.filter((q) => q.trackId !== req.trackId);   // the latest request for a track replaces one still waiting
    st.trackQueue.push(req);
    if (!tracking) nextTrack();
  }
  async function nextTrack() {
    const req = st.trackQueue.shift();
    if (!req) { trackProgress(''); return; }
    try { await trackOne(req); } catch (e) { toast('Không track được: ' + e.message); }
    tracking = null;
    nextTrack();
  }
  /** A track's keyframes as the panel compares them: a change made while a run was computing shows as a difference. */
  const keySig = (shapes) => shapes.map((s) => ({ frame: s.frame, outside: !!s.outside, sig: s.points.slice(0, 9).map((v) => v.toFixed(3)).join() })).sort((a, b) => a.frame - b.frame);
  const segText = (segs) => segs.map((g) => `${g.kind === 'static' ? 'đứng yên' : 'chạy'} ${g.from}–${g.to}`).join(' · ');
  /** ⇄: the segment holding `frame` changes kind; the track is worked out again (anchors kept). */
  function flipSegment(trackId, frame) {
    const info = st.trackInfo.get(trackId); if (!info) return;
    const g = info.segs.find((s) => frame >= s.from && frame <= s.to) || info.segs[info.segs.length - 1];
    const list = (st.kindOverride.get(trackId) || []).filter((o) => o.to < g.from || o.from > g.to);
    list.push({ from: g.from, to: g.to, kind: g.kind === 'static' ? 'moving' : 'static' });
    st.kindOverride.set(trackId, list);
    trackFollow(info.first, info.last);
  }
  const lerpBox = (a, b, w) => {
    const m = (u, v) => u + (v - u) * w;
    return { ...b, x: m(a.x, b.x), y: m(a.y, b.y), z: m(a.z, b.z), yaw: a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * w };
  };
  /** What a run of a track must respect, from the track in CVAT now: it never walks through an outside keyframe set by hand;
   *  `bound` (retrack after an edit) also stops at the neighbouring hand keyframes and blends into them. */
  async function trackLimits(trackId, f0, bound, job) {
    const lim = { lo: -Infinity, hi: Infinity, A: null, B: null, base: () => null };
    if (trackId == null) return lim;
    const tr = ((await api(`/jobs/${job.id}/annotations`)).tracks || []).find((x) => x.id === trackId);
    if (!tr) return lim;
    const shapes = tr.shapes.filter((x) => x.type === 'cuboid').sort((a, b) => a.frame - b.frame), memo = await trackMemo(trackId);
    const anchors = memo.keys ? anchorsOf(shapes, memo) : [];
    const before = (l) => Math.max(-Infinity, ...l.filter((f) => f < f0)), after = (l) => Math.min(Infinity, ...l.filter((f) => f > f0));
    const outs = anchors.filter((a) => a.outside).map((a) => a.frame);
    lim.lo = before(outs) + 1;
    lim.hi = after(outs) - 1;
    lim.outAfter = Number.isFinite(after(outs));
    if (bound) {
      const hand = anchors.filter((a) => !a.outside).map((a) => a.frame);
      const A = before([...hand, shapes.length ? shapes[0].frame : -Infinity]), B = after(hand);
      if (Number.isFinite(A)) { lim.A = A; lim.lo = Math.max(lim.lo, A + 1); }
      if (Number.isFinite(B)) { lim.B = B; lim.hi = Math.min(lim.hi, B - 1); }
      else lim.hi = Math.min(lim.hi, Math.max(f0 + 20, ...shapes.filter((x) => !x.outside).map((x) => x.frame)));
      lim.anchorFrames = hand;
      lim.base = (f) => { const at = TR.at({ shapes }, f); return at ? BF.fromCvatPoints(at.points) : null; };
    }
    return lim;
  }
  /** One line per tracked frame in the console of the CVAT page (filter "lidar-cam track"): what moved the box and how far. */
  function trackDebug(dir, f, motion, T, r, before) {
    const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    console.log(`[lidar-cam] track ${dir} f${f} ${motion} ego=${T ? `${T.source} t=(${n(T.tx)},${n(T.ty)},${n(T.tz)}) th=${n(T.th * 57.3, 1)}° inl=${n(T.inlier)}` : 'none'}`
      + ` | fit=${r ? `${r.fitted ? 'yes' : 'no'} ${r.how || ''} shift=${n(r.shift)} pts=${r.points ? r.points.length : 0}` : 'none'}`
      + ` | box (${n(before.x)},${n(before.y)},${n(before.z)}) -> (${r ? `${n(r.box.x)},${n(r.box.y)},${n(r.box.z)}` : '—'}) yaw ${r ? n(r.box.yaw * 57.3, 1) : '—'}°`);
  }
  async function trackOne({ trackId, frame: f0, box, labelId, lo, hi, motion = 'moving', bound = false, step = null }) {
    const job = st.job, run = tracking = { trackId, cancel: false };
    ui.trackCancel.onclick = () => { if (tracking) tracking.cancel = true; };
    const t0 = performance.now();
    const lim = await trackLimits(trackId, f0, bound, job);
    if (bound) { lo = job.start; hi = job.stop; }
    lo = Math.max(job.start, Number.isFinite(lo) ? lo : f0, lim.lo);
    hi = Math.min(job.stop, Number.isFinite(hi) ? hi : f0 + 20, lim.hi);
    const motionTag = motion === 'static' ? ' (đứng im)' : ' (di chuyển)';
    const name = (trackId != null ? `Track #${trackId}` : 'Track mới') + motionTag;

    // Static object with a per-frame ego pose: every frame is placed from the box at f0 (ego pose f0 -> f), not from the previous
    // frame's result, so a refit that slides cannot accumulate (BT.staticAt). Without a pose it is followed step by step as before.
    const anchored = motion === 'static' && !!st.poseMeta;
    const keys = [{ frame: f0, box: { ...box }, outside: false }];
    const s0 = st.scores.find((x) => x.frame === f0 && Math.hypot(x.box.x - box.x, x.box.y - box.y) < 0.5);
    const scoreVal = s0 ? s0.score : null;

    // Seed initial velocity from an adjacent frame if available (user already annotated 2 frames)
    let initVel = [0, 0, 0];
    if (motion !== 'static') {
      const prevEntry = serverBoxesAt(f0 - 1).find((b) => (trackId != null ? b.trackId === trackId : Math.hypot(b.box.x - box.x, b.box.y - box.y) < 3.5));
      if (prevEntry) {
        const v = [box.x - prevEntry.box.x, box.y - prevEntry.box.y, box.z - prevEntry.box.z];
        if (Math.hypot(v[0], v[1]) <= 6.0) initVel = v;
      }
    }

    // 1. Walk forward: f0 + 1 -> hi
    let curBox = { ...box }, curVel = [...initVel], missed = 0;
    for (let f = f0 + 1; f <= hi; f++) {
      if (run.cancel || st.job !== job) break;
      trackProgress(`${name} · frame ${f} (${lo}–${hi})`);

      // Prefetch next cloud in background while computing this frame
      if (f + 1 <= hi) loadCloud(f + 1);

      // Parallelize fetching cloud and ego pose (a static object is placed from the start frame, see anchored)
      const [xyz, T] = await Promise.all([loadCloud(f), egoBetween(anchored ? f0 : f - 1, f)]);
      if (!xyz || run.cancel) break;

      // Fast tracking: reuse current.ground if on current frame, otherwise let propagateStep
      // fit local ground under box in <0.1ms without global RANSAC BF.groundMask(xyz)
      const ground = current && current.frame === f ? current.ground : null;
      const fromSeed = anchored && T && T.source === 'pose';
      let r = fromSeed ? BT.staticAt(box, T, xyz, { calib: st.calib, ground }) : T ? BT.propagateStep(curBox, T, xyz, { motion, vel: motion === 'static' ? [0, 0, 0] : curVel, dt: T.dt, calib: st.calib, ground }) : null;
      if (!fromSeed && (!r || !r.fitted)) {
        r = BT.propagateBox ? BT.propagateBox(curBox, T || { th: 0, tx: 0, ty: 0 }, xyz, { vel: motion === 'static' ? [0, 0, 0] : curVel, calib: st.calib, ground }) : null;
      }
      trackDebug('→', f, motion, T, r, curBox);
      const hit = othersAt(f, trackId).some((b) => Math.hypot(b.x - r.box.x, b.y - r.box.y) < 1.0);
      if (hit) break;

      if (r.fitted || motion === 'static') {
        missed = 0;
        curVel = motion === 'static' ? [0, 0, 0] : (r.vel || [r.box.x - curBox.x, r.box.y - curBox.y, 0]);
        curBox = r.box;
        keys.push({ frame: f, box: { ...r.box }, outside: false, fit: !!r.fitted || motion === 'static' });
        recordScore({ frame: f, box: r.box, score: scoreVal, manual: scoreVal == null, labelId, trackId });
      } else {
        missed++;
        if (missed > 3) {
          keys.push({ frame: f, box: { ...curBox }, outside: true });
          break;
        }
        curBox = r.box;
        keys.push({ frame: f, box: { ...curBox }, outside: false, fit: false });
      }
    }

    // 2. Walk backward: f0 - 1 -> lo (if lo < f0)
    if (lo < f0) {
      // stepVel is displacement stepping 1 frame backward in time
      let stepVel = motion === 'static' ? [0, 0, 0] : [-initVel[0], -initVel[1], -initVel[2]];
      if (motion !== 'static') {
        const nextEntry = serverBoxesAt(f0 + 1).find((b) => (trackId != null ? b.trackId === trackId : Math.hypot(b.box.x - box.x, b.box.y - box.y) < 3.5));
        if (nextEntry) {
          const v = [box.x - nextEntry.box.x, box.y - nextEntry.box.y, box.z - nextEntry.box.z];
          if (Math.hypot(v[0], v[1]) <= 6.0) stepVel = v;
        }
      }
      curBox = { ...box }; missed = 0;
      for (let f = f0 - 1; f >= lo; f--) {
        if (run.cancel || st.job !== job) break;
        trackProgress(`${name} · frame ${f} (${lo}–${hi})`);

        // Prefetch previous cloud in background while computing this frame
        if (f - 1 >= lo) loadCloud(f - 1);

        // Parallelize fetching cloud and ego pose
        const [xyz, T] = await Promise.all([loadCloud(f), egoBetween(anchored ? f0 : f + 1, f)]);
        if (!xyz || run.cancel) break;

        const ground = current && current.frame === f ? current.ground : null;
        const fromSeed = anchored && T && T.source === 'pose';
        let r = fromSeed ? BT.staticAt(box, T, xyz, { calib: st.calib, ground }) : T ? BT.propagateStep(curBox, T, xyz, { motion, vel: motion === 'static' ? [0, 0, 0] : stepVel, dt: T.dt, calib: st.calib, ground }) : null;
        if (!fromSeed && (!r || !r.fitted)) {
          r = BT.propagateBox ? BT.propagateBox(curBox, T || { th: 0, tx: 0, ty: 0 }, xyz, { vel: motion === 'static' ? [0, 0, 0] : stepVel, calib: st.calib, ground }) : null;
        }
        trackDebug('←', f, motion, T, r, curBox);
        const hit = othersAt(f, trackId).some((b) => Math.hypot(b.x - r.box.x, b.y - r.box.y) < 1.0);
        if (hit) break;

        if (r.fitted || motion === 'static') {
          missed = 0;
          stepVel = motion === 'static' ? [0, 0, 0] : (r.vel || [r.box.x - curBox.x, r.box.y - curBox.y, 0]);
          curBox = r.box;
          keys.push({ frame: f, box: { ...r.box }, outside: false, fit: !!r.fitted || motion === 'static' });
          recordScore({ frame: f, box: r.box, score: scoreVal, manual: scoreVal == null, labelId, trackId });
        } else {
          missed++;
          if (missed > 3) {
            keys.push({ frame: f, box: { ...curBox }, outside: true });
            break;
          }
          curBox = r.box;
          keys.push({ frame: f, box: { ...curBox }, outside: false, fit: false });
        }
      }
    }

    trackProgress('');
    if (run.cancel || st.job !== job) { toast(`${name}: đã huỷ`); return; }

    for (const k of keys) {       // walked frames next to a hand keyframe move toward the box it already had there
      if (k.outside || k.frame === f0) continue;
      // a frame the walk back could not fit on the points (occluded, no returns) is only a prediction: keep what it had
      if (k.frame < f0 && lim.A != null) { const e = lim.base(k.frame); if (e) k.box = k.fit === false ? e : lerpBox(e, k.box, (k.frame - lim.A) / (f0 - lim.A)); }
      if (k.frame > f0 && lim.B != null) { const e = lim.base(k.frame); if (e) k.box = lerpBox(k.box, e, (k.frame - f0) / (lim.B - f0)); }
    }
    keys.sort((a, b) => a.frame - b.frame);
    // Outside keyframe at the end of the track (from Downloads/tracks.js) to prevent CVAT from extrapolating
    const stop = st.job ? st.job.stop : hi;
    const lastKey = keys[keys.length - 1];
    if (lastKey && !lastKey.outside && lastKey.frame < stop && lim.B == null && !lim.outAfter) {
      keys.push({ frame: Math.min(lastKey.frame + 1, stop), box: { ...lastKey.box }, outside: true });
    }
    // Retain all tracked frames as keyframes to prevent CVAT from doing naive sensor-space linear interpolation
    const cvatKeys = keys.map((k) => ({ frame: k.frame, outside: !!k.outside, points: BF.toCvatPoints(k.box) }));
    const ms = performance.now() - t0;

    if (trackId != null) {
      enqueue([{
        op: 'track-set',
        trackId,
        labelId,
        frame: f0,
        box,
        range: [keys[0].frame, keys[keys.length - 1].frame],
        keys: cvatKeys,
        motion,
        bound,
        anchorFrames: [f0, ...(lim.anchorFrames || [])],     // hand keyframes: the memo does not count them as the machine's
        step
      }]);
      toast(`${name}: bám ${keys.length} frame trong ${ms.toFixed(0)} ms (cùng Track #${trackId})`);
    } else {
      enqueue([{
        op: 'track-create',
        labelId,
        frame: f0,
        box,
        motion,
        anchorFrames: [f0],
        keys: cvatKeys,
        step
      }]);
      toast(`Tạo Track mới: bám ${keys.length} frame trong ${ms.toFixed(0)} ms`);
    }
  }
  // ---------------------------------------------------------------- auto: 2D detector -> 3D boxes to review
  // The detector runs in a hidden page of the extension (detector.html: YOLOX + onnxruntime-web), reached
  // through a MessageChannel handed over once; the image never leaves the browser.
  let detectorP = null;
  function detector() {
    if (detectorP) return detectorP;
    detectorP = new Promise((resolve, reject) => {
      const fr = el('iframe', { src: chrome.runtime.getURL('ui/detector.html'), hidden: true });
      fr.setAttribute('aria-hidden', 'true');
      const ch = new MessageChannel(), pend = new Map();
      let n = 0, timer = null;

      const cleanup = (err) => {
        if (timer) clearTimeout(timer);
        detectorP = null;
        fr.remove();
        if (err) reject(err);
      };

      timer = setTimeout(() => {
        cleanup(new Error('Hết thời gian nạp mô hình nhận diện (timeout 25s). Vui lòng vào chrome://extensions/ nhấn Tải lại (Reload ↻) và tải lại trang CVAT.'));
      }, 25000);

      ch.port1.onmessage = ({ data }) => {
        if ('ready' in data) {
          clearTimeout(timer); timer = null;
          if (!data.ready) { cleanup(new Error(data.error || 'detector không sẵn sàng')); return; }
          resolve({ run: (msg, transfer) => new Promise((res, rej) => { const id = ++n; pend.set(id, { res, rej }); ch.port1.postMessage({ ...msg, id }, transfer); }) });
          return;
        }
        const p = pend.get(data.id); if (!p) return;
        pend.delete(data.id);
        if (data.ok) p.res(data); else p.rej(new Error(data.error));
      };

      fr.onerror = (e) => cleanup(new Error('Không thể tải iframe nhận diện: ' + ((e && e.message) || 'lỗi tài nguyên')));
      fr.onload = () => {
        try {
          fr.contentWindow.postMessage({ type: 'lidar-cam-detector' }, new URL(chrome.runtime.getURL('')).origin, [ch.port2]);
        } catch (e) {
          cleanup(new Error('Lỗi kết nối iframe nhận diện: ' + e.message));
        }
      };
      document.body.append(fr);
    });
    return detectorP;
  }
  // ---- label mapping (PLAN 4.1): model class -> job label, confirmed once per project (labelmap.js)
  const mapKey = () => `labelMap:${location.origin}:${st.job.projectId != null ? 'p' + st.job.projectId : 't' + st.job.taskId}`;
  async function loadLabelMap() {
    let rec = null;
    try { rec = (await chrome.storage.local.get(mapKey()))[mapKey()]; } catch (e) { /* first time */ }
    st.labelMap = rec ? LM.valid(rec, st.job.labels) : { map: LM.suggest(st.job.labels), confirmed: false };
    buildAutoClasses();
  }
  function confirmLabelMap(map) {
    st.labelMap = LM.confirm(map);
    putStore({ [mapKey()]: st.labelMap });
    buildAutoClasses();
  }
  /** Job label a detector class goes to (null: that class is not proposed). */
  const labelFor = (cls) => (st.labelMap ? st.labelMap.map[cls] ?? null : null);
  /** The model class for a box drawn with a job label (several classes may share it: decided by the box size). */
  const classOfLabel = (labelId, box) => (st.labelMap && LM.classFor(st.labelMap.map, labelId, box)) || labelName(labelId);
  /** Detections of one camera image (detector input letterboxed here, as the model was trained). */
  async function detectOn(det, bmp) {
    const size = det.size, { r, nw, nh } = Detect.letterbox(bmp.width, bmp.height, size);
    const cv = new OffscreenCanvas(size, size), g = cv.getContext('2d');
    g.fillStyle = 'rgb(114,114,114)'; g.fillRect(0, 0, size, size);
    g.drawImage(bmp, 0, 0, nw, nh);
    const rgba = g.getImageData(0, 0, size, size).data.buffer;
    return det.run({ rgba, size, r, opts: { scoreThr: AF.LOW } }, [rgba]);       // once, low: the threshold only filters (4.2)
  }
  /**
   * Front / back of boxes from the image (heading.js + models/heading.onnx). list: [{box, cam, bmp, odds?}]; each box is
   * cropped from its camera image `bmp` through a virtual camera looking at it (as in training), all in one model run;
   * when the model finds the other end of the axis more likely, the box is turned by 180 deg. Mutates the boxes;
   * returns the per-box decision (null for a box without a crop; null overall when the model is unavailable).
   */
  async function headingFix(list) {
    if (!list.length || typeof Heading === 'undefined') return null;
    const S = Heading.SIZE, crops = new Float32Array(list.length * 3 * S * S);
    // each object through a virtual camera looking straight at it: fisheye images look like the pinhole training ones
    const seen = list.map(({ box, cam, bmp }, k) => {
      const rgba = bmp && Heading.rectify(box, st.calib, cam, st.adj[cam], pixelsOf(bmp));
      if (rgba) Heading.tensorFromRGBA(rgba, crops, k * 3 * S * S);
      return !!rgba;
    });
    let out;
    try { out = await (await detector()).run({ kind: 'heading', crops: crops.buffer, n: list.length }, [crops.buffer]); }
    catch (e) { console.warn('[lidar-cam] heading model:', e.message); return null; }
    return list.map(({ box: b, cam, odds }, k) => {
      if (!seen[k]) return null;
      const d = Heading.chooseEnd(b, Heading.softmax(out.logits, k * Heading.BINS), st.calib, cam, st.adj[cam], odds);
      if (d.flip) {                                  // same box turned round: the slope stays, so pitch / roll change sign
        const pr = BF.pitchRollOf(b); b.yaw = Heading.wrap(b.yaw + Math.PI);
        if (b.rx || b.ry) Object.assign(b, BF.tiltFromPitchRoll(b.yaw, -pr.pitch, -pr.roll));
      }
      return d;
    });
  }

  /** Candidates of one camera image (4.2/4.3): every detection with a 3D box or why it has none; `have` = boxes
   *  already there in this frame's sweep. data: a loaded frame ({xyz, ground}); dets: the detector's output.
   *  keepDup (range scan): one that is the same object as a box already there keeps its box, flagged `dup`. */
  function detectCands(data, camName, dets, have, keepDup = false) {
    // already boxed (on CVAT, saved): detections overlapping their projection on this camera (filtered by the threshold in split, not here)
    const haveRects = have.map((b) => {
      const q = BF.projectBox(b, st.calib, camName, st.adj[camName], 2).flat(); if (q.length < 4) return null;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [u, v] of q) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      return { u0, u1, v0, v1 };
    }).filter(Boolean);
    return dets.map((d) => {
      const cand = { det: d, cam: camName, reason: null, points: [], overlap: haveRects.reduce((m, h) => Math.max(m, Detect.iou(h, d)), 0) };
      if (!autoOn(d.label)) { cand.reason = 'off'; return cand; }
      const t1 = performance.now();
      const res = BF.fitFromRect(data.xyz, st.calib, camName, st.adj[camName], d, { label: d.label, ground: data.ground });
      if (!res.box) { cand.reason = 'nofit'; return cand; }
      const dup = have.some((b) => BF.sameObject(b, res.box));
      if (dup && !keepDup) { cand.reason = 'dup'; return cand; }
      return Object.assign(cand, { dup, labelId: labelFor(d.label), fitted: true, shift: 0, fit: res.box, pred: res.box, box: res.box, points: res.points, ms: performance.now() - t1, res });
    });
  }

  /**
   * T: detect the objects on the shown camera (Shift+T: on every camera of the frame), build a 3D box for each
   * one not boxed yet, review them as a batch. The same object seen by two cameras gives one box (best score).
   */
  async function autoDetect(allCams) {
    await settled();
    const notOk = notReady(); if (notOk) { toast(notOk); return; }
    if (!st.labelMap || !st.labelMap.confirmed || !AUTO_CLASSES.some(autoOn)) { openAutoDlg(allCams); return; }
    const frame = st.frame, t0 = performance.now();
    const cams = (allCams ? st.cams : st.cams.filter((c) => c.name === st.cam)).filter((c) => current.images[c.idx]);
    if (!cams.length) { toast('Chưa có ảnh camera'); return; }
    let det;
    try { ui.msg.textContent = 'Đang nạp mô hình nhận diện…'; det = await detector(); det.size ??= (await det.run({ kind: 'size' })).size; } catch (e) { ui.msg.textContent = ''; toast('Không nạp được mô hình nhận diện: ' + e.message); return; }
    const have = knownBoxes(frame);
    const cands = [];                    // every detection: a 3D box, or the reason it has none (4.3)
    let nDet = 0, ms = 0, fitMs = 0;
    // the detector page runs in its own process: the next camera is detected while this one's boxes are fitted
    let next = detectOn(det, current.images[cams[0].idx]);
    for (const [ci, c] of cams.entries()) {
      ui.msg.textContent = `Đang nhận diện ${c.name}…`;
      let out;
      try { out = await next; } catch (e) { ui.msg.textContent = ''; toast(`Nhận diện ${c.name} lỗi: ${e.message}`); return; }
      if (cams[ci + 1]) next = detectOn(det, current.images[cams[ci + 1].idx]);
      if (st.frame !== frame) { ui.msg.textContent = ''; return; }
      nDet += out.dets.length; ms += out.ms;
      for (const cand of detectCands(current, c.name, out.dets, have)) {
        cands.push(cand);
        fitMs += cand.ms || 0;
        if (cand.reason) continue;
        // one object seen by two cameras: same group; split() keeps the most confident one that passes the filters
        const same = cands.find((o) => o !== cand && o.box && BF.sameObject(o.box, cand.box));
        if (same) cand.group = same.group ?? (same.group = cands.indexOf(same) + 1);
      }
    }
    // whole-object boxes from the frustum models (one run for all), then which end is the front (one run for all)
    // Keep an ID on every detection, including ones filtered out. The surviving proposal keeps the same
    // ID when a reviewer adjusts thresholds, changes camera, or returns to a parked review.
    cands.forEach((cand, index) => { cand.reviewId = index + 1; });
    const items = cands.filter((c) => !c.reason);
    const tl = performance.now();
    const bmpOf = (cam) => current.images[cams.find((c) => c.name === cam).idx];
    const lb = await learnedBoxes(items.map((it) => ({ res: it.res, label: it.det.label, xyz: current.xyz, rect: it.det, cam: it.cam, bmp: bmpOf(it.cam),
      others: items.filter((o) => o !== it && o.cam === it.cam).map((o) => o.det) })));
    if (lb) items.forEach((it, k) => { if (lb[k]) { it.geo = it.box; it.box = it.fit = it.pred = { rx: 0, ry: 0, ...lb[k].box }; it.odds = lb[k].odds; it.how = 'learned'; it.model = lb[k].model; } });
    const learnMs = performance.now() - tl, th = performance.now();
    const dec = await headingFix(items.map((it) => ({ box: it.box, cam: it.cam, bmp: bmpOf(it.cam), odds: it.odds })));
    if (dec) items.forEach((it, k) => { it.heading = dec[k]; });
    const timing = { total: performance.now() - t0, detect: ms, fit: fitMs, learned: learnMs, heading: performance.now() - th, cams: cams.length };
    if (st.frame !== frame) { ui.msg.textContent = ''; return; }
    ui.msg.textContent = '';
    const where = allCams ? `${cams.length} camera` : cams[0].name;
    stampMachine(items, 'T');
    st.auto = { frame, where, cands, nDet };
    const r = refilterAuto(false);
    const why = Object.entries(AF.counts(r.rejected)).map(([k, n]) => `${n} ${AF.REASONS[k]}`).join(', ');
    console.info(`[lidar-cam] auto ${where}: ${items.length} boxes, ${(timing.total / 1000).toFixed(1)} s = detect ${(ms / 1000).toFixed(1)} s (model) · fit ${(fitMs / 1000).toFixed(1)} s · learned ${(timing.learned / 1000).toFixed(1)} s · heading ${(timing.heading / 1000).toFixed(1)} s`);
    if (!r.items.length) { buildBoxPanel(); draw(); toast(`Mô hình thấy ${nDet} vật trên ${where}, không có box mới${why ? ' (' + why + ')' : ''}`); return; }
    st.batch = { kind: 'auto', frame, from: null, items: r.items, ms: timing.total, timing };
    selectInBatch(0);
    toast(`Tự động: ${r.items.length} box mới trên ${where} (nhận diện ${Math.round(ms)} ms)${why ? ' · bỏ ' + why : ''}. Enter lưu từng box, X bỏ, Shift+Enter lưu tất cả.`);
  }

  /** Auto over a stretch of frames: every frame detected on every camera, the boxes grouped into objects (scan.js),
   *  each new object proposed once at the frame it was seen best. Saving one makes it a track (tracked by itself). */
  async function scanRange(lo, hi) {
    await settled();
    const notOk = notReady(); if (notOk) { toast(notOk); return; }
    if (!st.labelMap || !st.labelMap.confirmed || !AUTO_CLASSES.some(autoOn)) { openAutoDlg(false); return; }
    lo = Math.max(st.job.start, Math.min(lo, hi)); hi = Math.min(st.job.stop, Math.max(lo, hi));
    if (tracking) { toast('Đang track, chờ xong hoặc Huỷ'); return; }        // one run at a time: Huỷ stops the one shown
    const job = st.job, run = tracking = { cancel: false };
    let det, w;
    const dets = [], existing = new Map();
    const look = async (k, pose) => {
      if (run.cancel || st.job !== job) return false;
      trackProgress(`Quét frame ${k} (${lo}–${hi})`);
      let data;
      try { data = await loadFrame(k); await data.imgPending; } catch (e) { w = { end: k, why: 'load' }; return false; }
      const have = knownBoxes(k, true);                     // a track's box held past its last keyframe is not an object there
      existing.set(k, have.map((b) => EP.apply(pose, b)));
      for (const c of st.cams) {
        const bmp = data.images[c.idx]; if (!bmp) continue;
        const out = await detectOn(det, bmp);
        for (const cand of detectCands(data, c.name, out.dets, have, true)) if (!cand.reason)
          dets.push({ frame: k, label: cand.det.label, score: cand.det.score, points: cand.points.length, cam: c.name, local: cand.box, box: EP.apply(pose, cand.box), dup: cand.dup, cand });
      }
      return true;
    };
    try {
      try { det = await detector(); det.size ??= (await det.run({ kind: 'size' })).size; } catch (e) { toast('Không nạp được mô hình nhận diện: ' + e.message); return; }
      if (await look(lo, EP.I)) { const r = await EP.walk(lo, 1, hi, egoStep, look); if (!w) w = r; }
    } finally { tracking = null; trackProgress(''); nextTrack(); }
    if (st.job !== job) return;
    w ??= { end: lo, why: 'visit' };
    if (run.cancel) w.why = 'cancel';                       // Huỷ: the objects grouped so far are still proposed
    const objs = SC.overlap(SC.group(dets), existing, EL.iou3d);
    const cands = objs.map((o) => ({ ...o.best.cand, frame: o.best.frame, cam: o.best.cam, box: o.best.local, fit: o.best.local, pred: o.best.local,
      det: { ...o.best.cand.det, score: o.score }, overlap: o.overlap, seen: o.dets.length, span: [o.dets[0].frame, o.dets[o.dets.length - 1].frame] }));
    cands.forEach((cand, index) => { cand.reviewId = index + 1; });
    parkBatch(false);                                       // an open review is set aside, not lost
    st.auto = { frame: st.frame, where: `frame ${lo}–${w.end}`, cands, nDet: dets.length, scan: true };
    const r = refilterAuto(false);
    stampMachine(r.items, 'T');
    if (r.items.length) st.batch = { kind: 'scan', frame: st.frame, from: null, items: r.items, ms: 0 };
    const stop = { ego: 'không ước lượng được chuyển động xe', load: 'không tải được frame' }[w.why];
    toast(`Quét frame ${lo}–${w.end}: ${r.items.length} vật mới${r.rejected.length ? ` · bỏ ${r.rejected.length} (${Object.entries(AF.counts(r.rejected)).map(([k, n]) => `${n} ${AF.REASONS[k]}`).join(', ')})` : ''}${stop ? ` · dừng ở frame ${w.end}: ${stop}` : w.why === 'cancel' || w.why === 'visit' ? ` · đã dừng ở frame ${w.end}` : ''}`);
    if (r.items.length) selectInBatch(0); else { buildBoxPanel(); draw(); }
  }

  // ---- threshold (4.2): per class, plus a minimum of LiDAR points; changing it re-filters the last auto run only
  const overlapOf = () => st.opts.overlap ?? AF.OVERLAP;
  const thrOf = () => ({ ...Object.fromEntries(AUTO_CLASSES.map((c) => [c, AF.DEFAULT])), ...(st.opts.thr || {}) });
  /** The last auto run belongs to the shown frame (a scan belongs to its whole stretch). */
  const autoHere = () => st.auto && (st.auto.scan || st.auto.frame === st.frame);
  /** A review batch from the detector: one frame (auto) or a stretch of frames (scan). */
  const isAuto = (b) => b.kind === 'auto' || b.kind === 'scan';
  /** Re-split the last auto run of the shown frame with the current threshold; updates its review batch in place. */
  function refilterAuto(apply = true) {
    const a = st.auto;
    const r = AF.split(a ? a.cands : [], { thr: thrOf(), minPoints: st.opts.minPoints || 0, overlap: overlapOf() });
    r.items.sort((p, q) => (a && a.scan ? p.frame - q.frame : 0) || Math.hypot(p.box.x, p.box.y) - Math.hypot(q.box.x, q.box.y));   // review near to far (a scan: frame by frame)
    if (a) a.rejected = r.rejected;
    if (!apply || !a || (!a.scan && a.frame !== st.frame)) return r;
    const b = st.batch && isAuto(st.batch) && (a.scan || st.batch.frame === a.frame) ? st.batch : null;
    const sel = st.proposal && st.proposal.item;
    if (b) b.items = r.items;
    else if (r.items.length && !a.scan) st.batch = { kind: 'auto', frame: a.frame, from: null, items: r.items, ms: 0 };
    if (st.batch && isAuto(st.batch)) selectInBatch(Math.max(0, st.batch.items.indexOf(sel)));
    draw(); buildBoxPanel();
    return r;
  }
  // ---- settings (3.5): save mode, auto save, export / import of everything (mapping and thresholds included) as one JSON
  function exportConfig() {
    const cfg = { kind: 'calib-overlay-config', version: 1, saveMode: st.saveMode, thr: thrOf(), minPoints: st.opts.minPoints || 0, overlap: overlapOf(), trackGap: st.opts.trackGap || 10, autoSave: !!st.opts.autoSave,
      labelMap: st.labelMap && st.job ? Object.fromEntries(AUTO_CLASSES.map((c) => [c, labelName(st.labelMap.map[c]) || null])) : null };
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })), download: 'calib-overlay-config.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  /** The label mapping travels by label NAME (ids differ between CVAT projects). */
  function importConfig(text) {
    let cfg; try { cfg = JSON.parse(text); } catch (e) { toast(I18N.t('toast.cfg.bad')); return; }
    if (!cfg || cfg.kind !== 'calib-overlay-config') { toast(I18N.t('toast.cfg.notours')); return; }
    if (cfg.thr) st.opts.thr = Object.fromEntries(AUTO_CLASSES.map((c) => [c, Math.min(0.95, Math.max(AF.LOW, Number(cfg.thr[c]) || AF.DEFAULT))]));
    if (Number.isFinite(cfg.minPoints)) st.opts.minPoints = cfg.minPoints;
    if (Number.isFinite(cfg.overlap)) st.opts.overlap = Math.min(0.95, Math.max(0.05, cfg.overlap));
    if (Number.isFinite(cfg.trackGap)) { st.opts.trackGap = Math.max(1, cfg.trackGap); ui.trackGap.value = st.opts.trackGap; }
    if (typeof cfg.autoSave === 'boolean') { st.opts.autoSave = cfg.autoSave; ui.autoSave.checked = cfg.autoSave; }
    saveOpts();
    if (st.job && (cfg.saveMode === 'shape' || cfg.saveMode === 'track')) { setSaveMode(cfg.saveMode); ui.saveMode.value = cfg.saveMode; }
    if (st.job && cfg.labelMap) {
      const byName = (n) => (n == null ? null : (st.job.labels.find((l) => l.name === n) || {}).id ?? null);
      confirmLabelMap(Object.fromEntries(AUTO_CLASSES.map((c) => [c, byName(cfg.labelMap[c])])));
    }
    refilterAuto(); buildAutoClasses(); toast(I18N.t('toast.cfg.ok'));
  }
  /**
   * Leave the review without losing anything: the unsaved proposals are set aside on their frame (drawn
   * faintly; Tab, "Duyệt tiếp" or a click on one of them resumes; "Bỏ" drops them after a confirmation).
   */
  function parkBatch(redraw = true) {
    const b = st.batch;
    if (b && b.items.length) st.parked.set(b.kind === 'scan' ? 'scan' : b.frame, b);
    st.batch = null;
    if (st.proposal && st.proposal.item) st.proposal = null;
    if (redraw) { draw(); buildBoxPanel(); }
  }
  /** Where the batch set aside for the shown frame is kept: its own frame, or 'scan' (a scan spans frames: resumable from any). */
  const parkedKey = () => (st.parked.has(st.frame) ? st.frame : st.parked.has('scan') ? 'scan' : null);
  const parkedHere = () => st.parked.get(parkedKey());
  /** The items of a review batch that belong to the shown frame (a scan's carry their own frame). */
  const itemsHere = (b) => (b.kind === 'scan' ? b.items.filter((it) => it.frame === st.frame) : b.frame === st.frame ? b.items : []);
  function resumeParked(item, keepCam) {
    const key = parkedKey(), b = parkedHere(); if (!b) return false;
    if (st.proposal && !st.proposal.item) { autoSave(); setProposal(null); }
    st.parked.delete(key); st.batch = b;
    selectInBatch(item ? b.items.indexOf(item) : 0, keepCam);
    return true;
  }
  function discardParked() {
    const key = parkedKey(), b = parkedHere(); if (!b) return;
    if (!window.confirm(`Bỏ ${b.items.length} box chưa lưu${b.kind === 'scan' ? ' của lượt quét' : ' của frame này'}?`)) return;
    st.parked.delete(key); draw(); buildBoxPanel();
  }
  /** Unsaved proposal (in review or set aside) under an image point of the shown camera. */
  function pendingAt(u, v) {
    const lists = [st.batch, parkedHere()].filter(Boolean);
    let best = null;
    for (const b of lists) for (const it of itemsHere(b)) {
      const area = outlineArea(it.box, u, v);
      if (area !== null && (!best || area < best.area)) best = { batch: b, item: it, area };
    }
    return best;
  }

  /** keepCam: chosen by a click on the shown camera (otherwise jump to the camera the auto box was found on). */
  function selectInBatch(i, keepCam) {
    const b = st.batch; if (!b || !b.items.length) { st.batch = null; st.proposal = null; draw(); buildBoxPanel(); return; }
    b.idx = Math.max(0, Math.min(i, b.items.length - 1));
    const it = b.items[b.idx];
    if (it.frame != null && it.frame !== st.frame) { gotoFrame(it.frame).then((ok) => { if (ok && st.batch === b && st.frame === it.frame) selectInBatch(b.items.indexOf(it), keepCam); }); return; }
    if (!keepCam) showOnCamera(it.box, it.cam);       // found on another camera (auto) / not in this one: switch
    setProposal({ box: it.box, points: it.points, cam: st.cam, frame: it.frame ?? b.frame, ms: b.ms, item: it });
    if (it.labelId != null && st.job.labels.some((l) => l.id === it.labelId)) { st.labelId = it.labelId; ui.label.value = String(it.labelId); }
    draw(); buildBoxPanel();
  }
  function nextInBatch(it) {
    const b = st.batch; if (!b) return;
    if (!it.done) b.reviewed = (b.reviewed || 0) + 1;
    it.done = true;
    const k = b.items.indexOf(it);
    if (k >= 0) b.items.splice(k, 1);
    selectInBatch(k >= 0 ? k : b.idx);
  }
  function skipInBatch() { const p = st.proposal; if (p && p.item) { if (st.batch) st.batch.skippedCount = (st.batch.skippedCount || 0) + 1; logBox('skip', p.item); nextInBatch(p.item); } }
  /** P: switch between the LiDAR re-fit and the pure motion prediction (ego motion + own velocity). */
  function togglePred() {
    const p = st.proposal, it = p && p.item; if (!it) return;
    it.box = it.box === it.fit ? it.pred : it.fit;
    p.box = it.box; p.points = it.box === it.fit ? it.points : []; p.last = { ...p.box };
    draw(); buildBoxPanel();
  }
  function saveAllBatch() {
    const b = st.batch; if (!b || !b.items.length || !st.job) return;
    const items = b.items.filter((it) => it.labelId != null && BF.toCvatPoints(it.box).every(Number.isFinite));
    if (!items.length) return;
    const ops = items.map((it) => newBoxOp({ frame: it.frame ?? b.frame, labelId: it.labelId, box: it.box, vel: velocityOf(it),   // before the batch changes
      attrs: attrsFor(it.labelId, logBox('save', it, it.box, it.labelId, it.frame ?? b.frame)) }, it));
    for (const it of items) {
      if (it.det) recordScore({ frame: it.frame ?? b.frame, box: it.box, score: it.det.score, labelId: it.labelId });
      else recordScore({ frame: it.frame ?? b.frame, box: it.box, manual: false, labelId: it.labelId });
    }
    b.items = b.items.filter((it) => !items.includes(it));
    for (const it of items) it.done = true;
    b.reviewed = (b.reviewed || 0) + items.length;
    b.savedCount = (b.savedCount || 0) + items.length;
    st.proposal = null;
    selectInBatch(0);
    enqueue(ops);
  }
  /** Make CVAT's own view show the boxes saved here: it only reads annotations when a job opens, so
   *  re-open the job inside the page (route away and back, like clicking in CVAT) instead of a full
   *  page reload; scripts and cached chunks stay. Falls back to a reload if the route does not react. */
  async function reopenInCvat() {
    const back = location.pathname + '?frame=' + (st.frame ?? '');
    const m = location.pathname.match(/^(.*\/tasks\/\d+)\/jobs\/\d+/);
    const go = (url) => { history.pushState(history.state, '', url); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })); };
    go(m ? m[1] : '/jobs');
    await sleep(400);
    go(back);
    await sleep(3000);
    if (!document.querySelector('.cvat-player-frame-selector')) location.assign(back);   // router did not re-open it
  }
  // ---------------------------------------------------------------- work session: save / exit / resume
  const hasActivity = (a) => !!(a && (a.saved_boxes > 0 || a.total_actions > 0 || a.panel_seconds > 0 || a.manual_time_seconds > 0));
  const sessionsOn = () => typeof SessionManager !== 'undefined';
  const fmtDur = (sec) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
  function pushSessionSafe(s) { if (typeof SupaLog !== 'undefined' && SupaLog.pushSession) SupaLog.pushSession(s).catch(() => {}); }
  /** Timing and "edited" thresholds this session is measured with (kept with it, for the method section of a report). */
  function sessionParams() {
    const CT = self.CompareTimer, p = { edit_iou: EL.EDIT_IOU, edit_yaw_deg: EL.EDIT_YAW_DEG };
    if (CT) Object.assign(p, { idle_sec: CT.IDLE_SEC, grace_sec: CT.GRACE_SEC, panel_grace_sec: CT.PANEL_GRACE_SEC });
    return p;
  }
  function newSession() {
    if (!sessionsOn()) return null;
    st.activeSession = SessionManager.createSession({ jobId: st.job && st.job.id, frame: st.frame, origin: location.origin, params: sessionParams() });
    EL.setSession(st.activeSession.session_id);
    SessionManager.saveActiveSession(location.origin, st.activeSession);
    updateSessionLiveChip();
    return st.activeSession;
  }
  /** Close the open session (reason: 'saved' | 'exit' | 'stale'), keep it, send it to Supabase. Null when it holds nothing. */
  async function endSession(reason) {
    const a = st.activeSession;
    if (!a || !sessionsOn() || !hasActivity(a)) return null;
    const fin = SessionManager.finishSession(a, { cvatSaved: true, reason });
    await SessionManager.appendCompletedSession(location.origin, fin);
    pushSessionSafe(fin);
    st.activeSession = null;
    updateSessionLiveChip();
    if (sessionPopup && sessionPopup.isOpen) { await sessionPopup.refreshData(); sessionPopup.render(); }
    return fin;
  }
  /** Leave the session for later: paused (clock stopped), kept in storage, a partial row goes to Supabase. */
  async function pauseForLater() {
    const a = st.activeSession;
    if (!a || !sessionsOn()) return;
    SessionManager.pauseSession(a);
    await SessionManager.saveActiveSession(location.origin, a);
    pushSessionSafe(SessionManager.snapshot(a));
    st.activeSession = null;
    updateSessionLiveChip();
  }
  /** A small modal in the BoxLift window. buttons: [{label, primary, run}] (the first primary one gets the focus: Enter). */
  function openSessionDialog({ title, lines = [], note = '', buttons, onEsc = () => {} }) {
    if (ui.sessDlg) return;
    const close = () => { back.remove(); ui.sessDlg = null; };
    const btns = buttons.map((b) => el('button', { type: 'button', className: b.primary ? 'pri' : '', textContent: b.label, onclick: () => { close(); b.run(); } }));
    const box = el('div', { className: 'rangeDlg sessDlg', role: 'dialog', ariaLabel: title },
      el('div', { className: 'dlg-hd' }, el('b', { textContent: title })), ...lines,
      note ? el('p', { className: 'muted', style: 'margin:10px 0 0;font-size:12px', textContent: note }) : '',
      el('div', { className: 'sessbtns' }, ...btns));
    const back = el('div', { className: 'rangeBack' }, box);
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); onEsc(); } });
    ui.sessDlg = back; ui.root.append(back);
    (btns[buttons.findIndex((b) => b.primary)] || btns[0]).focus();
  }
  function openExitDialog() {
    const a = st.activeSession, T = (k, v) => I18N.t(k, v);
    openSessionDialog({
      title: T('sdlg.exit.title'),
      lines: [el('p', { style: 'margin:10px 0 0', textContent: T('sdlg.exit.body', { n: a.saved_boxes, m: Math.round((a.active_seconds || 0) / 60) }) })],
      note: T('sdlg.exit.pause.hint'),
      buttons: [{ label: T('sdlg.exit.save'), primary: true, run: () => closePanel({ decided: 'exit' }) },
        { label: T('sdlg.exit.pause'), run: () => closePanel({ decided: 'pause' }) },
        { label: T('sdlg.exit.stay'), run: () => {} }],
    });
  }
  /** After "Lưu phiên": what this session came to, in numbers the annotator can use now (nothing that needs the GT). */
  function openSummaryDialog(fin) {
    const T = (k, v) => I18N.t(k, v), m = SessionManager.metricsOf(fin);
    const toolSpb = m.toolAvg != null ? m.toolAvg : (fin.avg_seconds_per_box_overall || null);
    const rows = [[T('sdlg.sum.work'), fmtDur(fin.active_seconds || 0)], [T('sdlg.sum.boxes'), String(fin.saved_boxes)],
      [T('sdlg.sum.frames'), String((fin.frames_annotated || []).length)], [T('sdlg.sum.spb'), toolSpb == null ? '—' : `${toolSpb.toFixed(1)}s`],
      [T('sdlg.sum.kept'), m.editRate == null ? '—' : `${(100 - m.editRate).toFixed(0)}%`], [T('sdlg.sum.skipped'), String(fin.skipped_proposals || 0)],
      [T('sdlg.sum.tracks'), String(fin.tracks_created || 0)]];
    const cmp = m.manualAvg && m.toolAvg ? T('sdlg.sum.cmp.val', { manual: m.manualAvg.toFixed(0), tool: m.toolAvg.toFixed(0), x: m.speedup.toFixed(1) }) : T('sdlg.sum.cmp.none');
    openSessionDialog({
      title: T('sdlg.sum.title'),
      lines: [el('div', { className: 'sumgrid' }, ...rows.flatMap(([k, v]) => [el('span', { className: 'muted', textContent: k }), el('b', { className: 'mono', textContent: v })]),
        el('span', { className: 'muted', textContent: T('sdlg.sum.cmp') }), el('b', { className: 'mono', textContent: cmp }))],
      buttons: [{ label: T('sdlg.sum.again'), primary: true, run: () => newSession() },
        { label: T('sdlg.sum.dash'), run: () => { newSession(); if (sessionPopup) sessionPopup.open('dashboard'); } },
        { label: T('sdlg.sum.close'), run: () => {} }],
    });
  }
  /** The panel opens and an earlier session is still stored (paused, or left open): continue it or save it and start a new one. */
  function openResumeDialog(stored) {
    const T = (k, v) => I18N.t(k, v), m = Math.round((stored.active_seconds || 0) / 60), n = stored.saved_boxes || 0;
    openSessionDialog({
      title: T('sdlg.resume.title'),
      lines: [el('p', { style: 'margin:10px 0 0', textContent: T('sdlg.resume.body', { job: stored.job_id || '?', m, n }) })],
      note: stored.stale ? T('sdlg.resume.stale') : '',
      buttons: [{ label: T('sdlg.resume.continue', { m, n }), primary: true, run: async () => {
          SessionManager.resumeFromPrevious(stored); st.activeSession = stored; EL.setSession(stored.session_id);
          await SessionManager.saveActiveSession(location.origin, stored); updateSessionLiveChip(); toast(T('toast.session.resumedold'));
        } },
        { label: T('sdlg.resume.new'), run: async () => { st.activeSession = stored; await endSession(stored.stale ? 'stale' : 'saved'); newSession(); } }],
      onEsc: () => togglePanel(false),          // nothing chosen: the stored session stays as it is
    });
  }
  async function ensureSessionOnOpen() {
    if (st.activeSession || !sessionsOn() || ui.sessDlg || st.sessionOpening) return;
    st.sessionOpening = true;
    try {
      const stored = await SessionManager.loadActiveSession(location.origin);
      if (st.activeSession || !st.open) return;
      if (stored && stored.session_id) {
        SessionManager.settleStale(stored);
        if (hasActivity(stored)) { openResumeDialog(stored); return; }
      }
      newSession();
    } finally { st.sessionOpening = false; }
  }
  /** "Lưu phiên": close the session, then show the summary. */
  async function saveSessionFlow() {
    if (!sessionsOn() || !st.activeSession) { toast(I18N.t('toast.session.none')); return; }
    if (!hasActivity(st.activeSession)) { toast(I18N.t('toast.session.empty')); return; }
    const fin = await endSession('saved');
    if (fin) { if (sessionPopup && sessionPopup.isOpen) sessionPopup.close(); openSummaryDialog(fin); }   // the log window would cover the summary
  }
  /**
   * Save & Reload: closing the panel after boxes were saved here shows them in CVAT by itself. The outbox is drained
   * first, then CVAT's own Save keeps what the user changed in CVAT meanwhile, then the job is opened again on the
   * same frame. Nothing is lost on either side.
   * A session that holds work asks first: save it and leave / pause it for later / stay. opts.decided: 'exit' | 'pause' | 'save'
   * (the answer, or "save" from the dashboard's own button).
   */
  async function closePanel(opts = {}) {
    if (ui.sessDlg) return;
    const a = st.activeSession, mode = opts.decided || (sessionsOn() && hasActivity(a) ? 'ask' : 'none');
    if (mode === 'ask') { openExitDialog(); return; }
    togglePanel(false);
    if (mode === 'pause') await pauseForLater();
    const finish = async () => {
      if (mode !== 'exit' && mode !== 'save') return;
      const fin = await endSession(mode === 'save' ? 'saved' : 'exit');
      if (fin) toast(I18N.t('toast.session.savedexit', { n: fin.saved_boxes, m: Math.round((fin.active_seconds || 0) / 60) }));
    };
    if (!st.cvatStale) { await finish(); return; }
    for (let k = 0; k < 150 && (st.outbox.length || flushing); k++) await sleep(100);
    if (st.outbox.length) { toast('Còn box chưa lên CVAT: mở lại panel, extension tự thử lại'); return; }
    st.cvatStale = false;
    toast('Đang mở lại job để CVAT hiện box vừa lưu…');
    const save = document.querySelector('.cvat-annotation-header-save-button');
    if (save && !save.disabled) {
      save.click(); await sleep(300);
      for (let k = 0; k < 150 && save.isConnected && save.classList.contains('ant-btn-loading'); k++) await sleep(100);
    }
    await finish();
    await reopenInCvat();
  }
  /** D / F: CVAT's own previous / next frame (its player buttons, so CVAT and the panel stay on one frame).
   *  Resolves true once the panel has the new frame loaded. */
  // Presses are queued: CVAT ignores its frame buttons while it is still loading the last frame, so a quick D after F
  // would be lost. Each step waits for the previous one, and clicks again if CVAT did not move.
  let stepping = Promise.resolve(true);
  function stepFrame(d) { return (stepping = stepping.then(() => stepFrameNow(d), () => stepFrameNow(d))); }
  async function stepFrameNow(d) {
    if (d > 0 ? st.frame >= st.job.stop : st.frame <= st.job.start) { toast(d > 0 ? I18N.t('toast.lastFrame') : I18N.t('toast.firstFrame')); return false; }
    const before = st.frame;
    for (let tries = 0; tries < 4 && st.frame === before; tries++) {
      const btn = document.querySelector(d > 0 ? '.cvat-player-next-button' : '.cvat-player-previous-button');
      if (!btn) { toast('Không thấy nút chuyển frame của CVAT'); return false; }
      btn.click();
      for (let k = 0; k < 15 && st.frame === before; k++) { await sleep(100); await tick(false); }
    }
    if (st.frame === before) { toast('CVAT chưa chuyển frame'); return false; }
    for (let k = 0; k < 100 && (!current || current.frame !== st.frame); k++) await sleep(100);
    return true;
  }
  /** Any frame (frame bar): one step through CVAT's buttons, a jump through CVAT's own frame box (its number + Enter). */
  function gotoFrame(n) { return (stepping = stepping.then(() => gotoFrameNow(n), () => gotoFrameNow(n))); }
  async function gotoFrameNow(n) {
    if (!st.job) return false;
    n = Math.max(st.job.start, Math.min(st.job.stop, Math.round(n)));
    if (n === st.frame) return true;
    if (Math.abs(n - st.frame) === 1) return stepFrameNow(n - st.frame);
    const inp = document.querySelector('.cvat-player-frame-selector input');
    if (!inp) { toast('Không thấy ô số frame của CVAT'); return false; }
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    inp.focus(); set.call(inp, String(n)); inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    inp.blur();
    for (let k = 0; k < 50 && st.frame !== n; k++) { await sleep(100); await tick(false); }
    if (st.frame !== n) { toast(`CVAT chưa sang frame ${n}`); return false; }
    for (let k = 0; k < 100 && (!current || current.frame !== st.frame); k++) await sleep(100);
    return true;
  }
  /** Frame bar (3.1): follows CVAT; the slider jumps on release only (no load per pixel dragged). */
  const whereText = (jid) => `${st.job && st.job.taskName ? st.job.taskName + ' / ' : ''}job ${jid}`;
  /** Frame bar marks of the selected track: red line = your keyframes, yellow = between two red ones, green = after the last red (3D Track follows on). */
  function renderFrameMarks() {
    if (!ui.fMarks || !st.job) return;
    const p = st.proposal, lo = st.job.start, span = Math.max(1, st.job.stop - lo), kids = [];
    if (p && p.edit && p.edit.trackId != null) {
      const reds = [...keptOf(p)].filter(Number.isFinite).sort((a, b) => a - b);
      const info = st.trackInfo.get(p.edit.trackId), pos = (f) => `${(100 * (f - lo) / span).toFixed(2)}%`;
      const seg = (a, b, cls) => { if (b > a) kids.push(el('i', { className: `fm ${cls}`, style: `left:${pos(a)};width:${(100 * (b - a) / span).toFixed(2)}%` })); };
      for (let i = 0; i + 1 < reds.length; i++) seg(reds[i], reds[i + 1], 'edit');
      if (reds.length) seg(reds[reds.length - 1], Math.max(info && Number.isFinite(info.last) ? info.last : 0, reds[reds.length - 1]), 'auto');
      for (const f of reds) kids.push(el('i', { className: 'fm user', style: `left:${pos(f)}` }));
    }
    ui.fMarks.replaceChildren(...kids);
  }
  function syncFrameBar() {
    if (!ui.fbar || !st.job) return;
    renderFrameMarks();
    ui.fRange.min = st.job.start; ui.fRange.max = st.job.stop;
    if (!ui.fRange.dragging) ui.fRange.value = st.frame ?? st.job.start;
    ui.fTot.textContent = `/ ${st.job.stop}`;
    if (ui.root.activeElement !== ui.fNum) ui.fNum.value = st.frame ?? '';        // not while the user types a number
  }



  // ---------------------------------------------------------------- UI (shadow DOM)
  const ui = {};
  let sessionPopup = null;
  function updateSessionLiveChip() {
    if (!ui.sessionLiveChip) return;
    const a = st.activeSession, mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    if (!a) { ui.sessionLiveChip.textContent = I18N.t('session.chip', { t: '00:00', n: 0 }); ui.sessionBtn.dataset.state = 'idle'; ui.sessionPauseBtn.textContent = I18N.t('session.pause'); return; }
    // Same clock as "Tool" in the bottom-left bar (time working in the panel, saved into the session), so the two always agree.
    const panelSec = (a.panel_seconds || 0) + (self.CompareChip ? self.CompareChip.pendingPanelSec || 0 : 0);
    ui.sessionLiveChip.textContent = I18N.t('session.chip', { t: mmss(panelSec), n: a.saved_boxes });
    const paused = a.status === 'paused';
    ui.sessionBtn.dataset.state = paused ? 'paused' : 'live';
    ui.sessionPauseBtn.textContent = I18N.t(paused ? 'session.resume' : 'session.pause');
    const spd = a.saved_boxes > 0 ? `${(panelSec / a.saved_boxes).toFixed(0)}s` : '—';
    ui.sessionBtn.title = `${mmss(panelSec)} · ${a.saved_boxes} box (${spd}/box)`;
  }
  const view = { zoom: 1, ox: 0, oy: 0 };
  let tf = null;                      // last image->canvas transform {s, ox, oy, dpr}
  let boxViews = null;
  let handleHits = [];                // handles drawn on the image: [{h, x, y}] in canvas pixels
  const CSS = `
  /* Two colour themes, picked with the header button (st.opts.theme). Light is the default and sits with CVAT.
     Colour lives in these tokens only, except on what stays dark in both themes (camera image, point-cloud views). */
  :host { all: initial;
    --bg: #0e1116; --surface: #151a21; --raised: #1c222b; --ctl: #1c222b; --ctl-line: #2a313c; --line: #2a313c; --line-hi: #434c5a;
    --text: #e9edf2; --text-2: #c3cad4; --muted: #98a2b0; --accent: #4c9aff; --accent-hi: #78b2ff; --on-accent: #07111f;
    --box3d: #ffb547; --key-user: #f2766b; --key-edit: #f2d33c; --key-auto: #3fc47f;
    --ok: #3fc47f; --warn: #e6b450; --err: #f2766b; --shadow-sm: rgba(0,0,0,.4); --shadow-lg: rgba(0,0,0,.6);
    --rail-w: 56px; --r-sm: 4px; --r: 6px; --r-lg: 10px; --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    color: var(--text); }
  :host([data-theme="light"]) {
    --bg: #eef1f5; --surface: #ffffff; --raised: #f5f7fa; --ctl: #ffffff; --ctl-line: #cfd4db; --line: #d9dee6; --line-hi: #9aa2ae;
    --text: #14181f; --text-2: #363d48; --muted: #525b68; --accent: #1a5fd0; --accent-hi: #1249a8; --on-accent: #ffffff;
    --box3d: #b86e00; --key-user: #bb3326; --key-edit: #9a7400; --key-auto: #17794a;
    --ok: #17794a; --warn: #8a5a00; --err: #bb3326; --shadow-sm: rgba(0,0,0,.12); --shadow-lg: rgba(0,0,0,.18); }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; background: var(--surface); color: var(--text);
    border: 1px solid var(--line-hi); border-radius: 999px; padding: 8px 16px; cursor: pointer; box-shadow: 0 4px 18px var(--shadow-sm); font-weight: 600; }
  .fab:hover { background: var(--raised); }
  .backdrop { position: fixed; inset: 0; z-index: 2147483000; background: rgba(5,6,8,.74); display: grid; place-items: center; }
  .modal { width: min(1600px, 96vw); height: min(1000px, 94vh); background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: 0 20px 60px var(--shadow-lg);
    display: grid; grid-template-rows: auto auto 1fr; overflow: hidden; }
  .hd { display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--surface); height: 52px; }
  .ttl { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ttl b { font-size: 15px; font-weight: 650; white-space: nowrap; }
  .logo { width: 22px; height: 22px; flex: none; }
  .fab { display: inline-flex; align-items: center; gap: 8px; }
  .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 28ch; }
  .fctl { display: grid; gap: 2px; justify-items: center; }
  .fnum { display: inline-flex; align-items: center; gap: 4px; }
  .sessmain { display: inline-flex; align-items: center; gap: 7px; color: var(--text); cursor: pointer; }
  .sessmain .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .sessmain[data-state="live"] .dot { background: var(--ok); } .sessmain[data-state="paused"] .dot { background: var(--warn); }
  .popw { position: relative; }
  .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 5; min-width: 220px; padding: 4px; display: grid; gap: 2px;
    background: var(--raised); border: 1px solid var(--line-hi); border-radius: 10px; box-shadow: 0 8px 24px var(--shadow-lg); }
  .pop.right { left: auto; right: 0; }
  .mi { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left; background: none; border-color: transparent; padding: 6px 10px; }
  .mi:hover { background: var(--surface); border-color: transparent; }
  .lang { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r); padding: 1px; }
  .lang button { padding: 2px 8px; border: 0; font-weight: 600; } .lang button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
  button.ic { min-width: 28px; padding: 3px 7px; line-height: 1.2; }
  .fbar { display: flex; align-items: center; gap: 6px; }
  .ftl { position: relative; display: block; width: 240px; height: 20px; }
  .fmarks { position: absolute; left: 0; right: 0; top: 50%; height: 10px; margin-top: -5px; background: var(--raised); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .fm { position: absolute; top: 0; bottom: 0; display: block; }
  .fm.edit { background: var(--key-edit); opacity: .8; } .fm.auto { background: var(--key-auto); opacity: .8; }
  .fm.user { width: 2px; margin-left: -1px; background: var(--key-user); }
  .ftl input[type=range] { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; background: none; -webkit-appearance: none; appearance: none; cursor: pointer; }
  .ftl input[type=range]::-webkit-slider-runnable-track { background: none; height: 20px; }
  .ftl input[type=range]::-moz-range-track { background: none; height: 20px; }
  .ftl input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 3px; height: 18px; border-radius: 1px; background: var(--text); border: 0; box-shadow: 0 0 0 1px var(--bg); }
  .ftl input[type=range]::-moz-range-thumb { width: 3px; height: 18px; border-radius: 1px; background: var(--text); border: 0; }
  .fbar input[type=number] { width: 58px; padding: 3px 6px; text-align: right; }
  .muted { color: var(--muted); } .mono, .mono * { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  .sp { flex: 1; }
  button, select, input[type=number] { background: var(--raised); color: var(--text); border: 1px solid var(--line); border-radius: var(--r); padding: 5px 10px; }
  button, select { cursor: pointer; }
  button:hover, select:hover { border-color: var(--line-hi); }
  button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
  button.pri, button.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  button.pri:hover, button.on:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
  button:disabled { opacity: .45; cursor: default; }
  button.sm { padding: 3px 8px; font-size: 12px; }
  button.ghost { background: none; border-color: transparent; color: var(--muted); } button.ghost:hover { color: var(--text); border-color: var(--line); }
  .x { font-size: 15px; padding: 2px 9px; }
  input[type=range], input[type=checkbox], input[type=radio] { accent-color: var(--accent); }
  .tabs { display: flex; gap: 2px; padding: 6px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--line); background: var(--surface); }
  .tab { background: none; border-color: transparent; color: var(--muted); padding: 4px 10px; }
  .tab:hover { color: var(--text); background: var(--raised); }
  .tab .n { font-family: var(--mono); font-size: 11px; opacity: .7; margin-right: 6px; }
  .tab.sel { background: var(--text); border-color: var(--text); color: var(--on-accent); font-weight: 600; } .tab.sel .n { opacity: .6; }
  .tab .w { color: var(--warn); } .tab.sel .w { color: var(--warn); }
  .body { display: grid; grid-template-columns: var(--rail-w) 1fr 324px; min-height: 0; }
  .main { position: relative; display: grid; grid-template-rows: 1fr auto auto; min-height: 0; min-width: 0; }
  .rail { display: flex; flex-direction: column; gap: 10px; padding: 8px 6px; border-right: 1px solid var(--line); background: var(--surface); overflow: hidden; min-height: 0; }
  .rgrp { display: grid; gap: 4px; }
  .rb { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 8px; background: none; border-color: transparent; color: var(--text-2); }
  .rb:hover { background: var(--raised); border-color: transparent; color: var(--text); }
  .rb.on, .rb[aria-pressed="true"].tool { background: var(--accent); color: var(--on-accent); }
  .rb.on:hover { background: var(--accent-hi); }
  .rb.auto .ri { color: var(--box3d); } .rb.auto.on .ri { color: inherit; }
  .ri { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .rmode { display: grid; }
  .seg { display: grid; width: 100%; gap: 2px; } .seg button { padding: 2px 4px; font-size: 11px; color: var(--muted); }
  .seg button[aria-pressed="true"] { color: var(--text); font-weight: 700; border-color: var(--accent); background: var(--raised); }
  .rgrp + .rgrp { border-top: 1px solid var(--line); padding-top: 10px; }
  .rgh, .rl, .rb kbd { display: none; }
  .rgh { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--muted); padding: 0 6px; }
  .rl { flex: 1; min-width: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rb kbd { flex: none; background: none; border-color: color-mix(in srgb, currentColor 35%, transparent); color: inherit; }
  #railToggle .ri { transition: transform .12s; } #railToggle[aria-pressed="true"] .ri { transform: rotate(180deg); }
  .body.rail-open { --rail-w: 176px; }
  .body.rail-open .rgh, .body.rail-open .rl { display: block; } .body.rail-open .rb kbd { display: inline-block; }
  .body.rail-open .rb { justify-content: flex-start; padding: 0 10px; }
  .hintbar { display: flex; align-items: center; gap: 12px; min-height: 36px; padding: 0 12px; border-top: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 12px; }
  .quick { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); cursor: default; }
  .quickcard { width: 40%; min-width: 340px; max-width: 640px; padding: 24px 28px 20px; background: var(--surface); border: 1px solid var(--line-hi); border-radius: var(--r-lg); box-shadow: 0 8px 24px var(--shadow-lg); }
  .quickcard .quickhd b { font-size: 18px; line-height: 26px; } .quicktt { display: inline-flex; align-items: center; gap: 10px; } .quicktt .logo { width: 28px; height: 28px; }
  .quickintro { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
  .quick ol li { align-items: flex-start; } .quick ol li > div { display: grid; gap: 2px; } .quick ol li b { font-weight: 650; color: var(--text); } .qsub { color: var(--muted); font-size: 13px; }
  .quickcard ol { gap: 12px; margin-bottom: 20px; } .quickcard ol li { font-size: 15px; line-height: 22px; }
  .quickcard ol li::before { width: 24px; height: 24px; font-size: 12px; background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .quickcard .quickft { font-size: 13px; } .quickcard .quickft button { padding: 10px 14px; font-size: 14px; }
  .quickstate { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 20px; padding: 10px 12px; border-radius: var(--r); background: var(--raised); color: var(--text-2); font-size: 12.5px; text-align: center; white-space: pre-line; }
  .quickstate.loading::before { content: ""; flex: none; width: 14px; height: 14px; border: 2px solid var(--line-hi); border-top-color: var(--accent); border-radius: 50%; animation: qspin .8s linear infinite; }
  .quickstate.ready { color: var(--ok); }
  @keyframes qspin { to { transform: rotate(360deg); } } @media (prefers-reduced-motion: reduce) { .quickstate.loading::before { animation: none; } }
  .qsrow { margin-bottom: 14px; } .qsrow ol { margin: 4px 0 0; padding-left: 20px; display: flex; flex-wrap: wrap; gap: 4px 24px; }
  .quickhd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; } .quickhd b { font-size: 15px; font-weight: 650; }
  .quick ol { list-style: none; counter-reset: qs; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
  .quick ol li { counter-increment: qs; display: flex; align-items: center; gap: 10px; color: var(--text-2); }
  .quick ol li::before { content: counter(qs); flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font: 600 11px var(--mono); background: var(--raised); border: 1px solid var(--line-hi); color: var(--text); }
  .quickft { display: grid; gap: 8px; font-size: 12px; justify-items: stretch; }
  .quickft button { width: 100%; white-space: nowrap; padding: 7px 12px; }
  .quickft .muted { text-align: center; font-size: 11.5px; }
  .hintkeys { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
  .hk { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px 2px 3px; border: 1px solid transparent; border-radius: var(--r-sm); background: none; color: var(--muted); font-size: 11.5px; white-space: nowrap; cursor: default; }
  button.hk { cursor: pointer; } button.hk:hover { color: var(--text); background: var(--raised); border-color: var(--line); }
  .hlg { display: flex; gap: 12px; font-size: 11.5px; white-space: nowrap; } .hlg > span { display: inline-flex; align-items: center; gap: 5px; }
  .sw { display: inline-block; width: 10px; height: 8px; border-radius: 2px; }
  .sw.user { width: 3px; background: var(--key-user); } .sw.edit { background: var(--key-edit); } .sw.auto { background: var(--key-auto); }
  @media (max-width: 1100px) { .hlg { display: none; } }
  .trackbar { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); }
  .view { position: relative; background: #000; overflow: hidden; cursor: grab; min-height: 0; touch-action: none; user-select: none; }
  .view.drag { cursor: grabbing; } .view.draw, .view.pair { cursor: crosshair; }
  #cv { position: absolute; inset: 0; width: 100%; height: 100%; }
  .views { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 6px; height: 240px; border-top: 1px solid var(--line); background: var(--bg); }
  .bv { background: #0a0c0f; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; touch-action: none; min-width: 0; display: flex; flex-direction: column; }
  .bv canvas { display: block; } .bvt { font-size: 11px; color: var(--muted); padding: 2px 8px; border-bottom: 1px solid var(--line); height: 22px; white-space: nowrap; overflow: hidden; }
  .msg { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; padding: 16px; color: #c9cfdb; pointer-events: none; white-space: pre-line; }
  .hud { position: absolute; left: 10px; bottom: 8px; background: rgba(0,0,0,.62); padding: 2px 8px; border-radius: var(--r-sm); pointer-events: none; }
  .side { border-left: 1px solid var(--line); padding: 12px 14px 16px; overflow: auto; background: var(--surface); }
  .sidetabs { display: flex; gap: 2px; margin: -12px -14px 12px; padding: 0 8px; border-bottom: 1px solid var(--line); position: sticky; top: -12px; background: var(--surface); z-index: 1; }
  .sidetabs button { flex: 1; background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 10px 6px 8px; color: var(--muted); font-weight: 600; }
  .sidetabs button:hover { color: var(--text); }
  .sidetabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  .sidehd { display: flex; align-items: center; gap: 8px; } .sidehd b { font-size: 13px; font-weight: 650; } .sidehd select { flex: 1; min-width: 0; }
  .card { background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 10px 12px; margin-top: 10px; }
  .card > .row:first-child { margin-top: 0; }
  .facts { margin-top: 8px; }
  .edit { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
  .edit label { display: grid; gap: 2px; } .edit label > span { font-size: 11px; }
  .edit input { width: 100%; background: var(--bg); border-radius: var(--r-sm); padding: 2px 5px; font: 12px var(--mono); }
  .rot { margin-top: 8px; } input.yaw { flex: 1; min-width: 120px; }
  .acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .acts button { background: var(--surface); }
  .askcard { display: grid; gap: 8px; }
  .askbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .askbtns .pri { grid-column: 1 / -1; }
  .askbtns button { white-space: normal; min-width: 0; }
  .commit { display: flex; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
  .commit .sp { flex: 1; } .commit button { white-space: nowrap; }
  .warn { color: var(--warn); margin-top: 8px; }
  .sl { display: grid; grid-template-columns: 48px 1fr 64px; gap: 6px; align-items: center; margin: 3px 0; }
  .sl input[type=number] { width: 64px; background: var(--bg); border-radius: var(--r-sm); padding: 1px 3px; font: 12px var(--mono); }
  .opt { display: grid; grid-template-columns: 1fr 110px; gap: 6px; align-items: center; margin: 3px 0; }
  .autocls { flex-wrap: wrap; gap: 2px 10px; font-size: 12px; }
  input.thr { flex: 1; min-width: 80px; }
  .set { display: grid; gap: 10px; padding: 8px 0 4px; } .thrrow { display: grid; grid-template-columns: 90px 1fr 40px; align-items: center; gap: 6px; font-size: 12px; }
  .link { background: none; border: 0; padding: 0; color: var(--muted); text-align: left; cursor: pointer; font-size: 12px; }
  .link:hover { color: var(--text); text-decoration: underline; }
  .mapcard { display: grid; gap: 4px; width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--raised); }
  .maprow { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
  details { border-top: 1px solid var(--line); margin-top: 14px; }
  details summary { cursor: pointer; color: var(--muted); font-weight: 600; padding: 10px 0 2px; list-style: none; display: flex; gap: 6px; align-items: baseline; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '›'; display: inline-block; width: 10px; transition: transform .12s; }
  details[open] summary::before { transform: rotate(90deg); }
  details summary:hover { color: var(--text); }
  .shift { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; vertical-align: -1px; margin-right: 1px; }
  kbd { font: 11px var(--mono); background: var(--bg); border: 1px solid var(--line-hi); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--text); white-space: nowrap; }
  .sheet { position: absolute; inset: 0; z-index: 3; background: color-mix(in srgb, var(--bg) 94%, transparent); overflow: auto; padding: 18px 22px; }
  .sheet .shd { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; } .sheet .shd b { font-size: 15px; font-weight: 650; }
  .sheet .cols { columns: 3 260px; column-gap: 28px; }
  .sheet section { break-inside: avoid; margin-bottom: 16px; }
  .sheet h5 { margin: 0 0 6px; font-size: 13px; font-weight: 650; color: var(--text); }
  .sheet dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  .sheet dt { text-align: right; } .sheet section.core kbd { border-color: var(--accent); }
  .sheet section.core h5 { color: var(--accent); }
  .inkbd { margin-left: 6px; background: none; color: inherit; border-color: color-mix(in srgb, currentColor 35%, transparent); } .sheet dd { margin: 0; color: var(--text-2); }
  .dlgwrap { display: grid; place-items: start center; padding-top: 56px; background: color-mix(in srgb, var(--bg) 62%, transparent); }
  .dlg { width: min(680px, 94%); background: var(--surface); border: 1px solid var(--line-hi); border-radius: var(--r-lg); padding: 16px 18px; box-shadow: 0 16px 48px var(--shadow-lg); }
  .dlg .shd { margin-bottom: 4px; }
  .arow { display: grid; grid-template-columns: 92px 14px minmax(0, 1fr) minmax(0, 1fr) 40px 52px 28px; gap: 8px; align-items: center; margin: 6px 0; }
  .aadd { display: grid; grid-template-columns: 92px 14px minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
  .aadd select { width: 100%; } .arrow { color: var(--muted); text-align: center; }
  .arow.ahd { font-size: 12px; margin-top: 14px; } .arow select { width: 100%; } .arow .cnt { text-align: right; }
  .arow.off input[type=range], .arow.off .val { opacity: .35; }
  .auto-filter-block { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); display: flex; flex-direction: column; gap: 8px; }
  .auto-filter-row { display: grid; grid-template-columns: 1fr minmax(140px, 220px) 64px; gap: 12px; align-items: center; font-size: 13px; color: var(--text); }
  .auto-filter-row .lbl { color: var(--text-2); font-weight: 500; }
  .auto-filter-row input[type=range] { width: 100%; margin: 0; accent-color: var(--accent); cursor: pointer; }
  .auto-filter-row .val { text-align: right; font-size: 12.5px; color: var(--accent); font-weight: 600; }
  .scope { display: flex; gap: 14px; align-items: center; } .scope label { display: flex; gap: 5px; align-items: center; cursor: pointer; }
  .side { scrollbar-width: thin; scrollbar-color: var(--line-hi) transparent; }
  .object-list {
    margin: 8px 0 10px; border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden;
    background: var(--surface); color: var(--text); display: flex; flex-direction: column;
  }
  .object-tabs { display: flex; gap: 14px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
  .object-tabs .object-tab { padding: 9px 0 7px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted); font-size: 12.5px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .object-tabs .object-tab:hover { color: var(--text); background: none; border-bottom-color: var(--line-hi); }
  .object-tabs .object-tab.on, .object-tabs .object-tab.on:hover { border-bottom-color: var(--accent); color: var(--text); font-weight: 600; background: none; }
  .m-prog { padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--surface); display: flex; flex-direction: column; gap: 5px; }
  .m-prog-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .m-prog-title { font-size: 12.5px; color: var(--muted); }
  .m-prog-title b { font-size: 17px; font-weight: 700; color: var(--text); }
  .m-prog-sub { font-size: 12px; color: var(--muted); }
  .m-bar { height: 6px; background: var(--accent); border-radius: 3px; overflow: hidden; display: flex; }
  .object-list-rows { display: flex; flex-direction: column; background: var(--surface); }
  .object-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; border: 0; border-radius: 0; border-bottom: 1px solid var(--line); background: var(--surface); color: var(--text); text-align: left; font: inherit; cursor: pointer; }
  .object-row:last-child { border-bottom: 0; }
  .object-row:hover { background: var(--raised); }
  .object-id { font: 600 12px var(--mono); color: var(--muted); flex-shrink: 0; white-space: nowrap; }
  .object-class { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 500; min-width: 0; }
  .object-conf { margin-left: auto; color: var(--muted); font: 12px var(--mono); flex-shrink: 0; }
  .object-empty { padding: 12px; color: var(--muted); font-size: 12px; }
  .cv-tag { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; border: 1px solid; font-size: 11.5px; white-space: nowrap; margin-left: auto; font-weight: 600; flex-shrink: 0; }
  .cv-tag.ok { background: color-mix(in srgb, var(--ok) 30%, var(--surface)); border-color: var(--ok); color: var(--ok); }
  .cv-tag.warn { background: color-mix(in srgb, var(--warn) 30%, var(--surface)); border-color: var(--warn); color: var(--warn); }
  button.pri.kf-hold { background: var(--ok); border-color: var(--ok); }
  button.pri.kf-back { background: var(--accent); border-color: var(--accent); }
  button.pri.kf-new { background: var(--err); border-color: var(--err); }
  button.pri.kf-hold:hover, button.pri.kf-new:hover { filter: brightness(1.1); }
  .cv-tag.err { background: color-mix(in srgb, var(--err) 30%, var(--surface)); border-color: var(--err); color: var(--err); }
  .cv-tag.info { background: color-mix(in srgb, var(--accent) 35%, var(--surface)); border-color: var(--accent); color: var(--accent); }
  .m-cur {
    background: linear-gradient(180deg, var(--surface) 0%, var(--surface) 100%);
    border: 1.5px solid var(--accent);
    border-radius: 8px;
    margin: 6px 6px 10px;
    padding: 10px;
    box-shadow: 0 4px 20px var(--shadow-lg), 0 0 16px color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--text);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .m-cur:last-child { margin-bottom: 6px; }
  .m-cur-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding-bottom: 5px; border-bottom: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
  .m-cur.collapsed { padding: 6px 8px; } .m-cur.collapsed .m-cur-hd { border-bottom: 0; padding-bottom: 0; }
  .m-cur { position: relative; border-left: 4px solid var(--stripe, var(--line-hi)); }
  .m-cur[data-kf="kf-new"] { --stripe: var(--key-user); } .m-cur[data-kf="kf-back"] { --stripe: var(--key-edit); }
  .m-cur[data-kf="kf-hold"] { --stripe: var(--key-auto); } .m-cur[data-kf="out"] { --stripe: var(--line-hi); }
  .m-cur-hd { display: grid; grid-template-columns: auto 1fr auto; grid-template-areas: "id cls more" "kind cls more"; column-gap: 8px; align-items: center; }
  .m-cur-hd .id { grid-area: id; justify-self: start; cursor: pointer; }
  .m-cur-hd .kind { grid-area: kind; font-size: 10px; letter-spacing: .08em; color: var(--muted); margin-top: 2px; }
  .m-cur-hd > :is(select, b) { grid-area: cls; }
  .m-cur-hd .more { grid-area: more; }
  .m-cur.collapsed .kind { display: none; }
  .stateline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .stateline .frm { font-size: 11px; color: var(--muted); }
  .navrow, .toolrow { display: flex; justify-content: space-between; align-items: center; }
  .navrow { padding: 0 6px; }
  .m-cur button.ib { display: inline-flex; align-items: center; justify-content: center; width: 34px; min-width: 0; height: 32px; padding: 0; background: none; border-color: transparent; color: var(--text-2); }
  .m-cur button.ib:hover { background: color-mix(in srgb, var(--text) 10%, transparent); border-color: transparent; color: var(--text); }
  .m-cur button.ib:disabled { opacity: .4; cursor: default; }
  .m-cur button.ib.star.on { color: var(--key-user); } .m-cur button.ib.star.on .ri { fill: currentColor; }
  .m-cur button.ib.outb:hover { color: var(--warn); }
  .m-cur[data-kf="out"] .navrow, .m-cur[data-kf="out"] .toolrow .ib:not(.outb) { opacity: .45; }
  .m-cur details.cur-detail summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; color: var(--muted); font-size: 10.5px; letter-spacing: .08em; padding: 2px 0 4px; text-transform: uppercase; }
  .m-cur details.cur-detail summary::-webkit-details-marker { display: none; }
  .m-cur details.cur-detail summary .chev { display: inline-flex; transition: transform .12s; }
  .m-cur details.cur-detail:not([open]) summary .chev { transform: rotate(-90deg); }
  .m-cur details.cur-detail summary .ri { width: 15px; height: 15px; }
  .cardmenu { position: absolute; top: 40px; right: 6px; z-index: 6; min-width: 200px; background: var(--surface); border: 1px solid var(--line-hi); border-radius: var(--r-lg); padding: 4px; box-shadow: 0 8px 26px var(--shadow-lg); }
  .m-cur .cardmenu button { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 10px; background: none; border-color: transparent; text-align: left; }
  .m-cur .cardmenu button span:first-of-type { flex: 1; } .m-cur .cardmenu button:hover { background: color-mix(in srgb, var(--text) 9%, transparent); }
  .m-cur .cardmenu button.danger { color: var(--err); } .cardmenu .ri { width: 17px; height: 17px; }
  .m-cur-toggle { width: auto !important; flex: none; padding: 0 4px !important; border-color: transparent !important; background: none !important; color: var(--muted); }
  .m-cur-hd .id { cursor: pointer; }
  .m-cur-hd .id { font: 700 13px var(--mono); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); padding: 2px 7px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); flex-shrink: 0; white-space: nowrap; }
  .m-cur-hd b { font-weight: 650; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .m-cur-label { background: var(--raised); color: var(--text); border: 1px solid var(--accent); border-radius: 5px; padding: 2px 6px; font-weight: 600; font-size: 12.5px; min-width: 0; max-width: 120px; flex-shrink: 1; }
  .m-stat-row { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 11px; }
  .m-stat-pill { background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid color-mix(in srgb, var(--text) 8%, transparent); border-radius: 5px; padding: 3px 6px; display: flex; flex-direction: column; gap: 1px; }
  .m-stat-pill span.lbl { font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .m-stat-pill span.val { font-family: var(--mono); color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .m-dim-block { display: flex; flex-direction: column; }
  .m-dim-inputs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .m-dim-field { display: flex; flex-direction: column; gap: 2px; }
  .m-dim-field span { font-size: 10px; color: var(--muted); text-align: center; font-weight: 500; }
  .m-dim-field input { width: 100%; box-sizing: border-box; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; color: var(--text); padding: 4px 2px; text-align: center; font: 600 12px var(--mono); outline: none; }
  .m-dim-field input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--surface); }
  .m-yaw-block { background: color-mix(in srgb, var(--bg) 32%, transparent); border: 1px solid color-mix(in srgb, var(--text) 8%, transparent); border-radius: 6px; padding: 5px 8px; display: flex; flex-direction: column; gap: 3px; }
  .m-yaw-top { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; color: var(--muted); }
  .m-yaw-inp-wrap { display: flex; align-items: center; gap: 3px; }
  .m-yaw-inp-wrap input.yaw-num { width: 56px; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; color: var(--text); padding: 2px 4px; text-align: right; font: 600 12px var(--mono); outline: none; }
  .m-yaw-inp-wrap input.yaw-num:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .m-yaw-block input[type=range].yaw { width: 100%; accent-color: var(--accent); margin: 2px 0 0; }
  .m-cur-status { font-size: 11px; color: var(--muted); }
  .m-cur-status.edited { color: var(--accent); font-weight: 600; }
  .m-cur-warn { font-size: 11.5px; color: var(--warn); background: var(--raised); border: 1px solid var(--warn); border-radius: 5px; padding: 4px 8px; }
  .m-cur button, .m-foot button { font: 12.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--ctl); border: 1px solid var(--ctl-line); border-radius: 6px; padding: 5px 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: space-between; gap: 6px; white-space: nowrap; width: 100%; min-width: 0; }
  .m-cur button:hover, .m-foot button:hover { border-color: var(--accent); background: var(--ctl); }
  .m-cur button.pri { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 650; padding: 7px 10px; font-size: 13px; box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 35%, transparent); }
  .m-cur button.pri:hover { background: var(--accent); border-color: var(--accent); }
  .m-cur .k, .m-foot .k { font: 10.5px var(--mono); background: var(--ctl); border: 1px solid var(--ctl-line); border-radius: 4px; padding: 0 4px; color: var(--muted); flex-shrink: 0; }
  .m-cur button.pri .k { background: color-mix(in srgb, var(--text) 18%, transparent); border-color: color-mix(in srgb, var(--text) 40%, transparent); color: var(--on-accent); }
  .m-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
  .m-cur-track { display: flex; flex-direction: column; gap: 4px; padding-top: 5px; border-top: 1px solid color-mix(in srgb, var(--text) 8%, transparent); font-size: 12px; }
  .m-cur-track-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .m-cur-track input[type=number] { width: 46px; padding: 3px 4px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 5px; font: 11.5px var(--mono); text-align: center; flex-shrink: 0; }
  .m-cur-track button#trackGo { flex: 1 1 100%; padding: 5px 8px; font-size: 12px; }
  .m-cur details.cur-adv { border-top: 1px solid color-mix(in srgb, var(--text) 8%, transparent); margin-top: 1px; padding-top: 2px; }
  .m-cur details.cur-adv summary { padding: 4px 0 2px; font-size: 11.5px; color: var(--accent); font-weight: 600; cursor: pointer; }
  .m-cur .rot { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 12px; }
  .m-cur .rot input.yaw { flex: 1; accent-color: var(--accent); }
  .m-cur .edit { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-top: 6px; }
  .m-cur .edit label { display: grid; gap: 2px; }
  .m-cur .edit label > span { font-size: 11px; color: var(--muted); }
  .m-cur .edit input { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; font: 12px var(--mono); }
  .m-foot { padding: 8px 10px; border-top: 1px solid var(--line); background: var(--surface); }
  .toasts { position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px; z-index: 2147483001; display: flex;
    flex-direction: column; align-items: center; gap: 6px; max-width: 80vw; pointer-events: none; }
  .view .toasts { position: absolute; left: auto; right: 10px; top: 10px; bottom: auto; transform: none; align-items: flex-end; max-width: min(520px, 70%); z-index: 2; }
  .stale { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483002; display: flex; align-items: center; gap: 10px;
    background: var(--raised); color: var(--text); border: 1px solid var(--warn); padding: 8px 12px; border-radius: var(--r); box-shadow: 0 6px 20px var(--shadow-sm); }
  .stale[hidden] { display: none; }
  .toast { background: var(--raised); color: var(--text); border: 1px solid var(--line-hi); padding: 7px 12px; border-radius: var(--r); box-shadow: 0 6px 20px var(--shadow-sm); }
  .chip { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); background: none; color: var(--muted); white-space: nowrap; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; }
  .chip.busy { color: var(--warn); border-color: var(--warn); } .chip.err { color: var(--err); border-color: var(--err); cursor: pointer; }
  .prog { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin: 0 0 8px; } .prog > i { display: block; height: 100%; background: var(--text); }
  .rangeBack { position: fixed; inset: 0; z-index: 2147483002; background: color-mix(in srgb, var(--bg) 60%, transparent); backdrop-filter: blur(2px); display: grid; place-items: center; }
  .rangeDlg { width: min(430px, 94vw); background: var(--raised); border: 1px solid var(--ctl-line); border-radius: 8px; padding: 16px; box-shadow: 0 12px 36px var(--shadow-lg); color: var(--text); }
  .rangeDlg input[type=number] { width: 100%; margin-top: 3px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 5px; }
  .sessDlg { width: min(460px, 94vw); } .sessbtns { display: grid; gap: 8px; margin-top: 16px; } .sessbtns button { padding: 8px 12px; white-space: normal; }
  .sumgrid { display: grid; grid-template-columns: 1fr auto; gap: 6px 20px; margin-top: 12px; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }
  .motionChoice { display: grid; gap: 8px; margin-top: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; }
  .motionChoice label { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; cursor: pointer; }
  .motionChoice input { margin-top: 3px; }
  .trackDlg input[type=radio] { accent-color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { details summary::before { transition: none; } }
  @media (max-width: 900px) { .body { grid-template-columns: var(--rail-w) 1fr; grid-template-rows: 1fr auto; } .side { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); max-height: 42vh; } }`;

  /** Shift key cap: an outlined arrow instead of the "⇧" glyph (it renders differently on every system). */
  const SHIFT_SVG = '<svg class="shift" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 2.4 8.4h3.4v4.4h4.4V8.4h3.4z"/></svg>';
  /** A string with [Key] marks becomes text with key caps: "Lưu bằng [Enter]". */
  function richKeys(str) {
    return str.split(/\[([^\]]+)\]/).map((part, i) => (i % 2 ? Object.assign(document.createElement('kbd'), { textContent: part }) : part)).filter((x) => x !== '');
  }
  function keyCap(txt) {
    if (!txt.startsWith('⇧')) return [txt];
    const icon = new DOMParser().parseFromString(SHIFT_SVG, 'image/svg+xml').documentElement;
    return [document.importNode(icon, true), txt.slice(1)];
  }
  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k !== '' && k != null) e.append(k);
    return e;
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'lidar-cam-panel-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    // static markup only (no server/calib strings here)
    root.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL('ui/session-popup.css')}"><style>${CSS}</style>
      <button class="fab" id="fab" data-i18n-title="app.open"><img class="logo" src="${chrome.runtime.getURL('assets/Logo/boxlift-mark.svg')}" alt=""><span data-i18n="app.open"></span></button>
      <div class="toasts" id="toasts"></div>
      <div class="stale" id="stale" hidden role="alert"><span data-i18n="stale.msg"></span><button type="button" id="staleReload" data-i18n="stale.btn"></button></div>
      <div class="backdrop" id="panel" hidden>
        <div class="modal" role="dialog" aria-label="BoxLift">
          <div class="hd">
            <div class="ttl"><img class="logo" src="${chrome.runtime.getURL('assets/Logo/boxlift-mark.svg')}" alt=""><b>BoxLift</b><span class="mono muted where" id="where"></span></div>
            <div class="fctl">
              <div class="fbar" id="fbar"><button class="ic" id="fPrev" data-i18n-title="frame.prev" data-sfx=" (D)" data-i18n-aria="frame.prev">‹</button>
                <span class="ftl"><span class="fmarks" id="fMarks" aria-hidden="true"></span><input type="range" id="fRange" step="1"></span><button class="ic" id="fNext" data-i18n-title="frame.next" data-sfx=" (F)" data-i18n-aria="frame.next">›</button>
                <span class="fnum mono"><input type="number" id="fNum" data-i18n-title="frame.goto"><span class="muted" id="fTot"></span></span></div>
            </div>
            <span class="sp"></span>
            <button class="chip" id="saveChip"></button>
            <div class="popw">
              <button class="chip sessmain" id="sessionBtn" aria-haspopup="true" aria-expanded="false"><span class="dot" aria-hidden="true"></span><span class="mono" id="sessionLiveChip">0m · 0 box</span></button>
              <div class="pop" id="sessPop" role="menu" hidden>
                <button class="mi" id="sessionPauseBtn" role="menuitem"></button>
                <button class="mi" id="sessionSaveBtn" role="menuitem" data-i18n="session.save"></button>
                <button class="mi" id="sessionDashBtn" role="menuitem"><span data-i18n="session.dash"></span><kbd>${SHIFT_SVG}L</kbd></button>
              </div>
            </div>
            <div class="lang" role="group" data-i18n-aria="top.lang"><button class="ghost sm" id="langVi" data-lang="vi">VI</button><button class="ghost sm" id="langEn" data-lang="en">EN</button></div>
            <button class="ghost ic" id="guideBtn" data-i18n-title="top.keys" data-sfx=" (?)" data-i18n-aria="top.keys">?</button>
            <div class="popw">
              <button class="ghost ic" id="moreBtn" data-i18n-title="top.menu" data-i18n-aria="top.menu" aria-haspopup="true" aria-expanded="false">⋯</button>
              <div class="pop right" id="morePop" role="menu" hidden>
                <button class="mi" id="logBtn" role="menuitem" data-i18n="top.log"></button>
                <button class="mi" id="themeBtn" role="menuitem"></button>
                <button class="mi" id="helpBtn" role="menuitem"><span data-i18n="top.keys"></span><kbd>?</kbd></button>
              </div>
            </div>
            <button class="ghost ic" id="close" data-i18n-title="app.close" data-sfx=" (Esc)" data-i18n-aria="app.close">✕</button>
          </div>
          <div class="tabs" id="tabs"></div>
          <div class="body" id="body">
            <nav class="rail" id="rail" data-i18n-aria="group.draw">
              <div class="rgrp"><div class="rgh" data-i18n="group.draw"></div>
                <button class="rb on" id="selBtn" data-i18n-title="tool.select" data-sfx=" (V)"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6z"/></svg><span class="rl" data-i18n="tool.select"></span><kbd>V</kbd></button>
                <button class="rb" id="drawBtn" data-i18n-title="tool.draw" data-sfx=" (N)"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="1.6"/></svg><span class="rl" data-i18n="tool.draw"></span><kbd>N</kbd></button>
                <div class="rmode" role="group" data-i18n-aria="tool.mode"><span class="rgh" data-i18n="tool.mode"></span>
                  <span class="seg"><button class="sm" id="drawModeShape" title="Shift+N">Shape</button><button class="sm" id="drawModeTrack" title="Shift+N">Track</button></span></div>
              </div>
              <div class="rgrp"><div class="rgh" data-i18n="group.auto"></div>
                <button class="rb auto" id="autoBtn" data-i18n-title="tool.auto" data-sfx=" (T · Shift+T)"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3l1.8 4.7L17.5 9.5l-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z"/></svg><span class="rl" data-i18n="tool.auto"></span><kbd>T</kbd></button>
                <button class="rb" id="trackBtn" data-i18n-title="tool.track" data-sfx=" (Shift+K / L)"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="17" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="19" cy="14" r="2"/><path d="M6.6 15.6l4-5M13.8 9.6l3.6 2.8"/></svg><span class="rl" data-i18n="tool.track"></span><kbd>${SHIFT_SVG}K</kbd></button>
              </div>
              <div class="rgrp"><div class="rgh" data-i18n="group.view"></div>
                <button class="rb" id="tPts" data-sfx=" (H)"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="5" cy="18" r="1.2"/><circle cx="11" cy="19" r="1.2"/><circle cx="18" cy="18" r="1.2"/></svg><span class="rl" data-i18n="tool.points"></span><kbd>H</kbd></button>
              </div>
              <span class="sp"></span>
              <button class="rb ghost" id="railToggle" aria-pressed="false"><svg class="ri" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg><span class="rl" id="railToggleLbl"></span></button>
            </nav>
            <div class="main">
              <div class="view" id="vp"><canvas id="cv"></canvas><div class="msg" id="msg"></div><div class="hud mono" id="hud"></div>
                <div class="quick" id="quick" hidden role="note"><div class="quickcard"><div class="quickhd"><span class="quicktt"><img class="logo" src="${chrome.runtime.getURL('assets/Logo/boxlift-mark.svg')}" alt=""><b data-i18n="qs.title"></b></span><button class="ghost x" id="quickClose" aria-label="×">✕</button></div>
                  <p class="quickintro" data-i18n="qs.intro"></p>
                  <ol>
                    <li><div><b data-i18n="qs.1"></b><span class="qsub" data-i18n-keys="qs.s1"></span></div></li>
                    <li><div><b data-i18n="qs.2"></b><span class="qsub" data-i18n-keys="qs.s2"></span></div></li>
                    <li><div><b data-i18n-keys="qs.t3"></b><span class="qsub" data-i18n-keys="qs.s3"></span></div></li>
                    <li><div><b data-i18n-keys="qs.t4"></b><span class="qsub" data-i18n-keys="qs.s4"></span></div></li>
                  </ol>
                  <div class="quickft"><div class="quickstate" id="quickState" role="status"></div><button class="pri" id="quickGo" data-i18n="qs.go"></button><span class="muted" data-i18n-keys="qs.hint"></span></div></div></div></div>
              <div id="views" class="views"></div>
              <div class="hintbar" id="hintbar">
                <span id="hintTxt"></span><span class="sp"></span>
                <span class="hlg" id="hintLegend" hidden><span><i class="sw user"></i><span data-i18n="key.user"></span></span><span><i class="sw edit"></i><span data-i18n="key.between"></span></span><span><i class="sw auto"></i><span data-i18n="key.auto"></span></span></span>
                <span class="hintkeys" id="hintKeys"></span>
                <span class="trackbar" id="trackBar" hidden><span id="trackTxt" class="mono"></span><button class="sm" id="trackCancel" data-i18n="track.cancel"></button></span>
              </div>
              <div class="sheet" id="keysDet" hidden role="dialog" data-i18n-aria="keys.title"><div class="shd"><b data-i18n="keys.title"></b><span class="muted" data-i18n="keys.close"></span><span class="sp"></span><button class="ghost x" id="keysClose">✕</button></div>
                <div class="qsrow"><b data-i18n="qs.title"></b><ol><li data-i18n="qs.1"></li><li data-i18n="qs.2"></li><li data-i18n="qs.3"></li><li data-i18n="qs.4"></li></ol></div>
                <div class="cols" id="keysCols"></div></div>
              <div class="sheet dlgwrap" id="autoDlg" hidden role="dialog" data-i18n-aria="auto.title"><div class="dlg">
                <div class="shd"><b data-i18n="auto.title"></b><span class="sp"></span><button class="ghost x" id="autoDlgClose" title="Esc">✕</button></div>
                <div class="muted" id="autoNote"></div>
                <div class="arow ahd muted"><span data-i18n="auto.model"></span><span></span><span data-i18n="auto.label"></span><span data-i18n="auto.threshold"></span><span></span><span class="cnt" data-i18n="auto.count" data-i18n-title="auto.count.tip"></span><span></span></div>
                <div id="autoRows"></div>
                <details class="auto-adv"><summary data-i18n="auto.advanced"></summary>
                <div class="auto-filter-block">
                  <div class="auto-filter-row" data-i18n-title="auto.minpts.tip">
                    <span class="lbl" data-i18n="auto.minpts"></span>
                    <input id="minPts" type="range" min="0" max="50" step="5">
                    <span class="mono val"><span id="minPtsV">0</span> <span data-i18n="auto.points"></span></span>
                  </div>
                  <div class="auto-filter-row" data-i18n-title="auto.overlap.tip">
                    <span class="lbl" data-i18n="auto.overlap"></span>
                    <input id="overlap" type="range" min="5" max="95" step="5">
                    <span class="mono val" id="overlapV">50%</span>
                  </div>
                </div>
                </details>
                <div class="commit"><div class="scope"><label><input type="radio" name="scope" id="scopeCam" checked> <span data-i18n="auto.scope.cam"></span></label><label><input type="radio" name="scope" id="scopeAll"> <span data-i18n="auto.scope.all"></span></label></div>
                  <span class="sp"></span><button id="autoCancel" data-i18n="app.close"></button><button class="pri" id="autoRun"><span data-i18n="auto.run"></span><kbd class="inkbd">↵</kbd></button></div>
              </div></div>
            </div>
            <div class="side" id="side">
              <div class="sidetabs" role="tablist" data-i18n-aria="tab.aria">
                <button role="tab" id="tabBox" data-tab="box" data-i18n="tab.box"></button>
                <button role="tab" id="tabView" data-tab="view" data-i18n="tab.view"></button>
                <button role="tab" id="tabSetup" data-tab="setup" data-i18n="tab.setup"></button>
              </div>
              <section class="pane" id="paneBox" role="tabpanel" data-pane="box">
                <div class="sidehd"><b data-i18n="box.label"></b><select id="label" data-i18n-title="box.label.tip"></select></div>
                <div id="boxPanel"></div>
              </section>
              <section class="pane" id="paneView" role="tabpanel" data-pane="view" hidden>
                <label class="opt"><span data-i18n="view.size"></span> <input id="size" type="range" min="1" max="6" value="2"></label>
                <label class="opt"><span data-i18n="view.alpha"></span> <input id="alpha" type="range" min="10" max="100" value="80"></label>
                <label class="opt"><span data-i18n="view.range"></span> <input id="maxR" type="range" min="10" max="100" value="40"></label>
                <label class="opt"><span data-i18n="view.show"></span> <input id="show" type="checkbox" checked></label>
                <label class="opt"><span data-i18n="view.mono"></span> <input id="mono" type="checkbox"></label>
                <label class="opt"><span><span data-i18n="view.ground"></span> (G)</span> <input id="ground" type="checkbox"></label>
                <label class="opt"><span><span data-i18n="view.three"></span> (Shift+V)</span> <input id="viewsOn" type="checkbox"></label>
              </section>
              <section class="pane" id="paneSetup" role="tabpanel" data-pane="setup" hidden>
                <div class="set" id="setDet">
                  <label class="opt" data-i18n-title="setup.mode.tip"><span data-i18n="setup.mode"></span>
                    <select id="saveMode"><option value="shape">Shape</option><option value="track">Track</option></select></label>
                  <div class="row" style="margin-top:0"><span class="muted" id="autoSum"></span><button class="link" id="autoCfgBtn" data-i18n="setup.auto.cfg"></button></div>
                  <label class="opt" data-i18n-title="setup.autosave.tip"><span data-i18n="setup.autosave"></span> <input id="autoSave" type="checkbox"></label>
                  <label class="opt" data-i18n-title="setup.gap.tip"><span data-i18n="setup.gap"></span> <input id="trackGap" type="number" min="1" max="60" step="1"></label>
                  <div class="row"><button class="sm" id="cfgExport" data-i18n="setup.cfg.export" data-i18n-title="setup.cfg.tip"></button>
                    <button class="sm" id="cfgImportBtn" data-i18n="setup.cfg.import"></button><input id="cfgImport" type="file" accept=".json" hidden></div>
                  <div id="logRow"></div>
                </div>
                <details open id="poseDet"><summary data-i18n="setup.pose"></summary>
                  <div class="row" style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="sm pri" id="poseAutoBtn" data-i18n="setup.pose.auto" data-i18n-title="setup.pose.auto.tip"></button>
                    <button class="sm" id="poseImportBtn" data-i18n="setup.pose.file" data-i18n-title="setup.pose.file.tip"></button>
                    <input id="poseImport" type="file" accept=".json,application/json" hidden>
                  </div>
                  <div class="muted" id="poseInfo" style="margin-top:6px"></div>
                </details>
                <details id="calibDet"><summary><span data-i18n="setup.calib"></span> <span id="camq"></span></summary>
                  <div id="sliders"></div>
                  <div class="row"><button id="reset" data-i18n="setup.calib.reset"></button><button id="save" data-i18n="setup.calib.save"></button></div>
                  <div class="row"><label data-i18n-title="setup.calib.profile.tip"><span data-i18n="setup.calib.profile"></span> <select id="profile"></select></label></div>
                  <div class="row"><button id="export" data-i18n="setup.calib.export"></button><button id="importBtn" data-i18n="setup.calib.import"></button>
                    <input id="import" type="file" accept=".json" hidden></div>
                  <div class="muted" id="calibsrc" style="margin-top:6px"></div>
                </details>
              </section>
            </div>
          </div>
        </div>
      </div>`;
    Object.assign(ui, { root, host, ...Object.fromEntries([...root.querySelectorAll('[id]')].map((e) => [e.id, e])) });
    root.addEventListener('click', (e) => {
      const path = e.composedPath();
      if (ui.cardMenu && !ui.cardMenu.hidden && !path.includes(ui.cardMenu) && !path.includes(ui.cardMore)) ui.cardMenu.hidden = true;
    });

    // keep CVAT from reacting to anything done inside the window (its shortcuts listen on document)
    for (const t of ['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'contextmenu']) {
      ui.panel.addEventListener(t, (e) => e.stopPropagation());
    }
    ui.fab.onclick = () => togglePanel(true);
    ui.close.onclick = () => closePanel();
    ui.drawBtn.onclick = () => setMode(st.mode === 'draw' ? 'view' : 'draw');
    ui.selBtn.onclick = () => setMode('view');
    ui.railToggle.onclick = () => { st.opts.railOpen = !st.opts.railOpen; saveOpts(); applyRail(); };
    for (const [id, k] of [['selBtn', 'select'], ['autoBtn', 'auto'], ['trackBtn', 'track'], ['tPts', 'points'], ['drawModeShape', 'mode'], ['drawModeTrack', 'mode']]) ui[id].addEventListener('click', () => noteTool(k));
    for (const b of ui.side.querySelectorAll('.sidetabs [role=tab]')) b.onclick = () => selectSideTab(b.dataset.tab);
    ui.quick.addEventListener('pointerdown', (e) => e.stopPropagation());
    ui.quickClose.onclick = () => { st.quickHidden = true; st.quickLatched = false; updateQuick(); };
    new MutationObserver(syncQuickState).observe(ui.msg, { childList: true, characterData: true, subtree: true });
    ui.quickGo.onclick = startFromQuick;
    if (ui.drawModeShape) ui.drawModeShape.onclick = (e) => { e.stopPropagation(); setSaveMode('shape'); };
    if (ui.drawModeTrack) ui.drawModeTrack.onclick = (e) => { e.stopPropagation(); setSaveMode('track'); };
    updateSaveModeUI();
    ui.saveMode.onchange = () => setSaveMode(ui.saveMode.value);
    buildAutoClasses();
    ui.minPts.oninput = () => { st.opts.minPoints = Number(ui.minPts.value); ui.minPtsV.textContent = ui.minPts.value; saveOpts(); refilterAuto(); buildAutoClasses(); };
    ui.overlap.oninput = () => { st.opts.overlap = Number(ui.overlap.value) / 100; ui.overlapV.textContent = `${ui.overlap.value}%`; saveOpts(); refilterAuto(); buildAutoClasses(); };
    ui.cfgExport.onclick = exportConfig;
    ui.cfgImportBtn.onclick = () => ui.cfgImport.click();
    ui.cfgImport.onchange = async () => { const f = ui.cfgImport.files[0]; ui.cfgImport.value = ''; if (f) importConfig(await f.text()); };
    ui.saveChip.onclick = () => { if (st.saveError && st.outbox.length) { clearTimeout(retryTimer); flushOutbox(); } };
    updateSaveChip();
    ui.fPrev.onclick = () => stepFrame(-1);
    ui.fNext.onclick = () => stepFrame(1);
    ui.fRange.oninput = () => { ui.fRange.dragging = true; ui.fNum.value = ui.fRange.value; };
    ui.fRange.onchange = () => { ui.fRange.dragging = false; gotoFrame(Number(ui.fRange.value)); };
    if (ui.trackBtn) ui.trackBtn.onclick = () => openTrackDialog();
    ui.autoBtn.onclick = (e) => openAutoDlg(e.shiftKey);
    if (ui.autoCfgBtn) ui.autoCfgBtn.onclick = () => openAutoDlg(false);
    if (ui.autoCfg) ui.autoCfg.onclick = () => openAutoDlg(false);
    ui.autoDlgClose.onclick = ui.autoCancel.onclick = () => closeAutoDlg();
    ui.autoRun.onclick = () => runFromDlg();
    ui.trackCancel.onclick = () => { if (tracking) tracking.cancel = true; };
    ui.trackGap.onchange = () => { st.opts.trackGap = Math.max(1, Number(ui.trackGap.value) || 10); saveOpts(); };
    if (typeof SessionPopup !== 'undefined') {
      sessionPopup = new SessionPopup.SessionPopupComponent({
        origin: location.origin,
        onCvatSave: () => closePanel({ decided: 'save' }),
        getActive: () => st.activeSession,
        onSaveSession: () => saveSessionFlow(),
        onSessionChange: () => updateSessionLiveChip(),
        onToast: toast
      });
      sessionPopup.mount(root);
      ui.sessionDashBtn.onclick = () => { closePops(); sessionPopup.open('dashboard'); };
      if (ui.sessionPauseBtn) {
        ui.sessionPauseBtn.onclick = () => {
          if (!st.activeSession || typeof SessionManager === 'undefined') return;
          if (st.activeSession.status === 'paused') {
            SessionManager.resumeSession(st.activeSession);
            SessionManager.saveActiveSession(location.origin, st.activeSession);
            toast(I18N.t('toast.session.resumed'));
          } else {
            SessionManager.pauseSession(st.activeSession);
            SessionManager.saveActiveSession(location.origin, st.activeSession);
            toast(I18N.t('toast.session.paused'));
          }
          updateSessionLiveChip();
          if (sessionPopup && sessionPopup.isOpen) sessionPopup.render();
        };
      }
      if (ui.sessionSaveBtn) {
        ui.sessionSaveBtn.onclick = () => { closePops(); saveSessionFlow(); };
      }
      ui.logBtn.onclick = () => { closePops(); sessionPopup.open('sessions'); };
    } else {
      ui.logBtn.onclick = () => { closePops(); window.open(chrome.runtime.getURL('ui/logtab.html'), '_blank'); };
      ui.sessionDashBtn.onclick = ui.logBtn.onclick;
    }
    ui.helpBtn.onclick = () => { closePops(); showShortcuts(); };
    ui.guideBtn.onclick = () => showShortcuts();
    for (const [b, p] of [[ui.sessionBtn, ui.sessPop], [ui.moreBtn, ui.morePop]]) b.onclick = () => { const open = p.hidden; closePops(); p.hidden = !open; b.setAttribute('aria-expanded', String(open)); };
    ui.panel.addEventListener('pointerdown', (e) => { if (!e.composedPath().some((n) => n.classList && n.classList.contains('popw'))) closePops(); }, true);
    for (const b of [ui.langVi, ui.langEn]) b.onclick = () => { st.opts.lang = I18N.setLang(b.dataset.lang); saveOpts(); applyLang(); };
    applyLang();
    ui.themeBtn.onclick = () => { closePops(); st.opts.theme = st.opts.theme === 'dark' ? 'light' : 'dark'; saveOpts(); applyTheme(); };
    ui.keysClose.onclick = () => showShortcuts(false);
    ui.tPts.onclick = () => cyclePoints();
    ui.staleReload.onclick = () => location.reload();
    ui.label.onchange = () => { st.labelId = Number(ui.label.value); if (st.proposal && st.proposal.item) st.proposal.item.labelId = st.labelId; refit(); };
    ui.reset.onclick = () => { if (!st.calib) return; st.adj[st.cam] = defAdj(); buildSliders(); draw(); };
    ui.save.onclick = () => saveCalib();
    if (ui.pairBtn) {
      ui.pairBtn.onclick = () => setMode(st.mode === 'pair' ? 'view' : 'pair');
      ui.pairSolve.onclick = solvePairs;
      ui.pairMeasure.onclick = measurePairs;
      ui.pairExport.onclick = exportPairs;
      ui.pairUndo.onclick = () => { if (st.pending) st.pending = null; else (st.pairs[st.cam] || []).pop(); savePairs(); pairInfoUpdate(); draw(); };
      ui.pairClear.onclick = () => {
        const n = (st.pairs[st.cam] || []).length;
        if (n && confirm(`Xoá ${n} cặp điểm của ${st.cam}?`)) { st.pairs[st.cam] = []; st.pending = null; savePairs(); pairInfoUpdate(); draw(); }
      };
    }
    ui.export.onclick = exportCalib;
    if (ui.poseAutoBtn) ui.poseAutoBtn.onclick = () => runAutoOdometry();
    ui.poseImportBtn.onclick = () => ui.poseImport.click();
    ui.poseImport.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const raw = JSON.parse(await f.text());
        setPoseMeta(raw, f.name);
        try {
          await chrome.storage.local.set({ [poseKey(st.job)]: { raw, src: f.name, at: Date.now() } });
          toast(I18N.t('toast.pose.ok', { m: st.poseCoverage.matched, t: st.poseCoverage.total }));
        } catch (saveErr) { toast(`Đã nạp ego pose cho phiên này nhưng không nhớ được: ${saveErr.message}`); }


        // Đẩy lên Supabase: chỉ chính thiết bị này đọc lại được (owner_device_id)
        const SL = typeof SupaLog !== 'undefined' ? SupaLog : (typeof root !== 'undefined' ? root.SupaLog : null);
        if (SL && SL.upsertTaskPose && st.job) {
          SL.upsertTaskPose({
            origin: location.origin,
            taskId: st.job.taskId,
            taskName: st.job.taskName,
            source: f.name,
            rawPose: raw,
            frameCount: raw.frames ? raw.frames.length : 0
          }).catch((err) => console.warn('[lidar-cam] sync pose to supabase failed', err.message));
        }
      } catch (err) { toast('Ego pose metadata lỗi: ' + err.message); }
      ui.poseImport.value = '';
    };
    ui.importBtn.onclick = () => ui.import.click();
    ui.import.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        setCalib(JSON.parse(await f.text()), f.name, null, null);
        await saveCalib(true); await loadPairs(); await loadPoseFor(st.job); toast('Task này dùng ' + f.name);
      } catch (err) { toast('calib.json lỗi: ' + err.message); }
    };
    ui.profile.onchange = () => { if (ui.profile.value) chooseProfile(ui.profile.value).catch((err) => toast(err.message)); };
    const bind = (id, k, f) => (ui[id].oninput = () => { st.opts[k] = f(ui[id]); saveOpts(); draw(); });
    bind('size', 'size', (e) => +e.value); bind('alpha', 'alpha', (e) => e.value / 100);
    bind('maxR', 'maxR', (e) => +e.value); bind('ground', 'hideGround', (e) => e.checked); bind('show', 'show', (e) => e.checked);
    bind('viewsOn', 'views', (e) => e.checked); bind('autoSave', 'autoSave', (e) => e.checked); bind('mono', 'mono', (e) => e.checked);

    // zoom / pan / draw
    ui.vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = ui.vp.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      const z = Math.min(12, Math.max(1, view.zoom * Math.exp(-e.deltaY * 0.0015))), f = z / view.zoom;
      view.ox = mx - (mx - view.ox) * f; view.oy = my - (my - view.oy) * f; view.zoom = z;
      if (z === 1) { view.ox = 0; view.oy = 0; }
      drawSoon();
    }, { passive: false });
    let drag = null;
    const toImg = (e) => {
      const r = ui.vp.getBoundingClientRect();
      return [((e.clientX - r.left) * tf.dpr - tf.ox) / tf.s, ((e.clientY - r.top) * tf.dpr - tf.oy) / tf.s];
    };
    // pointer capture: once a drag starts on the image, every move/up goes to it even if the page
    // (CVAT) listens on window/document and stops propagation
    ui.vp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { ui.vp.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const r = ui.vp.getBoundingClientRect(), cx = (e.clientX - r.left) * (tf ? tf.dpr : 1), cy = (e.clientY - r.top) * (tf ? tf.dpr : 1);
      const hh = handleHits.find((q) => Math.hypot(q.x - cx, q.y - cy) < 10 * (tf ? tf.dpr : 1));
      if (hh && st.proposal) drag = { kind: 'handle', h: hh.h, box0: { ...st.proposal.box } };
      else if (st.mode === 'draw' && !e.altKey && tf) { const [u, v] = toImg(e); drag = { kind: 'rect', u0: u, v0: v, u1: u, v1: v }; }
      else { drag = { kind: 'pan', x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: 0 }; ui.vp.classList.add('drag'); }
    });
    ui.vp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'rect') { [drag.u1, drag.v1] = toImg(e); drawSoon(drag); }
      else if (drag.kind === 'handle') {
        const p = st.proposal; if (!p) return;
        Object.assign(p.box, BH.drag(drag.box0, drag.h, toImg(e), proj3, { vertical: e.shiftKey }));
        drawSoon(); syncFields();
      } else { drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y)); view.ox = drag.ox + e.clientX - drag.x; view.oy = drag.oy + e.clientY - drag.y; drawSoon(); }
    });
    const endDrag = (e) => {
      const d = drag; drag = null; ui.vp.classList.remove('drag');
      if (drawRaf) draw();                         // the last move, without the drag rectangle
      try { ui.vp.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (d && d.kind === 'handle') { commit(); buildBoxPanel(); return; }
      if (d && d.kind === 'pan' && d.moved < 4 && tf && st.mode === 'pair') { pairClick(...toImg(e)); return; }
      if (d && d.kind === 'pan' && d.moved < 4 && tf) {         // a click (no drag): select the box under it
        const [u, v] = toImg(e), pend = pendingAt(u, v), rec = pend ? null : boxAt(u, v);
        if (pend) { if (pend.batch === st.batch) selectInBatch(st.batch.items.indexOf(pend.item), true); else resumeParked(pend.item, true); return; }
        if (rec) selectServerBox(rec);
        else if (st.proposal && !st.proposal.item) { if (!autoSave()) return; draw(); buildBoxPanel(); }
        return;
      }
      if (d && d.kind === 'rect') {
        const dragged = Math.abs(d.u1 - d.u0) * tf.s / tf.dpr > 6 || Math.abs(d.v1 - d.v0) * tf.s / tf.dpr > 6;
        if (st.proposal && !st.proposal.item) autoSave();   // a new box: the previous one is accepted
        if (dragged) runFit({ u0: d.u0, v0: d.v0, u1: d.u1, v1: d.v1 });
        else runClick({ u: d.u0, v: d.v0 });       // a plain click: seed a 3D region grow
        if (st.proposal) setMode('view');          // one box per N: adjust / save it, N again to draw the next (no box made: stay, to retry)
      }
    };
    ui.vp.addEventListener('pointerup', endDrag);
    // top / side / front views of the proposal: drag edges to resize, inside to move, (top) outside to rotate
    boxViews = BV.create(ui.views, {
      box: () => (st.proposal && current && st.proposal.frame === st.frame ? st.proposal.box : null),
      cloud: () => current,
      onLive: () => { draw(); syncFields(); },
      onCommit: () => { commit(); draw(); buildBoxPanel(); },
      onRotate: (yaw) => setYaw(yaw, true),
    });
    ui.vp.addEventListener('pointercancel', () => { drag = null; ui.vp.classList.remove('drag'); draw(); });
    ui.vp.addEventListener('dblclick', () => { view.zoom = 1; view.ox = 0; view.oy = 0; draw(); });
    new ResizeObserver(() => st.open && draw()).observe(ui.vp);
    new ResizeObserver(() => st.open && boxViews && boxViews.draw()).observe(ui.views);

    ui.panel.addEventListener('keydown', onKey);
    window.addEventListener('keydown', (e) => { if (st.open && !e.composedPath().includes(ui.panel)) onKey(e); }, true);
  }

  /** QuickStart: Enter / Space (or the button) closes the guide and starts drawing. */
  function startFromQuick() { if (!quickReady()) return; st.quickHidden = true; st.quickLatched = false; setMode('draw'); updateQuick(); }
  function closePops() {
    for (const [b, p] of [[ui.sessionBtn, ui.sessPop], [ui.moreBtn, ui.morePop]]) { p.hidden = true; b.setAttribute('aria-expanded', 'false'); }
  }
  function onKey(e) {
    if (!st.open || e.__lidarCam) return;
    noteStale();
    if (e.key === 'Escape' && (!ui.sessPop.hidden || !ui.morePop.hidden)) { closePops(); e.preventDefault(); e.stopPropagation(); return; }
    if (sessionPopup && sessionPopup.isOpen && e.key === 'Escape') {
      sessionPopup.close(); e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault(); e.stopPropagation();
      if (sessionPopup) {
        if (sessionPopup.isOpen) sessionPopup.close();
        else sessionPopup.open('dashboard');
      }
      return;
    }
    e.__lidarCam = true;
    const target = e.composedPath()[0] || {};
    if (ui.rangeDlg?.contains(target) || ui.trackDlg?.contains(target) || ui.sessDlg?.contains(target)) return;
    if (!ui.autoDlg.hidden) {
      if (e.key === 'Escape') closeAutoDlg();
      else if (e.key === 'Enter' && target.tagName !== 'SELECT') runFromDlg();
      else return;
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.key === 'Escape' && !ui.keysDet.hidden) { showShortcuts(false); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape' && st.mode === 'pair') {
      if (st.pending) { st.pending = null; pairInfoUpdate(); draw(); } else setMode('view');
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.key === 'Escape') {
      if (st.sizeAsk && !st.proposal) { st.sizeAsk = null; draw(); buildBoxPanel(); }
      else if (st.batch) parkBatch();
      else if (st.proposal) { setProposal(null); draw(); buildBoxPanel(); } else closePanel();
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (target.id === 'trackLo' || target.id === 'trackHi') {
      if (e.key === 'Enter') { ui.boxPanel.querySelector('#trackGo')?.click(); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (target.tagName === 'INPUT' && target.type === 'number') {
      if (e.key === 'Enter' && st.proposal) { target.dispatchEvent(new Event('change')); target.blur(); saveProposal(true); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (target.tagName === 'SELECT') return;
    const k = e.shiftKey ? 5 : 1, ctrl = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key, p = st.proposal;
    const map = { ArrowLeft: ['pan', -0.05], ArrowRight: ['pan', 0.05], ArrowUp: ['tilt', -0.05], ArrowDown: ['tilt', 0.05],
      q: ['roll', -0.05], e: ['roll', 0.05] };
    if (st.calib && ui.calibDet.open && map[key] && !ctrl) { const a = st.adj[st.cam], [pp, d] = map[key]; a[pp] = +(a[pp] + d * k).toFixed(3); buildSliders(); draw(); }
    // CVAT-style
    else if (ctrl && key === 'z' && !e.shiftKey) { if (!undoEdit()) undoAction(); }
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) redoEdit();
    else if (ctrl && key === 's') { if (p) saveProposal(true); else flushOutbox(); }
    else if (ctrl && key === 'c') copyBox();
    else if (ctrl && key === 'v') pasteBox();
    else if (ctrl && /^[1-9]$/.test(key)) { const l = st.job && st.job.labels[+key - 1]; if (l) { st.labelId = l.id; ui.label.value = String(l.id); if (p && p.item) p.item.labelId = l.id; buildBoxPanel(); } }
    else if (ctrl) return;
    else if (!ui.quick.hidden && !p && !e.shiftKey && (key === 'Enter' || key === ' ') && target.tagName !== 'INPUT' && target.id !== 'quickClose') startFromQuick();
    else if (key === 'n' || key === 'b') {
      if (e.shiftKey && key === 'n') setSaveMode(st.saveMode === 'shape' ? 'track' : 'shape');
      else setMode(st.mode === 'draw' ? 'view' : 'draw');
    }
    else if (key === ' ' && p && target.tagName !== 'BUTTON') toggleCard();
    else if (e.key === '?') showShortcuts();
    else if (key === 'Enter' && e.shiftKey && st.batch) saveAllBatch();
    else if (key === 'Enter' && st.sizeAsk && !p) answerSize(true);
    else if (key === 'Enter' && p) saveProposal(true);
    else if ((key === 'Delete' || key === 'Backspace') && p) deleteSelected();
    else if (key === 'l') { if (e.shiftKey) nextFrameAndPropagate(); else if (p && !p.item) openTrackDialog(); else propagateFromPrev(); }
    else if (key === 't') autoDetect(e.shiftKey);
    else if (key === 'x' && p && p.item) skipInBatch();
    else if (key === 'p' && p && p.item) togglePred();
    else if (key === 'Tab' && st.batch) selectInBatch((st.batch.idx + (e.shiftKey ? -1 : 1) + st.batch.items.length) % st.batch.items.length);
    else if (key === 'Tab' && (!p || p.edit) && parkedKey() != null) resumeParked();
    else if (key === 'Tab') {
      const list = serverBoxesAt(st.frame).sort((a, b) => Math.hypot(a.box.x, a.box.y) - Math.hypot(b.box.x, b.box.y));
      if (list.length) { const i = p && p.edit ? list.findIndex((r) => recKey(r) === recKey(p.edit)) : -1; selectServerBox(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length], true); }
    }
    else if (key === 'r' && p) { if (e.shiftKey) tweak((b) => { b.yaw += Math.PI; }); else tweak((b) => { b.yaw += Math.PI / 2; [b.l, b.w] = [b.w, b.l]; }); }
    else if (key === 's' && p) snapYaw();
    else if (key === 'a' && p) alignGround();
    else if (key === '[' && p) tweak((b) => { b.yaw -= DEG * k; });
    else if (key === ']' && p) tweak((b) => { b.yaw += DEG * k; });
    else if ((key === ',' || key === '.') && p) tilt((key === '.' ? 1 : -1) * 0.5 * DEG * (e.shiftKey ? 4 : 1), 0);
    else if ((key === ';' || key === "'") && p) tilt(0, (key === "'" ? 1 : -1) * 0.5 * DEG * (e.shiftKey ? 4 : 1));
    else if (key.startsWith('Arrow') && p) { const m = e.shiftKey ? 0.5 : 0.1; nudge(key === 'ArrowUp' ? m : key === 'ArrowDown' ? -m : 0, key === 'ArrowLeft' ? m : key === 'ArrowRight' ? -m : 0, 0); }
    else if (key === 'h') cyclePoints();
    else if (key === 'g') toggleOpt('hideGround', 'ground');
    else if (key === 'o' && !e.altKey) trackCmd('outside');
    else if (key === 'k') { if (e.shiftKey) openTrackDialog(); else keyframeKey(); }
    else if (key === 'v' && e.shiftKey) toggleOpt('views', 'viewsOn');
    else if (key === 'v') setMode('view');
    else if (/^[1-8]$/.test(key)) {
      const list = visibleCams();
      if (list[+key - 1]) selectCam(list[+key - 1].name);
    }
    else return;
    e.preventDefault(); e.stopPropagation();
  }

  const OPTS_KEY = 'viewOpts';
  /** Light / dark window: data-theme on the host picks the CSS tokens under :host (dark) / :host([data-theme="light"]). */
  /** Chuỗi tĩnh của giao diện: phần tử có data-i18n (chữ), data-i18n-title / -aria (+ data-sfx: phím), điền từ bảng chuỗi. */
  /** Bảng phải: 3 tab Box · Hiển thị · Thiết lập; tab đang chọn được nhớ theo trình duyệt. */
  function selectSideTab(name, save = true) {
    if (!['box', 'view', 'setup'].includes(name)) name = 'box';
    st.opts.sideTab = name;
    for (const b of ui.side.querySelectorAll('.sidetabs [role=tab]')) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    }
    for (const p of ui.side.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
    if (save) saveOpts();
  }
  /** Phím tắt theo thứ tự dùng; nhóm đầu là 8 phím cốt lõi (viền accent). "~" = chữ thường, "·" = hoặc. */
  const SHORTCUTS = [
    ['keys.core', true, [['N', 'k.draw'], ['Enter', 'k.save'], ['D F', 'k.frame'], ['T', 'k.auto'], ['Shift+K · L', 'k.track3d'], ['K', 'k.keyframe'], ['Ctrl+Z Ctrl+Y', 'k.undo'], ['Del', 'k.delete']]],
    ['keys.nav', false, [['V', 'k.select'], ['~Click Tab', 'k.pick'], ['Esc', 'k.esc'], ['Shift+D Shift+F', 'k.cam'], ['1 – 8', 'k.camnum'], ['Ctrl+1 – Ctrl+9', 'k.label'], ['Space', 'k.space']]],
    ['keys.edit', false, [['~k.drag.t', 'k.drag'], ['← ↑ ↓ →', 'k.nudge'], ['Alt+U Alt+O', 'k.updown'], ['[ ]', 'k.yaw'], [', . ; \'', 'k.tilt'], ['R · Shift+R', 'k.rot90'], ['S · A', 'k.snap'], ['~k.views.t', 'k.views']]],
    ['keys.auto', false, [['T · Shift+T', 'k.auto'], ['Tab', 'k.nextbox'], ['X · P', 'k.skip'], ['Shift+Enter', 'k.saveall']]],
    ['keys.track', false, [['O', 'k.outside'], ['K', 'k.colors'], ['Shift+K · L', 'k.track3d']]],
    ['keys.view', false, [['H', 'k.points'], ['G', 'k.ground'], ['Shift+V', 'k.three'], ['~k.wheel', 'k.zoom']]],
    ['keys.copy', false, [['Ctrl+C Ctrl+V', 'k.copy']]],
    ['keys.calib', false, [['← → ↑ ↓ Q E', 'k.calib']]],
  ];
  function renderShortcuts() {
    const T = (k) => I18N.t(k);
    const keys = (str) => str.split(' ').map((w) => (w === '·' || w === '–' ? w : w.startsWith('~') ? T(w.slice(1)) : el('kbd', { textContent: w })))
      .flatMap((n, i) => (i ? [' ', n] : [n]));
    ui.keysCols.replaceChildren(...SHORTCUTS.map(([title, core, rows]) => el('section', { className: core ? 'core' : '' },
      el('h5', { textContent: T(title) }),
      el('dl', {}, ...rows.flatMap(([k, d]) => [el('dt', {}, ...keys(k)), el('dd', { textContent: T(d) })])))));
  }
  function applyRail() {
    const open = !!st.opts.railOpen;
    ui.body.classList.toggle('rail-open', open);
    ui.railToggle.setAttribute('aria-pressed', String(open));
    ui.railToggle.title = I18N.t(open ? 'rail.collapse' : 'rail.expand');
    ui.railToggleLbl.textContent = ui.railToggle.title;
  }
  /** Tool note: clicking a tool says in the hint bar what it does (for a few seconds). */
  function noteTool(key) {
    st.toolNote = key; clearTimeout(st.toolNoteTimer);
    st.toolNoteTimer = setTimeout(() => { st.toolNote = null; updateHint(); }, 7000);
    updateHint();
  }
  function applyLang() {
    if (!ui.root) return;
    for (const e of ui.root.querySelectorAll('[data-i18n]')) e.textContent = I18N.t(e.dataset.i18n);
    for (const e of ui.root.querySelectorAll('[data-i18n-keys]')) e.replaceChildren(...richKeys(I18N.t(e.dataset.i18nKeys)));
    for (const e of ui.root.querySelectorAll('[data-i18n-title]')) e.title = I18N.t(e.dataset.i18nTitle) + (e.dataset.sfx || '');
    for (const e of ui.root.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', I18N.t(e.dataset.i18nAria));
    for (const b of [ui.langVi, ui.langEn]) b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.getLang()));
    ui.host.lang = I18N.getLang();                // not the CVAT page's own <html lang>
    updateHint(); renderShortcuts(); applyRail(); selectSideTab(st.opts.sideTab, false); poseInfoUpdate(); applyTheme(); updateSaveChip(); updateSessionLiveChip(); syncFrameBar(); updateSaveModeUI();
    if (st.job) { buildBoxPanel(); buildAutoClasses(); }
    if (sessionPopup && sessionPopup.isOpen) sessionPopup.render();
  }
  function applyTheme() {
    const dark = st.opts.theme === 'dark';
    ui.host.dataset.theme = dark ? 'dark' : 'light';
    ui.themeBtn.textContent = `${dark ? '☾' : '☀'}  ${I18N.t('top.theme')}`;
  }
  // The extension was reloaded under this open page: every chrome.* call now throws "Extension context invalidated" at once, so a
  // `.catch` on a storage write never sees it and the handler dies half way (H changed the mode, then never redrew). Writes go through
  // putStore, and the first sign of it puts up a banner: the page has to be reloaded to join the new extension.
  let staleShown = false;
  const extAlive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  function noteStale() {
    if (staleShown || extAlive()) return;
    staleShown = true;
    if (ui.stale) ui.stale.hidden = false;
  }
  function putStore(obj) { try { chrome.storage.local.set(obj).catch(noteStale); } catch (e) { noteStale(); } }
  function saveOpts() { putStore({ [OPTS_KEY]: st.opts }); }
  async function loadOpts() {
    try { const o = (await chrome.storage.local.get(OPTS_KEY))[OPTS_KEY]; if (o) Object.assign(st.opts, o); if (Number.isFinite(st.opts.overlap)) st.opts.overlap = Math.min(0.95, Math.max(0.05, st.opts.overlap)); } catch (e) { /* defaults */ }
    for (const [id, k] of [['size', 'size'], ['maxR', 'maxR']]) ui[id].value = st.opts[k];
    ui.alpha.value = Math.round(st.opts.alpha * 100);
    ui.ground.checked = st.opts.hideGround; ui.show.checked = st.opts.show; ui.viewsOn.checked = st.opts.views; ui.autoSave.checked = st.opts.autoSave; ui.mono.checked = st.opts.mono; ui.trackGap.value = st.opts.trackGap || 10;
    I18N.setLang(st.opts.lang); applyLang(); applyTheme();
  }
  function toggleOpt(k, id) { st.opts[k] = !st.opts[k]; ui[id].checked = st.opts[k]; saveOpts(); draw(); }
  const PTS = [['obj', 'pts.obj'], ['boxes', 'pts.boxes'], ['all', 'pts.all'], ['box', 'pts.box'], ['off', 'pts.off']];
  const ptsModeOf = () => st.opts.pts[st.cam] || PTS[0][0];
  function cyclePoints() {
    const cur = st.opts.pts[st.cam] || PTS[0][0], k = PTS.findIndex(([m]) => m === cur);
    const next = PTS[(k + 1) % PTS.length];
    for (const c of st.cams) st.opts.pts[c.name] = next[0];   // one mode for every camera: H on one must not leave the others behind
    st.opts.pts[st.cam] = next[0]; saveOpts(); draw();
    toast(`${I18N.t('tool.points')}: ${I18N.t(next[1])}`);
  }
  function showShortcuts(open = ui.keysDet.hidden) { ui.keysDet.hidden = !open; ui.helpBtn.classList.toggle('on', open); ui.guideBtn.classList.toggle('on', open); }
  function stepCam(d) {
    const list = visibleCams();
    const k = list.findIndex((c) => c.name === st.cam);
    const n = list.length;
    if (n) selectCam(list[(k + d + n) % n].name);
  }
  // ---- box editing commands (keyboard + toolbar)
  function nudge(da, db, dz) {
    const p = st.proposal; if (!p) return;
    const b = p.box, c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    b.x += da * c - db * sn; b.y += da * sn + db * c; b.z += dz;
    commit(); draw(); syncFields();
  }
  function tilt(dp, dr) {
    const p = st.proposal; if (!p) return;
    const pr = BF.pitchRollOf(p.box);
    Object.assign(p.box, BF.tiltFromPitchRoll(p.box.yaw, pr.pitch + dp, pr.roll + dr));
    commit(); draw(); syncFields();
  }
  function alignGround() {
    const p = st.proposal; if (!p || !current) return;
    const g = BF.groundUnder(current.xyz, p.box, current.ground);
    if (!g) { toast(I18N.t('toast.noGround')); return; }
    // only the height: the bottom face goes down to the road under the centre. Heading, pitch and roll stay as they are
    // (standing the box on the fitted plane tilted it whenever the plane was fitted on a few noisy points).
    const [a, bb, c] = g, dz = (a * p.box.x + bb * p.box.y + c + p.box.h / 2) - p.box.z;
    p.box.z += dz;
    commit(); draw(); buildBoxPanel();
    toast(`Xuống đất: ${dz >= 0 ? '+' : ''}${(dz * 100).toFixed(0)} cm theo chiều cao, giữ nguyên hướng và độ nghiêng`);
  }
  function copyBox() { const p = st.proposal; if (!p) return; st.clip = { box: { ...p.box }, labelId: st.labelId }; toast(I18N.t('toast.copied')); }
  function pasteBox() {
    if (!st.clip || !current) return;
    autoSave();
    setProposal({ box: { ...st.clip.box }, points: pointsInBox(st.clip.box), cam: st.cam, frame: st.frame, ms: 0 });
    if (st.clip.labelId != null) { st.labelId = st.clip.labelId; ui.label.value = String(st.labelId); }
    draw(); buildBoxPanel();
  }
  /** Box under an image point (smallest projected outline first). */
  function boxAt(u, v) {
    let best = null;
    for (const rec of serverBoxesAt(st.frame)) {
      const area = outlineArea(rec.box, u, v);
      if (area !== null && (!best || area < best.area)) best = { rec, area };
    }
    return best && best.rec;
  }
  /** Area of a box's projected outline (2x, shown camera) when it contains the image point (u, v), else null. */
  function outlineArea(box, u, v) {
    const pts = BF.corners(box).map(proj3).filter(Boolean);
    if (pts.length < 4) return null;
    const hull = convexHull(pts);
    if (!inPoly(hull, u, v)) return null;
    return Math.abs(hull.reduce((a, q, i) => { const r = hull[(i + 1) % hull.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0));
  }
  function convexHull(pts) {
    const P2 = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of P2) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of P2.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function inPoly(poly, x, y) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function proj3(p) { const r = P.projectCloud(new Float32Array(p), st.calib, st.cam, st.adj[st.cam]); return r.u.length ? [r.u[0], r.v[0]] : null; }
  function setMode(m) {
    st.mode = m;
    if (ui.hintTxt) { updateHint(); }
    if (ui.selBtn) { ui.selBtn.classList.toggle('on', m === 'view'); ui.selBtn.setAttribute('aria-pressed', String(m === 'view')); }
    if (ui.drawBtn) { ui.drawBtn.classList.toggle('on', m === 'draw'); ui.drawBtn.setAttribute('aria-pressed', String(m === 'draw')); }
    if (ui.vp) {
      ui.vp.classList.toggle('draw', m === 'draw');
      ui.vp.classList.toggle('pair', m === 'pair');
    }
    if (ui.pairBtn) ui.pairBtn.classList.toggle('on', m === 'pair');
    if (m === 'pair') {
      ui.calibDet.open = true; selectSideTab('setup');
      const cur = st.opts.pts[st.cam] || PTS[0][0];
      if (st.cam && cur !== 'all') {                    // poles and walls are the best pairs: show every point
        st.ptsBeforePair = { cam: st.cam, mode: cur };
        st.opts.pts[st.cam] = 'all';
        toast(I18N.t('toast.points.pairs'));
      }
    } else {
      st.pending = null;
      if (st.ptsBeforePair) { st.opts.pts[st.ptsBeforePair.cam] = st.ptsBeforePair.mode; st.ptsBeforePair = null; }
    }
    pairInfoUpdate();
    if (st.open) { draw(); buildBoxPanel(); }
  }
  /** Messages stack above each other (newest at the bottom) instead of covering one another; at most 3 at once. */
  function toast(t) {
    const e = el('div', { className: 'toast', textContent: t });
    ui.toasts.appendChild(e);
    while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
    setTimeout(() => e.remove(), 4000);
  }
  /** Save state, always visible in the header (3.3): nothing pending / saving N / N not saved (click: retry now). */
  function updateSaveChip() {
    if (!ui.saveChip) return;
    const n = st.outbox.length;
    ui.saveChip.className = 'chip' + (st.saveError && n ? ' err' : n ? ' busy' : '');
    ui.saveChip.textContent = st.saveError && n ? `⚠ ${I18N.t('save.err')}` : n ? `${I18N.t('save.busy')} ${n}` : `✓ ${I18N.t('save.ok')}`;
    ui.saveChip.title = st.saveError && n ? `CVAT báo: ${st.saveError}. Box vẫn được giữ, kể cả khi tải lại trang.` : 'Box lưu lên CVAT ngay khi bạn bấm Lưu / Enter';
  }
  function togglePanel(open) {
    st.open = open; ui.panel.hidden = !open; ui.fab.hidden = open;
    if (open) updateQuick();
    (open ? ui.vp : ui.root).appendChild(ui.toasts);
    if (open) {
      ensureSessionOnOpen();
      tick(true); requestAnimationFrame(draw);
    }
  }
  function selectCam(name) {
    st.cam = name; view.zoom = 1; view.ox = 0; view.oy = 0; buildTabs(); buildSliders(); draw();
  }
  function detectCamName(cName, calib) {
    if (!cName) return '';
    const raw = String(cName).replace(/^CAM_?/i, '');
    const norm = raw.toUpperCase();

    // 1. Bản đồ từ viết tắt và quy ước phổ biến
    const NAME_MAP = {
      'F': 'Front', 'FRONT': 'Front',
      'B': 'Back', 'BACK': 'Back', 'REAR': 'Back',
      'FL': 'Front Left', 'FRONT_LEFT': 'Front Left', 'FRONTLEFT': 'Front Left',
      'FR': 'Front Right', 'FRONT_RIGHT': 'Front Right', 'FRONTRIGHT': 'Front Right',
      'L': 'Side Left', 'SIDE_LEFT': 'Side Left', 'SIDELEFT': 'Side Left', 'LEFT': 'Side Left',
      'R': 'Side Right', 'SIDE_RIGHT': 'Side Right', 'SIDERIGHT': 'Side Right', 'RIGHT': 'Side Right',
      'BL': 'Back Left', 'BACK_LEFT': 'Back Left', 'BACKLEFT': 'Back Left', 'REAR_LEFT': 'Back Left',
      'BR': 'Back Right', 'BACK_RIGHT': 'Back Right', 'BACKRIGHT': 'Back Right', 'REAR_RIGHT': 'Back Right',
      // Pinhole (P_...)
      'P_F': 'Front', 'P_B': 'Back', 'P_FL': 'Front Left', 'P_FR': 'Front Right',
      'P_L': 'Side Left', 'P_R': 'Side Right', 'P_BL': 'Back Left', 'P_BR': 'Back Right',
      // Fisheye (F_...)
      'F_F': 'Fisheye Front', 'F_B': 'Fisheye Back', 'F_FL': 'Fisheye Front Left', 'F_FR': 'Fisheye Front Right',
      'F_L': 'Fisheye Side Left', 'F_R': 'Fisheye Side Right', 'F_BL': 'Fisheye Back Left', 'F_BR': 'Fisheye Back Right',
    };
    if (NAME_MAP[norm]) return NAME_MAP[norm];

    // nuScenes words regex: FRONT, BACK, SIDE_LEFT...
    const m = norm.match(/^(FRONT|BACK|SIDE)(?:_(LEFT|RIGHT))?$/);
    if (m) {
      return norm.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
    }

    // 2. Nếu tên là số thuần tuý (00, 01, 02...) hoặc mã lạ: Tự động detect từ ego2cam (extrinsics)
    const camObj = calib && calib.cameras && calib.cameras[cName];
    if (camObj && Array.isArray(camObj.ego2cam) && camObj.ego2cam.length >= 3) {
      const r20 = camObj.ego2cam[2][0];
      const r21 = camObj.ego2cam[2][1];
      const yawDeg = Math.atan2(r21, r20) * (180 / Math.PI); // -180 đến 180 độ
      
      if (yawDeg >= -22.5 && yawDeg <= 22.5) {
        // Hướng nhìn thẳng ra trước. Kiểm tra toạ độ lateral y để phân biệt stereo/lệch trái phải
        const tx = camObj.ego2cam[0][3] || 0, ty = camObj.ego2cam[1][3] || 0, tz = camObj.ego2cam[2][3] || 0;
        const cy = -(camObj.ego2cam[0][1] * tx + camObj.ego2cam[1][1] * ty + camObj.ego2cam[2][1] * tz);
        if (cy > 0.15) return 'Front Left';
        if (cy < -0.15) return 'Front Right';
        return 'Front';
      }
      if (yawDeg > 22.5 && yawDeg <= 67.5) return 'Front Left';
      if (yawDeg > 67.5 && yawDeg <= 112.5) return 'Side Left';
      if (yawDeg > 112.5 && yawDeg <= 157.5) return 'Back Left';
      if (yawDeg > 157.5 || yawDeg < -157.5) return 'Back';
      if (yawDeg >= -157.5 && yawDeg < -112.5) return 'Back Right';
      if (yawDeg >= -112.5 && yawDeg < -67.5) return 'Side Right';
      if (yawDeg >= -67.5 && yawDeg < -22.5) return 'Front Right';
    }

    return raw;
  }

  function visibleCams() {
    if (!st.cams || !st.cams.length) return [];
    if (current && current.images && Object.keys(current.images).length > 0) {
      const filtered = st.cams.filter((c) => !!current.images[c.idx]);
      if (filtered.length > 0) return filtered;
    }
    return st.cams;
  }

  function buildTabs() {
    const list = visibleCams();
    if (!list.some((c) => c.name === st.cam) && list.length > 0) {
      st.cam = list[0].name;
    }
    ui.tabs.replaceChildren(...list.map((c, i) => {
      const q = (st.calib.quality || {})[c.name];
      const dispName = detectCamName(c.name, st.calib);
      const b = el('button', { className: 'tab' + (c.name === st.cam ? ' sel' : '') },
        el('span', { className: 'n', textContent: String(i + 1) }),
        dispName
      );
      if (q && q.status && q.status !== 'ok') b.append(' ', el('span', { className: 'w', textContent: '⚠' }));
      b.title = `${c.img} · ${c.name} (${dispName})${q ? ` · ${q.source || ''}${q.median_reproj_px != null ? ` · trung vị ${q.median_reproj_px}px` : ''}${q.status && q.status !== 'ok' ? ' · ' + q.status : ''}` : ''} (phím ${i + 1})`;
      b.onclick = () => selectCam(c.name);
      return b;
    }));
  }
  function buildLabels() {
    const labels = (st.job && st.job.labels) || [];
    ui.label.replaceChildren(...labels.map((l) => el('option', { value: String(l.id), textContent: l.name })));
    if (!labels.find((l) => l.id === st.labelId)) {
      const car = labels.find((l) => /car|xe|vehicle/i.test(l.name));
      st.labelId = (car || labels[0] || {}).id ?? null;
    }
    if (st.labelId != null) ui.label.value = String(st.labelId);
    buildAutoClasses();
  }
  /** Tick boxes of the detector classes used by auto (only classes the task has a label for). */
  const AUTO_CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian'];
  const autoOn = (cls) => labelFor(cls) != null;
  /**
   * "Tự động gán nhãn" (4.1 + 4.2), like CVAT's automatic annotation: one row per model class with the job label it
   * goes to and its own threshold. Moving a threshold re-filters the last run at once (count per class on the right);
   * "Chạy" keeps the mapping (per project) and runs the model. T runs straight away once the mapping is kept.
   */
  function buildAutoClasses() {
    if (!ui.autoRows || !st.job || !st.labelMap) return;
    const m = st.labelMap.map, thr = thrOf();
    const groups = new Map();
    for (const c of AUTO_CLASSES) if (m[c] != null) groups.set(m[c], [...(groups.get(m[c]) || []), c]);
    const same = groups.size && [...groups].every(([id, cs]) => cs.length === 1 && labelName(id) === cs[0]);
    ui.autoSum.textContent = !st.labelMap.confirmed ? I18N.t('auto.sum.none') : same ? I18N.t('auto.sum.same', { n: groups.size })
      : I18N.t('auto.sum.pairs', { list: [...groups].map(([id, cs]) => `${cs.join(', ')} → ${labelName(id)}`).join(' · ') || I18N.t('auto.sum.skip') });
    if (ui.autoDlg.hidden) return;
    const a = autoHere() ? st.auto : null;
    const r = a ? AF.split(a.cands, { thr, minPoints: st.opts.minPoints || 0, overlap: overlapOf() }) : null;
    ui.autoDraft ??= { ...m };                        // the pairs being edited; kept by "Chạy"
    const d = ui.autoDraft, opt = (v, t) => el('option', { value: v, textContent: t });
    const labelSel = (v) => { const x = el('select', {}, ...st.job.labels.map((l) => opt(String(l.id), l.name))); if (v != null) x.value = String(v); return x; };
    const rows = AUTO_CLASSES.filter((c) => d[c] != null).map((c) => {
      const sel = labelSel(d[c]);
      sel.onchange = () => { d[c] = Number(sel.value); };
      const val = el('span', { className: 'mono val', textContent: `${Math.round(100 * thr[c])}%` });
      const rng = el('input', { type: 'range', min: Math.round(100 * AF.LOW), max: 95, step: 5, value: Math.round(100 * thr[c]) });
      rng.oninput = () => { val.textContent = `${rng.value}%`; st.opts.thr = { ...thrOf(), [c]: Number(rng.value) / 100 }; saveOpts(); refilterAuto(); buildAutoClasses(); };
      const seen = a ? a.cands.filter((x) => x.det.label === c && !x.done).length : 0;
      const kept = r ? r.items.filter((x) => x.det.label === c).length : 0;
      const cnt = el('span', { className: 'mono cnt muted', textContent: a ? `${kept} / ${seen}` : '—',
        title: a ? `${kept} box đạt ngưỡng trên ${seen} vật mô hình thấy` : 'Chưa chạy ở frame này' });
      const del = el('button', { className: 'ghost sm', textContent: '✕', title: I18N.t('auto.drop', { c }), onclick: () => { d[c] = null; buildAutoClasses(); } });
      return el('div', { className: 'arow' }, el('span', { textContent: c }), el('span', { className: 'arrow', textContent: '→' }), sel, rng, val, cnt, del);
    });
    const free = AUTO_CLASSES.filter((c) => d[c] == null);
    let add = '';
    if (free.length && st.job.labels.length) {
      const cls = el('select', {}, ...free.map((c) => opt(c, c))), lab = labelSel(null), hint = LM.suggest(st.job.labels);
      const pre = () => { if (hint[cls.value] != null) lab.value = String(hint[cls.value]); };   // the label of the same name, if any
      cls.onchange = pre; pre();
      add = el('div', { className: 'aadd' }, cls, el('span', { className: 'arrow', textContent: '→' }), lab,
        el('button', { className: 'sm', textContent: I18N.t('auto.addpair'), onclick: () => { d[cls.value] = Number(lab.value); buildAutoClasses(); } }));
    }
    ui.autoRows.replaceChildren(...rows, rows.length ? '' : el('div', { className: 'muted', textContent: I18N.t('auto.nopairs') }), add);
    ui.minPts.value = st.opts.minPoints || 0; ui.minPtsV.textContent = String(st.opts.minPoints || 0);
    const ovp = Math.round(100 * overlapOf()); ui.overlap.value = ovp; ui.overlapV.textContent = `${ovp}%`;
    ui.autoNote.textContent = !st.labelMap.confirmed ? I18N.t('auto.note.first')
      : a ? I18N.t('auto.note.last', { where: a.where })
        : I18N.t('auto.note.ready');
  }
  function openAutoDlg(allCams) {
    if (!st.job || !st.labelMap) { toast(notReady() || 'Job chưa tải xong'); return; }
    ui.autoDraft = null; ui.autoDlg.hidden = false;
    (allCams ? ui.scopeAll : ui.scopeCam).checked = true;
    buildAutoClasses();
    ui.autoRun.focus();
  }
  function closeAutoDlg() { ui.autoDlg.hidden = true; ui.autoDraft = null; }
  function runFromDlg() {
    const d = ui.autoDraft || {};
    const map = Object.fromEntries(AUTO_CLASSES.map((c) => [c, d[c] ?? null]));
    if (!AUTO_CLASSES.some((c) => map[c] != null)) { toast('Chọn nhãn cho ít nhất một loại'); return; }
    confirmLabelMap(map);
    const all = ui.scopeAll.checked;
    closeAutoDlg();
    autoDetect(all);
  }
  const FIELDS = [['dài', 'l', 0.01], ['rộng', 'w', 0.01], ['cao', 'h', 0.01], ['x', 'x', 0.05], ['y', 'y', 0.05], ['z', 'z', 0.05],
    ['hướng°', 'yaw', 0.5], ['dốc°', 'pitch', 0.5], ['nghiêng°', 'roll', 0.5]];
  function fieldGet(b, key) {
    if (key === 'yaw') return (b.yaw / DEG).toFixed(1);
    if (key === 'pitch' || key === 'roll') return (BF.pitchRollOf(b)[key] / DEG).toFixed(1);
    return b[key].toFixed(2);
  }
  function fieldSet(b, key, v) {
    if (key === 'yaw') { BF.setYaw(b, v * DEG); return; }
    if (key === 'pitch' || key === 'roll') { const pr = BF.pitchRollOf(b); pr[key] = v * DEG; Object.assign(b, BF.tiltFromPitchRoll(b.yaw, pr.pitch, pr.roll)); return; }
    const old = b[key]; b[key] = v;
    if (key === 'h') b.z += (b.h - old) / 2;          // keep the bottom where it was
  }
  const fmtNum = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');
  function editStatusText(p) {
    if (!p || !p.orig) return '';
    if (sameBox(p.box, p.orig)) return p.item ? 'Chưa sửa, giống box máy đề xuất' : p.edit ? 'Chưa sửa so với bản đã lưu' : 'Chưa chỉnh sửa sau khi dựng';
    const dPos = Math.hypot(p.box.x - p.orig.x, p.box.y - p.orig.y, p.box.z - p.orig.z);
    const dYaw = Math.abs(BF.wrap(p.box.yaw - p.orig.yaw)) / DEG;
    const dSize = Math.max(Math.abs(p.box.l - p.orig.l), Math.abs(p.box.w - p.orig.w), Math.abs(p.box.h - p.orig.h));
    const parts = [
      dPos >= 0.01 ? `dời ${Math.round(dPos * 100)} cm` : '',
      dYaw >= 0.3 ? `xoay ${fmtNum(dYaw, 1)}°` : '',
      dSize >= 0.01 ? `đổi cỡ ${Math.round(dSize * 100)} cm` : '',
    ].filter(Boolean).join(', ');
    return `Đã sửa: ${parts || 'thay đổi nhỏ'}`;
  }
  /** Refresh the number fields (and yaw slider + CVAT inline card values) from the box without rebuilding the panel. */
  function syncFields() {
    const p = st.proposal, b = p && p.box; if (!b || !ui.fields) return;
    for (const [key, inp] of Object.entries(ui.fields)) if (inp && inp !== ui.root.activeElement) inp.value = fieldGet(b, key);
    if (ui.yawSlider && ui.yawSlider !== ui.root.activeElement) ui.yawSlider.value = (b.yaw / DEG).toFixed(1);
    if (ui.yawNum && ui.yawNum !== ui.root.activeElement) ui.yawNum.value = (b.yaw / DEG).toFixed(1);
    if (ui.dimSub) ui.dimSub.textContent = `${fmtNum(b.l)} × ${fmtNum(b.w)} × ${fmtNum(b.h)} m`;
    if (ui.kvSize) ui.kvSize.textContent = `${fmtNum(b.l)} × ${fmtNum(b.w)} × ${fmtNum(b.h)} m`;
    if (ui.kvYaw) {
      const pr = BF.pitchRollOf(b), tiltTxt = (Math.abs(pr.pitch) > 0.01 || Math.abs(pr.roll) > 0.01) ? ` · dốc ${fmtNum(pr.pitch / DEG, 1)}° · nghiêng ${fmtNum(pr.roll / DEG, 1)}°` : '';
      ui.kvYaw.textContent = `${fmtNum(b.yaw / DEG, 1)}°${tiltTxt}`;
    }
    if (ui.kvEdit) {
      ui.kvEdit.textContent = editStatusText(p);
      ui.kvEdit.classList.toggle('edited', !sameBox(b, p.orig));
    }
    applyKeyframeState(p);
  }
  /** Time shown for a proposal: its own fit; for an auto box also the whole run it came from (all cameras). */
  function timeText(p) {
    const t = p.item && st.batch && st.batch.timing, own = p.item ? p.item.ms ?? p.ms : p.ms;
    const box = own != null ? `${own.toFixed(0)} ms` : '—';
    if (!t) return box;
    const s = (v) => (v / 1000).toFixed(1);
    return `${box} · cả lượt ${s(t.total)} s (${t.cams} camera: nhận diện ${s(t.detect)} · dựng ${s(t.fit)} · mô hình box ${s(t.learned || 0)} · đầu/đuôi ${s(t.heading)} s)`;
  }
  /** Last auto run of this frame: threshold slider (box count changes as you drag) and why the others were dropped. */
  function autoCard() {
    const a = st.auto;
    const kept = st.batch && isAuto(st.batch) ? st.batch.items.length : 0;
    const why = Object.entries(AF.counts(a.rejected || [])).map(([k, n]) => `${n} ${AF.REASONS[k]}`).join(' · ');
    const show = el('input', { type: 'checkbox', checked: !!st.opts.showRejected });
    show.onchange = () => { st.opts.showRejected = show.checked; saveOpts(); draw(); };
    return el('div', { className: 'card' },
      el('div', { className: 'row' }, el('b', { textContent: `Tự động · ${a.where}` }), el('span', { className: 'muted', textContent: `${kept} box chờ duyệt` })),
      el('div', { className: 'row' }, el('button', { className: 'sm', id: 'autoTune', textContent: 'Ngưỡng theo loại…', title: 'Mỗi loại một ngưỡng; số box đổi ngay, không chạy lại mô hình', onclick: () => openAutoDlg(false) })),
      why ? el('div', { className: 'muted', textContent: `Bỏ: ${why}` }) : '',
      el('label', { className: 'row muted' }, show, ' Vẽ khung bị bỏ kèm lý do'));
  }
  const percentText = (score) => Number.isFinite(score) ? `${Math.round((score <= 1 ? score : score / 100) * 100)}%` : '—';
  /** Confidence previously saved for this box, if it came from a detector or tracker. */
  function scoreOf(frame, box) {
    const s = st.scores.find((x) => x.frame === frame && Math.hypot(x.box.x - box.x, x.box.y - box.y) < 0.5);
    return s && !s.manual ? s.score : null;
  }
  /** Build the inline expanded CVAT-style card (.m-cur) for the currently selected box (`st.proposal`). */
  /** Bottom bar: always the next step and its key, by context: nothing selected / drawing / box waiting / saved box / tracking. */
  /** Hint bar: what to do next (left), the colours of the keyframe bar for a selected track (middle), the keys that matter now
   *  as small buttons (right; the ones that have an action can be clicked). */
  function updateHint() {
    if (!ui.hintTxt) return;
    const p = st.proposal, T = (k) => I18N.t(k), isTrack = !!(p && p.edit && p.edit.trackId != null);
    const chips = [];
    const chip = (keys, label, act) => chips.push([keys, T(label), act]);
    let a = T('hint.start');
    if (!ui.trackBar.hidden) a = T('hint.tracking');
    else if (p && (p.item || !p.edit)) {
      a = T('hint.pending');
      chip('Enter', 'hint.k.save', () => saveProposal(true)); if (p.item) chip('X', 'hint.k.skip', skipInBatch);
      if (st.batch && st.batch.items.length > 1) { chip('Tab', 'hint.k.nextbox'); chip('⇧Enter', 'hint.k.saveall', saveAllBatch); }
    } else if (p) {
      a = T('hint.selected');
      chip('Enter', 'hint.k.save', () => saveProposal(true)); if (isTrack) chip('K', 'hint.k.keyframe', keyframeKey);
      chip('Del', 'hint.k.del', deleteSelected); chip('Esc', 'hint.k.desel');
    } else if (st.mode === 'draw') {
      a = T('hint.drawing'); chip('Esc', 'hint.k.exit', () => setMode('view')); chip('Alt', 'hint.k.pan');
    } else {
      chip('N', 'hint.k.draw', () => setMode('draw')); chip('T', 'hint.k.auto', () => autoDetect(false));
      chip('⇧K', 'hint.k.track', () => openTrackDialog()); chip('F', 'hint.k.next', () => stepFrame(1));
    }
    if (st.toolNote && ui.trackBar.hidden) {
      const ptsNow = () => I18N.t(PTS.find(([m]) => m === ptsModeOf())[1]);
      a = { select: T('hint.tool.select'), auto: T('hint.tool.auto'), track: T('hint.tool.track'), mode: T('hint.tool.mode'),
        points: `${T('hint.tool.points')}: ${ptsNow()}` }[st.toolNote] || a;
    }
    if (ui.trackBar.hidden) chip('?', 'hint.k.help', () => showShortcuts());
    ui.hintTxt.textContent = a;
    ui.hintLegend.hidden = !isTrack || !ui.trackBar.hidden;
    ui.hintKeys.replaceChildren(...chips.map(([keys, label, act]) => {
      const node = el(act ? 'button' : 'span', { className: 'hk', title: label }, el('kbd', {}, ...keyCap(keys)), label);
      if (act) { node.type = 'button'; node.onclick = () => { node.blur(); act(); }; }
      return node;
    }));
  }
  /** Quick start card: first use and while the frame has no box; gone for good after the first save; `?` shows the same steps. */
  const quickReady = () => !!(current && current.frame === st.frame);          // point cloud + images of this frame are in
  /** Quick start: shown as soon as the window opens (over the loading screen, which stays hidden behind it) and kept until
   *  Enter / the button / ✕ closes it: loading finishing or boxes appearing never close it. Gone for good after the first save. */
  function updateQuick() {
    if (!ui.quick) return;
    if (!st.opts.qsDone && (st.saved.length || st.savedTrackIds.size)) { st.opts.qsDone = true; saveOpts(); }
    const empty = !st.proposal && !serverBoxesAt(st.frame).length && !(parkedHere() || st.batch);
    if (!st.opts.qsDone && !st.quickHidden && (st.quickLatched || empty)) st.quickLatched = true;
    ui.quick.hidden = !(st.quickLatched && !st.opts.qsDone && !st.quickHidden);
    syncQuickState();
  }
  function syncQuickState() {
    if (!ui.quick || ui.quick.hidden) return;
    const ready = quickReady(), loadTxt = ui.msg.textContent.trim();
    ui.quickState.className = `quickstate ${ready ? 'ready' : 'loading'}`;
    ui.quickState.textContent = ready ? I18N.t('qs.ready') : (loadTxt || I18N.t('qs.loading'));
    ui.quickGo.disabled = !ready;
  }
  function toggleCard() { st.opts.cardCollapsed = !st.opts.cardCollapsed; saveOpts(); buildBoxPanel(); }
  // Lucide icons (ISC licence, see THIRD_PARTY.md): inner markup only, drawn with the .ri stroke style
  const ICONS = {
    skip_back: '<polygon points="19 20 9 12 19 4 19 20" /><line x1="5" x2="5" y1="19" y2="5" />',
    chevron_left: '<path d="m15 18-6-6 6-6" />',
    chevron_right: '<path d="m9 18 6-6-6-6" />',
    skip_forward: '<polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" />',
    log_out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" />',
    star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
    rotate_cw: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />',
    arrow_left_right: '<path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" />',
    align_center_vertical: '<path d="M12 2v20" /><path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4" /><path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" /><path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1" /><path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1" />',
    arrow_down_to_line: '<path d="M12 17V3" /><path d="m6 11 6 6 6-6" /><path d="M19 21H5" />',
    route: '<circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" />',
    x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
    trash_2: '<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />',
    ellipsis_vertical: '<circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />',
    chevron_down: '<path d="m6 9 6 6 6-6" />',
  };
  const svgIcon = (name) => `<svg class="ri" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  function iconBtn(name, title, onclick, cls = '') {
    const b = el('button', { type: 'button', className: `ib ${cls}`.trim(), title, 'aria-label': title, onclick });
    b.innerHTML = svgIcon(name);                      // static markup from ICONS above
    return b;
  }
  function renderActiveBoxCard(entry, p) {
    const b = p.box, it = p.item, dist = Math.hypot(b.x, b.y);
    const btnKey = (txt, keyTxt, title, onclick, cls = '') => el('button', { type: 'button', className: cls, title, onclick },
      el('span', { textContent: txt }), keyTxt ? el('span', { className: 'k' }, ...keyCap(keyTxt)) : '');

    // 1. Header: #ID + class/label + concise right status badge (no redundant Track ID repetition)
    const labels = (st.job && st.job.labels) || [];
    let clsNode = el('b', { textContent: entry.cls, title: entry.cls });
    if (labels.length > 1) {
      const sel = el('select', { className: 'm-cur-label', title: 'Đổi nhãn cho box này (Ctrl+1..9)' },
        ...labels.map((l) => el('option', { value: String(l.id), textContent: l.name })));
      if (st.labelId != null) sel.value = String(st.labelId);
      sel.onchange = (ev) => {
        ev.stopPropagation();
        st.labelId = Number(sel.value);
        if (ui.label) ui.label.value = String(st.labelId);
        if (p.item) p.item.labelId = st.labelId;
        refit(); buildBoxPanel();
      };
      clsNode = sel;
    }
    let badgeNode = '';
    if (it && it.det && it.det.score != null) {
      const pct = Math.round((it.det.score <= 1 ? it.det.score : it.det.score / 100) * 100);
      const isWarn = p.points.length < 30 || (it.heading && it.heading.conf < 1.5);
      badgeNode = el('span', { className: `cv-tag ${isWarn ? 'warn' : 'info'}`, textContent: I18N.t('card.conf', { n: pct }) });
    } else if (it) {
      badgeNode = el('span', { className: `cv-tag ${!it.fitted ? 'warn' : 'info'}`, textContent: !it.fitted ? I18N.t('card.predonly') : I18N.t('tool.track') });
    } else if (p.edit) {
      const savScore = scoreOf(st.frame, p.box);
      if (p.edit.trackId != null) {
        const k = keyframeState(p);
        badgeNode = ui.kvBadge = el('span', { className: `cv-tag ${k.cls}`, textContent: k.text, title: k.title, });
      } else {
        const txt = savScore != null ? `${I18N.t('save.ok')} · ${percentText(savScore)}` : I18N.t('save.ok');
        badgeNode = el('span', { className: 'cv-tag ok', textContent: txt });
      }
    } else {
      badgeNode = el('span', { className: 'cv-tag info', textContent: I18N.t('obj.drawn') });
    }
    const collapsed = !!st.opts.cardCollapsed;
    const isTrk = !!(p.edit && p.edit.trackId != null);
    const idBtn = el('button', { type: 'button', className: 'id', 'aria-expanded': String(!collapsed),
      title: I18N.t(collapsed ? 'card.expand' : 'card.collapse'), textContent: entry.id === 'mới' ? I18N.t('obj.new') : `#${entry.id}`, onclick: toggleCard });
    const kind = el('span', { className: 'kind', textContent: I18N.t(isTrk ? 'card.kind.track' : it ? 'card.kind.prop' : 'card.kind.box') });
    const cardMore = iconBtn('ellipsis_vertical', I18N.t('card.more'), () => { cardMenu.hidden = !cardMenu.hidden; }, 'ghost more');
    const menuItem = (icon, label, key, act, cls = '') => {
      const b = el('button', { type: 'button', role: 'menuitem', className: cls, onclick: () => { cardMenu.hidden = true; act(); } });
      b.innerHTML = svgIcon(icon); b.append(el('span', { textContent: label }), el('span', { className: 'k' }, ...keyCap(key)));
      return b;
    };
    const cardMenu = el('div', { className: 'cardmenu', role: 'menu', hidden: true },
      ...(isTrk ? [menuItem('route', I18N.t('card.track3d'), '⇧K', () => { const go = ui.boxPanel.querySelector('#trackGo'); if (go) go.click(); else openTrackDialog(); })] : []),
      menuItem('x', I18N.t('card.deselect'), 'Esc', () => { setProposal(null); draw(); buildBoxPanel(); }),
      menuItem('trash_2', I18N.t(isTrk ? 'card.del.track' : 'card.del.box'), 'Del', deleteSelected, 'danger'));
    ui.cardMenu = cardMenu; ui.cardMore = cardMore;
    const hd = el('div', { className: 'm-cur-hd' }, idBtn, kind, clsNode, ...(it && st.batch ? [] : [cardMore, cardMenu]));
    const stateLine = el('div', { className: 'stateline' }, badgeNode, el('span', { className: 'frm', textContent: I18N.t('card.frame', { f: p.frame ?? st.frame }) }));
    if (collapsed) {          // class + id only (as CVAT's object row); Enter / Esc / Del and every key still act on the box
      ui.fields = null; ui.yawSlider = null; ui.yawNum = null; ui.dimSub = null; ui.kvSize = null; ui.kvYaw = null; ui.kvEdit = null;
      ui.saveBox = el('button');
      const cardC = ui.card = el('div', { className: 'm-cur collapsed' }, hd);
      applyKeyframeState(p);
      return cardC;
    }

    // 2. Info pills: Mô hình / Nguồn + Điểm LiDAR & Khoảng cách
    const savScore = p.edit ? scoreOf(st.frame, p.box) : null;
    const modelTxt = it
      ? (it.model === 'mtrans' ? 'MTrans' : it.how === 'learned' ? 'Frustum' : (st.batch && !isAuto(st.batch)) ? (it.box === it.fit ? (it.fitted ? 'Track (ôm điểm)' : 'Track (dự đoán)') : 'Track (dự đoán)') : 'L-shape')
      : p.edit
        ? (savScore != null ? `Auto (${percentText(savScore)})` : 'Thủ công')
        : (p.model === 'mtrans' ? 'MTrans' : p.how === 'learned' ? 'Frustum' : p.click ? 'Vẽ tay' : p.rect ? 'Kéo khung' : 'Dán box');
    const statRow = el('div', { className: 'm-stat-row', title: `Thời gian xử lý: ${timeText(p)}` },
      el('div', { className: 'm-stat-pill' },
        el('span', { className: 'lbl', textContent: I18N.t('card.src') }),
        el('span', { className: 'val', textContent: modelTxt + (it && it.vel ? ` · ${(Math.hypot(...it.vel)).toFixed(2)}m/f` : '') })),
      el('div', { className: 'm-stat-pill' },
        el('span', { className: 'lbl', textContent: 'LiDAR' }),
        el('span', { className: 'val', textContent: `${p.points.length} pts · ${dist.toFixed(1)}m` })));

    // 3. Direct Dimension Inputs (Dài, Rộng, Cao) - CVAT Style
    ui.fields = {};
    ui.dimSub = el('span', { className: 'm-dim-sub', textContent: `${fmtNum(b.l)} × ${fmtNum(b.w)} × ${fmtNum(b.h)} m` });
    ui.kvSize = ui.dimSub;

    const makeDimInput = (labelTxt, key, step = 0.05) => {
      const inp = el('input', { type: 'number', step: String(step), min: '0.1', max: '30', value: fieldGet(b, key) });
      const applyVal = (isCommit) => {
        const v = Number(inp.value); if (!Number.isFinite(v) || v <= 0.05) return;
        fieldSet(b, key, v);
        draw();
        syncFields();
        if (isCommit) commit();
      };
      inp.oninput = () => applyVal(false);
      inp.onchange = () => applyVal(true);
      ui.fields[key] = inp;
      return el('div', { className: 'm-dim-field' },
        el('span', { textContent: labelTxt }), inp);
    };

    const dimBlock = el('div', { className: 'm-dim-block' },
      el('div', { className: 'm-dim-inputs' },
        makeDimInput(I18N.t('card.len'), 'l'),
        makeDimInput(I18N.t('card.wid'), 'w'),
        makeDimInput(I18N.t('card.hei'), 'h')));

    // 4. Direct Heading (Yaw) control with number input & slider
    ui.yawNum = el('input', { type: 'number', step: '0.5', className: 'yaw-num', value: (b.yaw / DEG).toFixed(1), title: 'Góc xoay theo độ (°)' });
    ui.yawNum.oninput = () => {
      const deg = Number(ui.yawNum.value);
      if (!Number.isFinite(deg)) return;
      if (ui.yawSlider) ui.yawSlider.value = deg;
      setYaw(deg * DEG, false, false);
    };
    ui.yawNum.onchange = () => {
      const deg = Number(ui.yawNum.value);
      if (!Number.isFinite(deg)) return;
      if (ui.yawSlider) ui.yawSlider.value = deg;
      setYaw(deg * DEG, false, true);
    };

    ui.yawSlider = el('input', { type: 'range', min: -180, max: 180, step: 0.5, value: (b.yaw / DEG).toFixed(1), className: 'yaw' });
    ui.yawSlider.oninput = () => {
      const deg = Number(ui.yawSlider.value);
      if (ui.yawNum) ui.yawNum.value = deg.toFixed(1);
      setYaw(deg * DEG, false, false);
    };
    ui.yawSlider.onchange = () => {
      const deg = Number(ui.yawSlider.value);
      if (ui.yawNum) ui.yawNum.value = deg.toFixed(1);
      setYaw(deg * DEG, false, true);
    };

    const pr = BF.pitchRollOf(b), tiltTxt = (Math.abs(pr.pitch) > 0.01 || Math.abs(pr.roll) > 0.01) ? ` · dốc ${fmtNum(pr.pitch / DEG, 1)}°` : '';
    ui.kvYaw = el('span', { className: 'mut mono', style: 'font-size:10.5px', textContent: tiltTxt });

    const yawBlock = el('div', { className: 'm-yaw-block' },
      el('div', { className: 'm-yaw-top' },
        el('span', { textContent: I18N.t('card.yaw') }),
        el('div', { className: 'm-yaw-inp-wrap' }, ui.yawNum, el('span', { className: 'mut', textContent: '°' }), ui.kvYaw)),
      ui.yawSlider);

    // 5. Edit status & warnings
    ui.kvEdit = el('div', { className: 'm-cur-status' + (!sameBox(b, p.orig) ? ' edited' : ''), textContent: editStatusText(p) });
    const warnMsg = it && !it.fitted
      ? '⚠ Không thấy điểm LiDAR ở frame này: chỉ là dự đoán.'
      : p.points.length < 30
        ? '⚠ Ít điểm LiDAR (xe xa/bị che): kiểm tra kỹ.'
        : (it && it.heading && it.heading.conf < 1.5)
          ? '⚠ Hướng đầu/đuôi chưa chắc: kiểm tra kỹ.' : '';
    const warnNode = warnMsg ? el('div', { className: 'm-cur-warn', textContent: warnMsg }) : '';

    // 6. Primary Save / Update button
    ui.saveBox = btnKey(it ? I18N.t('card.save.next') : p.edit ? I18N.t('card.save.update') : I18N.t('card.save.new'), 'Enter', 'Lưu box lên CVAT (Enter)', () => saveProposal(true), 'pri');
    if (p.edit && p.edit.trackId != null) { if (!st.held.has(p.edit.trackId)) refreshHeld(p.edit.trackId); }

    // 7. 2-column action grids (review navigation + 3D box adjustments)
    let navGrid = '';
    if (it && st.batch) {
      const bBatch = st.batch;
      const navBtns = [
        btnKey(I18N.t('card.skip'), 'X', 'Bỏ qua box đề xuất này (X)', skipInBatch),
        btnKey(I18N.t('card.later'), 'Tab', 'Chuyển sang box kế tiếp trong danh sách (Tab)', () => selectInBatch((bBatch.idx + 1) % bBatch.items.length)),
      ];
      if (!isAuto(bBatch)) {
        navBtns.push(btnKey(it.box === it.fit ? I18N.t('card.usepred') : I18N.t('card.snap'), 'P', 'Đổi giữa vị trí dự đoán và vị trí ôm điểm LiDAR (P)', togglePred));
        navBtns.push(btnKey(I18N.t('card.pause'), 'Esc', 'Giữ lại các box chưa lưu để xem tiếp sau (Esc)', () => parkBatch()));
      }
      navGrid = el('div', { className: 'm-grid2' }, ...navBtns);
    }

    // keyframes you set by hand (red): the nav buttons jump between them, the star is on when this frame is one
    const jumpKey = (pick) => {
      const ks = [...keptOf(p)].sort((a, b) => a - b), f = pick(ks, p.frame);
      if (f == null) { toast(I18N.t('card.kf.none')); return; }
      gotoFrame(f);
    };
    const navRow = isTrk ? el('div', { className: 'navrow' },
      iconBtn('skip_back', I18N.t('card.kf.first'), () => jumpKey((ks) => ks[0]), 'kfnav'),
      iconBtn('chevron_left', I18N.t('card.kf.prev'), () => jumpKey((ks, f) => ks.filter((x) => x < f).pop()), 'kfnav'),
      iconBtn('chevron_right', I18N.t('card.kf.next'), () => jumpKey((ks, f) => ks.find((x) => x > f)), 'kfnav'),
      iconBtn('skip_forward', I18N.t('card.kf.last'), () => jumpKey((ks) => ks[ks.length - 1]), 'kfnav')) : '';
    ui.cardStar = isTrk ? iconBtn('star', `${I18N.t('card.kf')} (K)`, keyframeKey, 'star') : null;
    const toolRow = el('div', { className: 'toolrow' },
      ...(isTrk ? [iconBtn('log_out', `${I18N.t('card.out')} (O)`, () => trackCmd('outside'), 'outb'), ui.cardStar] : []),
      iconBtn('rotate_cw', `${I18N.t('card.rot90')} (R)`, () => tweak((x) => { x.yaw += Math.PI / 2; [x.l, x.w] = [x.w, x.l]; })),
      iconBtn('arrow_left_right', `${I18N.t('card.flip')} (⇧R)`, () => tweak((x) => { x.yaw += Math.PI; })),
      iconBtn('align_center_vertical', `${I18N.t('card.lane')} (S)`, snapYaw),
      iconBtn('arrow_down_to_line', `${I18N.t('card.ground')} (A)`, alignGround));

    // 8. Compact single-row Track across frames (Shift+K)
    let trackSec = '';
    if (st.job) {
      const f0 = p.frame ?? st.frame;
      const isTrk = !!(p.edit && p.edit.trackId != null);
      const id = isTrk ? p.edit.trackId : null, info = id != null ? st.trackInfo.get(id) : null;
      const defLo = isTrk && info ? info.first : f0;
      const defHi = isTrk && info ? Math.max(info.last, f0 + 20) : Math.min(st.job.stop, f0 + 20);
      const lo = el('input', { type: 'number', id: 'trackLo', value: defLo, className: 'mono', title: 'Frame bắt đầu track (lùi lại)' });
      const hi = el('input', { type: 'number', id: 'trackHi', value: defHi, className: 'mono', title: 'Frame kết thúc track (tiến tới)' });
      const segRow = info ? el('div', { className: 'm-cur-track-row mut' },
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', textContent: segText(info.segs) + (info.hidden ? ` · ${info.hidden} khuất` : '') }),
        el('button', { type: 'button', id: 'segFlip', style: 'width:auto;padding:2px 6px', textContent: '⇄', title: 'Đổi đứng yên / chạy cho đoạn chứa frame này, rồi track lại', onclick: () => flipSegment(id, p.frame) })) : '';
      trackSec = el('div', { className: 'm-cur-track' },
        segRow,
        el('div', { className: 'm-cur-track-row' },
          el('span', { className: 'mut', textContent: 'Frame' }),
          lo, el('span', { className: 'mut', textContent: '–' }), hi,
          el('button', { type: 'button', id: 'trackGo', title: 'Bám vật thể cả đoạn tiến và lùi từ box này (Shift+K)', onclick: () => openTrackDialog(Number(lo.value), Number(hi.value)) },
            el('span', { textContent: isTrk ? I18N.t('card.track.all') : I18N.t('card.track.new') }),
            el('span', { className: 'k' }, ...keyCap('⇧K')))));
    }

    // 9. Advanced fine-tuning details (X, Y, Z, Pitch, Roll)
    const extraBtns = el('div', { className: 'm-grid2', style: 'margin-top:5px' },
      btnKey(I18N.t('card.resnap'), '', 'Giữ hướng hiện tại, tính lại tâm / dài / rộng theo điểm LiDAR', () => setYaw(b.yaw, true)),
      btnKey(I18N.t('card.flat'), '', 'Bỏ góc dốc (pitch) và nghiêng (roll)', () => tweak((x) => { x.rx = 0; x.ry = 0; })));

    const ADV_FIELDS = [
      [I18N.t('card.cx'), 'x', 0.05],
      [I18N.t('card.cy'), 'y', 0.05],
      [I18N.t('card.cz'), 'z', 0.05],
      [I18N.t('card.pitch'), 'pitch', 0.5],
      [I18N.t('card.roll'), 'roll', 0.5],
    ];
    const edit = el('div', { className: 'edit mono' });
    for (const [lab, key, step] of ADV_FIELDS) {
      const inp = el('input', { type: 'number', step: String(step), value: fieldGet(b, key) });
      inp.onchange = () => {
        const v = Number(inp.value); if (!Number.isFinite(v)) return;
        fieldSet(b, key, v); commit(); draw(); syncFields();
      };
      ui.fields[key] = inp;
      edit.append(el('label', {}, el('span', { textContent: lab }), inp));
    }
    const advDet = el('details', { className: 'cur-adv', open: !!st.advOpen },
      el('summary', { textContent: I18N.t('card.adv') }), extraBtns, edit);
    advDet.ontoggle = () => { st.advOpen = advDet.open; };

    const detail = el('details', { className: 'cur-detail', open: st.opts.detOpen !== false },
      el('summary', {}, el('span', { className: 'chev', innerHTML: svgIcon('chevron_down') }), el('span', { textContent: I18N.t('card.detail') })), statRow, dimBlock, yawBlock);
    detail.ontoggle = () => { st.opts.detOpen = detail.open; saveOpts(); };
    const card = ui.card = el('div', { className: 'm-cur' }, hd, stateLine, navRow, toolRow, detail, ui.kvEdit, warnNode, ui.saveBox, navGrid, trackSec, advDet);
    applyKeyframeState(p);
    return card;
  }
  /** Always-visible CVAT-style object list with inline expanded box card, progress header, and batch footer. */
  function objectList() {
    const p = st.proposal;
    const saved = serverBoxesAt(st.frame).map((rec, idx) => {
      const sc = scoreOf(st.frame, rec.box);
      const dispId = rec.reviewId != null ? String(rec.reviewId) : rec.trackId != null ? `T${rec.trackId}` : String((rec.shape && rec.shape.id) ?? (idx + 1));
      return {
        kind: 'saved', rec, id: dispId,
        cls: labelName(rec.labelId) || 'Object',
        confidence: percentText(sc),
        active: !!(p && p.edit && recKey(p.edit) === recKey(rec)),
        select: () => selectServerBox(rec, true),
      };
    });
    const left = outsideRecsAt(st.frame).map((rec) => ({
      kind: 'left', rec, id: `T${rec.trackId}`, cls: labelName(rec.labelId) || 'Object',
      active: !!(p && p.edit && recKey(p.edit) === recKey(rec)),
      select: () => selectServerBox(rec, true),
    }));
    const batch = st.batch || parkedHere();
    const pending = batch ? itemsHere(batch).map((item, index) => {
      const lowPts = item.points && item.points.length < 30;
      const lowHead = item.heading && item.heading.conf < 1.5;
      const warnTxt = !item.fitted ? I18N.t('obj.warn.pred') : lowPts ? I18N.t('obj.warn.pts') : lowHead ? I18N.t('obj.warn.head') : null;
      return {
        kind: 'proposal', item, id: String(item.reviewId ?? (saved.length + index + 1)),
        cls: (item.det && item.det.label) || labelName(item.labelId) || 'Object',
        confidence: item.det ? percentText(item.det.score) : I18N.t('obj.pending'),
        warnTxt,
        active: !!(p && p.item === item),
        select: () => {
          if (batch === st.batch) selectInBatch(batch.items.indexOf(item));
          else resumeParked(item);
        },
      };
    }) : [];
    const draft = p && !p.edit && !p.item ? [{
      kind: 'draft', id: 'mới', cls: labelName(st.labelId) || 'Object', confidence: I18N.t('save.dirty'), active: true, select: () => {},
    }] : [];
    const all = [...saved, ...draft, ...pending];
    const groups = { all, pending: [...pending, ...draft], saved };
    if (!groups[st.objectTab]) st.objectTab = 'all';
    const shown = (groups[st.objectTab] || all).concat(st.objectTab === 'pending' ? [] : left);

    const proposedTotal = batch ? (batch.reviewed || 0) + batch.items.length : (pending.length + draft.length + saved.length);
    const tab = (key, text, count) => el('button', {
      type: 'button', className: `object-tab${st.objectTab === key ? ' on' : ''}`,
      textContent: `${text} (${count})`, onclick: () => { st.objectTab = key; buildBoxPanel(); },
    });

    // Progress header (.m-prog)
    let progNode = '';
    if (batch) {
      const rev = batch.reviewed || 0, rem = batch.items.length, tot = Math.max(1, rev + rem);
      const savCnt = batch.savedCount ?? saved.length, skpCnt = batch.skippedCount || 0;
      const curNum = p && p.item ? (p.item.reviewId ?? (rev + Math.max(0, batch.idx || 0) + 1)) : Math.min(tot, rev + 1);
      const savPct = Math.min(100, (100 * savCnt) / tot);
      const curPct = rem > 0 ? Math.min(100 - savPct, Math.max(6, 100 / tot)) : 0;
      progNode = el('div', { className: 'm-prog' },
        el('div', { className: 'm-prog-top' },
          el('span', { className: 'm-prog-title' }, el('b', { textContent: `Box ${curNum}` }), ` / ${tot}`),
          el('span', { className: 'm-prog-sub', textContent: I18N.t('obj.prog.batch', { s: savCnt, k: skpCnt, r: rem }) })),
        el('div', { className: 'm-bar' },
          el('div', { style: `width:${savPct.toFixed(1)}%;background:var(--accent)` }),
          el('div', { style: `width:${curPct.toFixed(1)}%;background:var(--ok)` })));
    } else if (all.length) {
      const actIdx = all.findIndex((e) => e.active);
      const savPct = Math.min(100, (100 * saved.length) / Math.max(1, all.length));
      progNode = el('div', { className: 'm-prog' },
        el('div', { className: 'm-prog-top' },
          el('span', { className: 'm-prog-title' }, el('b', { textContent: actIdx >= 0 ? `Box ${actIdx + 1}` : I18N.t('obj.prog.total', { n: all.length }) }), actIdx >= 0 ? ` / ${all.length}` : ''),
          el('span', { className: 'm-prog-sub', textContent: `${I18N.t('obj.prog.saved', { n: saved.length })}${draft.length ? I18N.t('obj.prog.drawing') : ''}` })),
        el('div', { className: 'm-bar' },
          el('div', { style: `width:${savPct.toFixed(1)}%;background:var(--accent)` }),
          draft.length ? el('div', { style: `width:${(100 / all.length).toFixed(1)}%;background:var(--ok)` }) : ''));
    }

    // List rows: active box expands inline into .m-cur; other boxes render as compact .object-row
    const rows = shown.map((entry) => {
      if (entry.active && p) return renderActiveBoxCard(entry, p);
      let rightBadge;
      if (entry.kind === 'left') {
        rightBadge = el('span', { className: 'cv-tag', textContent: I18N.t('obj.left') });
      } else if (entry.kind === 'saved') {
        rightBadge = el('span', { className: 'cv-tag ok', textContent: I18N.t('save.ok') });
      } else if (entry.warnTxt) {
        rightBadge = el('span', { className: 'cv-tag warn', textContent: I18N.t('obj.warn.label'), title: entry.warnTxt });
      } else {
        rightBadge = el('span', { className: 'object-conf', textContent: entry.confidence });
      }
      return el('button', {
        type: 'button', className: 'object-row', style: entry.kind === 'left' ? 'opacity:.6' : '',
        title: entry.kind === 'left' ? I18N.t('obj.left.tip') : I18N.t('obj.open', { id: entry.id }),
        onclick: (ev) => { ev.currentTarget.blur(); entry.select(); },   // focus off the row: Enter then saves the selected box
      },
      el('span', { className: 'object-id', textContent: entry.id === 'mới' ? I18N.t('obj.new') : `#${entry.id}` }),
      el('span', { className: 'object-class', textContent: entry.cls }),
      rightBadge);
    });

    // Footer: "Lưu tất cả X box còn lại [⇧Enter]"
    let footNode = '';
    if (st.batch && st.batch.items.length > 0) {
      footNode = el('div', { className: 'm-foot' },
        el('button', { type: 'button', title: I18N.t('obj.foot.all.tip'), onclick: saveAllBatch },
          el('span', { textContent: I18N.t('obj.foot.all', { n: st.batch.items.length }) }),
          el('span', { className: 'k' }, ...keyCap('⇧Enter'))));
    } else if (!st.batch && parkedHere() && parkedHere().items.length > 0) {
      const pk = parkedHere();
      footNode = el('div', { className: 'm-foot', style: 'display:grid;gap:6px' },
        el('button', { type: 'button', onclick: () => resumeParked() },
          el('span', { textContent: I18N.t('obj.foot.resume', { n: pk.items.length }) }),
          el('span', { className: 'k', textContent: 'Tab' })),
        el('button', { type: 'button', onclick: () => { if (resumeParked()) saveAllBatch(); } },
          el('span', { textContent: I18N.t('obj.foot.all', { n: pk.items.length }) }),
          el('span', { className: 'k' }, ...keyCap('⇧Enter'))));
    }

    return el('section', { className: 'object-list', 'aria-label': 'Danh sách object ở frame hiện tại' },
      el('div', { className: 'object-tabs' },
        tab('all', batch ? I18N.t('obj.tab.proposed') : I18N.t('obj.tab.all'), batch ? proposedTotal : all.length),
        tab('saved', I18N.t('save.ok'), saved.length),
        pending.length ? tab('pending', I18N.t('obj.pending'), pending.length + draft.length) : ''),
      progNode,
      el('div', { className: 'object-list-rows' }, ...(rows.length ? rows : [el('div', { className: 'object-empty', textContent: I18N.t('obj.empty') })])),
      footNode);
  }
  function buildBoxPanel() {
    const p = st.proposal, kids = [];
    if (!p) { ui.saveBox = el('button'); ui.fields = null; ui.yawSlider = null; ui.yawNum = null; ui.dimSub = null; ui.kvSize = null; ui.kvYaw = null; ui.kvEdit = null; }
    kids.push(objectList());
    if (!p) {
      if (st.sizeAsk) kids.push(el('div', { className: 'card askcard' }, el('b', { textContent: I18N.t('ask.title', { id: st.sizeAsk.trackId }) }),
        el('div', { className: 'mono', textContent: `${st.sizeAsk.size.l.toFixed(2)}×${st.sizeAsk.size.w.toFixed(2)}×${st.sizeAsk.size.h.toFixed(2)} m` }),
        el('div', { className: 'askbtns' },
          el('button', { className: 'pri', id: 'sizeAll', textContent: `${I18N.t('ask.all')} ↵`, onclick: () => answerSize(true) }),
          el('button', { id: 'sizeOne', textContent: I18N.t('ask.one'), onclick: () => answerSize(false) }),
          el('button', { className: 'ghost', textContent: I18N.t('ask.cancel'), onclick: () => { st.sizeAsk = null; draw(); buildBoxPanel(); } }))));
      kids.push(el('div', { className: 'muted', style: 'margin-top:6px;font-size:12px', textContent: st.mode === 'draw' ? 'Click vào vật thể, hoặc kéo khung quanh nó (tốt hơn khi xe bị che).' : 'N để vẽ box mới · click một box trong danh sách hoặc trên ảnh để mở · ? xem mọi phím.' }));
    }
    const pk = !st.batch && parkedHere();
    if (pk) kids.push(el('div', { className: 'row muted', style: 'font-size:12px' },
      el('span', { textContent: `${pk.items.length} box tạm dừng duyệt đang vẽ mờ trên ảnh.` }),
      el('button', { className: 'link', textContent: 'Bỏ hết', onclick: discardParked })));
    if (autoHere()) kids.push(autoCard());
    if (st.outbox.length) {
      kids.push(el('div', { className: 'card' },
        el('div', { textContent: st.saveError ? `⚠ ${st.outbox.length} box chưa lên CVAT: ${st.saveError}` : `⏳ Đang lưu ${st.outbox.length} box lên CVAT…` }),
        el('div', { className: 'muted', textContent: 'Được giữ lại cả khi tải lại trang; tự thử lại.' }),
        st.saveError ? el('button', { className: 'sm', textContent: 'Thử lại ngay', onclick: () => { clearTimeout(retryTimer); flushOutbox(); } }) : ''));
    }
    if (st.saved.length || st.savedTrackIds.size) {
      const parts = [st.saved.length && `${st.saved.length} shape`, st.savedTrackIds.size && `${st.savedTrackIds.size} track`].filter(Boolean).join(' · ');
      kids.push(el('div', { className: 'row muted' }, `✓ Đã lưu lên server: ${parts}. CVAT cần mở lại job để nạp annotation mới.`,
        st.undo.steps.length ? el('button', { className: 'link', textContent: I18N.t('undo.last'), onclick: undoAction }) : '',
        el('button', { className: 'pri sm', textContent: 'Hiện shape/track trong CVAT', title: 'Mở lại job để CVAT nạp annotation vừa lưu', onclick: reopenInCvat })));
    }
    ui.boxPanel.replaceChildren(...kids);
    renderFrameMarks(); updateHint(); updateQuick();
    ui.logRow.replaceChildren();
    const openLogTab = () => sessionPopup ? sessionPopup.open('sessions') : window.open(chrome.runtime.getURL('ui/logtab.html'), '_blank');
    const openDash = () => sessionPopup ? sessionPopup.open('dashboard') : window.open(chrome.runtime.getURL('ui/logtab.html'), '_blank');
    if (st.editlog.length) {
      const s = EL.summary(st.editlog);
      ui.logRow.append(el('div', { className: 'row' },
        el('span', { className: 'muted', title: `Đã sửa: IoU 3D < ${EL.EDIT_IOU}, lệch hướng > ${EL.EDIT_YAW_DEG}° hoặc đổi nhãn`,
          textContent: `Box máy đề xuất: lưu ${s.saved}, phải sửa ${s.edited} (${s.pct.toFixed(0)}%), bỏ ${s.skipped}` }),
        el('button', { className: 'sm pri', textContent: 'Dashboard phân tích', onclick: openDash }),
        el('button', { className: 'sm', textContent: 'Các phiên', onclick: openLogTab }),
        el('button', { className: 'sm', textContent: 'Xuất CSV', onclick: exportEditlog })));
    } else {
      ui.logRow.append(el('div', { className: 'row' },
        el('span', { className: 'muted', textContent: 'Nhật ký thao tác' }),
        el('button', { className: 'sm pri', textContent: 'Dashboard phân tích', onclick: openDash }),
        el('button', { className: 'sm', textContent: 'Các phiên', onclick: openLogTab })));
    }
  }
  function buildSliders() {
    ui.sliders.replaceChildren(...SLIDERS.map(([k, label, min, max, step]) => {
      const rng = el('input', { type: 'range', min, max, step }), num = el('input', { type: 'number', step });
      const fmt = (v) => (+v).toFixed(step < 0.01 ? 3 : 2);
      rng.value = st.adj[st.cam][k]; num.value = fmt(rng.value);
      const set = (v) => {
        if (!Number.isFinite(v)) return;
        st.adj[st.cam][k] = v; rng.value = v; num.value = fmt(v); drawSoon();
      };
      rng.oninput = () => set(+rng.value); num.onchange = () => set(+num.value);
      return el('div', { className: 'sl' }, el('span', { className: 'mono', textContent: label }), rng, num);
    }));
    const q = (st.calib.quality || {})[st.cam] || {};
    const cam = st.calib.cameras[st.cam];
    ui.camq.textContent = `· ${cam.model || 'pinhole'}${q.median_reproj_px != null ? ' · ' + q.median_reproj_px + 'px' : ''}`;
    ui.calibsrc.textContent = 'Calib: ' + st.calibSrc;
    pairInfoUpdate();
  }

  // ---------------------------------------------------------------- calibration from clicked pairs (pairs.js)
  // Click a LiDAR point as drawn, then the pixel where that point really is. Pairs are kept per camera
  // (any frame / job of this CVAT) in chrome.storage; "Giải" fits the 7 slider deltas to all of them.
  // kept per calibration (the profile, or the task when a file was loaded): pairs of different vehicles never mix
  const pairsKey = () => `pairs:${location.origin}:${st.profile || 'task' + (st.job && st.job.taskId)}`;
  async function loadPairs() { try { st.pairs = (await chrome.storage.local.get(pairsKey()))[pairsKey()] || {}; } catch (e) { st.pairs = {}; } }
  function savePairs() { putStore({ [pairsKey()]: st.pairs }); }
  function pairInfoUpdate() {
    if (!ui.pairInfo || !st.cam) return;
    const all = st.pairs[st.cam] || [], here = all.filter((p) => st.job && p.job === st.job.id && p.frame === st.frame).length;
    ui.pairInfo.textContent = st.pending ? 'Giờ click đúng chỗ của điểm đó trên ảnh (Esc: bỏ)'
      : `${all.length} cặp cho ${st.cam}${here ? ` (${here} ở frame này)` : ''}` +
        (all.length < PS.MIN_PAIRS ? ` · cần ≥ ${PS.MIN_PAIRS}, nên 15–25` : '') +
        (st.pairRes && st.pairRes.cam === st.cam ? ` · lần giải gần nhất: ${st.pairRes.before.toFixed(1)} → ${st.pairRes.after.toFixed(1)} px` : '') +
        (st.measured && st.measured.cam === st.cam ? ` · ${st.measured.text}` : '');
  }
  function pairClick(u, v) {
    if (!current || current.frame !== st.frame || !st.job) return;
    if (!st.pending) {                                          // 1st click: the LiDAR point as drawn
      const pj = current.proj;
      if (!pj || !pj.key.startsWith(st.cam + '|')) { toast('Bật hiện điểm LiDAR (H) để chọn điểm 3D'); return; }
      const tol = (12 * tf.dpr) / tf.s;
      let best = -1, bd = tol;
      for (let j = 0; j < pj.p.u.length; j++) { const dd = Math.hypot(pj.p.u[j] - u, pj.p.v[j] - v); if (dd < bd) { bd = dd; best = j; } }
      if (best < 0) { toast('Click trúng một điểm LiDAR (chấm màu) trước, rồi mới click chỗ của nó trên ảnh'); return; }
      const i = pj.p.idx[best], c = pj.cloud;
      st.pending = { xyz: [c[3 * i], c[3 * i + 1], c[3 * i + 2]], job: st.job.id, frame: st.frame, cam: st.cam };
    } else {                                                    // 2nd click: where that point really is
      const p = st.pending;
      st.pending = null;
      const q = proj3(p.xyz), off = q ? Math.hypot(q[0] - u, q[1] - v) : Infinity;
      if (off > PS.FAR && !confirm(`Chỗ vừa click cách điểm LiDAR ${Number.isFinite(off) ? off.toFixed(0) + ' px' : 'rất xa'} ` +
        `(calib thường chỉ lệch vài chục px). Có chắc đây đúng là cùng một điểm, không phải đầu kia của xe / vật khác?`)) { pairInfoUpdate(); draw(); return; }
      if (p.cam === st.cam && p.frame === st.frame && p.job === st.job.id) {
        (st.pairs[st.cam] ??= []).push({ xyz: p.xyz, uv: [+u.toFixed(1), +v.toFixed(1)], job: p.job, frame: p.frame });
        savePairs();
      }
    }
    pairInfoUpdate(); draw();
  }
  const fmtStats = (m) => `trung vị ${m.median.toFixed(1)} · p90 ${m.p90.toFixed(1)} · max ${m.max.toFixed(0)} px`;
  function solvePairs() {
    const list = st.pairs[st.cam] || [];
    try {
      const r = PS.solve(st.calib, st.cam, st.adj[st.cam], list);
      const what = `Giải ${list.length} cặp (${r.mode === 'rot' ? 'chỉ xoay: cặp ít hoặc dồn một chỗ' : 'xoay + vị trí + f'}, phủ ${r.cells}/9 ô): ` +
        `${r.before.median.toFixed(1)} → ${r.after.median.toFixed(1)} px, điểm không dùng để giải ${r.loo.median.toFixed(1)} px`;
      if (!r.ok && !confirm(`${what}\n\nKHÔNG NÊN áp dụng:\n- ${r.reasons.join('\n- ')}\n\nVẫn áp dụng lên thanh trượt?`)) {
        toast('Giữ nguyên calib. ' + r.reasons[0]); return;
      }
      st.adj[st.cam] = { ...defAdj(), ...r.adj };
      st.pairRes = { cam: st.cam, before: r.before.median, after: r.after.median }; st.measured = null;
      const bad = r.errors.filter((e) => e > 5).length;
      buildSliders(); draw();
      toast(`${what}${bad ? ` · ${bad} cặp còn lệch > 5 px (đỏ)${r.suspect.length ? `, ${r.suspect.length} cặp > ${PS.FAR} px có lẽ click nhầm (đã bỏ qua, nên xoá)` : ''}` : ''}. Bấm Lưu calib để giữ.`);
    } catch (e) { toast(e.message); }
  }
  /** Error of the calibration in use (and of the bundled one when the sliders moved) on this camera's pairs. */
  function measurePairs() {
    const list = st.pairs[st.cam] || [];
    if (!list.length) { toast('Chưa có cặp điểm nào cho ' + st.cam); return; }
    const m = PS.measure(st.calib, st.cam, st.adj[st.cam], list), m0 = PS.measure(st.calib, st.cam, null, list);
    const moved = Object.entries(defAdj()).some(([k, v]) => st.adj[st.cam][k] !== v);
    const jobs = new Set(list.map((p) => p.job)).size;
    st.pairRes = null;
    st.measured = { cam: st.cam, text: `đo: ${fmtStats(m)}` };
    toast(`${st.cam}: ${list.length} cặp / ${jobs} job, phủ ${m.cells}/9 ô · ${fmtStats(m)}` +
      (moved ? ` (calib đóng gói: ${fmtStats(m0)})` : '') + (m.cells < 4 ? ' · cặp dồn một chỗ: rải thêm ra rìa ảnh' : ''));
    pairInfoUpdate(); draw();
  }
  /** Every pair + its error, as JSON for tools/pairs_report.js (no host name: just job ids and points). */
  function exportPairs() {
    const cams = {};
    for (const [cam, list] of Object.entries(st.pairs)) {
      if (!list.length || !st.calib.cameras[cam]) continue;
      const m = PS.measure(st.calib, cam, null, list);
      cams[cam] = { pairs: list, adj: st.adj[cam], bundled: { median: m.median, p90: m.p90, max: m.max, cells: m.cells } };
    }
    if (!Object.keys(cams).length) { toast('Chưa có cặp điểm nào để xuất'); return; }
    const out = { kind: 'lidar-cam-pairs', version: 1, calib_hash: st.calibHash, at: new Date().toISOString(), cameras: cams };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `pairs-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** Pairs of this camera clicked on this frame: LiDAR point as projected now (yellow), clicked pixel
   *  (cross; red when still > 5 px off), and the LiDAR point waiting for its pixel (ring). */
  function drawPairs(ctx, s, ox, oy, dpr) {
    const list = (st.pairs[st.cam] || []).filter((p) => p.job === st.job.id && p.frame === st.frame);
    const pts = list.map((p) => p.xyz);
    if (st.pending && st.pending.cam === st.cam && st.pending.frame === st.frame) pts.push(st.pending.xyz);
    if (!pts.length) return;
    const pr = P.projectCloud(new Float32Array(pts.flat()), st.calib, st.cam, st.adj[st.cam]), at = new Map();
    pr.idx.forEach((i, j) => at.set(i, [pr.u[j] * s + ox, pr.v[j] * s + oy]));
    list.forEach((p, i) => {
      const x = p.uv[0] * s + ox, y = p.uv[1] * s + oy, q = at.get(i), r = 6 * dpr;
      const off = q ? Math.hypot(q[0] - x, q[1] - y) / s : Infinity;
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = off > 5 ? '#ff4d4d' : '#3dff6e';
      if (q) {
        ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5 * dpr, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
    });
    const q = at.get(list.length);
    if (q) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.arc(q[0], q[1], 9 * dpr, 0, 2 * Math.PI); ctx.stroke(); }
  }

  // ---------------------------------------------------------------- drawing
  function colorFor(t) {
    const c = (x) => Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(x))));
    return `rgb(${c(4 * t - 3)},${c(4 * t - 2)},${c(4 * t - 1)})`;
  }
  /** Project a 3D polyline (pcd frame), sampled so lens distortion bends it; returns image-space runs. */
  function projectPolyline(pts3d, steps = 8) {
    const dense = [];
    for (let i = 0; i + 1 < pts3d.length; i++) for (let k = 0; k <= steps; k++) {
      const t = k / steps, a = pts3d[i], b = pts3d[i + 1];
      dense.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    }
    const pr = P.projectCloud(new Float32Array(dense), st.calib, st.cam, st.adj[st.cam]);
    const by = new Map(); pr.idx.forEach((i, j) => by.set(i, [pr.u[j], pr.v[j]]));
    const runs = []; let cur = [];
    for (let i = 0; i < dense.length / 3; i++) { const p = by.get(i); if (p) cur.push(p); else if (cur.length) { runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);
    return runs.filter((r) => r.length > 1);
  }
  function strokeRuns(ctx, runs, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width * tf.dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const seg of runs) {
      ctx.beginPath();
      seg.forEach(([u, v], k) => (k ? ctx.lineTo(u * tf.s + tf.ox, v * tf.s + tf.oy) : ctx.moveTo(u * tf.s + tf.ox, v * tf.s + tf.oy)));
      ctx.stroke();
    }
  }
  /** Box edges + heading (X on the front face, arrow on the ground) + optional size label. */
  function strokeBox(ctx, box, color, width, label) {
    strokeRuns(ctx, BF.projectBox(box, st.calib, st.cam, st.adj[st.cam]), color, width);
    const c = BF.corners(box);                       // indices 4..7 = front face (+x of the box)
    const head = width >= 2 ? '#ffd23f' : color;
    strokeRuns(ctx, projectPolyline([c[4], c[7]]), head, width);
    strokeRuns(ctx, projectPolyline([c[5], c[6]]), head, width);
    const cs = Math.cos(box.yaw), sn = Math.sin(box.yaw), zb = box.z - box.h / 2;
    const tip = [box.x + cs * (box.l / 2 + 1.2), box.y + sn * (box.l / 2 + 1.2), zb];
    const wing = (sgn) => [tip[0] - cs * 0.6 - sgn * sn * 0.45, tip[1] - sn * 0.6 + sgn * cs * 0.45, zb];
    strokeRuns(ctx, projectPolyline([[box.x, box.y, zb], tip]), head, width);
    strokeRuns(ctx, projectPolyline([wing(1), tip, wing(-1)]), head, width);
    if (!label) return;
    const tag = typeof label === 'string' ? { text: label, color } : label;
    const top = projectPolyline([[box.x, box.y, box.z + box.h / 2], [box.x, box.y, box.z + box.h / 2 + 0.01]], 1)[0];
    if (!top) return;
    const [u, v] = top[0], x = u * tf.s + tf.ox, y = v * tf.s + tf.oy - 10 * tf.dpr;
    ctx.font = `${12 * tf.dpr}px ui-monospace, Menlo, monospace`;
    const w = ctx.measureText(tag.text).width + 10 * tf.dpr, hgt = 18 * tf.dpr;
    const r = TAG.place(tagsPlaced, { x, y, w, h: hgt });          // tags of nearby boxes do not cover each other
    ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(r.x - w / 2, r.y - hgt, w, hgt);
    ctx.fillStyle = tag.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(tag.text, r.x, r.y - hgt / 2); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  let tagsPlaced = [];
  /** 4.3: the detections of the last auto run that gave no box, on the camera that saw them, with the reason. */
  function drawRejected(ctx) {
    ctx.save(); ctx.setLineDash([3 * tf.dpr, 3 * tf.dpr]); ctx.lineWidth = 1.2 * tf.dpr; ctx.strokeStyle = 'rgba(180,186,200,.85)';
    ctx.font = `${11 * tf.dpr}px system-ui, sans-serif`; ctx.textBaseline = 'bottom';
    for (const { cand, reason } of st.auto.rejected || []) {
      if (cand.cam !== st.cam) continue;
      const d = cand.det, x = d.u0 * tf.s + tf.ox, y = d.v0 * tf.s + tf.oy, w = (d.u1 - d.u0) * tf.s, h = (d.v1 - d.v0) * tf.s;
      ctx.strokeRect(x, y, w, h);
      const t = `${d.label} ${Math.round(100 * d.score)}% · ${AF.REASONS[reason]}`, tw = ctx.measureText(t).width + 6 * tf.dpr;
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(x, y - 15 * tf.dpr, tw, 15 * tf.dpr);
      ctx.fillStyle = '#d6dae3'; ctx.fillText(t, x + 3 * tf.dpr, y - 2 * tf.dpr);
    }
    ctx.restore();
  }
  /** Tag for an auto proposal: "#3 · car 85%" (or the usual track/manual label). */
  function itemTag(it) {
    const lName = (it && it.labelId != null ? labelName(it.labelId) : null) || 'Object';
    const trStr = it && it.trackId != null ? ` #${it.trackId}` : '';
    const cls = `${lName}${trStr}`;
    if (it && it.det && it.det.score != null) {
      const pct = Math.round(it.det.score <= 1 ? it.det.score * 100 : it.det.score);
      const level = it.det.score >= 0.7 ? 'high' : it.det.score >= 0.5 ? 'mid' : 'low';
      const id = it.reviewId != null ? `#${it.reviewId} · ` : '';
      const detectorClass = it.det.label || cls;
      return { text: `${id}${detectorClass} ${pct}%`, color: TAG.COLORS[level] || '#4ea1ff' };
    }
    return { text: `${cls} - manual`, color: '#a0aec0' };
  }
  /** Tag for any existing or saved box: "Car #1 - 85%" or "Car - manual" */
  function boxTag(frame, box, labelId, rec) {
    const lName = (labelId != null ? labelName(labelId) : null) || (rec && (rec.labelName || (rec.labelId != null && labelName(rec.labelId)))) || 'Object';
    const trId = rec && rec.trackId != null ? rec.trackId : (rec && rec.track ? rec.track.id : null);
    const trStr = trId != null ? ` #${trId}` : '';
    const cls = `${lName}${trStr}`;
    const s = st.scores.find((x) => x.frame === frame && Math.hypot(x.box.x - box.x, x.box.y - box.y) < 0.5);
    let score = null, manual = false;
    if (s) {
      score = s.score;
      manual = s.manual || score == null;
    } else if (rec && rec.shape) {
      const scAttr = (rec.shape.attributes || []).find((at) => {
        const l = st.job && st.job.labels.find((lb) => lb.id === (labelId ?? rec.shape.label_id));
        const spec = l && l.attributes.find((sp) => sp.id === at.spec_id);
        return spec && /score|confidence|conf/i.test(spec.name);
      });
      if (scAttr && !isNaN(parseFloat(scAttr.value))) score = parseFloat(scAttr.value);
      else manual = true;
    } else {
      manual = true;
    }

    if (!manual && score != null && !isNaN(score)) {
      const pct = Math.round(score <= 1 ? score * 100 : score);
      const level = score >= 0.7 ? 'high' : score >= 0.5 ? 'mid' : 'low';
      return { text: `${cls} - ${pct}%`, color: TAG.COLORS[level] || '#4ea1ff' };
    }
    return { text: `${cls} - manual`, color: '#a0aec0' };
  }
  const sizeLabel = (b) => `${b.l.toFixed(2)}×${b.w.toFixed(2)}×${b.h.toFixed(2)} m · ${(b.yaw / DEG).toFixed(1)}°`;

  let current = null;
  /** draw() once on the next animation frame: pointer / wheel / slider events come faster than the screen. */
  let drawRaf = 0;
  function drawSoon(dragRect) {
    cancelAnimationFrame(drawRaf);
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; draw(dragRect); });
  }
  function draw(dragRect) {
    if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; }     // drawn now: a queued one would be stale
    if (!st.open || !ui.cv) return;
    const cv = ui.cv, dpr = window.devicePixelRatio || 1;
    const cw = ui.vp.clientWidth, ch = ui.vp.clientHeight;
    if (!cw || !ch) return;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!st.calib) { ui.msg.textContent = st.calibError || 'Đang nạp calib…'; return; }
    if (!current) return;
    const entry = st.cams.find((c) => c.name === st.cam);
    const bmp = current.images[entry.idx];
    const [W, H] = st.calib.cameras[st.cam].image_size || [1920, 1536];
    const s = Math.min(cv.width / W, cv.height / H) * view.zoom;
    const ox = (cv.width - W * s) / 2 + view.ox * dpr, oy = (cv.height - H * s) / 2 + view.oy * dpr;
    tf = { s, ox, oy, dpr }; tagsPlaced = [];
    let msg = '';
    let note = '';                     // shown, but the points are still drawn
    if (!bmp) {
      const im = current.img || {};
      if (im.state === 'loading') note = `Đang tải ảnh camera từ CVAT… ${(im.bytes / 1e6).toFixed(1)} MB · ${Math.round((performance.now() - im.t0) / 1000)} s`;
      else if (im.state === 'error') note = `Không tải được ảnh camera: ${im.error}${Number.isFinite(im.retryAt) ? ' (tự thử lại)' : ''}`;
      else note = `Frame này không có ${entry.img} trong CVAT`;
    }
    else if (bmp.width !== W || bmp.height !== H) msg = `Ảnh ${bmp.width}×${bmp.height} ≠ calib ${W}×${H}: không chiếu`;
    if (bmp) ctx.drawImage(bmp, ox, oy, W * s, H * s);
    ui.msg.textContent = msg || note;
    let nPts = 0;
    const ptsMode = ptsModeOf();
    ui.tPts.title = `${I18N.t('tool.points')}: ${I18N.t(PTS.find(([m]) => m === ptsMode)[1])} (H)`;
    if (st.opts.show && !msg && ptsMode !== 'off') {
      // only the shown points are projected (ground dropped once per frame), and the projection is
      // reused while just panning / zooming
      const o = st.opts;
      if (o.hideGround && !current.above) {
        let m = 0; for (let i = 0; i < current.ground.length; i++) if (!current.ground[i]) m++;
        const out = new Float32Array(m * 3); let j = 0;
        for (let i = 0; i < current.ground.length; i++) if (!current.ground[i]) { out[j++] = current.xyz[3 * i]; out[j++] = current.xyz[3 * i + 1]; out[j++] = current.xyz[3 * i + 2]; }
        current.above = out;
      }
      let proj;
      if (ptsMode === 'box') {                                   // only the points around the selected box
        const b = st.proposal && st.proposal.frame === st.frame && st.proposal.box, sel = b ? pointsInBox(b, 1.0) : [];
        const sub = new Float32Array(sel.length * 3); let j = 0;
        for (const i of sel) { if (o.hideGround && current.ground[i]) continue; sub[j++] = current.xyz[3 * i]; sub[j++] = current.xyz[3 * i + 1]; sub[j++] = current.xyz[3 * i + 2]; }
        proj = P.projectCloud(sub.subarray(0, j), st.calib, st.cam, st.adj[st.cam]);
      } else {
        if (ptsMode === 'obj' && !current.objects) {        // road users only: once per frame
          const keep = BF.objectMask(current.xyz, current.ground);
          let m = 0; for (let i = 0; i < keep.length; i++) if (keep[i]) m++;
          const out = new Float32Array(m * 3); let j = 0;
          for (let i = 0; i < keep.length; i++) if (keep[i]) { out[j++] = current.xyz[3 * i]; out[j++] = current.xyz[3 * i + 1]; out[j++] = current.xyz[3 * i + 2]; }
          current.objects = out;
        }
        const inBoxes = ptsMode === 'boxes' ? boxesCloud(o.hideGround) : null;
        const cloud = inBoxes ? inBoxes.cloud : ptsMode === 'obj' ? current.objects : o.hideGround ? current.above : current.xyz;
        const pkey = `${st.cam}|${JSON.stringify(st.adj[st.cam])}|${o.hideGround}|${ptsMode}|${inBoxes ? inBoxes.key : ''}`;
        if (!current.proj || current.proj.key !== pkey || current.proj.calib !== st.calib) {
          current.proj = { key: pkey, calib: st.calib, cloud, p: P.projectCloud(cloud, st.calib, st.cam, st.adj[st.cam]) };
        }
        proj = current.proj.p;
      }
      const size = o.size * dpr * Math.max(1, view.zoom / 2), buckets = new Map();
      for (let j = 0; j < proj.u.length; j++) {
        const b = Math.min(63, Math.floor((proj.range[j] / o.maxR) * 64));
        let arr = buckets.get(b); if (!arr) buckets.set(b, (arr = []));
        arr.push(proj.u[j] * s + ox, proj.v[j] * s + oy);
      }
      ctx.globalAlpha = st.proposal ? o.alpha * 0.5 : o.alpha;
      for (const [b, arr] of buckets) {
        ctx.fillStyle = o.mono ? '#39c5ff' : colorFor((b + 0.5) / 64);
        for (let k = 0; k < arr.length; k += 2) ctx.fillRect(arr[k] - size / 2, arr[k + 1] - size / 2, size, size);
      }
      ctx.globalAlpha = 1; nPts = proj.u.length;
    }
    if (!msg) {
      // boxes already in the job (grey), saved in this session (cyan), proposal (green + its points)
      // boxes being edited / updated / deleted are drawn in their new state only
      const hidden = new Set(st.outbox.map((o) => (o.shape && o.op !== 'create' ? `s${o.shape.id}` : o.trackId != null && o.frame === st.frame ? `t${o.trackId}` : null)).filter(Boolean));
      if (st.proposal && st.proposal.edit) hidden.add(recKey(st.proposal.edit));
      for (const e of boxesAt(st.frame)) {
        if (e.rec && hidden.has(recKey(e.rec))) continue;
        if (e.interp) ctx.setLineDash([5 * dpr, 4 * dpr]);
        strokeBox(ctx, e.box, 'rgba(200,200,200,.85)', 1.5, boxTag(st.frame, e.box, e.rec ? e.rec.labelId : null, e.rec));
        ctx.setLineDash([]);
      }
      for (const sv of st.saved) if (sv.frame === st.frame && !hidden.has(`s${sv.shape.id}`)) strokeBox(ctx, sv.box, '#39c5ff', 2, boxTag(sv.frame, sv.box, sv.labelId ?? (sv.shape && sv.shape.label_id), sv));
      for (const o of st.outbox) if (o.frame === st.frame && o.box && o.op !== 'delete' && o.op !== 'track-delete') strokeBox(ctx, o.box, '#ff9f1a', 2, 'đang lưu…');
      if (st.batch) {
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        for (const it of itemsHere(st.batch)) if (!st.proposal || it !== st.proposal.item) strokeBox(ctx, it.box, 'rgba(61,255,110,.75)', 1.5, itemTag(it));
        ctx.setLineDash([]);
      }
      if (st.opts.showRejected && st.auto && !st.auto.scan && st.auto.frame === st.frame) drawRejected(ctx);
      if (parkedKey() != null) {                                 // set aside, not saved: faint, clickable
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        for (const it of itemsHere(parkedHere())) strokeBox(ctx, it.box, 'rgba(61,255,110,.7)', 1.6, itemTag(it));
        ctx.setLineDash([]);
      }
      if (st.proposal && st.proposal.frame === st.frame) {
        const sub = new Float32Array(st.proposal.points.flatMap((i) => [current.xyz[3 * i], current.xyz[3 * i + 1], current.xyz[3 * i + 2]]));
        const pp = P.projectCloud(sub, st.calib, st.cam, st.adj[st.cam]);
        ctx.fillStyle = '#ff3df2';
        for (let j = 0; j < pp.u.length; j++) ctx.fillRect(pp.u[j] * s + ox - 1.5 * dpr, pp.v[j] * s + oy - 1.5 * dpr, 3 * dpr, 3 * dpr);
        const pTag = st.proposal.item
          ? itemTag(st.proposal.item)
          : (st.proposal.edit
            ? boxTag(st.proposal.frame, st.proposal.box, st.labelId, st.proposal.edit)
            : { text: `${labelName(st.labelId) || 'Object'} - manual`, color: '#a0aec0' });
        strokeBox(ctx, st.proposal.box, '#3dff6e', 2.5, pTag);
        // handles: white = move (Shift: up/down), squares = faces, yellow = heading
        handleHits = [];
        for (const h of BH.handles(st.proposal.box)) {
          const q = proj3(h.p); if (!q) continue;
          const x = q[0] * s + ox, y = q[1] * s + oy, r = 6 * dpr;
          if (x < 0 || y < 0 || x > cv.width || y > cv.height) continue;
          handleHits.push({ h, x, y });
          ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#0b0d11';
          ctx.fillStyle = h.id === 'move' ? '#ffffff' : h.id === 'yaw' ? '#ffd23f' : h.axis === 'h' ? '#7ee8ff' : '#3dff6e';
          ctx.beginPath();
          if (h.id === 'face') ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); else ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fill(); ctx.stroke();
        }
        if (st.proposal.cam === st.cam && st.proposal.click) {
          const c = st.proposal.click;
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.beginPath();
          ctx.arc(c.u * s + ox, c.v * s + oy, 7 * dpr, 0, 2 * Math.PI); ctx.stroke();
        }
        if (st.proposal.cam === st.cam && st.proposal.rect) {
          const r = st.proposal.rect;
          ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1 * dpr;
          ctx.strokeRect(Math.min(r.u0, r.u1) * s + ox, Math.min(r.v0, r.v1) * s + oy, Math.abs(r.u1 - r.u0) * s, Math.abs(r.v1 - r.v0) * s);
          ctx.setLineDash([]);
        }
      }
    }
    if (!msg && st.mode === 'pair') drawPairs(ctx, s, ox, oy, dpr);
    if (dragRect && dragRect.kind === 'rect') {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(Math.min(dragRect.u0, dragRect.u1) * s + ox, Math.min(dragRect.v0, dragRect.v1) * s + oy,
        Math.abs(dragRect.u1 - dragRect.u0) * s, Math.abs(dragRect.v1 - dragRect.v0) * s);
      ctx.setLineDash([]);
    }
    if (!st.proposal || st.proposal.frame !== st.frame || msg) handleHits = [];
    const viewsOn = !!(st.opts.views && st.proposal && st.proposal.frame === st.frame);
    if (ui.views.hidden === viewsOn) ui.views.hidden = !viewsOn;
    if (boxViews && viewsOn) boxViews.draw();
    ui.hud.textContent = `${entry.img} · ${st.cam} · ${nPts.toLocaleString()} điểm · zoom ${view.zoom.toFixed(1)}×${st.mode === 'draw' ? ' · ĐANG VẼ BOX' : st.mode === 'pair' ? ' · CẶP ĐIỂM' : ''}`;
  }

  // ---------------------------------------------------------------- follow CVAT
  let lastKey = '';
  let jobLoading = null, existingLoading = null;      // requests in flight: later ticks wait instead of asking again
  async function tick(force) {
    const jid = routeJob();
    ui.host.style.display = jid ? '' : 'none';
    if (!jid) { st.job = null; return; }
    try {
      if (!st.job || st.job.id !== jid) {
        if (jobLoading === jid) return;            // the 400 ms timer: that job is still being read
        jobLoading = jid;
        st.job = null; st.data.clear(); st.existing = null; st.saved = []; st.savedTrackIds.clear(); st.scores = []; st.trackInfo.clear(); st.held.clear(); st.kindOverride.clear(); st.trackQueue = []; if (tracking) tracking.cancel = true; st.outbox = []; st.saveError = null; st.undo = UD.create(); st.undone.clear(); st.proposal = null; st.batch = null; st.parked.clear(); st.ego.clear(); st.lastT = null; st.poseMeta = null; st.poseSrc = ''; st.poseCoverage = null; st.poseError = null; st.siblings = null; st.clouds.clear(); st.nbCtl.abort(); st.auto = null; st.objectTab = 'all';
        const job = await loadJob(jid).finally(() => { jobLoading = null; });
        if (!job) { ui.host.style.display = 'none'; return; }      // only 3D jobs
        st.job = job; buildLabels(); restoreOutbox(); await loadScores(); loadEditlog().then(buildBoxPanel); loadLabelMap();
        try { await loadCalibFor(job); } catch (e) { st.calibError = 'Không nạp được calib: ' + e.message; console.warn('[lidar-cam]', st.calibError); }
        try { await loadPoseFor(job); } catch (e) { st.poseError = 'Không nạp được ego pose đã lưu: ' + e.message; poseInfoUpdate(); console.warn('[lidar-cam]', st.poseError); }
        if (st.calib) { buildBoxPanel(); }
      }
      if (!st.open) return;
      updateSessionLiveChip();
      if (!st.existing) { await (existingLoading ??= loadExisting().finally(() => { existingLoading = null; })); await loadSaveMode(); }
      const frame = currentFrame() ?? st.job.start;
      const key = `${jid}:${frame}`;
      if (key === lastKey && !force) {
        const im = current && current.frame === frame && current.img;
        if (im && im.state === 'loading') draw();                                    // live counter
        else if (im && im.state === 'error' && performance.now() > im.retryAt) loadImages(current);
        return;
      }
      lastKey = key;
      // D / F: the box of a track that was open stays selected on the next frame (below), so frames can be checked one by one
      const keepTrack = st.proposal && st.proposal.frame !== frame && st.proposal.edit && st.proposal.edit.trackId != null ? st.proposal.edit.trackId : null;
      if (st.proposal && st.proposal.frame !== frame && !autoSave()) st.proposal = null;
      if (st.batch && st.batch.kind !== 'scan' && st.batch.frame !== frame) {   // unsaved proposals wait for their frame (a scan's span several)
        if (st.batch.items.length) toast(`${st.batch.items.length} box chưa lưu của frame ${st.batch.frame} được giữ lại: quay về frame đó để duyệt tiếp`);
        parkBatch(false); st.proposal = null;
      }
      st.frame = frame;
      ui.where.textContent = whereText(jid); syncFrameBar();
      ui.msg.textContent = 'Đang tải point cloud + ảnh camera từ CVAT…';
      const shown = setInterval(() => {               // what is still in flight, so a slow CVAT is visible
        const pg = st.progress.get(key); if (!pg || lastKey !== key) return;
        const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
        ui.msg.textContent = `Đang tải frame ${frame} từ CVAT… ${Math.round((performance.now() - pg.t0) / 1000)} s\n` +
          `point cloud${pg.src ? ' (' + pg.src + ')' : ''}: ${pg.pcdDone ? '✓ ' + mb(pg.pcd) : pg.pcd ? mb(pg.pcd) : 'đang chờ CVAT'} · ` +
          `ảnh camera: ${pg.img ? mb(pg.img) : 'đang chờ CVAT'} (hiện sau)`;
      }, 500);
      let data;
      try { data = await loadFrame(frame); } finally { clearInterval(shown); }
      if (lastKey !== key) return;
      current = data;
      st.retryMs = 0;
      if (parkedKey() != null && itemsHere(parkedHere()).length) toast(`Frame này còn ${itemsHere(parkedHere()).length} box chưa lưu (vẽ mờ): Tab hoặc click để duyệt tiếp`);
      ui.where.textContent = whereText(jid); ui.where.title = `${data.name.replace(/^.*\//, '')} · ${(data.xyz.length / 3).toLocaleString()} điểm`; syncFrameBar();
      draw(); buildBoxPanel();
      if (keepTrack != null && !st.proposal) { const rec = trackRecsAt(frame).find((x) => x.trackId === keepTrack); if (rec) selectServerBox(rec); }
      // prefetch the next frame only once this one's images are in (a busy CVAT answers one at a time)
      Promise.resolve(data.imgPending).finally(() => { if (lastKey === key && frame + 1 <= st.job.stop) loadFrame(frame + 1).catch(() => {}); });
    } catch (e) {
      ui.msg.textContent = 'Lỗi: ' + e.message + '\n';
      console.warn('[lidar-cam]', e);
      st.retryMs = Math.min(120000, (st.retryMs || 15000) * 2);    // 30 s, 60 s, 120 s: let a busy CVAT catch up
      ui.msg.textContent += ` (thử lại sau ${st.retryMs / 1000} s)`;
      setTimeout(() => { lastKey = ''; }, st.retryMs);
    }
  }

  buildUI();
  if (self.CompareChip) self.CompareChip.mount({
    ask: CVAT.ask, getJob: () => st.job, toast,
    getSession: () => st.activeSession,
    getFrame: () => st.frame,
    getDeviceId: () => (self.SupaLog ? self.SupaLog.getDeviceId() : Promise.resolve('')),
    getRecords: (sid) => st.editlog.filter((r) => r.session_id === sid),
    saveSession: (a) => { SessionManager.saveActiveSession(location.origin, a); updateSessionLiveChip(); },
    // panel open: the tool's own clock runs; a box the tool saved in the last 20 s (or still being saved) is not a manual object
    isBusy: () => ({ panel: st.open, paused: !!(st.activeSession && st.activeSession.status === 'paused'), tool: st.open || st.outbox.length > 0 || (st.activeSession && Date.now() - st.activeSession.last_action_ts < 20000) }),
  });
  EL.setSession(crypto.randomUUID());   // gắn session_id cho mọi EditLog record trong phiên này
  loadOpts().then(() => { buildAutoClasses(); if (st.open) draw(); });
  ui.host.style.display = 'none';
  setMode('view');
  setInterval(() => tick(false), 400);
  window.__lidarCamDebug = { state: st, tick, draw, runFit, runClick, boxesAt, trackFollow, openTrackDialog, get handles() { return handleHits; } };
})();
