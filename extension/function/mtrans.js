/*
 * Learned 2D box -> 3D box with MTrans (Liu et al., ECCV 2022: image + LiDAR, the hidden side of the object too), for
 * cars: the image crop of the drawn rectangle and the LiDAR points seen in it go through models/mtrans.onnx (trained on
 * KITTI then nuScenes, tools/public/NHAT-KY-DO.md 4.I). Inputs are built exactly as the training data was
 * (MTrans datasets/kitti_detection.py, eval mode):
 *   - the points are turned about z so x looks along the camera's axis (the "velodyne" frame of the training data);
 *   - the crop: integer box (floor / ceil), scaled so its longer side is SIZE (bilinear, corners aligned), centred on a
 *     zero-padded SIZE x SIZE square; a 4th channel is 0 where another box of the same image overlaps;
 *   - up to NPTS points (random choice if more); the free slots get pixels of the crop (not padding) with no 3D point.
 * Pure functions: the detector page runs the model between prepare and decode.
 */
(function (root) {
  'use strict';
  const P = root.LidarProjection || (typeof require !== 'undefined' ? require('./projection.js') : null);
  const SIZE = 112, NPTS = 512, MIN_PTS = 5;

  /** Small deterministic generator: the same box gives the same sample every time. */
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

  /** Heading of the camera's optical axis in the pcd frame (the training data's frame is the pcd turned by it). */
  function axisYaw(calib, cam, adj) {
    let M = P.effectiveEgo2Cam(calib.cameras[cam], adj);
    if ((calib.pcd_frame || 'lidar') === 'lidar') M = P.matMul(M, calib.lidar.sensor2ego);
    return Math.atan2(M[2][1], M[2][0]);
  }

  /**
   * img: {width, height, data: RGBA} whole camera image; rect {u0, v0, u1, v1}; others: rectangles of the other boxes
   * in this image. Writes the crop into image (3 x SIZE x SIZE) / overlap (SIZE x SIZE) at the offsets and returns
   * {l, t, sc, padL, padT, valid: pixels usable for the free slots}.
   */
  function crop(img, rect, others, image, overlap, offI = 0, offO = 0) {
    const W = img.width, H = img.height, px = img.data;
    const u0 = Math.max(0, Math.min(rect.u0, rect.u1)), u1 = Math.min(W - 1, Math.max(rect.u0, rect.u1));
    const v0 = Math.max(0, Math.min(rect.v0, rect.v1)), v1 = Math.min(H - 1, Math.max(rect.v0, rect.v1));
    const l = Math.floor(u0), t = Math.floor(v0), r = Math.ceil(u1), b = Math.ceil(v1);
    const w = r - l, h = b - t, sc = SIZE / Math.max(w, h);
    const ow = Math.floor(w * sc), oh = Math.floor(h * sc);
    const padL = Math.floor((SIZE - ow) / 2), padT = Math.floor((SIZE - oh) / 2);
    const mask = new Uint8Array(w * h).fill(1);           // the overlap channel over the crop's own pixels
    for (const o of others || []) {
      const x0 = Math.max(l, Math.floor(Math.min(o.u0, o.u1))), x1 = Math.min(r, Math.ceil(Math.max(o.u0, o.u1)));
      const y0 = Math.max(t, Math.floor(Math.min(o.v0, o.v1))), y1 = Math.min(b, Math.ceil(Math.max(o.v0, o.v1)));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[(y - t) * w + (x - l)] = 0;
    }
    const fx = ow > 1 ? (w - 1) / (ow - 1) : 0, fy = oh > 1 ? (h - 1) / (oh - 1) : 0;
    const valid = [], SS = SIZE * SIZE;
    for (let y = 0; y < oh; y++) {
      const sy = y * fy, y0 = Math.floor(sy), y1 = Math.min(y0 + 1, h - 1), ly = sy - y0;
      for (let x = 0; x < ow; x++) {
        const sx = x * fx, x0 = Math.floor(sx), x1 = Math.min(x0 + 1, w - 1), lx = sx - x0;
        const wts = [(1 - ly) * (1 - lx), (1 - ly) * lx, ly * (1 - lx), ly * lx];
        const at = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const o = (y + padT) * SIZE + x + padL;
        let allSet = true;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += wts[k] * px[4 * ((t + at[k][1]) * W + l + at[k][0]) + c];
          image[offI + c * SS + o] = s / 255;
          if (!(s > 0)) allSet = false;
        }
        let m = 0;
        for (let k = 0; k < 4; k++) m += wts[k] * mask[at[k][1] * w + at[k][0]];
        overlap[offO + o] = m;
        if (allSet) valid.push(o);
      }
    }
    return { l, t, sc, padL, padT, valid, u0, u1, v0, v1 };
  }

  /**
   * One object: xyz (pcd cloud), proj (projection.js projectCloud of this camera), img, rect, others, th (axisYaw).
   * Fills the k-th slot of the batch arrays {image, overlap, cloud, cloud2d, real}; returns its point count.
   */
  function prepare(xyz, proj, img, rect, others, th, batch, k) {
    const cr = crop(img, rect, others, batch.image, batch.overlap, k * 3 * SIZE * SIZE, k * SIZE * SIZE);
    const sel = [];
    for (let j = 0; j < proj.u.length; j++) {
      const u = proj.u[j], v = proj.v[j];
      if (u > cr.u0 && v > cr.v0 && u < cr.u1 && v < cr.v1) sel.push(j);
    }
    const n = sel.length, r = rng(n * 2654435761 + (sel[0] || 0) + Math.round(cr.u0 * 31 + cr.v0));
    let use = sel;
    if (n > NPTS) {                                      // without replacement: partial Fisher-Yates
      use = sel.slice();
      for (let i = 0; i < NPTS; i++) { const j = i + Math.floor(r() * (n - i)); const q = use[i]; use[i] = use[j]; use[j] = q; }
      use = use.slice(0, NPTS);
    }
    const c = Math.cos(th), s = Math.sin(th), oc = k * NPTS * 3, o2 = k * NPTS * 2, orl = k * NPTS;
    use.forEach((j, m) => {
      const i = proj.idx[j], x = xyz[3 * i], y = xyz[3 * i + 1];
      batch.cloud[oc + 3 * m] = c * x + s * y; batch.cloud[oc + 3 * m + 1] = -s * x + c * y; batch.cloud[oc + 3 * m + 2] = xyz[3 * i + 2];
      batch.cloud2d[o2 + 2 * m] = (proj.u[j] - cr.l) * cr.sc + cr.padL;
      batch.cloud2d[o2 + 2 * m + 1] = (proj.v[j] - cr.t) * cr.sc + cr.padT;
      batch.real[orl + m] = 1;
    });
    for (let m = use.length; m < NPTS; m++) {            // free slots: pixels of the object's crop, no 3D point
      const o = cr.valid.length ? cr.valid[Math.floor(r() * cr.valid.length)] : (SIZE / 2) * SIZE + SIZE / 2;
      batch.cloud2d[o2 + 2 * m] = o % SIZE; batch.cloud2d[o2 + 2 * m + 1] = Math.floor(o / SIZE);
      batch.real[orl + m] = 0;
    }
    return n;
  }
  const newBatch = (n) => ({ n, image: new Float32Array(n * 3 * SIZE * SIZE), overlap: new Float32Array(n * SIZE * SIZE),
    cloud: new Float32Array(n * NPTS * 3), cloud2d: new Float32Array(n * NPTS * 2), real: new Float32Array(n * NPTS) });

  /**
   * Model output k (box: n x 7 in the turned frame, dir: n x 2) -> box in the pcd frame + odds of the other end.
   * About 1 box in 5 comes out with length and width swapped and the heading turned 90 deg (same footprint, but the
   * front points sideways): the long side is made the length again, and its front / back is left to the image model
   * (odds 1). Measured in tools/public/NHAT-KY-DO.md 4.J (cars, yaw <= 10 deg after the heading step 69% -> 83%).
   */
  function decode(box, dir, k, th) {
    const b = box.subarray ? box.subarray(7 * k, 7 * k + 7) : box.slice(7 * k, 7 * k + 7);
    const c = Math.cos(th), s = Math.sin(th), swap = b[4] > b[3], yaw = b[6] + th + (swap ? Math.PI / 2 : 0);
    const p0 = dir[2 * k], p1 = dir[2 * k + 1];
    return { box: { x: c * b[0] - s * b[1], y: s * b[0] + c * b[1], z: b[2], l: swap ? b[4] : b[3], w: swap ? b[3] : b[4], h: b[5], yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) },
      odds: swap ? 1 : Math.min(p0, p1) / Math.max(1e-12, Math.max(p0, p1)) };
  }

  /** Cars only (the model learned cars); other classes keep the frustum / geometric box. */
  const useFor = (label) => /car|van|vehicle|xe con|ô tô|oto/i.test(String(label || '')) && !/truck|bus|motor|bicycle|bike|trailer|construction/i.test(String(label || ''));

  const api = { SIZE, NPTS, MIN_PTS, axisYaw, crop, prepare, newBatch, decode, useFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MTrans = api;
})(typeof self !== 'undefined' ? self : this);
