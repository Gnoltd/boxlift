/*
 * 2D box on a camera image -> 3D cuboid from the LiDAR cloud. Runs entirely in the page.
 *   1. points whose projection falls in the drawn rectangle (frustum)
 *   2. local ground plane (RANSAC on the low points of a wider frustum) -> drop ground
 *   3. euclidean clustering on a 3D grid
 *   4. pick the cluster whose projected 2D extent best matches the rectangle
 *   5. L-shape fit (yaw from the "closeness" criterion), height from ground to top
 *   6. size prior per class: a partly seen object is extended AWAY from the sensor
 * Output is in the point-cloud frame, in CVAT cuboid convention:
 *   points = [x, y, z, 0, 0, yaw, length(x), width(y), height(z), 0 x 7]
 */
(function (root) {
  'use strict';
  const P = root.LidarProjection || (typeof require !== 'undefined' ? require('./projection.js') : null);

  const PRIORS = {               // length, width, height (m) used only to complete partial views
    car: [4.5, 1.85, 1.55], van: [5.0, 2.0, 2.0], truck: [7.5, 2.4, 3.0], bus: [11.0, 2.6, 3.2],
    motorbike: [1.9, 0.75, 1.5], motorcycle: [1.9, 0.75, 1.5], bicycle: [1.8, 0.6, 1.5], cyclist: [1.8, 0.7, 1.7],
    pedestrian: [0.6, 0.6, 1.7], person: [0.6, 0.6, 1.7],
  };
  function priorFor(label) {
    const k = String(label || '').toLowerCase();
    for (const [name, v] of Object.entries(PRIORS)) if (k.includes(name)) return v;
    return null;
  }

  // ---------------------------------------------------------------- helpers
  function sensorOrigin(calib) {
    // LiDAR origin in the pcd frame: (0, 0, 0) when the pcd is in the sensor frame (nuScenes, KITTI);
    // calib.lidar.origin_pcd for a pcd shifted to another origin. It only decides which box faces are
    // visible, so a rough value is enough.
    return (calib && calib.lidar && calib.lidar.origin_pcd) || [0, 0, 0];
  }

  /** z = a x + b y + c fitted with RANSAC on candidate ground points. */
  function fitGround(pts, iters = 120, tol = 0.08) {
    const n = pts.length / 3;
    if (n < 10) return null;
    let best = null, bestIn = -1;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let it = 0; it < iters; it++) {
      const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n), k = Math.floor(rnd() * n);
      const ax = pts[3 * i], ay = pts[3 * i + 1], az = pts[3 * i + 2];
      const ux = pts[3 * j] - ax, uy = pts[3 * j + 1] - ay, uz = pts[3 * j + 2] - az;
      const vx = pts[3 * k] - ax, vy = pts[3 * k + 1] - ay, vz = pts[3 * k + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (Math.abs(nz) < 1e-6 || Math.abs(nz) / Math.hypot(nx, ny, nz) < 0.95) continue;   // near-horizontal only
      const a = -nx / nz, b = -ny / nz, c = az - a * ax - b * ay;
      let cnt = 0;
      for (let p = 0; p < n; p++) if (Math.abs(pts[3 * p + 2] - (a * pts[3 * p] + b * pts[3 * p + 1] + c)) < tol) cnt++;
      if (cnt > bestIn) { bestIn = cnt; best = [a, b, c]; }
    }
    return best;
  }

  /**
   * Euclidean clustering: points closer than eps are linked (union-find over a hash grid). Vertically the
   * link reaches RING_GAP x range (up to RING_GAP_MAX): LiDAR rings are a fixed angle apart, so on a far
   * object they are far apart in height (32 beams: ~0.7 m at 30 m) and a car would fall apart into rings.
   * origin: sensor position in the pcd frame.
   */
  const RING_GAP = 0.025, RING_GAP_MAX = 0.8;          // ~1.4 deg between rings; cap: do not reach tree canopies
  const VOX_DENSE = 3;                                 // points per eps/2 voxel from which the voxels are clustered
  /**
   * A dense LiDAR (100k+ points) puts hundreds of points in each eps cell and point-to-point linking grows with the
   * square of that. Points in one eps/2 voxel are within eps of each other (linked anyway): the voxels are linked
   * instead (by their centroids when those are close enough, else by the first pair of their points that is), and
   * every point gets its voxel's cluster: the same clusters as point by point. A sparse cloud (most voxels hold
   * 1-2 points) is clustered point by point. minPts counts points.
   */
  function cluster(pts, idx, eps = 0.35, minPts = 8, origin = [0, 0, 0]) {
    const a = eps / 2, vox = new Map();
    for (const i of idx) {
      const k = `${Math.floor(pts[3 * i] / a)},${Math.floor(pts[3 * i + 1] / a)},${Math.floor(pts[3 * i + 2] / a)}`;
      let m = vox.get(k); if (!m) vox.set(k, (m = [])); m.push(i);
    }
    if (idx.length < VOX_DENSE * vox.size) return linkPoints(pts, idx, eps, minPts, origin);
    const members = [...vox.values()], cen = new Float32Array(members.length * 3);
    members.forEach((m, v) => {
      for (const i of m) for (let c = 0; c < 3; c++) cen[3 * v + c] += pts[3 * i + c];
      for (let c = 0; c < 3; c++) cen[3 * v + c] /= m.length;
    });
    return linkPoints(cen, members.map((_, v) => v), eps, 1, origin, { pts, members, a })
      .map((g) => g.flatMap((v) => members[v])).filter((g) => g.length >= minPts);
  }
  /**
   * Union-find over a hash grid. vox (optional): the items are voxel centroids; two voxels whose centroids do not
   * link are linked when any pair of their points does (checked only when the voxels' extents allow it).
   */
  function linkPoints(pts, idx, eps, minPts, origin, vox = null) {
    const n = idx.length, parent = new Int32Array(n).map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const slack = vox ? 2 * vox.a : 0, low = (d) => Math.max(0, Math.abs(d) - slack);   // members within a of their centroid per axis
    // neighbour cells reach the link distance (plus the voxels' own extent)
    const grid = new Map(), cell = (v) => Math.floor(v / (eps + slack)), cellZ = (v) => Math.floor(v / (RING_GAP_MAX + slack));
    for (let k = 0; k < n; k++) {
      const i = idx[k], key = `${cell(pts[3 * i])},${cell(pts[3 * i + 1])},${cellZ(pts[3 * i + 2])}`;
      let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(k);
    }
    const e2 = eps * eps;
    // within eps in 3D; or above each other (horizontally close) within the ring gap
    const links = (h2, dz, ez) => h2 + dz * dz < e2 || (dz < ez && h2 < e2 * 0.25);
    const anyPair = (A, B, ez) => {
      const P = vox.pts;
      for (const p of A) for (const q of B) {
        const dx = P[3 * q] - P[3 * p], dy = P[3 * q + 1] - P[3 * p + 1];
        if (links(dx * dx + dy * dy, Math.abs(P[3 * q + 2] - P[3 * p + 2]), ez)) return true;
      }
      return false;
    };
    for (let k = 0; k < n; k++) {
      const i = idx[k], x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
      const ez = Math.min(RING_GAP_MAX, Math.max(eps, RING_GAP * Math.hypot(x - origin[0], y - origin[1])));
      const cx = cell(x), cy = cell(y), cz = cellZ(z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const a = grid.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!a) continue;
        for (const m of a) {
          if (m <= k) continue;
          const j = idx[m], ddx = pts[3 * j] - x, ddy = pts[3 * j + 1] - y, ddz = Math.abs(pts[3 * j + 2] - z);
          let ok = links(ddx * ddx + ddy * ddy, ddz, ez);
          if (!ok && vox) {
            const lx = low(ddx), ly = low(ddy);
            if (!links(lx * lx + ly * ly, low(ddz), ez)) continue;                // too far apart whatever the members
            const ra = find(k), rb = find(m);
            if (ra === rb) continue;
            ok = anyPair(vox.members[i], vox.members[j], ez);
          }
          if (ok) { const ra = find(k), rb = find(m); if (ra !== rb) parent[ra] = rb; }
        }
      }
    }
    const groups = new Map();
    for (let k = 0; k < n; k++) { const r = find(k); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(idx[k]); }
    return [...groups.values()].filter((g) => g.length >= minPts);
  }

  /**
   * Link distance for clustering, from the data: ~2.5x the typical spacing between neighbouring returns on the
   * object (median nearest-neighbour distance of the points in the drawn box), between EPS_MIN (dense LiDAR: as
   * before) and EPS_MAX (cars parked bumper to bumper stay apart). A sparse LiDAR (32 beams, far objects) gets
   * a longer link, so a car stays one cluster instead of pieces that are dropped.
   */
  const EPS_MIN = 0.35, EPS_MAX = 0.7;
  function autoEps(pts, idx) {
    if (idx.length < 6) return EPS_MIN;
    const C = EPS_MAX, grid = new Map(), key = (x, y, z) => `${Math.floor(x / C)},${Math.floor(y / C)},${Math.floor(z / C)}`;
    for (const i of idx) { const k = key(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
    const step = Math.ceil(idx.length / 400), nn = [];
    for (let s = 0; s < idx.length; s += step) {
      const i = idx[s], x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
      const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(z / C);
      let b = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
          if (j === i) continue;
          const d = (pts[3 * j] - x) ** 2 + (pts[3 * j + 1] - y) ** 2 + (pts[3 * j + 2] - z) ** 2;
          if (d < b) b = d;
        }
      }
      nn.push(b < Infinity ? Math.sqrt(b) : EPS_MAX);
    }
    nn.sort((a, b) => a - b);
    return Math.min(EPS_MAX, Math.max(EPS_MIN, 2.5 * nn[nn.length >> 1]));
  }

  /** One point per cell x cell square (top view) of a point list: the outline of a dense cluster (thousands of
   *  returns per car on a dense LiDAR) for the L-shape and the gap test, which only need it to a few cm. */
  const THIN = 0.05;
  function thinIdx(pts, idx, cell = THIN) {
    const seen = new Set(), out = [];
    for (const i of idx) {
      const k = Math.floor(pts[3 * i] / cell) * 1e6 + Math.floor(pts[3 * i + 1] / cell);
      if (!seen.has(k)) { seen.add(k); out.push(i); }
    }
    return out;
  }
  const thinXY = (pts, idx) => Float64Array.from(thinIdx(pts, idx).flatMap((i) => [pts[3 * i], pts[3 * i + 1]]));

  /** L-shape fit (Zhang et al. 2017, closeness criterion) on xy points -> {yaw, cx, cy, l, w}. */
  function lshape(xy, stepDeg = 1) {
    const n = xy.length / 2;
    let best = null;
    for (let d = 0; d < 90; d += stepDeg) {
      const t = (d * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      let a1 = Infinity, A1 = -Infinity, a2 = Infinity, A2 = -Infinity;
      const p1 = new Float64Array(n), p2 = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        p1[i] = x * c + y * s; p2[i] = -x * s + y * c;
        if (p1[i] < a1) a1 = p1[i]; if (p1[i] > A1) A1 = p1[i];
        if (p2[i] < a2) a2 = p2[i]; if (p2[i] > A2) A2 = p2[i];
      }
      let score = 0;
      for (let i = 0; i < n; i++) {
        const d1 = Math.min(A1 - p1[i], p1[i] - a1), d2 = Math.min(A2 - p2[i], p2[i] - a2);
        score += 1 / Math.max(Math.min(d1, d2), 0.05);
      }
      if (!best || score > best.score) best = { score, t, a1, A1, a2, A2 };
    }
    let { t, a1, A1, a2, A2 } = best;
    let l = A1 - a1, w = A2 - a2;
    const m1 = (a1 + A1) / 2, m2 = (a2 + A2) / 2;
    let cx = m1 * Math.cos(t) - m2 * Math.sin(t), cy = m1 * Math.sin(t) + m2 * Math.cos(t);
    if (w > l) { [l, w] = [w, l]; t += Math.PI / 2; }        // x axis = long side
    return { yaw: t, cx, cy, l, w };
  }

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  /** Heading ambiguity: prefer the direction closest to the ego's forward axis (+x). */
  function canonicalYaw(y) { y = wrap(y); if (y > Math.PI / 2) y -= Math.PI; if (y <= -Math.PI / 2) y += Math.PI; return y; }

  function growAway(box, axis, target, origin) {
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    const ax = axis === 'l' ? [c, s] : [-s, c];
    const toSensor = (origin[0] - box.cx) * ax[0] + (origin[1] - box.cy) * ax[1];
    const g = target - box[axis], dir = toSensor > 0 ? -1 : 1;     // extend away from the sensor
    return { ...box, cx: box.cx + (dir * g / 2) * ax[0], cy: box.cy + (dir * g / 2) * ax[1], [axis]: target };
  }

  /** Grow a partly observed box to the class prior. When only one face is seen, try both
   *  "this face is a side" and "this face is the front/back" and keep the better size match. */
  function completeWithPrior(box, prior, origin) {
    if (!prior) return box;
    const [pl, pw] = prior;
    const hyps = [];
    // H1: observed long edge is along the object's length
    let h1 = box;
    if (h1.l < pl * 0.8) h1 = growAway(h1, 'l', pl, origin);
    if (h1.w < pw * 0.8) h1 = growAway(h1, 'w', pw, origin);
    hyps.push({ b: h1, cost: Math.abs(Math.log(Math.max(box.l, 0.1) / pl)) * (box.l > pl * 1.15 ? 3 : 1) });
    // H2: observed long edge is the front/back face (its length ~ object width)
    // (skip when the full width is already seen: then the long edge must be the length)
    if (box.l < pl * 0.75 && box.w < pw * 0.7) {
      let h2 = { ...box, yaw: box.yaw + Math.PI / 2, l: box.w, w: box.l };
      if (h2.l < pl * 0.8) h2 = growAway(h2, 'l', pl, origin);
      if (h2.w < pw * 0.8) h2 = growAway(h2, 'w', pw, origin);
      hyps.push({ b: h2, cost: Math.abs(Math.log(Math.max(box.l, 0.1) / pw)) + 0.05 });
    }
    hyps.sort((a, b) => a.cost - b.cost);
    return hyps[0].b;
  }

  /** Complete a partly seen box so that its projection fills the drawn rectangle: try both
   *  orientations x 4 fixed corners of the observed footprint, sizes from the class prior. */
  function completeWithRect(box, prior, rectIoU) {
    if (!prior) return null;
    const [pl, pw] = prior;
    if (box.l >= pl * 0.8 && box.w >= pw * 0.8) return null;      // fully seen: nothing to complete
    let best = null;
    const orients = [box];
    if (box.l < pl * 0.75) orients.push({ ...box, yaw: box.yaw + Math.PI / 2, l: box.w, w: box.l });
    for (const o of orients) {
      const L = Math.max(o.l, pl), Wd = Math.max(o.w, pw);
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      for (const sl of [-1, 1]) for (const sw of [-1, 1]) {
        // keep the observed corner (sl, sw) fixed, grow towards the opposite corner
        const fx = o.cx + (sl * o.l / 2) * c - (sw * o.w / 2) * s, fy = o.cy + (sl * o.l / 2) * s + (sw * o.w / 2) * c;
        const cx = fx - (sl * L / 2) * c + (sw * Wd / 2) * s, cy = fy - (sl * L / 2) * s - (sw * Wd / 2) * c;
        const cand = { ...o, cx, cy, l: L, w: Wd };
        const sc = rectIoU(cand) - (o === box ? 0 : 0.03);
        if (!best || sc > best.sc) best = { sc, cand };
      }
    }
    return best;
  }

  /**
   * Main entry.
   * xyz: Float32Array cloud (pcd frame); rect: {u0, v0, u1, v1} in image pixels.
   * opts.motion: ego motion around the sweep, for the camera's time offset (projection.js projectCloud).
   * Returns {box, points, ground, candidates, reason?}
   */
  function fitFromRect(xyz, calib, cam, adj, rect, opts = {}) {
    const u0 = Math.min(rect.u0, rect.u1), u1 = Math.max(rect.u0, rect.u1);
    const v0 = Math.min(rect.v0, rect.v1), v1 = Math.max(rect.v0, rect.v1);
    const proj = P.projectCloud(xyz, calib, cam, adj, opts.motion);
    // frustum, plus a wider one: objects that spill out of the rectangle are neighbours/occluders
    const inside = [], wide = [], groundCand = [];
    const du = u1 - u0, dv = v1 - v0;
    const W0 = u0 - du * 1.2, W1 = u1 + du * 1.2, V0 = v0 - dv * 1.0, V1 = v1 + dv * 1.0;
    const n = xyz.length / 3, U = new Float32Array(n), V = new Float32Array(n);   // image position of the wide points
    for (let j = 0; j < proj.u.length; j++) {
      const u = proj.u[j], v = proj.v[j], i = proj.idx[j];
      if (u >= W0 && u <= W1 && v >= V0 && v <= V1) { wide.push(i); U[i] = u; V[i] = v; }
      if (u >= u0 && u <= u1 && v >= v0 && v <= v1) inside.push(i);
      if (u >= u0 - du * 0.2 && u <= u1 + du * 0.2 && v >= v0 && v <= v1 + dv * 0.4) groundCand.push(i);
    }
    if (inside.length < 10) return { box: null, reason: 'Quá ít điểm LiDAR trong khung (' + inside.length + ')' };

    // ground: RANSAC on the lowest 40% below/around the rectangle
    const zs = groundCand.map((i) => xyz[3 * i + 2]).sort((a, b) => a - b);
    const g = fitGround(groundPoints(xyz, groundCand, opts.ground, 0.4)) || [0, 0, zs[Math.floor(zs.length * 0.05)]];
    const gz = (x, y) => g[0] * x + g[1] * y + g[2];
    const clear = opts.groundClear ?? 0.2;
    const isAbove = (i) => xyz[3 * i + 2] - gz(xyz[3 * i], xyz[3 * i + 1]) > clear;
    const insideSet = new Set(inside.filter(isAbove));
    if (insideSet.size < 8) return { box: null, reason: 'Chỉ có điểm mặt đất trong khung' };
    const eps = opts.eps ?? autoEps(xyz, [...insideSet]);
    const clusters = cluster(xyz, wide.filter(isAbove), eps, opts.minPts ?? (eps > EPS_MIN ? 5 : 8), sensorOrigin(calib))
      .filter((cl) => cl.some((i) => insideSet.has(i)));
    if (!clusters.length) return { box: null, reason: 'Không gom được cụm điểm' };
    const area = du * dv;
    let best = null;
    for (const cl of clusters) {
      let a = Infinity, A = -Infinity, b = Infinity, B = -Infinity, nin = 0;
      for (const i of cl) {
        const u = U[i], v = V[i];
        if (u < a) a = u; if (u > A) A = u; if (v < b) b = v; if (v > B) B = v;
        if (insideSet.has(i)) nin++;
      }
      const iw = Math.max(0, Math.min(A, u1) - Math.max(a, u0)), ih = Math.max(0, Math.min(B, v1) - Math.max(b, v0));
      const ext = Math.max(1, (A - a) * (B - b));
      const iou = (iw * ih) / (area + ext - iw * ih);
      const contain = (iw * ih) / ext;                 // ~1: the cluster sits inside the drawn box
      const cover = (iw * ih) / area;                  // how much of the drawn box it explains
      const frac = nin / cl.length;
      // the drawn object is contained in the rectangle; occluders (nearer, bigger) and neighbours spill out
      const score = contain * contain * frac * (0.3 + 0.7 * cover) + 0.03 * Math.min(1, nin / 150);
      if (!best || score > best.score) best = { cl: cl.filter((i) => insideSet.has(i) || frac > 0.85), score, iou };
      cl.frac = frac;
    }
    let cl = mergePieces(xyz, best.cl, clusters, insideSet, priorFor(opts.label));
    // evaluation only (tools/public/eval_boxes.js --oracle): the true object's points (Set of indices) stand in for a
    // perfect step: 'cluster' = the cluster holding most of them is chosen, 'points' = exactly them (above the ground)
    if (opts.oracle) {
      const has = (c) => c.reduce((k, i) => k + opts.oracle.points.has(i), 0);
      if (opts.oracle.mode === 'cluster') cl = clusters.reduce((a, c) => (has(c) > has(a) ? c : a), clusters[0]);
      else cl = [...opts.oracle.points].filter(isAbove);
      if (cl.length < 3) cl = best.cl;
    }

    const fit = fitCluster(xyz, cl, gz, calib, cam, adj, { u0, v0, u1, v1 }, opts);
    return { ...fit, points: cl, nInside: inside.length, frustum: inside, clusterIoU: best.iou, ground: g, candidates: clusters.length };
  }

  const PIECE_GAP = 1.0;                            // m between a piece and the chosen cluster (top view)
  /**
   * One object split into several clusters (a gap in the returns: wheel arch, glass, dark or shiny paint): add the
   * other clusters that lie mostly in the drawn box and within PIECE_GAP of the chosen one, as long as the whole
   * still has the size of the class (an object behind or a parked neighbour makes it too long and is left out).
   * A piece may lengthen the object but not widen it past a vehicle's width (a pole, bush or person beside it would).
   */
  function mergePieces(xyz, chosen, clusters, insideSet, prior) {
    if (!prior || clusters.length < 2) return chosen;
    const T = 0.1, G = PIECE_GAP + T * Math.SQRT2, GAP2 = G * G;   // outlines thinned to T: kept points can be T * sqrt2 farther
    const key = (x, y) => Math.floor(x / G) + ',' + Math.floor(y / G);
    const near = (pts, grid) => pts.some((i) => {
      const x = xyz[3 * i], y = xyz[3 * i + 1], gx = Math.floor(x / G), gy = Math.floor(y / G);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get((gx + a) + ',' + (gy + b)) || [])
        if ((xyz[3 * j] - x) ** 2 + (xyz[3 * j + 1] - y) ** 2 < GAP2) return true;
      return false;
    });
    const foot = (pts) => {                          // smallest rectangle around the points (top view): [long, short]
      const b = lshape(thinXY(xyz, pts), 2);
      return [Math.max(b.l, b.w), Math.min(b.l, b.w)];
    };
    let out = chosen;
    const set = new Set(chosen), maxShort = Math.max(foot(chosen)[1], prior[1]) + 0.15;
    const pieces = clusters.filter((c) => c.frac > 0.6 && !c.some((i) => set.has(i))).map((c) => c.filter((i) => insideSet.has(i)))
      .filter((c) => c.length >= 3).sort((a, b) => b.length - a.length);
    for (const pc of pieces) {
      const grid = new Map();                        // gap test on thinned outlines
      for (const j of thinIdx(xyz, out, T)) { const k = key(xyz[3 * j], xyz[3 * j + 1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(j); }
      if (!near(thinIdx(xyz, pc, T), grid)) continue;
      const all = out.concat(pc), [L, Wd] = foot(all);
      if (L <= prior[0] * 1.2 && Wd <= maxShort) out = all;
    }
    return out;
  }

  const ORIENT_PTS = 40, ORIENT_MARGIN = 0.03;      // few returns: also try the heading turned by 90 deg (see fitCluster)
  /** L-shape + ground + class-prior completion of one cluster. rect (optional) = drawn 2D box. */
  function fitCluster(xyz, cl, gz, calib, cam, adj, rect, opts) {
    let zmax = -Infinity, gsum = 0;
    for (const i of cl) {
      if (xyz[3 * i + 2] > zmax) zmax = xyz[3 * i + 2];
      gsum += gz(xyz[3 * i], xyz[3 * i + 1]);
    }
    let box = lshape(Float64Array.from(cl.flatMap((i) => [xyz[3 * i], xyz[3 * i + 1]])));
    // ground under the object from the whole cloud around it (occluders hide it in the frustum)
    const ring = [];
    for (let i = 0, n = xyz.length / 3; i < n; i += 2) {
      const dx = xyz[3 * i] - box.cx, dy = xyz[3 * i + 1] - box.cy;
      if (dx * dx + dy * dy < 36) ring.push(i);
    }
    let ground = gsum / cl.length;
    // road height under the object from the grown road model: robust far away, where only a few
    // returns are around and the lowest of them may be noise below the road
    const road = opts.ground && opts.ground.height ? opts.ground.height(box.cx, box.cy) : NaN;
    if (road === road && Math.abs(road - ground) < 0.6) ground = road;
    else if (ring.length > 20) {
      const gp = fitGround(groundPoints(xyz, ring, opts.ground, 0.3));
      if (gp) { const z = gp[0] * box.cx + gp[1] * box.cy + gp[2]; if (z < ground + 0.3) ground = Math.min(ground, z); }
    }
    let h = Math.max(0.3, zmax - ground);
    const hObs = h;
    const prior = opts.prior || priorFor(opts.label);
    const byAway = completeWithPrior(box, prior, sensorOrigin(calib));
    if (rect && prior) {
      // Fill the drawn rectangle: LiDAR often misses glass and dark paint, so the visible points
      // under-cover the object. Grow height / length / width (within class limits) until the
      // projection fills the 2D box, keeping every observed point inside.
      const { u0, v0, u1, v1 } = rect, area = (u1 - u0) * (v1 - v0);
      const bbox = (b, hh) => {
        const pr = projectBox({ x: b.cx, y: b.cy, z: ground + hh / 2, yaw: b.yaw, l: b.l, w: b.w, h: hh }, calib, cam, adj, 2, opts.motion).flat();
        if (pr.length < 4) return null;
        let a = Infinity, A = -Infinity, c = Infinity, C = -Infinity;
        for (const [u, v] of pr) { if (u < a) a = u; if (u > A) A = u; if (v < c) c = v; if (v > C) C = v; }
        return [a, A, c, C];
      };
      const iouOf = (b, hh) => {
        const q = bbox(b, hh); if (!q) return -1;
        const [a, A, c, C] = q;
        const iw = Math.max(0, Math.min(A, u1) - Math.max(a, u0)), ih = Math.max(0, Math.min(C, v1) - Math.max(c, v0));
        return (iw * ih) / (area + (A - a) * (C - c) - iw * ih);
      };
      const fitH = (b) => {                       // raise the roof until the top edge reaches the rectangle top
        const lo = hObs, hi = Math.max(hObs, prior[2] * 1.35);
        const top = (hh) => { const q = bbox(b, hh); return q ? q[2] : Infinity; };
        if (top(lo) <= v0 + 2) return lo;
        if (top(hi) > v0 + 2) return hi;
        let l = lo, r = hi;
        for (let k = 0; k < 14; k++) { const m = (l + r) / 2; if (top(m) <= v0 + 2) r = m; else l = m; }
        return r;
      };
      const [pl, pw] = prior;
      const orients = [box];
      if (box.l < pl * 0.75 && box.w < pw * 0.7) orients.push({ ...box, yaw: box.yaw + Math.PI / 2, l: box.w, w: box.l });
      h = fitH(byAway);
      let best = { sc: iouOf(byAway, h) - 0.01, cand: byAway };
      // Few returns: the L-shape heading is a guess (the box turned by 90 deg fits the points as well). Try it
      // with the class size and keep it when its projection matches the drawn rectangle clearly better.
      if (cl.length < ORIENT_PTS && pl >= 3) {        // vehicles; two-wheelers are too thin to tell
        let alt = { ...box, yaw: box.yaw + Math.PI / 2, l: box.w, w: box.l };
        if (alt.l < pl * 0.8) alt = growAway(alt, 'l', pl, sensorOrigin(calib));
        if (alt.w < pw * 0.8) alt = growAway(alt, 'w', pw, sensorOrigin(calib));
        const ha = fitH(alt), sa = iouOf(alt, ha) - 0.01;
        if (sa > best.sc + ORIENT_MARGIN) { best = { sc: sa, cand: alt }; h = ha; orients.push(alt); }
      }
      // only search sizes when the usual fit clearly under-fills the drawn box (missing returns)
      if (best.sc < 0.74) for (const o of orients) {
        const Ls = new Set([o.l, pl]), Ws = new Set([o.w, pw]);
        for (let k = 0; k <= 6; k++) { Ls.add(o.l + (Math.max(o.l, pl * 1.25) - o.l) * k / 6); Ws.add(o.w + (Math.max(o.w, pw * 1.2) - o.w) * k / 6); }
        const c = Math.cos(o.yaw), sn = Math.sin(o.yaw);
        for (const L of Ls) for (const Wd of Ws) for (const sl of [-1, 1]) for (const sw of [-1, 1]) {
          if (L < o.l - 1e-9 || Wd < o.w - 1e-9) continue;
          const fx = o.cx + (sl * o.l / 2) * c - (sw * o.w / 2) * sn, fy = o.cy + (sl * o.l / 2) * sn + (sw * o.w / 2) * c;
          const cand = { ...o, cx: fx - (sl * L / 2) * c + (sw * Wd / 2) * sn, cy: fy - (sl * L / 2) * sn - (sw * Wd / 2) * c, l: L, w: Wd };
          const sc = iouOf(cand, h) - 0.04 * (Math.abs(Math.log(L / pl)) + Math.abs(Math.log(Wd / pw)));
          if (sc > best.sc) best = { sc, cand };
        }
      }
      box = best.cand;
      h = fitH(box);
    } else {
      box = byAway;
      if (prior && h < prior[2] * 0.75) h = prior[2];   // click mode: roof not seen -> class height
    }
    return { box: { x: box.cx, y: box.cy, z: ground + h / 2, yaw: canonicalYaw(box.yaw), l: box.l, w: box.w, h } };
  }

  /**
   * One click on the image -> 3D box. The LiDAR point under the click seeds a 3D region grow, so
   * cars parked bumper to bumper still come out separately (they are > eps apart in 3D).
   */
  function fitFromClick(xyz, calib, cam, adj, click, opts = {}) {
    const proj = P.projectCloud(xyz, calib, cam, adj, opts.motion);
    let cand = [];
    for (const R of [8, 16, 32]) {
      cand = [];
      for (let j = 0; j < proj.u.length; j++) {
        const du = proj.u[j] - click.u, dv = proj.v[j] - click.v;
        if (du * du + dv * dv <= R * R) cand.push([proj.idx[j], proj.range[j]]);
      }
      if (cand.length >= 5) break;
    }
    if (cand.length < 3) return { box: null, reason: 'Không có điểm LiDAR dưới chỗ click (thử click vào thân vật thể)' };
    // local ground around the clicked area
    const mx = cand.reduce((s, [i]) => s + xyz[3 * i], 0) / cand.length, my = cand.reduce((s, [i]) => s + xyz[3 * i + 1], 0) / cand.length;
    const near = [];
    for (let i = 0, n = xyz.length / 3; i < n; i++) {
      const dx = xyz[3 * i] - mx, dy = xyz[3 * i + 1] - my;
      if (dx * dx + dy * dy < 64) near.push(i);
    }
    const zs = near.map((i) => xyz[3 * i + 2]).sort((a, b) => a - b);
    const g = fitGround(groundPoints(xyz, near, opts.ground, 0.3)) || [0, 0, zs[Math.floor(zs.length * 0.05)]];
    const gz = (x, y) => g[0] * x + g[1] * y + g[2];
    const clear = opts.groundClear ?? 0.2;
    const above = (i) => xyz[3 * i + 2] - gz(xyz[3 * i], xyz[3 * i + 1]) > clear;
    const objCand = cand.filter(([i]) => above(i)).sort((a, b) => a[1] - b[1]);
    if (!objCand.length) return { box: null, reason: 'Chỗ click là mặt đất' };
    const seed = objCand[Math.min(objCand.length - 1, Math.floor(objCand.length * 0.15))][0];
    // region grow inside a 7 m neighbourhood of the seed
    const sx = xyz[3 * seed], sy = xyz[3 * seed + 1];
    const region = [];
    for (let i = 0, n = xyz.length / 3; i < n; i++) {
      const dx = xyz[3 * i] - sx, dy = xyz[3 * i + 1] - sy;
      if (dx * dx + dy * dy < 49 && above(i)) region.push(i);
    }
    const cl = cluster(xyz, region, opts.eps ?? 0.35, 3, sensorOrigin(calib)).find((c) => c.includes(seed));
    if (!cl || cl.length < 8) return { box: null, reason: 'Vật thể quá ít điểm LiDAR' };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of cl) { const x = xyz[3 * i], y = xyz[3 * i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (Math.hypot(x1 - x0, y1 - y0) > 13) return { box: null, reason: 'Cụm điểm quá lớn (tường/cây/dải phân cách?): hãy kéo khung thay vì click' };
    const fit = fitCluster(xyz, cl, gz, calib, cam, adj, null, opts);
    return { ...fit, points: cl, nInside: cand.length, seed, ground: g };
  }

  /** Keep the user's heading, re-fit centre / length / width to the object's points (then complete
   *  a partial view with the class prior, away from the sensor). Height and ground are kept. */
  function refitAtYaw(xyz, points, box, yaw, opts = {}) {
    if (!points || points.length < 3) return { ...box, yaw };
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let a1 = Infinity, A1 = -Infinity, a2 = Infinity, A2 = -Infinity;
    for (const i of points) {
      const x = xyz[3 * i], y = xyz[3 * i + 1], p1 = x * c + y * s, p2 = -x * s + y * c;
      if (p1 < a1) a1 = p1; if (p1 > A1) A1 = p1; if (p2 < a2) a2 = p2; if (p2 > A2) A2 = p2;
    }
    const m1 = (a1 + A1) / 2, m2 = (a2 + A2) / 2;
    let fp = { yaw, cx: m1 * c - m2 * s, cy: m1 * s + m2 * c, l: A1 - a1, w: A2 - a2 };
    const prior = opts.prior || priorFor(opts.label);
    if (prior) {                         // grow only the missing part, never shrink below what is seen
      const origin = opts.origin || sensorOrigin(opts.calib);
      if (fp.l < prior[0] * 0.8) fp = growAway(fp, 'l', prior[0], origin);
      if (fp.w < prior[1] * 0.8) fp = growAway(fp, 'w', prior[1], origin);
    }
    return { ...box, x: fp.cx, y: fp.cy, yaw, l: Math.max(fp.l, 0.2), w: Math.max(fp.w, 0.2) };
  }

  /**
   * Road ground by region growing on a 0.5 m grid, starting from the road around the ego car: a
   * neighbouring cell joins when its lowest return is within STEP of the current cell (smooth road,
   * slopes, flat verges), so a raised planter, kerb or traffic island (a step of 15-40 cm) is NOT
   * ground even when it is right next to the road. Small gaps (shadows, under cars) are bridged.
   * A point is ground when it is within 0.15 m above its cell's ground height.
   * Returns a Uint8Array mask; mask.height(x, y) gives the road height (NaN where unknown).
   */
  function groundMask(xyz) {
    const n = xyz.length / 3, C = 0.5, O = 20000, B = 40000, STEP = 0.09, TOL = 0.1;
    // far away the scan rings are metres apart: the gaps that may be bridged grow with range
    const maxGap = (cx, cy) => Math.max(4, Math.round(0.12 * Math.hypot(cx * C, cy * C) / C));
    const key = (cx, cy) => (cx + O) * B + (cy + O);
    const cmin = new Map();
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(xyz[3 * i] / C), Math.floor(xyz[3 * i + 1] / C)), z = xyz[3 * i + 2], m = cmin.get(k);
      if (m === undefined || z < m) cmin.set(k, z);
    }
    // seeds: cells 3-8 m around the sensor at the common (road) level
    const near = [];
    for (const [k, z] of cmin) {
      const cx = Math.floor(k / B) - O, cy = (k % B) - O, r = Math.hypot((cx + 0.5) * C, (cy + 0.5) * C);
      if (r > 3 && r < 8) near.push([k, z]);
    }
    const g = new Map(), bridged = new Set();          // cell -> road height (grown); gap cells crossed
    if (near.length) {
      // the road is the lowest surface around the car: seed at a low percentile, tightly. (A median with a
      // 20 cm band let a planter / median kerb beside the car seed the road too: its top became "ground".)
      const zs = near.map((q) => q[1]).sort((a, b2) => a - b2), zRoad = zs[Math.floor(zs.length * 0.2)];
      const queue = [];
      for (const [k, z] of near) if (Math.abs(z - zRoad) < 0.1) { g.set(k, z); queue.push([k, z, 0, 0]); }
      for (let qi = 0; qi < queue.length; qi++) {
        const [k, zc, gap, empty] = queue[qi], cx = Math.floor(k / B) - O, cy = (k % B) - O;   // empty: cells without returns crossed
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nk = key(cx + dx, cy + dy);
          if (g.has(nk)) continue;
          const z = cmin.get(nk);
          // across empty cells (sparse far rings) the road may have climbed a little; across cells with
          // something on them (car, pole, planter) it may not: a planter top must not join the road
          // (only far out, > 20 m: nearer, an empty stretch is the shadow behind a kerb / planter)
          const relax = Math.hypot(cx * C, cy * C) > 20 ? 0.04 * empty * C : 0;
          if (z !== undefined && Math.abs(z - zc) <= STEP + relax) { g.set(nk, z); queue.push([nk, z, 0, 0]); }
          else if ((z === undefined || z > zc + STEP) && gap < maxGap(cx, cy) && !bridged.has(nk)) {
            bridged.add(nk); queue.push([nk, zc, gap + 1, empty + (z === undefined ? 1 : 0)]);
          }
        }
      }
    }
    // far away (> 20 m) single cells are unreliable (rings metres apart; the lowest returns of a car
    // or motorbike can pass for road): use a robust plane through the grown cells around instead
    const bins = new Map(), BIN = 4;                  // grown cells pooled in 4 m bins
    const planeCache = new Map();
    function pool() {
      bins.clear(); planeCache.clear();
      for (const [k, z] of g) {
        const cx = Math.floor(k / B) - O, cy = (k % B) - O, bk = `${Math.floor(cx * C / BIN)},${Math.floor(cy * C / BIN)}`;
        let b = bins.get(bk); if (!b) bins.set(bk, (b = [])); b.push([(cx + 0.5) * C, (cy + 0.5) * C, z]);
      }
    }
    function farPlane(x, y) {
      const bx = Math.floor(x / BIN), by = Math.floor(y / BIN), ck = `${bx},${by}`;
      if (planeCache.has(ck)) return planeCache.get(ck);
      let pts = [];
      for (const R of [3, 5]) {                       // 12 m around, 20 m if too few cells
        pts = [];
        for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) { const b = bins.get(`${bx + dx},${by + dy}`); if (b) pts.push(...b); }
        if (pts.length >= 30) break;
      }
      let pl = null;
      for (let pass = 0; pass < 3 && pts.length >= 10; pass++) {   // least squares, then drop > 8 cm off
        let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
        for (const [px, py, pz] of pts) { sxx += px * px; sxy += px * py; sx += px; syy += py * py; sy += py; sxz += px * pz; syz += py * pz; sz += pz; }
        const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, pts.length]], bb = [sxz, syz, sz];
        const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        const D = det(A); if (Math.abs(D) < 1e-9) break;
        const sol = [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, j) => (j === c ? bb[r] : v)))) / D);
        pl = sol;
        const kept = pts.filter(([px, py, pz]) => Math.abs(pz - (sol[0] * px + sol[1] * py + sol[2])) < 0.08);
        if (kept.length === pts.length) break;
        pts = kept;
      }
      planeCache.set(ck, pl);
      return pl;
    }
    // the relaxed step across sparse far cells can climb onto a long planter / median top, and the flood
    // then follows that flat top back to the car: drop grown cells well above the robust local road plane
    pool();
    for (const [k, z] of [...g]) {
      const x = (Math.floor(k / B) - O + 0.5) * C, y = ((k % B) - O + 0.5) * C, pl = farPlane(x, y);
      if (pl && z - (pl[0] * x + pl[1] * y + pl[2]) > 0.12) g.delete(k);
    }
    pool();
    const height = (x, y) => {
      if (Math.hypot(x, y) > 20) { const pl = farPlane(x, y); if (pl) return pl[0] * x + pl[1] * y + pl[2]; }
      const cx = Math.floor(x / C), cy = Math.floor(y / C);
      let z = g.get(key(cx, cy));
      if (z !== undefined) return z;
      let s2 = 0, m = 0;                               // under an object: mean of the grown neighbours
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) { const v = g.get(key(cx + dx, cy + dy)); if (v !== undefined) { s2 += v; m++; } }
      return m ? s2 / m : NaN;
    };
    const mask = new Uint8Array(n), hcache = new Map();
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xyz[3 * i] / C), cy = Math.floor(xyz[3 * i + 1] / C), k = key(cx, cy);
      let h = g.get(k);
      if (h === undefined || Math.abs(cx) * C > 20 || Math.abs(cy) * C > 20) { if (!hcache.has(k)) hcache.set(k, height(xyz[3 * i], xyz[3 * i + 1])); h = hcache.get(k); }
      mask[i] = h === h && xyz[3 * i + 2] < h + TOL ? 1 : 0;
    }
    mask.height = height;
    return mask;
  }
  /**
   * Points that can belong to a road user (car, truck, bus, two-wheeler, pedestrian), for a clean view:
   * drops everything higher than maxH above the road (tree crowns, billboards, upper floors, wires),
   * then clusters the rest on a 0.3 m voxel grid and drops clusters that cannot be a road user:
   * floating (lowest point > 1.2 m above the road: branches, sign panels), thin and tall (poles, trunks),
   * or longer than 14 m (walls, hedges, facades). Display only: box fitting keeps the full cloud.
   */
  function objectMask(xyz, ground, maxH = 4.2) {
    const n = xyz.length / 3, V = 0.3, O = 30000, B = 60000, hr = new Float32Array(n), vox = new Map(), keep = new Uint8Array(n);
    const vkey = (x, y, z) => ((Math.floor(x / V) + O) * B + (Math.floor(y / V) + O)) * 64 + Math.max(0, Math.min(63, Math.floor(z / V) + 20));
    for (let i = 0; i < n; i++) {
      if (ground && ground[i]) continue;
      const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
      const r = ground && ground.height ? ground.height(x, y) : NaN;
      const h = r === r ? z - r : NaN;
      if (h === h && (h > maxH || h < -0.3)) continue;
      hr[i] = h === h ? h : 0.5;                        // unknown road height (far): keep, assume touching
      const k = vkey(x, y, z); let a = vox.get(k); if (!a) vox.set(k, (a = [])); a.push(i);
    }
    // union-find over occupied voxels (26-neighbourhood)
    const keys = [...vox.keys()], id = new Map(keys.map((k, j) => [k, j])), parent = new Int32Array(keys.length).map((_, j) => j);
    const find = (j) => { while (parent[j] !== j) { parent[j] = parent[parent[j]]; j = parent[j]; } return j; };
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j], zc = k % 64, xy = (k - zc) / 64, cy = xy % B, cx = (xy - cy) / B;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const z2 = zc + dz; if (z2 < 0 || z2 > 63) continue;
        const o = id.get(((cx + dx) * B + (cy + dy)) * 64 + z2);
        if (o !== undefined && o > j) { const a = find(j), b = find(o); if (a !== b) parent[a] = b; }
      }
    }
    const stat = new Map();
    for (let j = 0; j < keys.length; j++) {
      const r = find(j); let s2 = stat.get(r);
      if (!s2) stat.set(r, (s2 = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, h0: Infinity, h1: -Infinity, nv: 0, lx0: Infinity, lx1: -Infinity, ly0: Infinity, ly1: -Infinity }));
      s2.nv++;
      for (const i of vox.get(keys[j])) {
        const x = xyz[3 * i], y = xyz[3 * i + 1];
        if (x < s2.x0) s2.x0 = x; if (x > s2.x1) s2.x1 = x; if (y < s2.y0) s2.y0 = y; if (y > s2.y1) s2.y1 = y;
        if (hr[i] < s2.h0) s2.h0 = hr[i]; if (hr[i] > s2.h1) s2.h1 = hr[i];
        if (hr[i] < 1.0) { if (x < s2.lx0) s2.lx0 = x; if (x > s2.lx1) s2.lx1 = x; if (y < s2.ly0) s2.ly0 = y; if (y > s2.ly1) s2.ly1 = y; }
      }
    }
    for (const s2 of stat.values()) {
      const ext = Math.hypot(s2.x1 - s2.x0, s2.y1 - s2.y0), side = Math.max(s2.x1 - s2.x0, s2.y1 - s2.y0);
      // footprint at the bottom (< 1 m above the road): a road user stands on most of its outline,
      // a tree / billboard only on a trunk or pole
      const low = s2.lx1 >= s2.lx0 ? Math.max(s2.lx1 - s2.lx0, s2.ly1 - s2.ly0) : 0;
      const pole = side < 0.6 && s2.h1 - s2.h0 > 2.2;
      const crown = side > 1.5 && s2.h1 > 2.0 && low < 0.35 * side;
      const structure = s2.h1 > maxH - 0.2 && side > 6;             // taller than any vehicle and long: facade, tall wall
      s2.ok = s2.nv >= 2 && s2.h0 < 1.2 && ext < 14 && !pole && !crown && !structure;
    }
    for (let j = 0; j < keys.length; j++) if (stat.get(find(j)).ok) for (const i of vox.get(keys[j])) keep[i] = 1;
    return keep;
  }
  /** Ground points for a plane fit among candidate indices: the road points of the ground mask when
   *  there are enough of them (never a planter top / kerb), else the lowest share of the candidates. */
  function groundPoints(xyz, idx, ground, share = 0.3) {
    if (ground) {
      const gi = idx.filter((i) => ground[i]);
      if (gi.length >= 20) return new Float32Array(gi.flatMap((i) => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]));
    }
    const zs = idx.map((i) => xyz[3 * i + 2]).sort((a, b2) => a - b2), cut = zs[Math.floor(zs.length * share)];
    return new Float32Array(idx.filter((i) => xyz[3 * i + 2] <= cut).flatMap((i) => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]));
  }

  // ---------------------------------------------------------------- full 3D orientation
  // CVAT stores a cuboid's rotation as three.js Euler angles (rx, ry, rz = yaw), order XYZ:
  // R = Rx(rx) * Ry(ry) * Rz(rz). Boxes here carry .yaw (= rz) and optional .rx, .ry (0 when level).
  function rotMat(b) {
    const a = b.rx || 0, c = b.ry || 0, y = b.yaw;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(c), sb = Math.sin(c), cy = Math.cos(y), sy = Math.sin(y);
    // rows of Rx*Ry*Rz
    return [
      [cb * cy, -cb * sy, sb],
      [ca * sy + sa * sb * cy, ca * cy - sa * sb * sy, -sa * cb],
      [sa * sy - ca * sb * cy, sa * cy + ca * sb * sy, ca * cb],
    ];
  }
  /** Box-frame (along length, along width, up) -> pcd frame. */
  function toWorld(b, u, v, w) {
    const R = rotMat(b);
    return [b.x + R[0][0] * u + R[0][1] * v + R[0][2] * w, b.y + R[1][0] * u + R[1][1] * v + R[1][2] * w, b.z + R[2][0] * u + R[2][1] * v + R[2][2] * w];
  }
  /** Tilt expressed the way an annotator thinks of it: pitch = nose up (+) / down about the box's
   *  width axis, roll = left side up (+) about its length axis (radians). */
  function pitchRollOf(b) {
    const R = rotMat(b), up = [R[0][2], R[1][2], R[2][2]];
    const fa = [Math.cos(b.yaw), Math.sin(b.yaw)], fb = [-Math.sin(b.yaw), Math.cos(b.yaw)];
    return { pitch: -Math.asin(up[0] * fa[0] + up[1] * fa[1]), roll: -Math.asin(up[0] * fb[0] + up[1] * fb[1]) };
  }
  /** Set the box's up axis from pitch / roll (heading kept); returns {rx, ry}. */
  function tiltFromPitchRoll(yaw, pitch, roll) {
    const ua = -Math.sin(pitch), ub = -Math.sin(roll), uz = Math.sqrt(Math.max(0, 1 - ua * ua - ub * ub));
    const ux = ua * Math.cos(yaw) - ub * Math.sin(yaw), uy = ua * Math.sin(yaw) + ub * Math.cos(yaw);
    return tiltFromUp([ux, uy, uz]);
  }
  /** Set the heading, wrapped to (-180°, 180°]; a tilted box keeps its pitch / roll (pr: read before the box changed). */
  function setYaw(b, yaw, pr = pitchRollOf(b)) {
    b.yaw = wrap(yaw);
    if (b.rx || b.ry) Object.assign(b, tiltFromPitchRoll(b.yaw, pr.pitch, pr.roll));
    return b;
  }
  /** rx, ry that point the box's up axis along `up` (unit): third column of Rx*Ry*Rz = (sin ry, -sin rx cos ry, cos rx cos ry). */
  function tiltFromUp(up) {
    const ry = Math.asin(Math.max(-1, Math.min(1, up[0])));
    const rx = Math.atan2(-up[1], up[2]);
    return { rx, ry };
  }
  /** Stand the box on a ground plane z = a x + b y + c: up axis = plane normal, bottom face on the plane. */
  function alignToGround(b, plane) {
    const [a, bb, c] = plane, n = Math.hypot(a, bb, 1), up = [-a / n, -bb / n, 1 / n];
    const t = tiltFromUp(up), out = { ...b, ...t };
    const gz = a * b.x + bb * b.y + c;                              // ground point under the centre
    out.x = b.x + (b.h / 2) * up[0]; out.y = b.y + (b.h / 2) * up[1]; out.z = gz + (b.h / 2) * up[2];   // bottom centre on it
    return out;
  }
  /** Ground plane under a box from the cloud (low points within 6 m), or null. */
  function groundUnder(xyz, b, ground) {
    const ring = [];
    for (let i = 0, n = xyz.length / 3; i < n; i++) {
      const dx = xyz[3 * i] - b.x, dy = xyz[3 * i + 1] - b.y;
      if (dx * dx + dy * dy < 36) ring.push(i);
    }
    if (ring.length < 30) return null;
    return fitGround(groundPoints(xyz, ring, ground, 0.3), 200, 0.06);
  }

  /** 8 corners of a box in the pcd frame (index bits: length, width, height; 4..7 = front face). */
  function corners(b) {
    const out = [];
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) out.push(toWorld(b, (dx * b.l) / 2, (dy * b.w) / 2, (dz * b.h) / 2));
    return out;
  }
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  /** Projected polylines of the 12 edges (sampled, so lens distortion bends them correctly). */
  function projectBox(b, calib, cam, adj, steps = 16, motion = null) {
    const cs = corners(b), pts = [];
    for (const [a, z] of EDGES) for (let k = 0; k <= steps; k++) {
      const t = k / steps; pts.push(...[0, 1, 2].map((d) => cs[a][d] + (cs[z][d] - cs[a][d]) * t));
    }
    const pr = P.projectCloud(new Float32Array(pts), calib, cam, adj, motion);
    const byIdx = new Map(); pr.idx.forEach((i, j) => byIdx.set(i, [pr.u[j], pr.v[j]]));
    return EDGES.map((_, e) => {
      const seg = []; let cur = [];
      for (let k = 0; k <= steps; k++) {
        const p = byIdx.get(e * (steps + 1) + k);
        if (p) cur.push(p); else if (cur.length) { seg.push(cur); cur = []; }
      }
      if (cur.length) seg.push(cur);
      return seg;
    }).flat().filter((s) => s.length > 1);
  }

  /** Bird's-eye IoU of two boxes {x, y, yaw, l, w} (convex polygon clipping). */
  function bevIoU(a, b) {
    const poly = (q) => { const c = Math.cos(q.yaw), s = Math.sin(q.yaw);
      return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) => [q.x + (i * q.l / 2) * c - (j * q.w / 2) * s, q.y + (i * q.l / 2) * s + (j * q.w / 2) * c]); };
    let out = poly(a);
    const cl = poly(b);
    for (let i = 0; i < 4 && out.length; i++) {
      const p0 = cl[i], p1 = cl[(i + 1) % 4], inp = out; out = [];
      const side = (p) => (p1[0] - p0[0]) * (p[1] - p0[1]) - (p1[1] - p0[1]) * (p[0] - p0[0]);
      for (let k = 0; k < inp.length; k++) {
        const p = inp[k], q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
      }
    }
    let inter = 0;
    for (let i = 0; i < out.length; i++) { const p = out[i], q = out[(i + 1) % out.length]; inter += p[0] * q[1] - q[0] * p[1]; }
    inter = Math.abs(inter) / 2;
    return inter / (a.l * a.w + b.l * b.w - inter);
  }
  /** Two 3D boxes of one object (e.g. built from two cameras' views of it): footprints overlap, or centres < 1 m. */
  const sameObject = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1.0 || bevIoU(a, b) > 0.1;

  function toCvatPoints(b) { return [b.x, b.y, b.z, b.rx || 0, b.ry || 0, b.yaw, b.l, b.w, b.h, 0, 0, 0, 0, 0, 0, 0]; }
  function fromCvatPoints(p) { return { x: p[0], y: p[1], z: p[2], rx: p[3] || 0, ry: p[4] || 0, yaw: p[5], l: p[6], w: p[7], h: p[8] }; }

  const api = { bevIoU, sameObject, fitFromRect, fitFromClick, fitCluster, refitAtYaw, projectBox, corners, toCvatPoints, fromCvatPoints, priorFor, lshape, canonicalYaw,
    fitGround, cluster, sensorOrigin, groundMask, groundPoints, objectMask, rotMat, toWorld, wrap, pitchRollOf, tiltFromPitchRoll, setYaw, tiltFromUp, alignToGround, groundUnder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxFit = api;
})(typeof self !== 'undefined' ? self : this);
