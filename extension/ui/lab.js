/* Calib Lab: view LiDAR projected on every camera, nudge the calibration, export it.
 * Files are read with the File API only; nothing leaves the browser. */
(() => {
  'use strict';
  const P = window.LidarProjection;
  const $ = (id) => document.getElementById(id);
  const t = (k, v) => I18n.t(k, v);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SLIDERS = [
    { key: 'pan', label: 'pan °', min: -5, max: 5, step: 0.01 },
    { key: 'tilt', label: 'tilt °', min: -5, max: 5, step: 0.01 },
    { key: 'roll', label: 'roll °', min: -5, max: 5, step: 0.01 },
    { key: 'dx', label: 'x m', min: -0.5, max: 0.5, step: 0.005 },
    { key: 'dy', label: 'y m', min: -0.5, max: 0.5, step: 0.005 },
    { key: 'dz', label: 'z m', min: -0.5, max: 0.5, step: 0.005 },
    { key: 'fscale', label: 'f ×', min: 0.9, max: 1.1, step: 0.001, def: 1 },
  ];
  const defAdj = () => Object.fromEntries(SLIDERS.map((s) => [s.key, s.def ?? 0]));

  const st = {
    calib: null, calibName: '', bundled: false, cams: [], adj: {},
    frames: [], index: new Map(), fi: 0, cam: null,
    cloud: new Map(), images: new Map(), view: { zoom: 1, ox: 0, oy: 0 },
  };

  // ---------- calibration ----------
  function setCalibInfo() { $('calibInfo').textContent = t('lab.cams', { name: st.bundled ? t('lab.bundled', { name: st.calibName }) : st.calibName, n: st.cams.length }); }
  function setCalib(c, name, bundled = false) {
    st.calib = c; st.calibName = name; st.bundled = bundled;
    const map = c.camera_map || { image_1: Object.keys(c.cameras)[0] };
    st.cams = Object.entries(map)
      .map(([img, nm]) => ({ img, idx: Number(img.split('_')[1]), name: nm }))
      .filter((x) => c.cameras[x.name])
      .sort((a, b) => a.idx - b.idx);
    st.adj = Object.fromEntries(st.cams.map((x) => [x.name, defAdj()]));
    if (!st.cam || !c.cameras[st.cam]) st.cam = (st.cams.find((x) => x.idx === 1) || st.cams[0]).name;
    setCalibInfo();
    buildThumbs(); buildSliders(); render();
  }

  // first bundled profile (calibs/index.json) until a calib.json is loaded
  const url = (f) => ((window.chrome && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL(f) : f);
  fetch(url('calibs/index.json')).then((r) => r.json())
    .then((ix) => { const p = ix.profiles[0]; return fetch(url('calibs/' + p.file)).then((r) => r.json()).then((c) => setCalib(c, p.name, true)); })
    .catch((e) => { $('calibInfo').textContent = t('lab.err.bundled', { msg: e.message }); });

  $('calibFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { setCalib(JSON.parse(await f.text()), f.name); } catch (err) { alert(t('lab.err.calib', { msg: err.message })); }
  });

  $('export').addEventListener('click', () => {
    if (!st.calib) return;
    const out = P.bakeCalib(st.calib, st.adj);
    out.edited = { from: st.calibName, at: new Date().toISOString(),
      adjustments: Object.fromEntries(Object.entries(st.adj).filter(([, a]) => SLIDERS.some((s) => a[s.key] !== (s.def ?? 0)))) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'calib.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------- data folder ----------
  $('dir').addEventListener('change', (e) => loadFiles(e.target.files));
  function loadFiles(files) {
    st.index.clear(); st.cloud.clear(); st.images.clear();
    for (const f of files) {
      const p = f.webkitRelativePath || f._path || f.name;
      let m = p.match(/([^/]+)\.pcd$/i);
      if (m) { entry(m[1]).pcd = f; continue; }
      m = p.match(/([^/]+?)(?:_pcd)?\/image_(\d+)\.(?:jpe?g|png)$/i);
      if (m) entry(m[1]).imgs[Number(m[2])] = f;
    }
    st.frames = [...st.index.keys()].filter((k) => st.index.get(k).pcd).sort();
    $('frame').max = Math.max(0, st.frames.length - 1); $('frame').value = 0; st.fi = 0;
    $('empty').hidden = st.frames.length > 0;
    if (!st.frames.length) alert(t('lab.err.nopcd'));
    loadFrame();
  }
  PageI18n.init(() => { if (st.calib) { setCalibInfo(); updatePanel(); render(); } });
  window.__calibLab = { loadFiles, state: st };   // test hook (used by automated checks)
  function entry(id) { if (!st.index.has(id)) st.index.set(id, { pcd: null, imgs: {} }); return st.index.get(id); }

  async function getCloud(id) {
    if (st.cloud.has(id)) return st.cloud.get(id);
    const xyz = PCD.parsePCD(await st.index.get(id).pcd.arrayBuffer());
    // ground: points within 0.25 m of a low height percentile (in the pcd frame, z up)
    const n = xyz.length / 3, zs = [];
    for (let i = 0; i < n; i += 7) { const r = Math.hypot(xyz[3 * i], xyz[3 * i + 1]); if (r > 3 && r < 25) zs.push(xyz[3 * i + 2]); }
    zs.sort((a, b) => a - b);
    const zg = zs.length ? zs[Math.floor(zs.length * 0.05)] + 0.25 : -Infinity;
    const ground = new Uint8Array(n);
    for (let i = 0; i < n; i++) ground[i] = xyz[3 * i + 2] < zg ? 1 : 0;
    const sub = new Float32Array(Math.ceil(n / 4) * 3);   // thumbnails use every 4th point
    for (let i = 0, j = 0; i < n; i += 4, j++) sub.set(xyz.subarray(3 * i, 3 * i + 3), 3 * j);
    const c = { xyz, ground, sub };
    st.cloud.set(id, c);
    if (st.cloud.size > 6) st.cloud.delete(st.cloud.keys().next().value);
    return c;
  }
  async function getImage(id, idx) {
    const key = id + '/' + idx;
    if (st.images.has(key)) return st.images.get(key);
    const f = st.index.get(id).imgs[idx];
    const bmp = f ? await createImageBitmap(f) : null;
    st.images.set(key, bmp);
    if (st.images.size > 48) st.images.delete(st.images.keys().next().value);
    return bmp;
  }

  async function loadFrame() {
    if (!st.frames.length) return;
    const id = st.frames[st.fi];
    delete $('frameLabel').dataset.i18n; $('frameLabel').textContent = `${st.fi + 1}/${st.frames.length} · ${id}`;
    await getCloud(id);
    await Promise.all(st.cams.map((c) => getImage(id, c.idx)));
    if (st.frames[st.fi] === id) render();
  }
  $('frame').addEventListener('input', (e) => { st.fi = Number(e.target.value); loadFrame(); });
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  function step(d) { if (!st.frames.length) return; st.fi = Math.min(st.frames.length - 1, Math.max(0, st.fi + d)); $('frame').value = st.fi; loadFrame(); }

  // ---------- rendering ----------
  function colorFor(r, maxR) {          // turbo-like ramp: near = blue, far = red
    const t = Math.min(1, r / maxR);
    const R = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3))));
    const G = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2))));
    const B = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1))));
    return `rgb(${R},${G},${B})`;
  }
  function drawPoints(ctx, proj, ground, sx, sy, ox, oy, size, alpha, maxR, hideGround) {
    ctx.globalAlpha = alpha;
    const buckets = new Map();   // batch by colour bucket for speed
    for (let j = 0; j < proj.u.length; j++) {
      if (hideGround && ground && ground[proj.idx[j]]) continue;
      const b = Math.min(63, Math.floor((proj.range[j] / maxR) * 64));
      let arr = buckets.get(b); if (!arr) buckets.set(b, (arr = []));
      arr.push(proj.u[j] * sx + ox, proj.v[j] * sy + oy);
    }
    for (const [b, arr] of buckets) {
      ctx.fillStyle = colorFor(((b + 0.5) / 64) * maxR, maxR);
      for (let k = 0; k < arr.length; k += 2) ctx.fillRect(arr[k] - size / 2, arr[k + 1] - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    renderMain(); renderThumbs(); updatePanel();
  }

  function renderMain() {
    const cv = $('main'), vp = $('viewport');
    const dpr = window.devicePixelRatio || 1;
    cv.width = vp.clientWidth * dpr; cv.height = vp.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#08090c'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!st.calib || !st.frames.length) return;
    const id = st.frames[st.fi], camEntry = st.cams.find((c) => c.name === st.cam);
    const bmp = st.images.get(id + '/' + camEntry.idx), cloud = st.cloud.get(id);
    const [W, H] = st.calib.cameras[st.cam].image_size || [1920, 1536];
    const fit = Math.min(cv.width / W, cv.height / H);
    const s = fit * st.view.zoom;
    const ox = (cv.width - W * s) / 2 + st.view.ox * dpr, oy = (cv.height - H * s) / 2 + st.view.oy * dpr;
    if (bmp) ctx.drawImage(bmp, ox, oy, W * s, H * s);
    if (!cloud || !$('showPts').checked) return;
    const t0 = performance.now();
    const proj = P.projectCloud(cloud.xyz, st.calib, st.cam, st.adj[st.cam]);
    drawPoints(ctx, proj, cloud.ground, s, s, ox, oy, Number($('ptSize').value) * dpr * Math.max(1, st.view.zoom / 2),
      Number($('alpha').value) / 100, Number($('maxRange').value), $('hideGround').checked);
    $('hud').textContent = `${camEntry.img} · ${st.cam} · ${proj.u.length.toLocaleString()} ${t('lab.points')} · ${(performance.now() - t0).toFixed(0)} ms · zoom ${st.view.zoom.toFixed(1)}×`;
  }

  function buildThumbs() {
    const box = $('thumbs'); box.innerHTML = '';
    for (const c of st.cams) {
      const d = document.createElement('div');
      d.className = 'thumb' + (c.name === st.cam ? ' active' : '');
      d.innerHTML = `<canvas width="320" height="256"></canvas><span>${st.cams.indexOf(c) + 1} · img${c.idx} · ${esc(c.name.replace(/^CAM_/, ''))}</span>`;
      const q = st.calib.quality && st.calib.quality[c.name];
      if (q && q.status && q.status !== 'ok') d.innerHTML += `<span class="flag" title="${esc(q.status)}">⚠</span>`;
      d.addEventListener('click', () => selectCam(c.name));
      box.appendChild(d); c.el = d;
    }
  }
  function renderThumbs() {
    if (!st.calib || !st.frames.length) return;
    const id = st.frames[st.fi], cloud = st.cloud.get(id);
    for (const c of st.cams) {
      const cv = c.el.querySelector('canvas'), ctx = cv.getContext('2d');
      const bmp = st.images.get(id + '/' + c.idx);
      const [W, H] = st.calib.cameras[c.name].image_size || [1920, 1536];
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
      if (bmp) ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
      if (cloud && $('showPts').checked) {
        const proj = P.projectCloud(cloud.sub, st.calib, c.name, st.adj[c.name]);
        drawPoints(ctx, proj, null, cv.width / W, cv.height / H, 0, 0, 1.5, 0.8, Number($('maxRange').value), false);
      }
      c.el.classList.toggle('active', c.name === st.cam);
    }
  }
  function selectCam(name) { st.cam = name; st.view = { zoom: 1, ox: 0, oy: 0 }; buildSliders(); render(); }

  // ---------- panel ----------
  function buildSliders() {
    const box = $('sliders'); box.innerHTML = '';
    if (!st.cam) return;
    for (const s of SLIDERS) {
      const row = document.createElement('div'); row.className = 'sl';
      row.innerHTML = `<label class="mono">${s.label}</label><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><input type="number" step="${s.step}">`;
      const [, rng, num] = row.children;
      const set = (v) => { st.adj[st.cam][s.key] = v; rng.value = v; num.value = (+v).toFixed(s.step < 0.01 ? 3 : 2); renderMain(); renderThumbs(); };
      rng.addEventListener('input', () => set(Number(rng.value)));
      num.addEventListener('change', () => set(Number(num.value)));
      rng.value = st.adj[st.cam][s.key]; num.value = (+rng.value).toFixed(s.step < 0.01 ? 3 : 2);
      box.appendChild(row);
    }
  }
  function updatePanel() {
    if (!st.calib || !st.cam) return;
    const cam = st.calib.cameras[st.cam], entryCam = st.cams.find((c) => c.name === st.cam);
    delete $('camTitle').dataset.i18n; $('camTitle').textContent = `${entryCam.img} → ${st.cam}`;
    const q = (st.calib.quality || {})[st.cam] || {};
    const lines = [`model ${esc(cam.model || 'pinhole')} · f ${cam.K[0][0].toFixed(1)}`];
    if (q.source) lines.push(esc(q.source));
    if (q.median_reproj_px != null) lines.push(t('lab.reproj', { px: esc(q.median_reproj_px), pct: (q.inliers_lt5px * 100).toFixed(0) }));
    if (q.status && q.status !== 'ok') lines.push('⚠ ' + esc(q.status));
    $('camMeta').innerHTML = lines.join('<br>');
  }
  $('resetCam').addEventListener('click', () => { st.adj[st.cam] = defAdj(); buildSliders(); render(); });
  $('resetAll').addEventListener('click', () => { for (const k in st.adj) st.adj[k] = defAdj(); buildSliders(); render(); });
  for (const id of ['ptSize', 'alpha', 'maxRange', 'hideGround', 'showPts']) $(id).addEventListener('input', render);

  // ---------- zoom / pan ----------
  const vp = $('viewport');
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const k = Math.exp(-e.deltaY * 0.0015), z = Math.min(12, Math.max(1, st.view.zoom * k)), f = z / st.view.zoom;
    st.view.ox = mx - (mx - st.view.ox) * f; st.view.oy = my - (my - st.view.oy) * f; st.view.zoom = z;
    renderMain();
  }, { passive: false });
  let drag = null;
  vp.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: st.view.ox, oy: st.view.oy }; vp.classList.add('drag'); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; st.view.ox = drag.ox + e.clientX - drag.x; st.view.oy = drag.oy + e.clientY - drag.y; renderMain(); });
  window.addEventListener('mouseup', () => { drag = null; vp.classList.remove('drag'); });
  vp.addEventListener('dblclick', () => { st.view = { zoom: 1, ox: 0, oy: 0 }; renderMain(); });
  window.addEventListener('resize', renderMain);

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') return;
    const big = e.shiftKey ? 5 : 1, a = st.cam && st.adj[st.cam];
    const nudge = (k, d) => { a[k] = +(a[k] + d * big).toFixed(3); buildSliders(); renderMain(); renderThumbs(); e.preventDefault(); };
    switch (e.key) {
      case 'ArrowLeft': return a && nudge('pan', -0.05);
      case 'ArrowRight': return a && nudge('pan', 0.05);
      case 'ArrowUp': return a && nudge('tilt', -0.05);
      case 'ArrowDown': return a && nudge('tilt', 0.05);
      case 'q': case 'Q': return a && nudge('roll', -0.05);
      case 'e': case 'E': return a && nudge('roll', 0.05);
      case ',': return step(-1);
      case '.': return step(1);
      case 'h': case 'H': $('showPts').checked = !$('showPts').checked; return render();
      default:
        if (/^[1-8]$/.test(e.key)) { const c = st.cams[Number(e.key) - 1]; if (c) selectCam(c.name); }
    }
  });
})();
