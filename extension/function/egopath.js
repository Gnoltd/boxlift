/*
 * Ego poses along a stretch of frames (spec 2026-10-13: track along the object). World = the sweep of the frame the
 * walk starts from. A step T (propagate.egoMotion) maps points of sweep a to sweep a + 1; a pose maps sweep k to world.
 * walk() goes one frame at a time in one direction so the caller can look at the object as soon as its pose is known.
 */
(function (root) {
  'use strict';
  const I = { th: 0, tx: 0, ty: 0 };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  /** b first, then a. */
  function compose(a, b) {
    const c = Math.cos(a.th), s = Math.sin(a.th);
    return { th: wrap(a.th + b.th), tx: c * b.tx - s * b.ty + a.tx, ty: s * b.tx + c * b.ty + a.ty };
  }
  function invert(t) {
    const c = Math.cos(t.th), s = Math.sin(t.th);
    return { th: -t.th, tx: -(c * t.tx + s * t.ty), ty: s * t.tx - c * t.ty };
  }
  /** A box moved by t (x, y and heading; height and size stay). */
  function apply(t, box) {
    const c = Math.cos(t.th), s = Math.sin(t.th);
    return { ...box, x: c * box.x - s * box.y + t.tx, y: s * box.x + c * box.y + t.ty, yaw: wrap(box.yaw + t.th) };
  }
  /** Pose of the next frame in direction dir from the pose of this one and the step between them. */
  const stepPose = (pose, T, dir) => compose(pose, dir > 0 ? invert(T) : T);
  /**
   * From f0 towards bound (dir +1 / -1): step(a) -> T_{a→a+1} or null (ICP failed); a failed step reuses the last good
   * one and the frame is unsure; `maxFail` failures in a row (or one before any good step) stop. visit(k, pose, unsure)
   * returning false stops after k. A throwing step (frame not loaded) stops with why 'load'.
   */
  async function walk(f0, dir, bound, step, visit, maxFail = 3) {
    let pose = I, last = null, fails = 0, k = f0;
    while (dir > 0 ? k < bound : k > bound) {
      let T, unsure = false;
      try { T = await step(dir > 0 ? k : k - 1); } catch (e) { return { end: k, why: 'load', error: e.message }; }
      if (T) { last = T; fails = 0; }
      else if (++fails < maxFail && last) { T = last; unsure = true; }
      else return { end: k, why: 'ego' };
      pose = stepPose(pose, T, dir); k += dir;
      if ((await visit(k, pose, unsure)) === false) return { end: k, why: 'visit' };
    }
    return { end: k, why: 'bound' };
  }

  const api = { I, compose, invert, apply, stepPose, walk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EgoPath = api;
})(typeof self !== 'undefined' ? self : this);
