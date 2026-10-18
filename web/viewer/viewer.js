// 3D point-cloud screen of the web demo (ES module, three.js vendored under /vendor/three/, mapped by the import map in
// index.html). Draws the CURRENT frame's LiDAR points (extension PCD.parsePCD) coloured by height, a ground grid, an ego
// marker and every saved cuboid as a wireframe coloured by label (shapes + interpolated tracks, ViewerScene.frameBoxes).
// Renders on demand only: orbit/zoom/pan, resize, a frame change or a saved annotation; nothing runs while idle.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/OrbitControls.js';

const FALLBACK = {
  vi: 'Trình duyệt không bật được WebGL nên không hiện được màn hình 3D. Phần còn lại của demo vẫn dùng được: bấm "Mở BoxLift" ở góc dưới phải.',
  en: 'WebGL is not available in this browser, so the 3D screen cannot be shown. The rest of the demo still works: press "Open BoxLift" at the bottom right.'
};
const lang = (win) => { try { return JSON.parse(win.localStorage.getItem('ext:viewOpts')).lang === 'en' ? 'en' : 'vi'; } catch (e) { return 'vi'; } };

export function showFallback(win, container) {
  const d = win.document.createElement('div');
  d.className = 'viewer-fallback'; d.textContent = FALLBACK[lang(win)];
  container.replaceChildren(d);
  return null;
}

/** mount(win, {container, manifest, annKey}) -> {render, setFrame, refreshBoxes, frame()} or null (fallback shown). */
export function mount(win, { container, manifest, annKey }) {
  const doc = win.document, V = win.ViewerScene, PCD = win.PCD, BF = win.BoxFit, TR = win.Tracks;
  if (!V || !V.hasWebGL(doc)) return showFallback(win, container);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { return showFallback(win, container); }
  renderer.setPixelRatio(Math.min(2, win.devicePixelRatio || 1));
  renderer.setClearColor(0x101317, 1);
  renderer.domElement.className = 'viewer-canvas';
  container.replaceChildren(renderer.domElement);
  const hud = doc.createElement('div'); hud.className = 'viewer-hud'; container.appendChild(hud);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(V.CAMERA.fov, 1, 0.1, 2000);
  camera.up.set(...V.CAMERA.up); camera.position.set(...V.CAMERA.position);
  const controls = new OrbitControls(camera, renderer.domElement);   // left drag rotate, wheel zoom, right drag pan
  controls.target.set(...V.CAMERA.target); controls.maxDistance = 400; controls.update();

  const grid = new THREE.GridHelper(160, 32, 0x3a4350, 0x232a33);
  grid.rotation.x = Math.PI / 2;   // GridHelper lies in XZ; the cloud is z up
  scene.add(grid);
  const lineMat = (color) => new THREE.LineBasicMaterial({ color });
  const ego = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(V.boxSegments(V.EGO, BF.corners), 3)), lineMat(0xe9edf2));
  const nose = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(3.7, 0, V.EGO.z), 2.5, 0xe9edf2, 0.8, 0.5);
  scene.add(ego, nose);

  const ptsMat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });
  const boxMat = new THREE.LineBasicMaterial({ vertexColors: true });
  let points = null, boxes = null, frame = -1, token = 0, nPts = 0, nBoxes = 0;
  const cloudCache = new Map();   // fid -> {xyz, color, lo}; 10 frames of ~85k points: a few MB

  let queued = false;
  const render = () => { if (queued) return; queued = true; win.requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); }); };
  controls.addEventListener('change', render);
  const resize = () => {
    const w = container.clientWidth || win.innerWidth, h = container.clientHeight || win.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); render();
  };
  if (win.ResizeObserver) new win.ResizeObserver(resize).observe(container); else win.addEventListener('resize', resize);
  resize();

  const labelName = new Map(manifest.labels.map((l) => [l.id, l.name]));
  const hudText = () => {
    const en = lang(win) === 'en';
    hud.textContent = `LiDAR · frame ${frame + 1}/${manifest.frames.length} · ${nPts.toLocaleString()} ${en ? 'points' : 'điểm'} · ${nBoxes} box` +
      `  —  ${en ? 'drag: rotate · wheel: zoom · right drag: pan' : 'kéo: xoay · cuộn: phóng to · chuột phải: kéo ngang'}`;
  };

  function refreshBoxes() {
    let raw = null; try { raw = win.localStorage.getItem(annKey); } catch (e) { /* blocked */ }
    const list = frame < 0 ? [] : V.frameBoxes(V.parseAnnotations(raw), frame, { at: TR.at, fromCvat: BF.fromCvatPoints });
    if (boxes) { scene.remove(boxes); boxes.geometry.dispose(); boxes = null; }
    nBoxes = list.length;
    if (list.length) {
      const pos = new Float32Array(list.length * 72), col = new Float32Array(list.length * 72), c = new THREE.Color();
      list.forEach((b, i) => {
        pos.set(V.boxSegments(b.box, BF.corners), 72 * i);
        c.setHex(V.labelColor(labelName.get(b.labelId)));
        for (let k = 0; k < 24; k++) col.set([c.r, c.g, c.b], 72 * i + 3 * k);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      boxes = new THREE.LineSegments(g, boxMat); scene.add(boxes);
    }
    hudText(); render();
  }

  async function cloud(f) {
    const fr = manifest.frames[f];
    if (cloudCache.has(fr.fid)) return cloudCache.get(fr.fid);
    const r = await win.fetch('/' + String(fr.pcd).replace(/^\//, ''));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xyz = PCD.parsePCD(await r.arrayBuffer()), [lo, hi] = V.heightRange(xyz);
    const c = { xyz, color: V.colorize(xyz, lo, hi), lo };
    cloudCache.set(fr.fid, c);
    return c;
  }
  async function setFrame(f) {
    f = V.frameIndex(f, manifest.frames.length - 1);
    if (f === frame) return;
    frame = f; const my = ++token;
    refreshBoxes();
    let c;
    try { c = await cloud(f); } catch (e) { win.console.warn('BoxLift demo 3D: frame', f, e.message); return; }
    if (my !== token) return;   // a newer frame was asked for meanwhile
    if (points) { scene.remove(points); points.geometry.dispose(); }   // one BufferGeometry per frame, the old one freed
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.xyz, 3)); g.setAttribute('color', new THREE.BufferAttribute(c.color, 3));
    points = new THREE.Points(g, ptsMat); scene.add(points);
    grid.position.z = c.lo; nPts = c.xyz.length / 3;
    hudText(); render();
  }

  // Frame source = the host page's frame input (?frame=, next/prev, D/F all go through it). A 'change' event covers those;
  // a slow poll catches a programmatic value change without an event.
  const input = doc.querySelector('.cvat-player-frame-selector input');
  const sync = () => setFrame(input ? input.value : 0);
  if (input) input.addEventListener('change', sync);
  let lastLang = lang(win);
  win.setInterval(() => { sync(); const l = lang(win); if (l !== lastLang) { lastLang = l; hudText(); } }, 500);
  win.addEventListener('demo:annotation', refreshBoxes);
  sync();
  return { render, setFrame, refreshBoxes, frame: () => frame, boxes: () => nBoxes };
}
