#!/usr/bin/env node
/*
 * Error of the bundled calibration on the pairs exported by the extension ("Xuất cặp điểm"), per camera
 * and per job; with --solve, one guarded fit per camera from the pairs of every file and job together.
 *
 *   node tools/pairs_report.js pairs-*.json                      # table only, changes nothing
 *   node tools/pairs_report.js --solve calib-new.json pairs-*.json
 *
 * --calib (required: e.g. extension/calibs/nuscenes-scene-0061.json) must be the calibration the pairs were measured with
 * (checked against calib_hash in each file). A camera is changed only when its fit passes every check
 * (pairs.js: leave-one-out improves, camera moves < 15 cm, f changes < 2 %, no pair > 80 px off).
 */
const fs = require('fs');
const path = require('path');
const P = require('../extension/function/projection.js');
const PS = require('../extension/function/pairs.js');

function hashOf(obj) {                     // same as cvat.js
  const t = JSON.stringify(obj, (k, v) => (k === '_fold' ? undefined : v));
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

function main(argv) {
  let calibPath = null, solveOut = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--calib') calibPath = argv[++i];
    else if (argv[i] === '--solve') solveOut = argv[++i];
    else files.push(argv[i]);
  }
  if (!files.length || !calibPath) { console.error('usage: node tools/pairs_report.js --calib calib.json [--solve out.json] pairs-*.json'); return 2; }
  const calib = JSON.parse(fs.readFileSync(calibPath, 'utf8')), hash = hashOf(calib);

  const byCam = {}, seen = new Set();
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (d.kind !== 'lidar-cam-pairs') { console.error(`${f}: not a pairs export`); return 2; }
    if (d.calib_hash !== hash) console.warn(`! ${f}: measured with another calib.json (${d.calib_hash} != ${hash}); errors below are for ${calibPath}`);
    for (const [cam, c] of Object.entries(d.cameras)) {
      if (!calib.cameras[cam]) { console.warn(`! ${f}: camera ${cam} not in ${calibPath}`); continue; }
      for (const p of c.pairs) {
        const key = [cam, p.job, p.frame, ...p.xyz, ...p.uv].join();
        if (!seen.has(key)) { seen.add(key); (byCam[cam] ??= []).push(p); }
      }
    }
  }

  const camOrder = Object.entries(calib.camera_map || {}).sort().map(([img, name]) => [name, img]);
  const f1 = (x) => x.toFixed(1).padStart(6);
  console.log(`calib ${calibPath} (${hash})\n`);
  console.log('camera              pairs jobs cells  median    p90    max   worst job (median px)');
  const adjs = {};
  for (const [cam, img] of camOrder) {
    const list = byCam[cam];
    if (!list) continue;
    const m = PS.measure(calib, cam, null, list);
    const jobs = {};
    list.forEach((p, i) => (jobs[p.job] ??= []).push(m.errors[i]));
    const jm = Object.entries(jobs).map(([j, e]) => [j, e.sort((a, b) => a - b)[e.length >> 1]]).sort((a, b) => b[1] - a[1]);
    console.log(`${`${img} ${cam}`.padEnd(19)} ${String(list.length).padStart(5)} ${String(jm.length).padStart(4)}  ${m.cells}/9 ${f1(m.median)} ${f1(m.p90)} ${f1(m.max)}   ${jm[0][0]} (${jm[0][1].toFixed(1)})`);
  }
  if (!solveOut) return 0;

  console.log('\nsolve per camera (pairs of all jobs together):');
  for (const [cam, img] of camOrder) {
    const list = byCam[cam];
    if (!list) continue;
    if (list.length < 10) { console.log(`  ${img} ${cam}: ${list.length} pairs, need >= 10 — skipped`); continue; }
    const r = PS.solve(calib, cam, null, list);
    const a = r.adj, d = `pan ${a.pan.toFixed(2)} tilt ${a.tilt.toFixed(2)} roll ${a.roll.toFixed(2)} deg, ` +
      `move ${(100 * Math.hypot(a.dx, a.dy, a.dz)).toFixed(1)} cm, f ×${a.fscale.toFixed(4)}`;
    console.log(`  ${img} ${cam} [${r.mode}]: median ${r.before.median.toFixed(1)} -> ${r.after.median.toFixed(1)} px, ` +
      `left-out ${r.loo.median.toFixed(1)} px · ${d} · ${r.ok ? 'APPLY' : 'keep: ' + r.reasons.join('; ')}` +
      (r.suspect.length ? `\n      ${r.suspect.length} pair(s) > ${PS.FAR} px, ignored (wrong clicks?): ` +
        r.suspect.map((i) => `job ${list[i].job} frame ${list[i].frame}`).join(', ') : ''));
    if (r.ok) adjs[cam] = a;
  }
  if (!Object.keys(adjs).length) { console.log(`\nno camera passed the checks; ${solveOut} not written`); return 0; }
  const out = P.bakeCalib(calib, adjs);
  out.edited = { from: path.basename(calibPath), by: 'tools/pairs_report.js', pairs: files.map((f) => path.basename(f)), cameras: Object.keys(adjs), at: new Date().toISOString() };
  fs.writeFileSync(solveOut, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${solveOut} (changed: ${Object.keys(adjs).join(', ')}). Check it in the extension (Nạp calib.json) before shipping it.`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, hashOf };
