#!/usr/bin/env node
/*
 * T5 — 2D box on the image -> 3D box (extension/boxfit.js fitFromRect), against nuScenes ground-truth boxes.
 *   node tools/public/eval_boxes.js <converted keyframe scene dir> [--time] [--jitter 3] [--min-pts 10]
 *
 * For every annotated object of the classes below with >= min-pts LiDAR points, in the camera where it is
 * seen whole: the "drawn" 2D box = the image extent of its true 3D box, projected with the exact nuScenes
 * chain (vehicle pose at the camera time), each edge moved by up to ±jitter px (a person drawing it).
 * The tool then builds the 3D box from that rectangle, the sweep and the ground-truth calibration, as in
 * the extension (groundMask of the whole sweep, class label). --time: the tool also applies each camera's
 * time offset with the vehicle motion (what the extension would do if it knew the motion).
 * Reported per class and range: success rate, centre error (bird's-eye, m), yaw error (deg, a box has
 * no front/back so mod 180), size errors, bird's-eye IoU and 3D IoU.
 * --calib other.json: the tool works with that calibration instead of the truth (calibration sensitivity).
 */
const fs = require('fs');
const path = require('path');
const P = require('../../extension/function/projection.js');
const PCD = require('../../extension/function/pcd.js');
const BF = require('../../extension/function/boxfit.js');

const args = process.argv.slice(2), dir = args.find((x) => !x.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const TIME = args.includes('--time'), JIT = opt('--jitter', 3), MINPTS = opt('--min-pts', 10);
// --dense k: every point k times, +-2 cm apart (a dense LiDAR, for timing); --max-frames n: first n annotated frames
const DENSE = opt('--dense', 1), MAXF = opt('--max-frames', Infinity);
// --oracle cluster|points: the tool is given the true object's points (what a perfect cluster choice / a perfect
// segmentation would give), to see how much each step could still gain
// --learned <dir>: the box comes from the frustum models (dir: frustum_seg.onnx, frustum_box.onnx; extension/frustum.js),
// the geometric box is kept in row.geo; --ort <dir>: onnxruntime-web dist
const LEARNED = args.includes('--learned') ? args[args.indexOf('--learned') + 1] : null;
const FR = require('../../extension/function/frustum.js'), jobs = [];
// --mtrans <file.onnx>: car boxes from MTrans (extension/mtrans.js + the model; image crop + points), as the extension
const MTR = args.includes('--mtrans') ? args[args.indexOf('--mtrans') + 1] : null;
const MT = require('../../extension/function/mtrans.js'), mjobs = [];
const ORACLE = args.includes('--oracle') ? args[args.indexOf('--oracle') + 1] : null;
function pointsIn(xyz, b, m = 0.1) {
  const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw), out = new Set();
  for (let i = 0; i < xyz.length / 3; i++) {
    const dx = xyz[3 * i] - b.x, dy = xyz[3 * i + 1] - b.y, dz = xyz[3 * i + 2] - b.z;
    if (Math.abs(dx * c - dy * s) < b.l / 2 + m && Math.abs(dx * s + dy * c) < b.w / 2 + m && Math.abs(dz) < b.h / 2 + m) out.add(i);
  }
  return out;
}
const gtCalib = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'calib-gt.json'), 'utf8'));
// --calib other.json: the tool uses this calibration (the drawn boxes still come from the truth)
const calib = args.includes('--calib') ? JSON.parse(fs.readFileSync(args[args.indexOf('--calib') + 1], 'utf8')) : gtCalib;
const toolCam = (gname) => (calib === gtCalib ? gname : calib.camera_map[Object.keys(gtCalib.camera_map).find((k) => gtCalib.camera_map[k] === gname)]);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'frames.json'), 'utf8'));
const boxes = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'boxes.json'), 'utf8'));
const LABEL = [[/vehicle\.car/, 'car'], [/vehicle\.truck|vehicle\.construction/, 'truck'], [/vehicle\.bus/, 'bus'],
  [/vehicle\.motorcycle/, 'motorcycle'], [/vehicle\.bicycle/, 'bicycle'], [/human\.pedestrian/, 'pedestrian']];
const labelOf = (c) => (LABEL.find(([re]) => re.test(c)) || [])[1];

let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const mul = P.matMul, inv = P.inv4;
const F = meta.frames;
if (TIME) calib.sweep_period_s = (F[F.length - 1].lidar_t - F[0].lidar_t) * 1e-6 / (F.length - 1);

/** Bird's-eye polygon of a box (counter-clockwise). */
function poly(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) => [b.x + (i * b.l / 2) * c - (j * b.w / 2) * s, b.y + (i * b.l / 2) * s + (j * b.w / 2) * c]);
}
const area = (p) => Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
/** Convex polygon intersection (Sutherland-Hodgman). */
function clip(subject, clipper) {
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const a = clipper[i], b = clipper[(i + 1) % clipper.length], inp = out; out = [];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
  }
  return out;
}
function ious(a, b) {
  const pa = poly(a), pb = poly(b), inter = area(clip(pa, pb));
  const bev = inter / (a.l * a.w + b.l * b.w - inter);
  const zo = Math.max(0, Math.min(a.z + a.h / 2, b.z + b.h / 2) - Math.max(a.z - a.h / 2, b.z - b.h / 2));
  const i3 = inter * zo;
  return { bev, iou3d: i3 / (a.l * a.w * a.h + b.l * b.w * b.h - i3) };
}
/** Image extent of a box seen by a camera through matrix M (pcd -> camera), or null if not whole in view. */
function extent(b, K, W, H, M) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
    const x = b.x + (i * b.l / 2) * c - (j * b.w / 2) * s, y = b.y + (i * b.l / 2) * s + (j * b.w / 2) * c, z = b.z + k * b.h / 2;
    const X = M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3], Y = M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3],
      Z = M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3];
    if (Z < 0.5) return null;
    const u = K[0][0] * X / Z + K[0][2], v = K[1][1] * Y / Z + K[1][2];
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return u0 >= 0 && v0 >= 0 && u1 < W && v1 < H && u1 - u0 > 8 && v1 - v0 > 8 ? { u0, u1, v0, v1 } : null;
}

const rows = [];
F.forEach((fr, k) => {
  const gtb = boxes[fr.fid];
  if (!gtb) return;
  const buf = fs.readFileSync(path.join(dir, 'pointcloud', fr.fid + '.pcd'));
  if (rows.nFrames === MAXF) return;
  rows.nFrames = (rows.nFrames || 0) + 1;
  let xyz = PCD.parsePCD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  if (DENSE > 1) {
    const d = new Float32Array(xyz.length * DENSE);
    for (let i = 0; i < xyz.length; i += 3) for (let r = 0; r < DENSE; r++) for (let c = 0; c < 3; c++) d[(i * DENSE) + 3 * r + c] = xyz[i + c] + (r ? (rnd() - 0.5) * 0.04 : 0);
    xyz = d;
  }
  const ground = BF.groundMask(xyz);
  const motion = TIME ? { fwd: F[k + 1] && mul(inv(F[k + 1].lidar_ego), fr.lidar_ego), bwd: F[k - 1] && mul(inv(fr.lidar_ego), F[k - 1].lidar_ego) } : null;
  for (const b of gtb) {
    const label = labelOf(b.category);
    if (!label || b.num_lidar_pts < MINPTS) continue;
    let cam = null, rect = null, best = -1;
    for (const [img, name] of Object.entries(gtCalib.camera_map)) {       // camera seeing it whole, largest
      const g = gtCalib.cameras[name], cm = fr.cams[name];
      const M = mul(g.ego2cam, mul(inv(cm.ego), mul(fr.lidar_ego, gtCalib.lidar.sensor2ego)));
      const r = extent(b, g.K, ...g.image_size, M);
      if (r && (r.u1 - r.u0) * (r.v1 - r.v0) > best) { best = (r.u1 - r.u0) * (r.v1 - r.v0); cam = name; rect = r; }
    }
    if (!cam) continue;
    const j = () => (2 * rnd() - 1) * JIT;
    const drawn = { u0: rect.u0 + j(), u1: rect.u1 + j(), v0: rect.v0 + j(), v1: rect.v1 + j() };
    const t0 = performance.now();
    const res = BF.fitFromRect(xyz, calib, toolCam(cam), null, drawn, { label, ground, motion, oracle: ORACLE && { mode: ORACLE, points: pointsIn(xyz, b) }, minPts: process.env.MINPTS ? +process.env.MINPTS : undefined, eps: process.env.EPS ? +process.env.EPS : undefined });
    const ms = performance.now() - t0;
    const range = Math.hypot(b.x, b.y);
    const row = { fid: fr.fid, gt: b, drawn, label, cam, range, vis: b.visibility, pts: b.num_lidar_pts, ok: !!res.box, reason: res.reason, ms };
    if (res.box) {
      const o = res.box, dyaw = Math.abs(((o.yaw - b.yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - Math.PI / 2);
      Object.assign(row, { out: o, dc: Math.hypot(o.x - b.x, o.y - b.y), dz: o.z - b.z, dyaw: dyaw * 180 / Math.PI,
        dyaw360: Math.abs(((o.yaw - b.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI,   // front / back too
        dl: o.l - b.l, dw: o.w - b.w, dh: o.h - b.h, ...ious(o, b) });
    }
    rows.push(row);
    const cls = FR.classOf(label);
    if (LEARNED && res.frustum && res.frustum.length >= 8 && cls != null) jobs.push({ row, xyz, idx: res.frustum, cls });
    if (MTR && res.box && MT.useFor(label)) mjobs.push({ row, xyz, fid: fr.fid, cam });
  }
});

/** Frustum models on every collected box (batches), as the extension's detector page does. */
async function runLearned() {
  const ORT = args.includes('--ort') ? args[args.indexOf('--ort') + 1] : path.join(process.env.HOME, 'public-data/npm/package/dist');
  const ort = require(path.join(ORT, 'ort.wasm.min.js'));
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = ORT + '/';
  const seg = await ort.InferenceSession.create(fs.readFileSync(path.join(LEARNED, 'frustum_seg.onnx')));
  const boxM = await ort.InferenceSession.create(fs.readFileSync(path.join(LEARNED, 'frustum_box.onnx')));
  for (let b0 = 0; b0 < jobs.length; b0 += 64) {
    const js = jobs.slice(b0, b0 + 64), n = js.length, t0 = performance.now();
    const prep = js.map((j) => FR.prepare(j.xyz, j.idx, j.cls));
    const P1 = new Float32Array(n * FR.N1 * 3), OH = new Float32Array(n * 6);
    prep.forEach((p, k) => { P1.set(p.pts, k * FR.N1 * 3); OH.set(p.onehot, k * 6); });
    const lg = (await seg.run({ points: new ort.Tensor('float32', P1, [n, FR.N1, 3]), onehot: new ort.Tensor('float32', OH, [n, 6]) })).logits.data;
    const obj = prep.map((p, k) => FR.objectPoints(p.pts, lg, k * FR.N1 * 2));
    const P2 = new Float32Array(n * FR.N2 * 3);
    obj.forEach((o, k) => P2.set(o.pts, k * FR.N2 * 3));
    const out = (await boxM.run({ points: new ort.Tensor('float32', P2, [n, FR.N2, 3]), onehot: new ort.Tensor('float32', OH, [n, 6]) })).out.data;
    const ms = (performance.now() - t0) / n;
    js.forEach((j, k) => {
      const o = FR.decode(out, k * 30, j.cls, obj[k].cen, prep[k].phi), b = j.row.gt, row = j.row;
      const dyaw = Math.abs(((o.yaw - b.yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - Math.PI / 2);
      row.geo = { out: row.out, iou3d: row.iou3d, dc: row.dc, dyaw: row.dyaw, ok: row.ok };
      Object.assign(row, { ok: true, out: o, msLearned: ms, endOdds: FR.endOdds(out, k * 30), segPts: obj[k].n, dc: Math.hypot(o.x - b.x, o.y - b.y), dz: o.z - b.z, dyaw: dyaw * 180 / Math.PI,
        dyaw360: Math.abs(((o.yaw - b.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI,
        dl: o.l - b.l, dw: o.w - b.w, dh: o.h - b.h, ...ious(o, b) });
    });
  }
}

/** Camera image as RGBA (decoded by Python / Pillow: node has no image decoder). */
function imageOf(fid, cam) {
  const key = Object.keys(gtCalib.camera_map).find((k) => gtCalib.camera_map[k] === cam);
  const file = path.join(dir, 'related_images', fid + '_pcd', key + '.jpg');
  const py = path.join(__dirname, '..', '..', '.venv', 'bin', 'python');
  const r = require('child_process').spawnSync(py, ['-c', 'import sys;from PIL import Image;i=Image.open(sys.argv[1]).convert("RGBA");'
    + 'sys.stdout.write(f"{i.width} {i.height}\\n");sys.stdout.flush();sys.stdout.buffer.write(i.tobytes())', file], { maxBuffer: 1 << 26 });
  const nl = r.stdout.indexOf(10), [width, height] = r.stdout.subarray(0, nl).toString().split(' ').map(Number);
  return { width, height, data: r.stdout.subarray(nl + 1) };
}

/** MTrans on every car (one image decode per sweep and camera; the other cars of that image are its overlap boxes). */
async function runMTrans() {
  const ORT = args.includes('--ort') ? args[args.indexOf('--ort') + 1] : path.join(process.env.HOME, 'public-data/npm/package/dist');
  const ort = require(path.join(ORT, 'ort.wasm.min.js'));
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = ORT + '/';
  const sess = await ort.InferenceSession.create(fs.readFileSync(MTR));
  const groups = new Map();
  for (const j of mjobs) { const k = j.fid + '|' + j.cam; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
  let done = 0;
  for (const js of groups.values()) {
    const cam = toolCam(js[0].cam), img = imageOf(js[0].fid, js[0].cam), proj = P.projectCloud(js[0].xyz, calib, cam, null);
    const th = MT.axisYaw(calib, cam, null), B = MT.newBatch(js.length), t0 = performance.now();
    js.forEach((j, k) => MT.prepare(j.xyz, proj, img, j.row.drawn, js.filter((o) => o !== j).map((o) => o.row.drawn), th, B, k));
    const sh = (...d) => [js.length, ...d];
    const out = await sess.run({ image: new ort.Tensor('float32', B.image, sh(3, MT.SIZE, MT.SIZE)), overlap: new ort.Tensor('float32', B.overlap, sh(1, MT.SIZE, MT.SIZE)),
      cloud: new ort.Tensor('float32', B.cloud, sh(MT.NPTS, 3)), cloud2d: new ort.Tensor('float32', B.cloud2d, sh(MT.NPTS, 2)), real: new ort.Tensor('float32', B.real, sh(MT.NPTS)) });
    const ms = (performance.now() - t0) / js.length;
    js.forEach((j, k) => {
      const { box: o, odds } = MT.decode(out.box.data, out.dir.data, k, th), b = j.row.gt, row = j.row;
      const dyaw = Math.abs(((o.yaw - b.yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - Math.PI / 2);
      row.prev = { out: row.out, iou3d: row.iou3d, dc: row.dc, dyaw: row.dyaw, endOdds: row.endOdds };
      Object.assign(row, { ok: true, how: 'mtrans', out: o, msMTrans: ms, endOdds: odds, dc: Math.hypot(o.x - b.x, o.y - b.y), dz: o.z - b.z, dyaw: dyaw * 180 / Math.PI,
        dyaw360: Math.abs(((o.yaw - b.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI,
        dl: o.l - b.l, dw: o.w - b.w, dh: o.h - b.h, ...ious(o, b) });
    });
    done += js.length;
    if (process.stderr.isTTY) process.stderr.write(`\rMTrans ${done}/${mjobs.length}`);
  }
}

(async () => {
if (LEARNED) await runLearned();
if (MTR) await runMTrans();

const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-').padStart(6);
function report(name, rs) {
  const ok = rs.filter((r) => r.ok), m = (k, f = 0.5) => q(ok.map((r) => Math.abs(r[k])), f);
  console.log(`${name.padEnd(22)} ${String(rs.length).padStart(4)} ${f2(100 * ok.length / rs.length, 0)}%  ${f2(m('dc'))} ${f2(m('dc', 0.9))}  ` +
    `${f2(m('dyaw'), 1)} ${f2(m('dyaw', 0.9), 1)}  ${f2(m('dl'))} ${f2(m('dw'))} ${f2(m('dh'))}  ${f2(q(ok.map((r) => r.bev), 0.5))} ${f2(q(ok.map((r) => r.iou3d), 0.5))}` +
    `  ${f2(100 * ok.filter((r) => r.dc <= 0.3 && r.dyaw <= 5).length / rs.length, 0)}%`);
}
console.log(`${meta.scene}: ${rows.length} objects (>= ${MINPTS} LiDAR points, whole in one camera), drawn-box jitter ±${JIT} px` +
  `${TIME ? ', time offset applied' : ', no time offset (as the extension now)'}`);
console.log('                          n   made  centre m p50  p90   yaw° p50   p90   |dl|  |dw|  |dh| m   BEV-IoU 3D-IoU  ≤0.3m&≤5°');
for (const c of ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']) {
  const rs = rows.filter((r) => r.label === c);
  if (rs.length) report(c, rs);
}
for (const c of ['car', 'truck']) for (const [a, b] of [[0, 20], [20, 40], [40, 1e9]]) {
  const rs = rows.filter((r) => r.label === c && r.range >= a && r.range < b);
  if (rs.length) report(`  ${c} ${a}-${b < 1e9 ? b : '…'} m`, rs);
}
for (const v of ['v0-40', 'v40-60', 'v60-80', 'v80-100']) {
  const rs = rows.filter((r) => r.label === 'car' && r.vis === v);
  if (rs.length) report(`  car visible ${v.slice(1)}%`, rs);
}
const fails = {};
rows.filter((r) => !r.ok).forEach((r) => { fails[r.reason] = (fails[r.reason] || 0) + 1; });
if (Object.keys(fails).length) console.log('not made:', fails);
if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(rows));
})();
