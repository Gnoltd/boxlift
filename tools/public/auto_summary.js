#!/usr/bin/env node
/* Auto-labelling results of eval_auto.js --json, pooled over scenes, at several detector score thresholds:
 *   node tools/public/auto_summary.js work/public/auto-*-yolox_tiny.json */
const path = require('path');
const files = process.argv.slice(2);
const runs = files.map((f) => require(path.resolve(f)));
const gt = runs.flatMap((r) => r.gt), props = runs.flatMap((r) => r.props), det = runs.flatMap((r) => r.times.det);
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const pc = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-').padStart(5);
console.log(`${files.length} scenes, ${gt.length} objects to find, detector ${q(det, 0.5).toFixed(0)} ms / image (p90 ${q(det, 0.9).toFixed(0)})`);
for (const t of [0.2, 0.3, 0.4, 0.5]) {
  const P = props.filter((p) => p.score >= t), real = P.filter((p) => p.match && p.match.pts >= 10).length, wrong = P.filter((p) => !p.match).length;
  console.log(`\nscore >= ${t}: proposals ${P.length}, precision ${pc(real, real + wrong)} (nothing there: ${wrong})`);
  console.log('  class          n  found  class-ok  centre p50  yaw p50  3D-IoU p50  IoU>=0.5  IoU>=0.7  (of all n)');
  for (const c of ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']) {
    const r = gt.filter((x) => x.label === c); if (!r.length) continue;
    const f = r.filter((x) => x.found && x.score >= t);
    console.log(`  ${c.padEnd(11)}${String(r.length).padStart(5)}  ${pc(f.length, r.length)}   ${pc(f.filter((x) => x.cls === c).length, f.length)}` +
      `     ${q(f.map((x) => x.dc), 0.5).toFixed(2).padStart(5)}   ${q(f.map((x) => x.dyaw), 0.5).toFixed(1).padStart(5)}      ${q(f.map((x) => x.iou), 0.5).toFixed(2).padStart(5)}` +
      `    ${pc(f.filter((x) => x.iou >= 0.5).length, r.length)}    ${pc(f.filter((x) => x.iou >= 0.7).length, r.length)}`);
  }
  const cars = gt.filter((x) => x.label === 'car');
  for (const [a, b] of [[0, 20], [20, 40], [40, 1e9]]) {
    const r = cars.filter((x) => x.range >= a && x.range < b), f = r.filter((x) => x.found && x.score >= t);
    console.log(`    car ${a}-${b < 1e9 ? b : '…'} m: n ${r.length}, found ${pc(f.length, r.length)}, IoU>=0.5 ${pc(f.filter((x) => x.iou >= 0.5).length, r.length)}`);
  }
}
