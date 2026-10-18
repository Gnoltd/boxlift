/*
 * Carry boxes from one frame to the next. Runs entirely in the page.
 *   1. ego motion between the two sweeps: 2D ICP (x, y, yaw) on the above-ground structure
 *   2. each box is moved by the ego motion (+ its own velocity when known) -> prediction
 *   3. the prediction is re-fitted on the new sweep: object points near it are clustered and a box
 *      of the SAME size (a rigid object does not change size) is aligned to them (centre + heading)
 * Frames: every cloud is in its own sweep (pcd) frame. T maps a point of the previous sweep to the
 * current one: p_cur = R(th) p_prev + [tx, ty].
 */
(function (root) {
  'use strict';
  const BF = root.BoxFit || (typeof require !== 'undefined' ? require('./boxfit.js') : null);
  const { wrap } = BF;

  /** Above-ground structure as a 2D point set (one centroid per 0.3 m cell). */
  function structure(xyz, maxR = 60) {
    const n = xyz.length / 3, zs = [];
    for (let i = 0; i < n; i += 7) { const r = Math.hypot(xyz[3 * i], xyz[3 * i + 1]); if (r > 3 && r < 25) zs.push(xyz[3 * i + 2]); }
    zs.sort((a, b) => a - b);
    const zg = zs.length ? zs[Math.floor(zs.length * 0.05)] : 0;
    const cells = new Map(), C = 0.3;
    for (let i = 0; i < n; i++) {
      const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2], r = Math.hypot(x, y);
      if (r < 2.5 || r > maxR || z < zg + 0.5 || z > zg + 4) continue;
      const k = `${Math.floor(x / C)},${Math.floor(y / C)}`;
      const c = cells.get(k); if (c) { c[0] += x; c[1] += y; c[2]++; } else cells.set(k, [x, y, 1]);
    }
    const out = new Float64Array(cells.size * 2); let j = 0;
    for (const [x, y, m] of cells.values()) { out[j++] = x / m; out[j++] = y / m; }
    return out;
  }

  function gridOf(pts, cell) {
    const g = new Map();
    for (let i = 0; i < pts.length / 2; i++) {
      const k = `${Math.floor(pts[2 * i] / cell)},${Math.floor(pts[2 * i + 1] / cell)}`;
      let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(i);
    }
    return { g, cell };
  }
  function solve3(A, b) {
    const [a, b1, c, d, e, f, g, h, i] = A;
    const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const inv = [e * i - f * h, c * h - b1 * i, b1 * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b1 * g - a * h, a * e - b1 * d];
    return [0, 1, 2].map((r) => (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det);
  }
  function nearest(G, pts, x, y, maxD) {
    const cx = Math.floor(x / G.cell), cy = Math.floor(y / G.cell);
    let best = -1, bd = maxD * maxD;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = G.g.get(`${cx + dx},${cy + dy}`); if (!a) continue;
      for (const j of a) { const ex = pts[2 * j] - x, ey = pts[2 * j + 1] - y, d = ex * ex + ey * ey; if (d < bd) { bd = d; best = j; } }
    }
    return [best, bd];
  }

  /** Unit normal of the local surface at each target point (2D PCA over 0.75 m), or null (pole, corner). */
  function normalsOf(dst, G) {
    const n = dst.length / 2, out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const x = dst[2 * i], y = dst[2 * i + 1], cx = Math.floor(x / G.cell), cy = Math.floor(y / G.cell), nb = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const a = G.g.get(`${cx + dx},${cy + dy}`); if (!a) continue;
        for (const j of a) if (Math.hypot(dst[2 * j] - x, dst[2 * j + 1] - y) < 0.75) nb.push(j);
      }
      if (nb.length < 4) continue;
      let mx = 0, my = 0; for (const j of nb) { mx += dst[2 * j]; my += dst[2 * j + 1]; }
      mx /= nb.length; my /= nb.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const j of nb) { const u = dst[2 * j] - mx, v = dst[2 * j + 1] - my; sxx += u * u; sxy += u * v; syy += v * v; }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      if (l2 > 0.15 * l1) continue;                     // not a line: no reliable normal
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy) + Math.PI / 2;   // normal = across the main direction
      out[i] = [Math.cos(ang), Math.sin(ang)];
    }
    return out;
  }

  /** Trimmed 2D ICP, coarse to fine: point-to-point to lock on, then point-to-line (walls do not
   *  pin the position along them, so point-to-point would slide by the scan spacing). */
  function icp2d(src, dst, grids, normals, init) {
    let { th, tx, ty } = init;
    for (const [maxD, iters, toLine] of [[2.0, 12, false], [1.0, 10, true], [0.5, 10, true]]) {
      const G = grids[maxD];
      for (let it = 0; it < iters; it++) {
        const c = Math.cos(th), s = Math.sin(th), pairs = [];
        for (let i = 0; i < src.length / 2; i++) {
          const x = c * src[2 * i] - s * src[2 * i + 1] + tx, y = s * src[2 * i] + c * src[2 * i + 1] + ty;
          const [j, d] = nearest(G, dst, x, y, maxD);
          if (j >= 0) pairs.push([i, j, d, x, y]);
        }
        if (pairs.length < 30) return null;
        pairs.sort((a, b) => a[2] - b[2]);
        const keep = pairs.slice(0, Math.ceil(pairs.length * 0.8));
        if (!toLine) {
          let ax = 0, ay = 0, bx = 0, by = 0;
          for (const [i, j] of keep) { ax += src[2 * i]; ay += src[2 * i + 1]; bx += dst[2 * j]; by += dst[2 * j + 1]; }
          ax /= keep.length; ay /= keep.length; bx /= keep.length; by /= keep.length;
          let sxx = 0, sxy = 0;
          for (const [i, j] of keep) {
            const px = src[2 * i] - ax, py = src[2 * i + 1] - ay, qx = dst[2 * j] - bx, qy = dst[2 * j + 1] - by;
            sxx += px * qx + py * qy; sxy += px * qy - py * qx;
          }
          th = Math.atan2(sxy, sxx);
          tx = bx - (Math.cos(th) * ax - Math.sin(th) * ay); ty = by - (Math.sin(th) * ax + Math.cos(th) * ay);
          continue;
        }
        // Gauss-Newton on (th, tx, ty): rows n.(R p + t - q); points without a normal give two rows
        const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
        const row = (nx, ny, x, y, qx, qy) => {
          const J = [nx * -(y - ty) + ny * (x - tx), nx, ny], r = nx * (x - qx) + ny * (y - qy);
          for (let p = 0; p < 3; p++) { b[p] -= J[p] * r; for (let q = 0; q < 3; q++) A[3 * p + q] += J[p] * J[q]; }
        };
        for (const [, j, , x, y] of keep) {
          const nrm = normals[j], qx = dst[2 * j], qy = dst[2 * j + 1];
          if (nrm) row(nrm[0], nrm[1], x, y, qx, qy); else { row(1, 0, x, y, qx, qy); row(0, 1, x, y, qx, qy); }
        }
        const d = solve3(A, b); if (!d) break;
        th += d[0]; tx += d[1]; ty += d[2];
        if (Math.abs(d[0]) < 1e-6 && Math.abs(d[1]) + Math.abs(d[2]) < 1e-4) break;
      }
    }
    // quality: share of source points with a partner closer than 0.25 m
    const c = Math.cos(th), s = Math.sin(th);
    let inl = 0;
    for (let i = 0; i < src.length / 2; i++) {
      const x = c * src[2 * i] - s * src[2 * i + 1] + tx, y = s * src[2 * i] + c * src[2 * i + 1] + ty;
      if (nearest(grids[0.5], dst, x, y, 0.25)[0] >= 0) inl++;
    }
    return { th, tx, ty, inlier: inl / (src.length / 2) };
  }

  /**
   * Ego motion prev -> cur. hint: last known motion (driving is smooth). Several starts along the
   * two lidar axes cover up to ~5 m between sweeps; walls alone give
   * false locks shifted along them, so every start runs and the best overlap wins. Returns {th, tx, ty, inlier} or null.
   */
  function egoMotion(prevXyz, curXyz, hint, fwd) {
    let src = structure(prevXyz);
    const dst = structure(curXyz);
    if (src.length < 60 || dst.length < 60) return null;
    if (src.length / 2 > 4000) {                      // subsample the moving side for speed
      const step = Math.ceil(src.length / 2 / 4000), sub = [];
      for (let i = 0; i < src.length / 2; i += step) sub.push(src[2 * i], src[2 * i + 1]);
      src = new Float64Array(sub);
    }
    const grids = { 2: gridOf(dst, 2.0), 1: gridOf(dst, 1.0), 0.5: gridOf(dst, 0.5) };   // keyed by search radius
    const normals = normalsOf(dst, grids[1]);
    const offsets = [0, -0.75, -1.5, -2.25, -3, -3.75, -4.5, -5.25, -6, 0.75, 1.5, 3];
    let starts;
    if (fwd && Math.hypot(fwd[0], fwd[1]) > 1e-6) {
      const f = fwd.map((v) => v / Math.hypot(fwd[0], fwd[1]));
      starts = offsets.map((d) => ({ th: 0, tx: d * f[0], ty: d * f[1] }))
        .concat(offsets.slice(1).map((d) => ({ th: 0, tx: -d * f[1], ty: d * f[0] })));
    } else {
      starts = offsets.map((tx) => ({ th: 0, tx, ty: 0 }))
        .concat(offsets.slice(1).map((ty) => ({ th: 0, tx: 0, ty })));
    }
    if (hint) starts.unshift(hint);
    let best = null;
    for (const s0 of starts) {
      const r = icp2d(src, dst, grids, normals, s0);
      if (r && (!best || r.inlier > best.inlier + 1e-9)) best = r;
    }
    return best;
  }

  function moveBox(box, T) {
    if (T.matrix) {
      const M = T.matrix, x = box.x, y = box.y, z = box.z;
      const hx = Math.cos(box.yaw), hy = Math.sin(box.yaw);
      return { ...box,
        x: M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3],
        y: M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3],
        z: M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3],
        yaw: wrap(Math.atan2(M[1][0] * hx + M[1][1] * hy, M[0][0] * hx + M[0][1] * hy)) };
    }
    const c = Math.cos(T.th), s = Math.sin(T.th);
    return { ...box, x: c * box.x - s * box.y + T.tx, y: s * box.x + c * box.y + T.ty, yaw: wrap(box.yaw + T.th) };
  }

  function rotateMotion(vel, th) {
    if (!vel) return null;
    const c = Math.cos(th), s = Math.sin(th);
    return [c * vel[0] - s * vel[1], s * vel[0] + c * vel[1]];
  }

  /**
   * Predict `box` (previous sweep) in the current sweep and re-fit it on `xyz` (current sweep).
   * opts.vel: [vx, vy] own displacement per frame in the current sweep's axes (moving objects).
   * opts.maxMove: how far (m) an object of unknown velocity may have driven along its heading.
   * Returns {box, points, fitted: bool, shift: m between prediction and fit}.
   */
  function propagateBox(box, T, xyz, opts = {}) {
    let pred = moveBox(box, T);
    if (opts.vel) pred = { ...pred, x: pred.x + opts.vel[0], y: pred.y + opts.vel[1] };
    const search = opts.search ?? 2.0, maxMove = opts.maxMove ?? (opts.vel ? search : 4.0), n = xyz.length / 3;
    const reach = Math.hypot(pred.l, pred.w) / 2 + Math.max(search, maxMove);
    // local ground (low points around the object)
    const near = [];
    for (let i = 0; i < n; i++) { const dx = xyz[3 * i] - pred.x, dy = xyz[3 * i + 1] - pred.y; if (dx * dx + dy * dy < Math.max(64, reach * reach)) near.push(i); }
    if (near.length < 10) return { box: pred, points: [], fitted: false, shift: 0 };
    const zs = near.map((i) => xyz[3 * i + 2]).sort((a, b) => a - b);
    const g = BF.fitGround(BF.groundPoints(xyz, near, opts.ground, 0.3)) || [0, 0, zs[Math.floor(zs.length * 0.05)]];
    const gz = (x, y) => g[0] * x + g[1] * y + g[2];
    const road = opts.ground && opts.ground.height ? opts.ground.height(pred.x, pred.y) : NaN;
    const ground = road === road ? road : gz(pred.x, pred.y);
    let region = near.filter((i) => {
      const x = xyz[3 * i], y = xyz[3 * i + 1], h = xyz[3 * i + 2] - gz(x, y);
      return h > 0.2 && h < pred.h + 0.5 && Math.hypot(x - pred.x, y - pred.y) < reach;
    });
    // No object support means no correction. In particular, do not snap Z to a road estimate made
    // from unrelated nearby returns: at the edge of a sweep that estimate may be a kerb, roof or
    // facade and the error would then be carried into every following frame.
    const keepPred = { box: pred, points: [], fitted: false, shift: 0 };
    // drop structures far bigger than the object (walls, hedges, a row of merged cars)
    const big = new Set();
    for (const cl of BF.cluster(xyz, region, 0.35, 1)) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of cl) { const x = xyz[3 * i], y = xyz[3 * i + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (Math.hypot(x1 - x0, y1 - y0) > Math.hypot(pred.l, pred.w) + 1.5) for (const i of cl) big.add(i);
    }
    region = region.filter((i) => !big.has(i));
    if (region.length < 8) return keepPred;
    // locate: slide a same-size box along the heading (unknown speed: up to maxMove) and a little
    // sideways; keep the place holding most object points, mildly preferring the prediction. Works on
    // raw points, so a far car broken into scan columns / roof patches still counts as one object.
    const c0 = Math.cos(pred.yaw), s0 = Math.sin(pred.yaw);
    const loc = region.map((i) => { const dx = xyz[3 * i] - pred.x, dy = xyz[3 * i + 1] - pred.y; return [dx * c0 + dy * s0, -dx * s0 + dy * c0]; });
    const A = Math.max(search, maxMove), hl = pred.l / 2 + 0.2, hw = pred.w / 2 + 0.2;
    const countAt = (a, b) => { let cnt = 0; for (const [u, v] of loc) if (Math.abs(u - a) < hl && Math.abs(v - b) < hw) cnt++; return cnt; };
    const scan = (range) => {
      let best = null;
      for (let a = -range; a <= range + 1e-9; a += 0.15) for (let b = -0.6; b <= 0.6 + 1e-9; b += 0.15) {
        const cnt = countAt(a, b), score = cnt * (1 - 0.5 * Math.hypot(a, b) / A);
        if (!best || score > best.score) best = { score, cnt, a, b };
      }
      return best;
    };
    let bestLoc = scan(A);
    // the prediction still holds most of the object's points: it has not driven off, so only fine-tune
    // (stops a parked car with few returns from jumping onto a better-seen neighbour)
    if (Math.abs(bestLoc.a) > 1.2 && countAt(0, 0) >= 0.6 * bestLoc.cnt) bestLoc = scan(1.2);
    if (bestLoc.cnt < 8) return keepPred;
    const pts = region.filter((_, k) => Math.abs(loc[k][0] - bestLoc.a) < hl + 0.1 && Math.abs(loc[k][1] - bestLoc.b) < hw + 0.1);
    const how = Math.abs(bestLoc.a) > search ? 'heading' : 'near';
    // same-size box aligned to the points: heading near the prediction, the observed faces fix the centre
    const origin = BF.sensorOrigin(opts.calib || {});
    let best = null;
    for (let d = -8; d <= 8; d += 1) {
      const yaw = pred.yaw + (d * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
      let a1 = Infinity, A1 = -Infinity, a2 = Infinity, A2 = -Infinity;
      for (const i of pts) {
        const x = xyz[3 * i], y = xyz[3 * i + 1], p = x * c + y * s, q = -x * s + y * c;
        a1 = Math.min(a1, p); A1 = Math.max(A1, p); a2 = Math.min(a2, q); A2 = Math.max(A2, q);
      }
      const lx = pred.x + bestLoc.a * c0 - bestLoc.b * s0, ly = pred.y + bestLoc.a * s0 + bestLoc.b * c0;   // located centre
      const pp = lx * c + ly * s, pq = -lx * s + ly * c;
      const op = origin[0] * c + origin[1] * s, oq = -origin[0] * s + origin[1] * c;
      // along each axis: a full face seen across the other axis but the object not seen end to end
      // (the rear of a car ahead) -> hold that face, extend away from the sensor. Otherwise -> the
      // smallest move from the located centre that keeps the points inside (10 cm tolerance; when
      // the points span more than the size, the box stays within them).
      const place = (lo, hi, size, locC, o, faceSeen) => {
        if (faceSeen && hi - lo < size * 0.9) return o < (lo + hi) / 2 ? lo + size / 2 : hi - size / 2;
        const a = hi - size / 2, b = lo + size / 2;
        return Math.min(Math.max(locC, Math.min(a, b) - 0.1), Math.max(a, b) + 0.1);
      };
      const cp = place(a1, A1, pred.l, pp, op, A2 - a2 >= 0.6 * pred.w), cq = place(a2, A2, pred.w, pq, oq, A1 - a1 >= 0.6 * pred.l);
      // cost: mean distance of the points to the nearest box face (outside points count double)
      let cost = 0;
      for (const i of pts) {
        const x = xyz[3 * i], y = xyz[3 * i + 1], u = x * c + y * s - cp, v = -x * s + y * c - cq;
        const eu = Math.abs(u) - pred.l / 2, ev = Math.abs(v) - pred.w / 2;
        cost += eu > 0 || ev > 0 ? 2 * Math.hypot(Math.max(eu, 0), Math.max(ev, 0)) : Math.min(-eu, -ev);
      }
      cost = cost / pts.length + 0.004 * Math.abs(d);
      if (!best || cost < best.cost) best = { cost, yaw, x: cp * c - cq * s, y: cp * s + cq * c };
    }
    const shift = Math.hypot(best.x - pred.x, best.y - pred.y);
    const along = Math.abs((best.x - pred.x) * c0 + (best.y - pred.y) * s0), across = Math.abs(-(best.x - pred.x) * s0 + (best.y - pred.y) * c0);
    if (along > Math.max(search, maxMove) + 0.5 || across > search + 0.5) return keepPred;
    const z = Number.isFinite(ground) ? ground + pred.h / 2 : pred.z;
    return { box: { ...pred, x: best.x, y: best.y, yaw: wrap(best.yaw), z }, points: pts, fitted: true, shift, how };
  }

  /** One reviewed range-propagation step.
   * Static objects stay fixed in the world (ego motion only, with a narrow point-cloud correction).
   * Moving objects search farther on their first step, then carry a smoothed velocity estimate
   * expressed in the previous sweep into the current sweep before predicting the next box. */
  function propagateStep(box, T, xyz, opts = {}) {
    const moving = opts.motion === 'moving', dt = Number.isFinite(opts.dt) && opts.dt > 0 ? opts.dt : 1;
    const carried = moving ? rotateMotion(opts.vel, T.th) : null;
    const displacement = carried ? [carried[0] * dt, carried[1] * dt] : null;
    const r = propagateBox(box, T, xyz, {
      ...opts,
      vel: displacement,
      search: opts.search ?? (moving ? 2.0 : 0.75),
      maxMove: opts.maxMove ?? (moving ? (carried ? 2.0 : 6.0) : 0.75),
    });
    const moved = moveBox(box, T);
    // For a world-static object the full 3D ego-pose transform already determines its height. The
    // local cloud may refine its footprint/yaw, but a sparse or wrong ground patch must not lift it.
    if (!moving) r.box = { ...r.box, z: moved.z };
    let vel = null;
    if (moving) {
      const observed = r.fitted ? [(r.box.x - moved.x) / dt, (r.box.y - moved.y) / dt] : carried;
      if (observed && Math.hypot(observed[0], observed[1]) > 0.3) {
        vel = carried
          ? [0.5 * carried[0] + 0.5 * observed[0], 0.5 * carried[1] + 0.5 * observed[1]]
          : observed;
      }
    }
    return { ...r, moved, vel };
  }

  /**
   * A world-static object at some frame, from its box at the frame the track started. The ego motion from that frame to this
   * one (T0f) alone places it; the cloud may only nudge it (at most maxNudge m, heading within the refit's own limit) and the
   * nudge is never carried to the next frame. Chaining step by step (propagateStep from the previous result) let the box
   * follow the densest part of a partly scanned object every frame with nothing pulling it back: 0.2-1 m per frame, sawtooth,
   * several metres after ten frames on the real KITTI job.
   */
  function staticAt(seed, T0f, xyz, opts = {}) {
    const maxNudge = opts.maxNudge ?? 0.3;
    const base = moveBox(seed, T0f);
    const r = propagateBox(base, { th: 0, tx: 0, ty: 0 }, xyz, { ...opts, vel: null, search: maxNudge, maxMove: maxNudge });
    if (!r.fitted || Math.hypot(r.box.x - base.x, r.box.y - base.y) > maxNudge + 1e-6) return { box: base, points: r.points || [], fitted: false, shift: 0, moved: base };
    // size and height come from the seed and the pose; the cloud only refines the footprint position and heading
    return { ...r, box: { ...r.box, z: base.z, l: base.l, w: base.w, h: base.h }, moved: base };
  }

  /**
   * Standalone 3D Track algorithm for fast tracking with Longitudinal Corridor and Face Pinning.
   */
  function trackBox3D(box, xyz, opts = {}) {
    const vel = opts.vel || [0, 0, 0];
    const vx = vel[0] || 0, vy = vel[1] || 0, vz = vel[2] || 0;
    const speed = Math.hypot(vx, vy);

    // 1. Ego-motion compensation if transform T is provided
    const base = opts.T ? moveBox(box, opts.T) : box;

    // 2. Predict position based on velocity
    const pred = {
      ...base,
      x: base.x + vx,
      y: base.y + vy,
      z: base.z + vz,
      yaw: base.yaw
    };

    const c0 = Math.cos(pred.yaw), s0 = Math.sin(pred.yaw);
    const hl = pred.l / 2, hw = pred.w / 2;
    const minZ = pred.z - pred.h / 2 - 0.5;
    const maxZ = pred.z + pred.h / 2 + 0.7;

    // 3. Longitudinal Search Corridor
    const forwardMax = Math.max(4.5, speed + 2.5);
    const backwardMax = Math.max(2.5, speed * 0.5 + 1.5);
    const latMax = hw + 1.2;
    const reach = Math.hypot(hl + forwardMax, latMax);

    const n = xyz.length / 3;
    const candidateIndices = [];
    const uList = [], vList = [];

    for (let i = 0; i < n; i++) {
      const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      if (pz < minZ || pz > maxZ) continue;
      const dx = px - pred.x, dy = py - pred.y;
      if (dx * dx + dy * dy > reach * reach) continue;

      const u = dx * c0 + dy * s0;   // longitudinal (along heading)
      const v = -dx * s0 + dy * c0;  // lateral (across heading)

      if (u >= -hl - backwardMax && u <= hl + forwardMax && Math.abs(v) <= latMax) {
        candidateIndices.push(i);
        uList.push(u);
        vList.push(v);
      }
    }

    if (candidateIndices.length < 5) {
      return {
        box: pred,
        points: [],
        fitted: false,
        shift: speed,
        centerDist: 0,
        vel: [vx, vy, vz],
        how: 'inertial'
      };
    }

    // 4. Find the vehicle point cluster along longitudinal axis u
    let bestU = 0, maxCount = -1;
    const uScanMin = -backwardMax;
    const uScanMax = forwardMax;
    const boxHl = hl + 0.35, boxHw = hw + 0.35;

    for (let uTest = uScanMin; uTest <= uScanMax + 1e-6; uTest += 0.2) {
      let count = 0;
      for (let k = 0; k < candidateIndices.length; k++) {
        if (Math.abs(uList[k] - uTest) <= boxHl && Math.abs(vList[k]) <= boxHw) {
          count++;
        }
      }
      if (count > maxCount) {
        maxCount = count;
        bestU = uTest;
      }
    }

    if (maxCount < 4) {
      return {
        box: pred,
        points: [],
        fitted: false,
        shift: speed,
        centerDist: 0,
        vel: [vx, vy, vz],
        how: 'inertial'
      };
    }

    // Extract inBox points belonging to the detected vehicle cluster
    const inBox = [];
    const inBoxU = [], inBoxV = [];
    let sumZ = 0;
    for (let k = 0; k < candidateIndices.length; k++) {
      if (Math.abs(uList[k] - bestU) <= boxHl && Math.abs(vList[k]) <= boxHw) {
        const idx = candidateIndices[k];
        inBox.push(idx);
        inBoxU.push(uList[k]);
        inBoxV.push(vList[k]);
        sumZ += xyz[3 * idx + 2];
      }
    }

    const pts = inBox;
    const uMin = Math.min(...inBoxU), uMax = Math.max(...inBoxU);
    const vMin = Math.min(...inBoxV), vMax = Math.max(...inBoxV);
    const uSpan = uMax - uMin, vSpan = vMax - vMin;

    // 5. Surface-to-Center Geometry (Face Pinning)
    const uSensor = -pred.x * c0 - pred.y * s0;
    const vSensor = pred.x * s0 - pred.y * c0;

    let uFit;
    if (uSpan >= pred.l * 0.85) {
      uFit = (uMin + uMax) / 2;
    } else if (uSensor < uMin) {
      uFit = uMin + pred.l / 2;     // Sensor is behind the car -> uMin is rear bumper -> center is l/2 ahead
    } else if (uSensor > uMax) {
      uFit = uMax - pred.l / 2;     // Sensor is ahead -> uMax is front bumper -> center is l/2 behind
    } else {
      uFit = (uMin + uMax) / 2;
    }

    let vFit;
    if (vSpan >= pred.w * 0.85) {
      vFit = (vMin + vMax) / 2;
    } else if (vSensor < vMin) {
      vFit = vMin + pred.w / 2;
    } else if (vSensor > vMax) {
      vFit = vMax - pred.w / 2;
    } else {
      vFit = (vMin + vMax) / 2;
    }

    const fitX = pred.x + uFit * c0 - vFit * s0;
    const fitY = pred.y + uFit * s0 + vFit * c0;

    const zVals = inBox.map((idx) => xyz[3 * idx + 2]).sort((a, b) => a - b);
    const zMin = zVals[Math.floor(zVals.length * 0.05)];
    const fitZ = Number.isFinite(zMin) ? (zMin + pred.h / 2) : (sumZ / inBox.length);

    // Yaw fine-tuning in narrow ±10° range
    let bestYaw = pred.yaw, minCost = Infinity;
    for (let dy = -10; dy <= 10; dy += 2) {
      const y = pred.yaw + (dy * Math.PI) / 180;
      const cyw = Math.cos(y), syw = Math.sin(y);
      let cost = 0;
      for (const i of pts) {
        const dx = xyz[3 * i] - fitX, dy = xyz[3 * i + 1] - fitY;
        const u = Math.abs(dx * cyw + dy * syw) - hl;
        const v = Math.abs(-dx * syw + dy * cyw) - hw;
        cost += (u > 0 ? u * 2 : -u) + (v > 0 ? v * 2 : -v);
      }
      if (cost < minCost) { minCost = cost; bestYaw = y; }
    }

    const finalYaw = wrap(bestYaw);
    const newVel = [fitX - base.x, fitY - base.y, fitZ - base.z];

    const fittedBox = {
      ...pred,
      x: fitX,
      y: fitY,
      z: fitZ,
      yaw: finalYaw
    };

    return {
      box: fittedBox,
      points: pts,
      fitted: true,
      shift: Math.hypot(fitX - base.x, fitY - base.y),
      centerDist: Math.hypot(fitX - pred.x, fitY - pred.y),
      vel: Math.hypot(newVel[0], newVel[1]) > 0.15 ? newVel : [0, 0, 0],
      how: Math.abs(bestU) > 0.6 ? 'longitudinal-scan' : 'center-dist'
    };
  }

  const api = { egoMotion, moveBox, propagateBox, propagateStep, staticAt, rotateMotion, structure, trackBox3D, gridOf, nearest, normalsOf, solve3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxTrack = api;
})(typeof self !== 'undefined' ? self : this);
