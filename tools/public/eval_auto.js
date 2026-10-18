#!/usr/bin/env node
/*
 * Auto-labelling — a 2D detector (YOLOX, extension/detect.js) draws the boxes, the box tool
 * (boxfit.js fitFromRect) builds the 3D boxes, against the nuScenes ground truth. No human in the loop.
 *   node tools/public/eval_auto.js <scene dir> --model <yolox_tiny|yolox_s.onnx> [--score 0.3] [--json out.json]
 *
 * Per frame and camera: detections (score >= --score) -> 3D box each; boxes of one object (BF.sameObject: footprints
 * overlap or centres < 1 m, e.g. seen by two cameras) are merged, best score kept.
 * Ground truth: annotated objects of the box tool's classes with >= 10 LiDAR points whose centre is seen by a
 * camera. Matching: greedy by score, a 3D box finds the nearest unmatched ground-truth object within 2 m
 * (bird's-eye centre distance), any class. Proposals near objects with < 10 points are ignored (not wrong).
 * Reported: recall per class (found / all), class right, quality of the found ones (centre, yaw, 3D IoU),
 * precision (proposals that are a real object), time per image.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const PCD = require('../../extension/function/pcd.js');
const BF = require('../../extension/function/boxfit.js');
const P = require('../../extension/function/projection.js');
const DT = require('../../extension/function/detect.js');

const args = process.argv.slice(2), dir = args.find((x) => !x.startsWith('--') && !/^[\d.]+$/.test(x) && !x.endsWith('.onnx') && !x.endsWith('.json'));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('--model'), SCORE = +opt('--score', 0.3), ORT = opt('--ort', path.join(process.env.HOME, 'public-data/npm/package/dist'));
const calib = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'calib-gt.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'frames.json'), 'utf8'));
const boxes = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'boxes.json'), 'utf8'));
const LABEL = [[/vehicle\.car/, 'car'], [/vehicle\.truck|vehicle\.construction/, 'truck'], [/vehicle\.bus/, 'bus'],
  [/vehicle\.motorcycle/, 'motorcycle'], [/vehicle\.bicycle/, 'bicycle'], [/human\.pedestrian/, 'pedestrian']];
const labelOf = (c) => (LABEL.find(([re]) => re.test(c)) || [])[1];
const imgs = Object.keys(meta.camera_map).sort((a, b) => a.split('_')[1] - b.split('_')[1]);

function poly(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) => [b.x + (i * b.l / 2) * c - (j * b.w / 2) * s, b.y + (i * b.l / 2) * s + (j * b.w / 2) * c]);
}
const area = (p) => Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
function clip(sub, cl) {
  let out = sub;
  for (let i = 0; i < cl.length && out.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length], inp = out; out = [];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
  }
  return out;
}
function iou3d(a, b) {
  const inter = area(clip(poly(a), poly(b)));
  const zo = Math.max(0, Math.min(a.z + a.h / 2, b.z + b.h / 2) - Math.max(a.z - a.h / 2, b.z - b.h / 2));
  return inter * zo / (a.l * a.w * a.h + b.l * b.w * b.h - inter * zo);
}
/** Is the box centre seen by some camera (in front, inside the image)? */
function seen(b) {
  for (const img of imgs) {
    const r = P.projectCloud(new Float32Array([b.x, b.y, b.z]), calib, meta.camera_map[img], null);
    if (r.u.length) return true;
  }
  return false;
}

async function main() {
  const ort = require(path.join(ORT, 'ort.wasm.min.js'));
  ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = ORT + '/';
  const session = await ort.InferenceSession.create(fs.readFileSync(MODEL));
  const SIZE = session.inputMetadata[0].shape[2];
  const py = spawn(path.join(__dirname, '../../.venv/bin/python'), [path.join(__dirname, 'letterbox_stream.py'), dir, String(SIZE)]);
  py.stderr.pipe(process.stderr);
  let buf = Buffer.alloc(0), ended = false; const waiters = [];
  py.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); waiters.splice(0).forEach((w) => w()); });
  py.stdout.on('end', () => { ended = true; waiters.splice(0).forEach((w) => w()); });
  const read = async (n) => { while (buf.length < n) { if (ended) throw new Error('stream ended'); await new Promise((r) => waiters.push(r)); } const out = buf.subarray(0, n); buf = buf.subarray(n); return Buffer.from(out); };

  const gtRows = [], props = [], times = { det: [], fit: [] };
  for (const fr of meta.frames) {
    const pbuf = fs.readFileSync(path.join(dir, 'pointcloud', fr.fid + '.pcd'));
    const xyz = PCD.parsePCD(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.length));
    const ground = BF.groundMask(xyz);
    const here = [];
    for (const img of imgs) {
      const hdr = await read(8), w = hdr.readUInt32LE(0), h = hdr.readUInt32LE(4), bgr = await read(SIZE * SIZE * 3);
      const r = Math.min(SIZE / w, SIZE / h);
      let t = performance.now();
      const o = await session.run({ images: new ort.Tensor('float32', DT.tensorFromBGR(bgr, SIZE), [1, 3, SIZE, SIZE]) });
      const dets = DT.decode(o.output.data, SIZE, r, { scoreThr: SCORE });
      times.det.push(performance.now() - t);
      const cam = meta.camera_map[img];
      for (const d of dets) {
        t = performance.now();
        const res = BF.fitFromRect(xyz, calib, cam, null, d, { label: d.label, ground });
        times.fit.push(performance.now() - t);
        if (!res.box) continue;
        const near = here.find((p) => BF.sameObject(p.box, res.box));
        if (near) { if (near.score < d.score) Object.assign(near, { box: res.box, score: d.score, label: d.label, cam }); continue; }
        here.push({ fid: fr.fid, box: res.box, score: d.score, label: d.label, cam });
      }
    }
    const gts = (boxes[fr.fid] || []).filter((b) => labelOf(b.category));
    const used = new Set();
    here.sort((a, b) => b.score - a.score);
    for (const p of here) {
      let best = -1, bd = 2.0;
      gts.forEach((g, k) => { if (used.has(k)) return; const d = Math.hypot(g.x - p.box.x, g.y - p.box.y); if (d < bd) { bd = d; best = k; } });
      if (best >= 0) { used.add(best); p.gt = best; const g = gts[best];
        p.match = { label: labelOf(g.category), pts: g.num_lidar_pts, dc: bd, dyaw: Math.abs(((p.box.yaw - g.yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - Math.PI / 2) * 180 / Math.PI, iou: iou3d(p.box, g) }; }
      props.push(p);
    }
    gts.forEach((g, k) => {
      if (g.num_lidar_pts < 10 || !seen(g)) return;
      const p = here.find((x) => x.gt === k);
      gtRows.push({ fid: fr.fid, label: labelOf(g.category), range: Math.hypot(g.x, g.y), vis: g.visibility, found: !!p, cls: p ? p.label : null, score: p ? p.score : null, ...(p ? p.match : {}) });
    });
  }
  py.kill();
  report(gtRows, props, times);
  if (args.includes('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ gt: gtRows, props: props.map(({ box, ...p }) => ({ ...p, box })), times }));
}

const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const pc = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-').padStart(5);
function report(gt, props, times) {
  console.log(`${meta.scene}: ${meta.frames.length} frames x ${imgs.length} cameras, model ${path.basename(MODEL)}, score >= ${SCORE}`);
  console.log('class        n  found  class-ok  centre p50  yaw p50  3D-IoU p50  IoU>=0.5  IoU>=0.7   (of all n)');
  for (const c of ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']) {
    const r = gt.filter((x) => x.label === c); if (!r.length) continue;
    const f = r.filter((x) => x.found);
    console.log(`${c.padEnd(11)}${String(r.length).padStart(4)}  ${pc(f.length, r.length)}   ${pc(f.filter((x) => x.cls === c).length, f.length)}` +
      `     ${q(f.map((x) => x.dc), 0.5).toFixed(2).padStart(5)}   ${q(f.map((x) => x.dyaw), 0.5).toFixed(1).padStart(5)}      ${q(f.map((x) => x.iou), 0.5).toFixed(2).padStart(5)}` +
      `    ${pc(f.filter((x) => x.iou >= 0.5).length, r.length)}     ${pc(f.filter((x) => x.iou >= 0.7).length, r.length)}`);
  }
  const ign = props.filter((p) => p.match && p.match.pts < 10).length, real = props.filter((p) => p.match && p.match.pts >= 10).length;
  const wrong = props.filter((p) => !p.match).length;
  console.log(`proposals ${props.length}: real object ${real} · object with < 10 points (ignored) ${ign} · nothing there ${wrong} → precision ${pc(real, real + wrong)}`);
  console.log(`time per image: detector ${q(times.det, 0.5).toFixed(0)} ms (p90 ${q(times.det, 0.9).toFixed(0)}), 3D fit ${q(times.fit, 0.5).toFixed(0)} ms per box`);
}

main().catch((e) => { console.error(e); process.exit(1); });
