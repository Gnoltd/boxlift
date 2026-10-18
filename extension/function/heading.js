/*
 * Which end of an object is its front, from the image. The box tool gets the object's axis from the LiDAR
 * (L-shape, +-2 deg) but the points of a car's front and rear look alike; a small image model (MobileNetV3,
 * trained on nuScenes crops: tools/heading/) gives the observation angle alpha (heading relative to the camera
 * ray, 8 bins). Of the two headings along the axis, the one the model finds more likely is kept.
 * Pure functions: the extension (cvat.js + detector page) and the offline checks use the same code.
 */
(function (root) {
  'use strict';
  const P = root.LidarProjection || (typeof require !== 'undefined' ? require('./projection.js') : null);
  const BINS = 8, KAPPA = 4, SIZE = 128, MARGIN = 0.15, MIN_SEEN = 0.3;
  const CENTRES = Array.from({ length: BINS }, (_, k) => -Math.PI + (k + 0.5) * 2 * Math.PI / BINS);
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  /** RGBA pixels of a SIZExSIZE crop -> normalised CHW float (RGB, ImageNet mean / std), appended at `off`. */
  function tensorFromRGBA(rgba, out = new Float32Array(3 * SIZE * SIZE), off = 0) {
    const n = SIZE * SIZE;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[off + c * n + i] = (rgba[4 * i + c] / 255 - MEAN[c]) / STD[c];
    return out;
  }
  function softmax(logits, off = 0) {
    const l = Array.from({ length: BINS }, (_, k) => logits[off + k]), m = Math.max(...l), e = l.map((x) => Math.exp(x - m)), s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }
  /** Smoothed density of the model at angle a (same kernel as the training targets). */
  const density = (prob, a) => prob.reduce((s, p, k) => s + p * Math.exp(KAPPA * Math.cos(a - CENTRES[k])), 0);
  const wrap = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  /** pcd -> camera transform of a camera of the calibration. */
  const pcd2cam = (calib, cam, adj) => P.matMul(P.effectiveEgo2Cam(calib.cameras[cam], adj), calib.pcd_frame === 'ego' ? I4 : calib.lidar.sensor2ego);
  const apply = (M, p) => [0, 1, 2].map((i) => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3]);
  const rot = (R, p) => [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]);
  /**
   * Virtual pinhole camera at the real one's centre looking straight at the box (rows x', y', z' in camera frame):
   * every camera model (pinhole, fisheye) then shows the object the way the model was trained on
   * (tools/heading/rectify.py does the same). null when the box centre is straight above / below the camera.
   */
  function view(box, M) {
    const c = apply(M, [box.x, box.y, box.z]), n = Math.hypot(...c), z = c.map((v) => v / n);
    const x = [z[2], 0, -z[0]], nx = Math.hypot(...x);             // [0, 1, 0] x z
    if (nx < 1e-6) return null;
    const X = x.map((v) => v / nx);
    return [X, [z[1] * X[2] - z[2] * X[1], z[2] * X[0] - z[0] * X[2], z[0] * X[1] - z[1] * X[0]], z];
  }
  /** Observation angle of a box (pcd frame): its heading in the virtual camera looking at it. */
  function alphaOf(box, calib, cam, adj) {
    const M = pcd2cam(calib, cam, adj), R = view(box, M);
    if (!R) return 0;
    const v = rot(R, rot(M, [Math.cos(box.yaw), Math.sin(box.yaw), 0]));
    return Math.atan2(v[0], v[2]);
  }
  /**
   * Rectified crop of the box from the camera image `img` ({data: RGBA, width, height}): SIZE x SIZE RGBA, the box's
   * outline in the virtual camera + 15 % each side, each pixel looked up through the real camera model (bilinear,
   * black outside the image). A big object is rendered at up to 4x and averaged down. null when < 30 % of it is in the image.
   */
  function rectify(box, calib, cam, adj, img) {
    const M = pcd2cam(calib, cam, adj), R = view(box, M), C = calib.cameras[cam];
    if (!R) return null;
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    let a = Infinity, A = -Infinity, b = Infinity, B = -Infinity, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const px = [0, 0];
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
      const p = apply(M, [box.x + i * box.l / 2 * c - j * box.w / 2 * s, box.y + i * box.l / 2 * s + j * box.w / 2 * c, box.z + k * box.h / 2]);
      const q = rot(R, p);
      if (q[2] < 0.1) return null;
      a = Math.min(a, q[0] / q[2]); A = Math.max(A, q[0] / q[2]); b = Math.min(b, q[1] / q[2]); B = Math.max(B, q[1] / q[2]);
      if (P.camToPixel(C, adj, p[0], p[1], p[2], px)) { u0 = Math.min(u0, px[0]); u1 = Math.max(u1, px[0]); v0 = Math.min(v0, px[1]); v1 = Math.max(v1, px[1]); }
    }
    const ma = MARGIN * (A - a), mb = MARGIN * (B - b);
    a -= ma; A += ma; b -= mb; B += mb;
    const span = u1 > u0 ? Math.max(u1 - u0, v1 - v0) : SIZE;
    const ss = Math.min(4, Math.max(1, Math.ceil(span / SIZE))), N = SIZE * ss, W = img.width, H = img.height, D = img.data;
    const acc = new Float32Array(SIZE * SIZE * 3);
    let seen = 0;
    for (let r = 0; r < N; r++) for (let q = 0; q < N; q++) {
      const xn = a + (q + 0.5) / N * (A - a), yn = b + (r + 0.5) / N * (B - b);
      const ray = [0, 1, 2].map((i) => R[0][i] * xn + R[1][i] * yn + R[2][i]);   // virtual -> camera frame
      if (!P.camToPixel(C, adj, ray[0] * 10, ray[1] * 10, ray[2] * 10, px)) continue;
      const u = px[0], v = px[1];
      if (!(u >= 0 && u < W - 1 && v >= 0 && v < H - 1)) continue;
      seen++;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, o = 4 * (y0 * W + x0), t = 3 * ((r / ss | 0) * SIZE + (q / ss | 0));
      for (let ch = 0; ch < 3; ch++)
        acc[t + ch] += (D[o + ch] * (1 - fx) + D[o + 4 + ch] * fx) * (1 - fy) + (D[o + 4 * W + ch] * (1 - fx) + D[o + 4 * W + 4 + ch] * fx) * fy;
    }
    if (seen < MIN_SEEN * N * N) return null;                     // mostly outside the image (training: >= 60 % in)
    const out = new Uint8ClampedArray(SIZE * SIZE * 4), n2 = ss * ss;
    for (let i = 0; i < SIZE * SIZE; i++) { for (let ch = 0; ch < 3; ch++) out[4 * i + ch] = Math.round(acc[3 * i + ch] / n2); out[4 * i + 3] = 255; }
    return out;
  }
  /**
   * The box's heading along the same axis that the model finds more likely: {flip, conf, alpha}.
   * conf = density ratio of the chosen end over the other (>= 1; ~1 = no idea, e.g. a side view far away).
   * odds: another opinion on turning the box (the frustum box model's Frustum.endOdds), weighted by PRIOR_W
   * (tools/public/NHAT-KY-DO.md 4.H: 2 on the held-out scenes, car / truck / bus / bicycle right way 83.0 -> 88.1%).
   */
  const PRIOR_W = 2;
  function chooseEnd(box, prob, calib, cam, adj, odds = 1) {
    const a0 = alphaOf(box, calib, cam, adj), d0 = density(prob, a0), d1 = density(prob, wrap(a0 + Math.PI)) * odds ** PRIOR_W;
    return { flip: d1 > d0, conf: Math.max(d0, d1) / Math.max(1e-9, Math.min(d0, d1)), alpha: d1 > d0 ? wrap(a0 + Math.PI) : a0 };
  }

  const api = { BINS, SIZE, MARGIN, rectify, tensorFromRGBA, softmax, density, alphaOf, chooseEnd, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Heading = api;
})(typeof self !== 'undefined' ? self : this);
