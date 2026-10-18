/*
 * Calibration from clicked point pairs. A pair is a LiDAR point (pcd frame: the real 3D point) and
 * the pixel where that point really is in the image. Pairs from any frame or job of the same car can
 * be mixed: the pcd frame is the sensor frame of every sweep.
 * The solver fits the same 7 deltas as the calib sliders (pan, tilt, roll in degrees, dx, dy, dz in
 * metres, f scale) on top of the camera's calibration, so the result shows on the sliders and is saved
 * or exported like a manual adjustment. Levenberg-Marquardt with Huber weights (a few bad clicks do
 * not drag the camera) and a weak prior towards the stored calibration (few or badly spread pairs
 * cannot move it far).
 * Guardrails: few or bunched-up pairs only turn the camera (rotation-only); every solve is checked by
 * leave-one-out (each pair predicted by a fit without it) and against plausible limits, and `ok` says
 * whether to apply it. measure() reports the error of a calibration without changing anything.
 */
(function (root) {
  'use strict';
  const P = root.LidarProjection || (typeof require !== 'undefined' ? require('./projection.js') : null);
  const KEYS = ['pan', 'tilt', 'roll', 'dx', 'dy', 'dz', 'fscale'];
  const STEP = [1e-3, 1e-3, 1e-3, 1e-4, 1e-4, 1e-4, 1e-5];      // finite differences (deg, m, ×)
  const SIGMA = [3, 3, 3, 0.3, 0.3, 0.3, 0.05];                  // prior 1-sigma around the stored calib
  const CENTER = [0, 0, 0, 0, 0, 0, 1];
  const MISS = 50;                                               // px for a point off the image / behind
  const MIN_PAIRS = 4;
  const ROT = 3;                                                 // rotation-only: pan, tilt, roll free
  const FULL_MIN = { pairs: 10, cells: 4 };                      // below this (pairs, 3x3 cells hit): rotation-only
  const LIMIT = { move: 0.15, fscale: 0.02 };                    // m, ×: beyond this the result is implausible
  const FAR = 80;                                                // px: a click this far off is likely another point

  const toAdj = (x, base) => ({ ...base, ...Object.fromEntries(KEYS.map((k, i) => [k, x[i]])) });

  /** Residuals [du0, dv0, du1, ...] (px) of every pair under `adj`. */
  function residuals(calib, cam, adj, pairs) {
    const xyz = new Float32Array(pairs.length * 3);
    pairs.forEach((p, i) => xyz.set(p.xyz, 3 * i));
    const pr = P.projectCloud(xyz, calib, cam, adj);
    const r = new Float64Array(pairs.length * 2).fill(MISS);
    pr.idx.forEach((i, j) => { r[2 * i] = pr.u[j] - pairs[i].uv[0]; r[2 * i + 1] = pr.v[j] - pairs[i].uv[1]; });
    return r;
  }
  const pairErrors = (r) => Array.from({ length: r.length / 2 }, (_, i) => Math.hypot(r[2 * i], r[2 * i + 1]));
  const rms = (e) => Math.sqrt(e.reduce((a, x) => a + x * x, 0) / e.length);
  const huberW = (e, h) => (e <= h ? 1 : h / e);
  function cost(r, x, h, priorW, nFree) {
    let c = 0;
    for (const e of pairErrors(r)) c += e <= h ? e * e : 2 * h * e - h * h;
    for (let j = 0; j < nFree; j++) c += priorW * ((x[j] - CENTER[j]) / SIGMA[j]) ** 2;
    return c;
  }
  function stats(e) {
    const s = [...e].sort((a, b) => a - b), q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
    return { n: s.length, rms: rms(s), median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
  }
  /** How many cells of a 3x3 grid over the image the clicked pixels cover (spread of the pairs). */
  function coverage(calib, cam, pairs) {
    const [W, H] = calib.cameras[cam].image_size || [1920, 1536], hit = new Set();
    for (const p of pairs) hit.add(Math.min(2, Math.max(0, Math.floor(3 * p.uv[0] / W))) * 3 + Math.min(2, Math.max(0, Math.floor(3 * p.uv[1] / H))));
    return hit.size;
  }
  /** Error of a calibration on the pairs, nothing changed: {n, rms, median, p90, max, errors, cells}. */
  function measure(calib, cam, adj, pairs) {
    const errors = pairErrors(residuals(calib, cam, adj, pairs));
    return { ...stats(errors), errors, cells: coverage(calib, cam, pairs) };
  }
  /** Solve A x = b (small dense system, partial pivoting). */
  function solveLinear(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /** Levenberg-Marquardt over the first nFree deltas (the rest stay as in adj0). */
  function fit(calib, cam, base, pairs, nFree, { iters, huber, priorW }) {
    let x = KEYS.map((k, i) => (base[k] ?? CENTER[i]));
    let r = residuals(calib, cam, toAdj(x, base), pairs), c = cost(r, x, huber, priorW, nFree), lambda = 1e-3;
    for (let it = 0; it < iters; it++) {
      const w = pairErrors(r).map((e) => huberW(e, huber));
      const J = KEYS.slice(0, nFree).map((_, j) => {
        const xs = x.slice(); xs[j] += STEP[j];
        const rj = residuals(calib, cam, toAdj(xs, base), pairs);
        return Array.from(rj, (v, i) => (v - r[i]) / STEP[j]);
      });
      const n = nFree, A = [...Array(n)].map(() => new Array(n).fill(0)), g = new Array(n).fill(0);
      for (let i = 0; i < r.length; i++) {
        const wi = w[i >> 1];
        for (let a = 0; a < n; a++) {
          g[a] += wi * J[a][i] * r[i];
          for (let b = a; b < n; b++) A[a][b] += wi * J[a][i] * J[b][i];
        }
      }
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < a; b++) A[a][b] = A[b][a];
        A[a][a] += priorW / SIGMA[a] ** 2;
        g[a] += priorW * (x[a] - CENTER[a]) / SIGMA[a] ** 2;
      }
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) : v)));
        const d = solveLinear(Ad, g.map((v) => -v));
        const xn = x.map((v, j) => (j < n ? v + d[j] : v));
        const rn = residuals(calib, cam, toAdj(xn, base), pairs), cn = cost(rn, xn, huber, priorW, nFree);
        if (cn < c) {
          improved = true;
          const done = (c - cn) < 1e-9 * c;
          x = xn; r = rn; c = cn; lambda = Math.max(lambda / 10, 1e-9);
          if (done) it = iters;
        } else lambda *= 10;
      }
      if (!improved) break;
    }
    return { adj: toAdj(x.map((v) => +v.toFixed(6)), base), r };
  }

  /**
   * pairs: [{xyz: [x, y, z] (pcd frame), uv: [u, v] (image px)}]; adj0: current slider deltas.
   * mode: 'auto' (rotation-only when the pairs are few or bunched up), 'full' or 'rot'.
   * Returns {adj, mode, before, after, loo: {rms, median, p90, max} px, errors: px per pair after the fit,
   *          ok, reasons: why not to apply it, suspect: pairs still > FAR px off (likely wrong clicks)}. loo = each pair's error under a fit without it.
   */
  function solve(calib, cam, adj0, pairs, { iters = 40, huber = 3, priorW = 1, mode = 'auto', loo = true } = {}) {
    if (pairs.length < MIN_PAIRS) throw new Error(`cần ít nhất ${MIN_PAIRS} cặp điểm (đang có ${pairs.length})`);
    const base = adj0 || {}, opt = { iters, huber, priorW };
    const cells = coverage(calib, cam, pairs);
    const m = mode !== 'auto' ? mode : pairs.length >= FULL_MIN.pairs && cells >= FULL_MIN.cells ? 'full' : 'rot';
    const nFree = m === 'rot' ? ROT : KEYS.length;
    const before = stats(pairErrors(residuals(calib, cam, base, pairs)));
    const { adj, r } = fit(calib, cam, base, pairs, nFree, opt);
    const errors = pairErrors(r), out = { adj, mode: m, cells, before, after: stats(errors), errors, ok: true, reasons: [] };
    if (!loo) return out;
    const looErr = pairs.map((p, i) => {
      const f = fit(calib, cam, base, pairs.filter((_, j) => j !== i), nFree, { ...opt, iters: 20 });
      return pairErrors(residuals(calib, cam, f.adj, [p]))[0];
    });
    out.loo = stats(looErr);
    const moved = Math.hypot(adj.dx || 0, adj.dy || 0, adj.dz || 0), fs = Math.abs((adj.fscale ?? 1) - 1);
    if (moved > LIMIT.move) out.reasons.push(`camera dời ${(100 * moved).toFixed(0)} cm (> ${100 * LIMIT.move} cm)`);
    if (fs > LIMIT.fscale) out.reasons.push(`tiêu cự đổi ${(100 * fs).toFixed(1)}% (> ${100 * LIMIT.fscale}%)`);
    const gain = before.median - out.loo.median;                  // on pairs the fit never saw
    if (gain < Math.max(0.5, 0.1 * before.median)) {
      out.reasons.push(before.median < 3
        ? `calib hiện tại đã khớp (trung vị ${before.median.toFixed(1)} px), giải không làm tốt hơn`
        : `không cải thiện trên điểm không dùng để giải (${before.median.toFixed(1)} → ${out.loo.median.toFixed(1)} px): cặp điểm có thể sai`);
    }
    out.suspect = errors.flatMap((e, i) => (e > FAR ? [i] : []));  // Huber already ignored them: just report
    out.ok = !out.reasons.length;
    return out;
  }

  const api = { solve, measure, residuals, coverage, MIN_PAIRS, FAR, LIMIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalibPairs = api;
})(typeof self !== 'undefined' ? self : this);
