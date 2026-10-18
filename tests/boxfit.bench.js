// node tests/boxfit.bench.js [nScenes]
// Synthetic LiDAR scenes (ray-cast, this rig's geometry) with known boxes -> accuracy of BoxFit.
const fs = require('fs');
const path = require('path');
const BF = require('../extension/function/boxfit.js');
const P = require('../extension/function/projection.js');
const calib = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rig.json'), 'utf8'));

const { rnd, U, ORIGIN, GROUND, scan, iou3d } = require('./synth.js');

function makeScene(cam) {
  const W = 1920, H = 1536;
  for (let tries = 0; tries < 200; tries++) {
    const r = U(6, 45);
    const camYaw = cam === 'CAM_FRONT' ? 0 : -106 * Math.PI / 180;
    const az = camYaw + U(-0.5, 0.5);
    const tgt = { x: ORIGIN[0] + r * Math.cos(az), y: r * Math.sin(az), yaw: U(-Math.PI, Math.PI), l: U(4.2, 4.9), w: U(1.75, 1.95), h: U(1.45, 1.7) };
    tgt.z = GROUND + tgt.h / 2;
    const boxes = [tgt];
    const kind = rnd();
    const c = Math.cos(tgt.yaw), s = Math.sin(tgt.yaw);
    if (kind < 0.4) {        // parked side by side
      const gap = U(0.4, 1.0) + tgt.w;
      boxes.push({ ...tgt, x: tgt.x - s * gap, y: tgt.y + c * gap, yaw: tgt.yaw + U(-0.1, 0.1) });
    } else if (kind < 0.7) { // parked nose to tail
      const gap = U(0.6, 1.5) + tgt.l;
      boxes.push({ ...tgt, x: tgt.x + c * gap, y: tgt.y + s * gap });
    }
    let partial = false;
    if (rnd() < 0.3) {       // occluder between sensor and target
      const f = U(0.35, 0.6);
      boxes.push({ x: ORIGIN[0] + (tgt.x - ORIGIN[0]) * f + U(-1.2, 1.2), y: tgt.y * f + U(-1.2, 1.2), yaw: U(-Math.PI, Math.PI), l: 4.4, w: 1.8, h: 1.5, z: GROUND + 0.75 });
      partial = true;
    }
    // overlapping boxes are not physical
    let bad = false;
    for (let i = 1; i < boxes.length; i++) if (iou3d(boxes[0], boxes[i]) > 0 || Math.hypot(boxes[i].x - tgt.x, boxes[i].y - tgt.y) < 2.2) bad = true;
    if (bad) continue;
    const proj = BF.projectBox(tgt, calib, cam, null, 4).flat();
    if (proj.length < 20) continue;
    let u0 = Math.min(...proj.map((p) => p[0])), u1 = Math.max(...proj.map((p) => p[0]));
    let v0 = Math.min(...proj.map((p) => p[1])), v1 = Math.max(...proj.map((p) => p[1]));
    if (u0 < 5 || v0 < 5 || u1 > W - 5 || v1 > H - 5 || u1 - u0 < 25) continue;   // fully in view, drawable
    const jw = (u1 - u0) * 0.04, jh = (v1 - v0) * 0.04;
    return { tgt, boxes, partial, r, rect: { u0: u0 + U(-jw, jw), u1: u1 + U(-jw, jw), v0: v0 + U(-jh, jh), v1: v1 + U(-jh, jh) }, kind };
  }
  return null;
}

const N = Number(process.argv[2] || 60);
for (const cam of ['CAM_FRONT', 'CAM_RIGHT']) {
  const rows = [];
  for (let k = 0; k < N; k++) {
    const sc = makeScene(cam); if (!sc) continue;
    let xyz = scan(sc.boxes);
    if (process.env.DROP) {   // dark paint / glass: no returns above the doors and on the far half of the target
      const keep = [], c = Math.cos(-sc.tgt.yaw), sn = Math.sin(-sc.tgt.yaw), side = rnd() < 0.5 ? 1 : -1;
      for (let i = 0; i < xyz.length / 3; i++) {
        const dx = xyz[3 * i] - sc.tgt.x, dy = xyz[3 * i + 1] - sc.tgt.y, dz = xyz[3 * i + 2] - sc.tgt.z;
        const lx = dx * c - dy * sn, ly = dx * sn + dy * c;
        const onT = Math.abs(lx) < sc.tgt.l / 2 + 0.05 && Math.abs(ly) < sc.tgt.w / 2 + 0.05 && Math.abs(dz) < sc.tgt.h / 2 + 0.05;
        if (onT && (dz > sc.tgt.h / 2 - 0.65 || side * lx > 0.3)) continue;
        keep.push(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
      }
      xyz = new Float32Array(keep);
    }
    const t = Date.now();
    const gopt = process.env.NOMASK ? {} : { ground: BF.groundMask(xyz) };   // road ground as in the extension
    let res;
    if (process.env.MODE === 'click') {
      // the user clicks the middle of the visible part of the target
      const inT = [];
      const c = Math.cos(-sc.tgt.yaw), sn = Math.sin(-sc.tgt.yaw);
      for (let i = 0; i < xyz.length / 3; i++) {
        const dx = xyz[3 * i] - sc.tgt.x, dy = xyz[3 * i + 1] - sc.tgt.y, dz = xyz[3 * i + 2] - sc.tgt.z;
        if (Math.abs(dx * c - dy * sn) < sc.tgt.l / 2 + 0.05 && Math.abs(dx * sn + dy * c) < sc.tgt.w / 2 + 0.05 && Math.abs(dz) < sc.tgt.h / 2 + 0.05) inT.push(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
      }
      const pr = P.projectCloud(new Float32Array(inT), calib, cam, null);
      if (pr.u.length < 5) continue;
      const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
      res = BF.fitFromClick(xyz, calib, cam, null, { u: med(pr.u) + U(-6, 6), v: med(pr.v) + U(-6, 6) }, { label: 'car', ...gopt });
    } else res = BF.fitFromRect(xyz, calib, cam, null, sc.rect, { label: 'car', ...gopt });
    const ms = Date.now() - t;
    if (!res.box) { rows.push({ iou: 0, yawErr: 90, r: sc.r, partial: sc.partial, ms }); continue; }
    const dy = Math.abs(((res.box.yaw - sc.tgt.yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - Math.PI / 2);
    const iou = iou3d(res.box, sc.tgt);
    if (process.env.DIAG && iou < 0.5) {
      const b = res.box;
      console.log(`  FAIL ${cam} ${sc.kind < 0.4 ? 'side' : sc.kind < 0.7 ? 'tail' : 'alone'} occl=${sc.partial} r=${sc.r.toFixed(1)} iou=${iou.toFixed(2)} ` +
        `tgt=${[sc.tgt.x, sc.tgt.y, sc.tgt.l, sc.tgt.w].map((v) => v.toFixed(1))} fit=${[b.x, b.y, b.l, b.w].map((v) => v.toFixed(1))} nCl=${res.candidates} clIoU=${res.clusterIoU.toFixed(2)} pts=${res.points.length}`);
    }
    rows.push({ iou, yawErr: dy * 180 / Math.PI, r: sc.r, partial: sc.partial, ms });
  }
  const sum = (f) => rows.filter(f);
  const stat = (rs, name) => {
    if (!rs.length) return;
    const ious = rs.map((x) => x.iou).sort((a, b) => a - b), ye = rs.map((x) => x.yawErr).sort((a, b) => a - b);
    console.log(`${cam} ${name.padEnd(18)} n=${String(rs.length).padStart(3)}  IoU3D median ${ious[ious.length >> 1].toFixed(2)}  ` +
      `>=0.5: ${(100 * rs.filter((x) => x.iou >= 0.5).length / rs.length).toFixed(0)}%  >=0.7: ${(100 * rs.filter((x) => x.iou >= 0.7).length / rs.length).toFixed(0)}%  ` +
      `yaw err median ${ye[ye.length >> 1].toFixed(1)}°  time ${(rs.reduce((s, x) => s + x.ms, 0) / rs.length).toFixed(0)}ms`);
  };
  stat(rows, 'all');
  stat(sum((x) => x.r < 20 && !x.partial), '<20m, visible');
  stat(sum((x) => x.r >= 20 && !x.partial), '>=20m, visible');
  stat(sum((x) => x.partial), 'occluded');
}
