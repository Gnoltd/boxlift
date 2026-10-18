/*
 * LiDAR -> camera projection shared by Calib Lab and the 2D->3D labeling tool.
 * Mirrors autocalib/camera.py exactly:
 *   pcd (lidar) --sensor2ego--> ego --egoAt(dt)--> ego at camera time --ego2cam--> camera --model--> pixel
 *   egoAt needs the ego motion around the sweep (projectCloud's `motion`): without it a camera with a
 *   time offset is projected as if dt = 0 (see joint.py ego_at).
 *   model "pinhole": Brown-Conrady, dist = [k1, k2, p1, p2, k3]   (cv2.projectPoints)
 *   model "fisheye": Kannala-Brandt, dist = [k1, k2, k3, k4]      (cv2.fisheye)
 * Pose deltas used by the sliders are applied in the CAMERA frame (pan/tilt/roll) and the
 * camera centre is moved in the EGO frame, so a slider always moves the image the same way.
 */
(function (root) {
  'use strict';
  const DEG = Math.PI / 180;
  const FISHEYE_MAX_THETA = 100 * DEG;

  function matMul(A, B) {            // 4x4 or 3x3 row-major arrays of arrays
    const n = A.length, m = B[0].length, k = B.length, C = [];
    for (let i = 0; i < n; i++) {
      C.push(new Array(m).fill(0));
      for (let j = 0; j < m; j++) for (let t = 0; t < k; t++) C[i][j] += A[i][t] * B[t][j];
    }
    return C;
  }
  const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

  /** Largest undistorted r^2 where the pinhole radial model is still monotonic. */
  function radialFoldR2(dist) {
    const [k1 = 0, k2 = 0, , , k3 = 0] = dist;
    let prev = 0;
    for (let i = 1; i <= 200000; i++) {
      const r2 = (25 * i) / 200000, r = Math.sqrt(r2);
      const rd = r * (1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2);
      if (rd <= prev) return r2;
      prev = rd;
    }
    return 25;
  }

  // ---- camera-LiDAR time offset (mirrors joint.py: pose_pow, ego_at) ----------------------------
  // A camera exposes at t_lidar + dt. Static points are moved with the ego motion over dt before the
  // ego -> camera transform: E_eff = ego2cam . egoAt(dt). Ego motion T maps ego frame k to k+1.

  /** Rotation vector of a 3x3 rotation (log map). */
  function rotvec(R) {
    const c = Math.min(1, Math.max(-1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)), th = Math.acos(c);
    const w = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
    if (th < 1e-12) return [w[0] / 2, w[1] / 2, w[2] / 2];
    const s = th / (2 * Math.sin(th));
    return [w[0] * s, w[1] * s, w[2] * s];
  }
  /** Rotation matrix of a rotation vector (Rodrigues). */
  function rodrigues(v) {
    const th = Math.hypot(v[0], v[1], v[2]);
    if (th < 1e-15) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const [x, y, z] = v.map((a) => a / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
      [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
      [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
  }
  /** T^a for a small rigid motion: rotation vector and translation both scaled by a (joint.pose_pow). */
  function posePow(T, a) {
    const R = rodrigues(rotvec(T.slice(0, 3).map((r) => r.slice(0, 3))).map((x) => x * a));
    return [[...R[0], T[0][3] * a], [...R[1], T[1][3] * a], [...R[2], T[2][3] * a], [0, 0, 0, 1]];
  }
  /** Inverse of an affine 4x4 (also for sensor2ego, which is stored rounded and not exactly orthonormal). */
  function inv4(M) {
    const [[a, b, c], [d, e, f], [g, h, i]] = M;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
    const R = [[A / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [C / det, (b * g - a * h) / det, (a * e - b * d) / det]];
    const t = [0, 1, 2].map((r) => -(R[r][0] * M[0][3] + R[r][1] * M[1][3] + R[r][2] * M[2][3]));
    return [[...R[0], t[0]], [...R[1], t[1]], [...R[2], t[2]], [0, 0, 0, 1]];
  }
  /**
   * Ego frame at the LiDAR time -> ego frame `a` sweeps later (a = dt / sweep period; joint.ego_at).
   * motion: {fwd: T (k -> k+1) | null, bwd: T (k-1 -> k) | null} in the ego frame.
   * A missing side falls back to the other one (constant motion), as joint.py does at the ends.
   */
  function egoAt(motion, a) {
    if (a >= 0 || !motion.bwd) return posePow(motion.fwd || motion.bwd, a);
    return inv4(posePow(motion.bwd, -a));
  }
  /** 2D sweep motion {th, tx, ty} (pcd frame, p_cur = R p_prev + t) -> 4x4 ego-frame motion. */
  function motionFromSweep2D(m, sensor2ego) {
    const R = rotZ(m.th);
    const Tl = [[...R[0], m.tx], [...R[1], m.ty], [...R[2], 0], [0, 0, 0, 1]];
    return sensor2ego ? matMul(matMul(sensor2ego, Tl), inv4(sensor2ego)) : Tl;
  }
  /** Time offset (s) of a camera: stored calibration + slider (ms). */
  function timeOffset(cam, adj) {
    return (cam.time_offset_s || 0) + ((adj && adj.dt) || 0) / 1000;
  }
  /** egoAt for a camera's time offset, memoised on the motion object (one per shown sweep), or null. */
  function timeShift(calib, cam, adj, motion) {
    const dt = timeOffset(cam, adj);
    if (!dt || !motion || !(motion.fwd || motion.bwd)) return null;
    const a = dt / (calib.sweep_period_s || 0.2), memo = (motion._at ??= new Map());
    if (!memo.has(a)) memo.set(a, egoAt(motion, a));
    return memo.get(a);
  }

  /** Effective ego2cam (4x4) of a camera after applying slider deltas. */
  function effectiveEgo2Cam(cam, adj) {
    const E = cam.ego2cam;
    if (!adj) return E;
    const Rce = [E[0].slice(0, 3), E[1].slice(0, 3), E[2].slice(0, 3)];          // ego -> cam
    const t = [E[0][3], E[1][3], E[2][3]];
    // camera centre in ego: c = -Rce^T t
    const c = [0, 1, 2].map((j) => -(Rce[0][j] * t[0] + Rce[1][j] * t[1] + Rce[2][j] * t[2]));
    // pan (around cam y), tilt (around cam x), roll (around optical z), applied in camera frame
    const D = matMul(matMul(rotZ((adj.roll || 0) * DEG), rotX((adj.tilt || 0) * DEG)), rotY((adj.pan || 0) * DEG));
    const R = matMul(D, Rce);
    const cn = [c[0] + (adj.dx || 0), c[1] + (adj.dy || 0), c[2] + (adj.dz || 0)];
    const tn = [0, 1, 2].map((i) => -(R[i][0] * cn[0] + R[i][1] * cn[1] + R[i][2] * cn[2]));
    return [[...R[0], tn[0]], [...R[1], tn[1]], [...R[2], tn[2]], [0, 0, 0, 1]];
  }

  function effectiveK(cam, adj) {
    const s = adj && adj.fscale ? adj.fscale : 1;
    const K = cam.K;
    return [[K[0][0] * s, K[0][1], K[0][2]], [K[1][0], K[1][1] * s, K[1][2]], [0, 0, 1]];
  }

  /**
   * Camera-frame point -> distorted normalised image coords in out[0..1] (pixel = K * [xd, yd, 1]).
   * false when the model cannot image it (behind / too close / past the fisheye's field / past the pinhole fold).
   */
  function distort(model, d, fold, x, y, z, out) {
    if (model === 'fisheye') {
      const rho = Math.hypot(x, y), th = Math.atan2(rho, z);
      if (th >= FISHEYE_MAX_THETA || x * x + y * y + z * z < 0.09) return false;
      const t2 = th * th;
      const thd = th * (1 + (d[0] || 0) * t2 + (d[1] || 0) * t2 * t2 + (d[2] || 0) * t2 ** 3 + (d[3] || 0) * t2 ** 4);
      if (thd <= 0) return false;
      const s = rho > 1e-9 ? thd / rho : 0;
      out[0] = x * s; out[1] = y * s;
      return true;
    }
    if (z <= 0.3) return false;
    const xn = x / z, yn = y / z, r2 = xn * xn + yn * yn;
    if (r2 >= fold) return false;
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = d;
    const rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    out[0] = xn * rad + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
    out[1] = yn * rad + p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn;
    return true;
  }
  // pinhole radial fold per camera object (2% inside it), cached here rather than on the caller's calib
  const folds = new WeakMap();
  function foldOf(cam) {
    if (!folds.has(cam)) folds.set(cam, radialFoldR2(cam.dist || []) * 0.98);
    return folds.get(cam);
  }
  /** Pixel of a camera-frame point (no image-bounds check), or null. */
  function camToPixel(cam, adj, x, y, z, out = [0, 0]) {
    const model = cam.model || 'pinhole', d = cam.dist || [];
    const fold = model === 'pinhole' ? foldOf(cam) : 0;
    if (!distort(model, d, fold, x, y, z, out)) return null;
    const K = effectiveK(cam, adj), xd = out[0], yd = out[1];
    out[0] = K[0][0] * xd + K[0][1] * yd + K[0][2]; out[1] = K[1][1] * yd + K[1][2];
    return out;
  }

  /**
   * Project a Float32Array of xyz (pcd frame) into one camera.
   * motion (optional): ego motion around this sweep, {fwd, bwd} (see egoAt), for the camera's time offset.
   * Returns {u, v, range, idx} typed arrays of the visible points only.
   */
  function projectCloud(xyz, calib, camName, adj, motion) {
    const cam = calib.cameras[camName];
    const model = cam.model || 'pinhole';
    const [W, H] = cam.image_size || [1920, 1536];
    let M = effectiveEgo2Cam(cam, adj);
    const G = timeShift(calib, cam, adj, motion);
    if (G) M = matMul(M, G);
    if ((calib.pcd_frame || 'lidar') === 'lidar') M = matMul(M, calib.lidar.sensor2ego);
    const K = effectiveK(cam, adj);
    const d = cam.dist || [];
    const fold = model === 'pinhole' ? foldOf(cam) : 0;
    const n = xyz.length / 3, XY = [0, 0];
    const U = new Float32Array(n), V = new Float32Array(n), Rg = new Float32Array(n), I = new Uint32Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const X = xyz[3 * i], Y = xyz[3 * i + 1], Z = xyz[3 * i + 2];
      const x = M[0][0] * X + M[0][1] * Y + M[0][2] * Z + M[0][3];
      const y = M[1][0] * X + M[1][1] * Y + M[1][2] * Z + M[1][3];
      const z = M[2][0] * X + M[2][1] * Y + M[2][2] * Z + M[2][3];
      if (!distort(model, d, fold, x, y, z, XY)) continue;
      const xd = XY[0], yd = XY[1];
      const u = K[0][0] * xd + K[0][1] * yd + K[0][2];
      const v = K[1][1] * yd + K[1][2];
      if (u < 0 || u >= W - 1 || v < 0 || v >= H - 1) continue;
      U[m] = u; V[m] = v; Rg[m] = Math.sqrt(x * x + y * y + z * z); I[m] = i; m++;
    }
    return { u: U.subarray(0, m), v: V.subarray(0, m), range: Rg.subarray(0, m), idx: I.subarray(0, m) };
  }

  /** Bake slider deltas into a new calib object (for export). */
  function bakeCalib(calib, adjByCam) {
    const out = JSON.parse(JSON.stringify(calib));
    for (const [name, adj] of Object.entries(adjByCam || {})) {
      if (!out.cameras[name]) continue;
      out.cameras[name].ego2cam = effectiveEgo2Cam(calib.cameras[name], adj);
      out.cameras[name].K = effectiveK(calib.cameras[name], adj);
      const dt = timeOffset(calib.cameras[name], adj);
      if (dt || 'time_offset_s' in out.cameras[name]) out.cameras[name].time_offset_s = dt;
    }
    for (const c of Object.values(out.cameras)) delete c._fold;      // written into calibs by older versions
    return out;
  }

  const api = { projectCloud, camToPixel, effectiveEgo2Cam, effectiveK, bakeCalib, radialFoldR2,
    matMul, inv4, posePow, egoAt, motionFromSweep2D, timeOffset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LidarProjection = api;
})(typeof self !== 'undefined' ? self : this);
