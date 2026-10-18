// node tests/autoodometry.test.js — test in-browser KISS-ICP Auto-Odometry engine
const AO = require('../extension/function/autoodometry.js');
let PM;
try { PM = require('../extension/poses.js'); } catch { PM = require('../extension/function/poses.js'); }
const { U, GROUND, scan, iou3d, setSeed } = require('./synth.js');

let fail = 0;
const check = (ok, msg) => {
  if (!ok) {
    fail++;
    console.error('FAIL:', msg);
  } else {
    console.log('PASS:', msg);
  }
};

setSeed(42);

// 1. Basic VoxelSubmap test
const submap = new AO.VoxelSubmap(0.4);
const pts0 = new Float64Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
submap.insert(pts0, { th: 0, tx: 0, ty: 0 }, 0);
check(submap.cells.size === 3, `Submap has 3 cells (got ${submap.cells.size})`);

// 2. Synthetic sequence test (vehicle moving forward 3.0 m/frame for 5 frames)
const car = (x, y, yaw) => ({ x, y, yaw, l: U(4.2, 4.9), w: U(1.75, 1.95), h: 1.6, z: GROUND + 0.8 });
function world() {
  const all = [], keep = (b) => !all.some((a) => iou3d(a, b) > 0) && Math.hypot(b.x, b.y) > 4 && (all.push(b), true);
  for (const side of [-1, 1]) {
    const yw = side * U(9, 14);
    for (let x = -40; x < 60;) { const l = U(3, 10); keep({ x: x + l / 2, y: yw, yaw: U(-0.03, 0.03), l, w: 0.3, h: 3, z: GROUND + 1.5 }); x += l + U(0.5, 4); }
    for (let k = 0; k < 6; k++) keep({ x: U(-30, 50), y: side * U(7, 8.5), yaw: 0, l: 0.3, w: 0.3, h: 4, z: GROUND + 2 });
    for (let k = 0; k < 3; k++) keep(car(U(-25, 40), side * U(4.8, 6.2), 0));
  }
  return all;
}

const w = world();
const toEgo = (b, e) => { const c = Math.cos(-e.th), s = Math.sin(-e.th), dx = b.x - e.x, dy = b.y - e.y; return { ...b, x: c * dx - s * dy, y: s * dx + c * dy, yaw: b.yaw - e.th }; };

const NUM_FRAMES = 6;
const STEP_X = 2.5; // vehicle travels 2.5m per frame
const syntheticClouds = [];
const frameList = [];

for (let i = 0; i < NUM_FRAMES; i++) {
  const e = { x: i * STEP_X, y: 0, th: 0 };
  const cloud = scan(w.map((b) => toEgo(b, e)));
  syntheticClouds.push(cloud);
  frameList.push({
    index: i,
    name: `frame_${String(i).padStart(3, '0')}.pcd`,
    timestamp: 1532402927000000 + i * 500000
  });
}

(async () => {
  const tStart = performance.now();
  const res = await AO.computeTrajectory({
    frames: frameList,
    loadCloud: async (idx) => syntheticClouds[idx],
    sensor2ego: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ]
  });
  const tEnd = performance.now();

  const durationMs = tEnd - tStart;
  const msPerFrame = durationMs / NUM_FRAMES;
  console.log(`AutoOdometry: ${NUM_FRAMES} frames in ${durationMs.toFixed(1)} ms (${msPerFrame.toFixed(2)} ms/frame, ${(1000 / msPerFrame).toFixed(0)} FPS)`);

  check(res.raw && Array.isArray(res.raw.frames) && res.raw.frames.length === NUM_FRAMES, 'raw.frames length matches');
  check(msPerFrame < 50, `Latency is below 50 ms/frame (got ${msPerFrame.toFixed(2)} ms)`);

  // Verify compatibility with PoseMetadata (poses.js)
  const meta = PM.parse(res.raw);
  check(meta && meta.frames.length === NUM_FRAMES, 'PoseMetadata parsed successfully');

  const T01 = PM.between(meta, frameList[0].name, frameList[1].name);
  check(T01 && T01.source === 'pose', 'PM.between returns valid pose transform');
  const disp = Math.hypot(T01.tx, T01.ty);
  check(Math.abs(disp - STEP_X) < 0.4, `Step displacement near ${STEP_X}m (got ${disp.toFixed(2)}m)`);

  // The motion between two frames is a fact about the lidar: it must not depend on sensor2ego. The lidar poses were once
  // written as ego_to_global and sensor2ego was applied a second time (nuScenes: 90 deg turn + offset) -> parked objects slid.
  const rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const mm = (A, B) => A.map((r) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const Rn = mm(rz(0.002), rx(0.046));                                                                       // forward still +x (the scene drives along x): tilt + offset only
  const NU = [[...Rn[0], 0.944], [...Rn[1], 0], [...Rn[2], 1.84], [0, 0, 0, 1]];
  const res2 = await AO.computeTrajectory({ frames: frameList, loadCloud: async (idx) => syntheticClouds[idx], sensor2ego: NU });
  const T01n = PM.between(PM.parse(res2.raw), frameList[0].name, frameList[1].name);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check(near(T01n.tx, T01.tx) && near(T01n.ty, T01.ty) && near(T01n.th, T01.th), `step does not depend on sensor2ego (tx ${T01.tx.toFixed(3)} vs ${T01n.tx.toFixed(3)}, ty ${T01.ty.toFixed(3)} vs ${T01n.ty.toFixed(3)})`);
  check(Math.abs(T01n.matrix[2][3]) < 1e-6, 'no height offset invented between two frames');
  check(res2.raw.rev === AO.AUTO_REV, 'raw carries the revision (older saved poses are recomputed)');

  // nuScenes: forward is the lidar's +y (sensor2ego turns 90 deg) and a 2 Hz sweep is 3-5 m apart. The probes of the
  // registration used to run along x from the prediction: such steps came out as 0.1-0.4 m (real scene-0061: 47 m off after 14 steps).
  const rot90 = (b) => ({ ...b, x: -b.y, y: b.x, yaw: b.yaw + Math.PI / 2 });                                    // the same scene, driven along +y
  const wy = w.map(rot90), stepY = 4.5, cloudsY = [];
  for (let i = 0; i < 4; i++) cloudsY.push(scan(wy.map((b) => ({ ...b, y: b.y - i * stepY }))));
  const NU90 = [[0.002, 1, 0.024, 0.944], [-1, 0.002, -0.006, 0], [-0.006, -0.024, 1, 1.84], [0, 0, 0, 1]];
  const resY = await AO.computeTrajectory({ frames: [0, 1, 2, 3].map((i) => ({ index: i, name: `f${i}.pcd`, timestamp: 1532402927000000 + i * 500000 })), loadCloud: async (i) => cloudsY[i], sensor2ego: NU90 });
  const mY = PM.parse(resY.raw), Ty = PM.between(mY, 'f0.pcd', 'f3.pcd', NU90);
  check(Math.abs(Math.abs(Ty.ty) - 3 * stepY) < 1.2 && Math.abs(Ty.tx) < 1.0, `drives 3 x ${stepY} m along +y (nuScenes axes): got (${Ty.tx.toFixed(2)}, ${Ty.ty.toFixed(2)})`);

  console.log(fail ? `\n❌ ${fail} TESTS FAILED` : '\n✓ ALL AUTO-ODOMETRY TESTS PASSED');
  process.exit(fail ? 1 : 0);
})();
