#!/usr/bin/env node
/*
 * T1 — does the extension project LiDAR onto the images like nuScenes does?
 *   node tools/public/eval_projection.js <converted scene dir> [calib.json (default gt/calib-gt.json)]
 *
 * For every frame and camera, LiDAR points (pcd) are projected two ways:
 *   tool  : extension/projection.js projectCloud with the calibration (one ego frame, dt = 0)
 *   exact : nuScenes chain p_cam = cam2ego^-1 · ego_cam^-1 · ego_lidar · lidar2ego · p, where ego_lidar and
 *           ego_cam are the vehicle poses at the lidar and camera timestamps (gt/frames.json)
 * With the ground-truth calibration the two differ only by the vehicle moving between the lidar and the camera
 * timestamps; on frames where the car is (almost) still they must coincide. Reported per camera: median / p90 px,
 * split by vehicle speed. A different calibration (e.g. autocalib's) gives its total error against the truth.
 * --time: also apply each camera's time_offset_s the way the extension does (projection.js timeShift), with the
 *         vehicle motion between neighbouring sweeps taken from the nuScenes ego poses.
 */
const fs = require('fs');
const path = require('path');
const P = require('../../extension/function/projection.js');
const PCD = require('../../extension/function/pcd.js');

const args = process.argv.slice(2), TIME = args.includes('--time'), pos = args.filter((x) => !x.startsWith('--'));
const dir = pos[0];
const calib = JSON.parse(fs.readFileSync(pos[1] || path.join(dir, 'gt', 'calib-gt.json'), 'utf8'));
const gt = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'calib-gt.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'gt', 'frames.json'), 'utf8'));

const mul = P.matMul, inv = P.inv4;
const apply = (M, x, y, z) => [M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3], M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3],
  M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3]];
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };

const F = meta.frames;
if (TIME) calib.sweep_period_s = q(F.slice(1).map((f, k) => (f.lidar_t - F[k].lidar_t) * 1e-6), 0.5);
const res = {};          // cam -> {still: [], moving: [], all: []}
const speeds = [];
meta.frames.forEach((fr, k) => {
  const buf = fs.readFileSync(path.join(dir, 'pointcloud', fr.fid + '.pcd'));
  const all = PCD.parsePCD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const n = all.length / 3, step = Math.max(1, Math.floor(n / 15000));
  const xyz = new Float32Array(Math.ceil(n / step) * 3);
  for (let i = 0, j = 0; i < n; i += step, j++) xyz.set(all.subarray(3 * i, 3 * i + 3), 3 * j);
  const nb = meta.frames[k + 1] || meta.frames[k - 1];
  const dp = Math.hypot(nb.lidar_ego[0][3] - fr.lidar_ego[0][3], nb.lidar_ego[1][3] - fr.lidar_ego[1][3]);
  const speed = dp / (Math.abs(nb.lidar_t - fr.lidar_t) * 1e-6);
  speeds.push(speed);
  for (const [img, name] of Object.entries(calib.camera_map)) {
    const gname = gt.camera_map[img], g = gt.cameras[gname], cam = fr.cams[gname];     // matched by image_N
    if (!g || !cam || !calib.cameras[name]) continue;
    const M = mul(g.ego2cam, mul(inv(cam.ego), mul(fr.lidar_ego, gt.lidar.sensor2ego)));   // exact nuScenes chain
    const motion = TIME ? { fwd: F[k + 1] && mul(inv(F[k + 1].lidar_ego), fr.lidar_ego),
      bwd: F[k - 1] && mul(inv(fr.lidar_ego), F[k - 1].lidar_ego) } : null;     // ego frame k -> k+1 (k-1 -> k)
    const pr = P.projectCloud(xyz, calib, name, null, motion);
    const K = g.K, [W, H] = g.image_size;
    const r = (res[name] ??= { still: [], moving: [], all: [] });
    pr.idx.forEach((i, j) => {
      const [x, y, z] = apply(M, xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
      if (z < 1) return;
      const u = K[0][0] * x / z + K[0][2], v = K[1][1] * y / z + K[1][2];
      if (u < 0 || u >= W || v < 0 || v >= H) return;
      const e = Math.hypot(pr.u[j] - u, pr.v[j] - v);
      r.all.push(e); (speed < 0.5 ? r.still : r.moving).push(e);
    });
  }
});
const nStill = speeds.filter((s) => s < 0.5).length;
console.log(`${meta.scene} (${meta.mode})${TIME ? ' + time offset' : ''}: ${meta.frames.length} frames, ${nStill} with the car still (< 0.5 m/s), ` +
  `speed median ${q(speeds, 0.5).toFixed(1)} m/s, max ${Math.max(...speeds).toFixed(1)} m/s`);
console.log('camera            dt(ms)   still: median   p90 |  moving: median   p90 |  all: median   p90   (px vs exact nuScenes)');
for (const [img, name] of Object.entries(calib.camera_map)) {
  const r = res[name]; if (!r) continue;
  const f = (a) => (a.length ? `${q(a, 0.5).toFixed(2).padStart(6)} ${q(a, 0.9).toFixed(2).padStart(6)}` : '     -      -');
  const dt = 1000 * (gt.cameras[gt.camera_map[img]].time_offset_s || 0);
  console.log(`${img} ${name.padEnd(15)} ${dt.toFixed(0).padStart(5)}   ${f(r.still)}     |  ${f(r.moving)}      |  ${f(r.all)}`);
}
