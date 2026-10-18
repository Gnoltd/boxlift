/*
 * Auto-Odometry: Lightweight In-Browser KISS-ICP Style LiDAR Odometry.
 * Computes 6-DoF ego-motion trajectory across frames using:
 *   1. Static structure extraction (ground removal + vertical feature voxels)
 *   2. Local Voxel Hashing Submap (sliding window of map points, preventing cumulative drift)
 *   3. Constant Velocity Motion Prediction (smooth trajectory prior)
 *   4. Point-to-Line ICP with Adaptive Inlier Thresholding (automatic dynamic obstacle removal)
 * Compatible with PoseMetadata (poses.js) and CVAT extension storage.
 */
(function (root) {
  'use strict';

  function tryRequire(p) {
    if (typeof require !== 'undefined') {
      try { return require(p); } catch {}
    }
    return null;
  }
  function getBT() {
    return root.BoxTrack || tryRequire('../propagate.js') || tryRequire('./propagate.js') || null;
  }
  function getEP() {
    return root.EgoPath || tryRequire('../egopath.js') || tryRequire('./egopath.js') || null;
  }

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  /** Bumped when the pose file convention changes: a pose saved by an older revision is wrong and is worked out again. */
  const AUTO_REV = 3;                 // 3: registration reaches 2 Hz sweeps (4-5 m between frames); poses of rev 2 collapsed on them
  const LOCK_INLIER = 0.5;            // below this overlap the constant-velocity prediction is not trusted
  const mul4 = (A, B) => A.map((r, i) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j] + r[3] * B[3][j]));
  /** Inverse of a rigid 4x4 (rotation transposed, translation turned back). */
  const invRigid = (M) => {
    const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[j][i])), t = [M[0][3], M[1][3], M[2][3]];
    return [0, 1, 2].map((i) => [...R[i], -(R[i][0] * t[0] + R[i][1] * t[1] + R[i][2] * t[2])]).concat([[0, 0, 0, 1]]);
  };

  /**
   * 2D Rigid transformation of point [x, y] by pose (th, tx, ty)
   */
  function transformPoint(x, y, th, tx, ty) {
    const c = Math.cos(th), s = Math.sin(th);
    return [c * x - s * y + tx, s * x + c * y + ty];
  }

  /**
   * Local Voxel Hashing Submap
   * Stores static surface points in world coordinates across recent frames.
   */
  class VoxelSubmap {
    constructor(cellSize = 0.4) {
      this.cellSize = cellSize;
      this.cells = new Map(); // key -> { x, y, count, frame }
    }

    insert(pts, pose, frameIdx) {
      const C = this.cellSize;
      const c = Math.cos(pose.th), s = Math.sin(pose.th);
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) {
        const px = pts[2 * i], py = pts[2 * i + 1];
        const wx = c * px - s * py + pose.tx;
        const wy = s * px + c * py + pose.ty;
        const k = `${Math.floor(wx / C)},${Math.floor(wy / C)}`;
        const cell = this.cells.get(k);
        if (cell) {
          cell.x = (cell.x * cell.count + wx) / (cell.count + 1);
          cell.y = (cell.y * cell.count + wy) / (cell.count + 1);
          cell.count++;
          cell.frame = frameIdx;
        } else {
          this.cells.set(k, { x: wx, y: wy, count: 1, frame: frameIdx });
        }
      }
    }

    prune(currentPos, maxR = 80, maxAge = 12, currentFrame = 0) {
      const maxR2 = maxR * maxR;
      for (const [k, cell] of this.cells.entries()) {
        const dx = cell.x - currentPos.tx, dy = cell.y - currentPos.ty;
        if (dx * dx + dy * dy > maxR2 || (currentFrame - cell.frame > maxAge)) {
          this.cells.delete(k);
        }
      }
    }

    getPoints() {
      const out = new Float64Array(this.cells.size * 2);
      let j = 0;
      for (const cell of this.cells.values()) {
        out[j++] = cell.x;
        out[j++] = cell.y;
      }
      return out;
    }
  }

  /**
   * Downsample 2D points to target count using uniform striding
   */
  function downsamplePoints(pts, target = 1000) {
    const n = pts.length / 2;
    if (n <= target) return pts;
    const step = Math.ceil(n / target);
    const out = new Float64Array(Math.ceil(n / step) * 2);
    let j = 0;
    for (let i = 0; i < n; i += step) {
      out[j++] = pts[2 * i];
      out[j++] = pts[2 * i + 1];
    }
    return out;
  }

  /**
   * Register a structure point set against the local submap using coarse-to-fine Point-to-Line ICP
   * with Adaptive Thresholding to reject dynamic objects (moving cars/buses).
   */
  function registerToSubmap(srcPts, submap, initPose, opts = {}) {
    const dstPts = submap.getPoints();
    if (dstPts.length < 30) {
      return { pose: { ...initPose }, inlier: 1.0 };
    }

    const src = downsamplePoints(srcPts, 1000);
    const nSrc = src.length / 2;

    const BT = getBT();
    // Use single resolution grid (1.0m) for fast matching
    const G = BT && BT.gridOf ? BT.gridOf(dstPts, 1.0) : null;
    if (!G) return { pose: { ...initPose }, inlier: 0 };
    const normals = BT.normalsOf ? BT.normalsOf(dstPts, G) : null;

    let starts = [initPose];
    if (opts.needMultiStart) {
      // The car drives along its own forward axis (in lidar axes: +y for nuScenes, +x for KITTI), from the previous pose, and
      // a 2 Hz sweep can be 5 m apart: probing +-2/4 m along x, from the prediction, never reached it (nuScenes steps of
      // 3-5 m came out as 0.1-0.4 m, the whole trajectory collapsed and parked objects stuck to the ego).
      const base = opts.prevPose || initPose, f = opts.fwd || [1, 0], c = Math.cos(base.th), s = Math.sin(base.th);
      const wx = c * f[0] - s * f[1], wy = s * f[0] + c * f[1];
      for (const d of (opts.offsets || [0.5, 1, 2, 3, 4, 5, 6, 7, 8, -1])) {
        starts.push({ th: initPose.th, tx: base.tx + d * wx, ty: base.ty + d * wy });
      }
    }

    let bestResult = null;

    for (const start of starts) {
      let { th, tx, ty } = start;
      let finalInlier = 0;

      // 2-stage fast convergence: 3 coarse (point-to-point/line) + 3 fine (point-to-line)
      for (let it = 0; it < 6; it++) {
        const toLine = it >= 2;
        const maxSearchD = it < 2 ? 1.5 : 0.8;
        const c = Math.cos(th), s = Math.sin(th);

        let sumD = 0, sumD2 = 0, count = 0;
        const matches = [];

        for (let i = 0; i < nSrc; i++) {
          const x = c * src[2 * i] - s * src[2 * i + 1] + tx;
          const y = s * src[2 * i] + c * src[2 * i + 1] + ty;

          const [j, d2] = BT.nearest ? BT.nearest(G, dstPts, x, y, maxSearchD) : [-1, 99];
          if (j >= 0) {
            const d = Math.sqrt(d2);
            sumD += d;
            sumD2 += d2;
            count++;
            matches.push(i, j, x, y, d);
          }
        }

        if (count < 15) break;

        // KISS-ICP statistical threshold: mean + 2.2 * std
        const mean = sumD / count;
        const std = Math.sqrt(Math.max(0, sumD2 / count - mean * mean));
        const tau = Math.max(0.3, Math.min(maxSearchD, mean + 2.2 * std));

        const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
        let inl = 0;

        for (let p = 0; p < matches.length; p += 5) {
          const d = matches[p + 4];
          if (d > tau) continue;
          inl++;
          const i = matches[p], j = matches[p + 1], x = matches[p + 2], y = matches[p + 3];
          const qx = dstPts[2 * j], qy = dstPts[2 * j + 1];

          if (!toLine) {
            const rx = x - qx, ry = y - qy;
            const Jx = [-(y - ty), 1, 0], Jy = [x - tx, 0, 1];
            for (let u = 0; u < 3; u++) {
              b[u] -= Jx[u] * rx + Jy[u] * ry;
              for (let v = 0; v < 3; v++) A[3 * u + v] += Jx[u] * Jx[v] + Jy[u] * Jy[v];
            }
          } else {
            const nrm = normals ? normals[j] : null;
            const nx = nrm ? nrm[0] : (x - qx) / (d || 1e-6);
            const ny = nrm ? nrm[1] : (y - qy) / (d || 1e-6);
            const r = nx * (x - qx) + ny * (y - qy);
            const J = [nx * -(y - ty) + ny * (x - tx), nx, ny];
            for (let u = 0; u < 3; u++) {
              b[u] -= J[u] * r;
              for (let v = 0; v < 3; v++) A[3 * u + v] += J[u] * J[v];
            }
          }
        }

        finalInlier = inl / nSrc;
        const dPose = BT.solve3 ? BT.solve3(A, b) : null;
        if (!dPose) break;

        th = wrap(th + dPose[0]);
        tx += dPose[1];
        ty += dPose[2];

        if (Math.abs(dPose[0]) < 1e-4 && Math.abs(dPose[1]) + Math.abs(dPose[2]) < 1e-3) break;
      }

      if (!bestResult || finalInlier > bestResult.inlier) {
        bestResult = { pose: { th, tx, ty }, inlier: finalInlier };
      }
      // Confident match from the prediction: stop. Probing starts (multi-start) are all tried: an early exit at the first start
      // above 0.7 took a wrong lock 1 m short of a 2.5 m step (inlier 0.73) before the right start (0.93) was tried.
      if (!opts.needMultiStart && finalInlier > 0.70) break;
    }

    return bestResult || { pose: { ...initPose }, inlier: 0 };
  }

  /**
   * Run full KISS-ICP style Auto-Odometry over an array of job frames.
   *
   * @param {Object} options
   * @param {Array} options.frames - list of frames [{ index, name, timestamp }]
   * @param {Function} options.loadCloud - async function(frameNumber) -> Float32Array (pcd xyz)
   * @param {Array} [options.sensor2ego] - 4x4 matrix turning lidar into car axes (nuScenes forward = +y)
   * @param {Function} [options.onProgress] - callback(current, total, msElapsed, text)
   * @param {AbortSignal} [options.signal] - optional cancellation signal
   * @returns {Promise<{ raw: Object, summary: Object }>}
   */
  async function computeTrajectory({ frames, loadCloud, sensor2ego, onProgress, signal }) {
    if (!Array.isArray(frames) || !frames.length) {
      throw new Error('Danh sách frames không hợp lệ');
    }

    const t0 = performance.now();
    const BT = getBT(), EP = getEP();
    const submap = new VoxelSubmap(0.6);
    const poses = []; // world pose for each frame
    let lastVelocity = { th: 0, tx: 0, ty: 0 };
    let totalInliers = 0;

    // Default sensor2ego for nuScenes (+y forward) if not provided
    const S = sensor2ego || [
      [0, 1, 0, 0],
      [-1, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    // the car's forward axis in lidar axes: ego x seen from the lidar (row 0 of sensor2ego)
    const fwdLen = Math.hypot(S[0][0], S[0][1]) || 1, fwd = [S[0][0] / fwdLen, S[0][1] / fwdLen];

    for (let i = 0; i < frames.length; i++) {
      if (signal && signal.aborted) throw new Error('Đã huỷ tính toán Auto-Odometry');
      const f = frames[i];

      if (onProgress) {
        const ms = performance.now() - t0;
        onProgress(i + 1, frames.length, ms, `Frame ${i + 1}/${frames.length} (${f.name || f.index})`);
      }

      // Prefetch next 4 clouds in background for pipelined HTTP downloads
      for (let p = 1; p <= 4 && i + p < frames.length; p++) {
        loadCloud(frames[i + p].index).catch(() => {});
      }

      const xyz = await loadCloud(f.index);
      if (!xyz || !xyz.length) {
        // Missing cloud: fallback to dead reckoning
        const pred = poses.length
          ? (EP ? EP.compose(poses[poses.length - 1], lastVelocity) : {
              th: wrap(poses[poses.length - 1].th + lastVelocity.th),
              tx: poses[poses.length - 1].tx + lastVelocity.tx,
              ty: poses[poses.length - 1].ty + lastVelocity.ty
            })
          : { th: 0, tx: 0, ty: 0 };
        poses.push(pred);
        continue;
      }

      const rawStruct = BT && BT.structure ? BT.structure(xyz, 55) : new Float64Array(0);
      const struct = downsamplePoints(rawStruct, 1000);

      if (i === 0) {
        // First frame: origin of world coordinate frame
        const p0 = { th: 0, tx: 0, ty: 0 };
        poses.push(p0);
        submap.insert(struct, p0, 0);
        totalInliers += 1.0;
        continue;
      }

      // 1. Constant velocity prediction from previous frame
      const prevPose = poses[poses.length - 1];
      const predPose = EP ? EP.compose(prevPose, lastVelocity) : {
        th: wrap(prevPose.th + lastVelocity.th),
        tx: prevPose.tx + lastVelocity.tx,
        ty: prevPose.ty + lastVelocity.ty
      };

      // 2. Scan-to-Submap Registration with adaptive threshold
      // first the constant-velocity prediction; when it does not explain the scan (a jump in speed, a 2 Hz sweep) probe along
      // the forward axis and keep the best overlap
      const regOpts = { prevPose, fwd };
      let reg = registerToSubmap(struct, submap, predPose, { ...regOpts, needMultiStart: i === 1 });
      if (i > 1 && reg.inlier < LOCK_INLIER) {
        const wide = registerToSubmap(struct, submap, predPose, { ...regOpts, needMultiStart: true });
        if (wide.inlier > reg.inlier) reg = wide;
      }
      const curPose = reg.pose;
      poses.push(curPose);
      totalInliers += reg.inlier;

      // 3. Update velocity estimate
      lastVelocity = EP ? EP.compose(EP.invert(prevPose), curPose) : {
        th: wrap(curPose.th - prevPose.th),
        tx: curPose.tx - prevPose.tx,
        ty: curPose.ty - prevPose.ty
      };

      // 4. Insert static points into local submap and prune distant voxels
      submap.insert(struct, curPose, i);
      submap.prune(curPose, 75, 10, i);
    }

    const durationMs = performance.now() - t0;
    const fps = ((frames.length / (durationMs / 1000)) || 0).toFixed(0);

    // Build nuScenes-compatible raw metadata object. The poses above are poses of the LIDAR (the scans are registered in
    // lidar axes), but poses.js composes global_from_lidar = ego_to_global * sensor2ego. So the file must hold
    // ego_to_global = lidar_pose * sensor2ego^-1; writing the lidar pose there applied sensor2ego twice (its 90 deg turn and
    // offset leaked into every frame-to-frame motion: parked objects slid sideways / back and forth).
    const Sinv = invRigid(S);
    const rawFrames = frames.map((f, i) => {
      const p = poses[i];
      const c = Math.cos(p.th), s = Math.sin(p.th);
      const lidar_to_global = [
        [c, -s, 0, p.tx],
        [s,  c, 0, p.ty],
        [0,  0, 1,    0],
        [0,  0, 0,    1]
      ];
      const ego_to_global = mul4(lidar_to_global, Sinv);
      return {
        index: i,
        filename: f.name || `frame_${String(i).padStart(3, '0')}.pcd`,
        fid: f.name ? f.name.replace(/\.[^/.]+$/, '') : String(i),
        timestamp: f.timestamp || (1532402927000000 + i * 500000),
        ego_to_global
      };
    });

    const raw = {
      scene: `KISS-ICP Auto [${frames.length} frames]`,
      mode: 'kiss-icp-auto',
      rev: AUTO_REV,
      sensor2ego: S,
      frames: rawFrames
    };

    return {
      raw,
      summary: {
        totalFrames: frames.length,
        durationMs,
        fps: Number(fps),
        meanInliers: totalInliers / frames.length
      }
    };
  }

  const api = { VoxelSubmap, registerToSubmap, computeTrajectory, AUTO_REV, invRigid, mul4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoOdometry = api;
})(typeof self !== 'undefined' ? self : this);
