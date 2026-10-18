/*
 * One object's track through a stretch of frames (spec 2026-10-13). Observations: what the LiDAR saw of it in each
 * frame walked, in world coordinates (world = the sweep of the frame the track started from). Out: one size for the ID,
 * still or moving, a box for every frame, the frames it was hidden, and (keyframes) the few frames CVAT needs. Pure.
 */
(function (root) {
  'use strict';
  const SEEN = 5, MIN_SIZE_POINTS = 30, STATIC_SPEED = 0.25, MAX_GAP = 10, WINDOW = 3, OUTLIER = 1.0;
  const TOL = { pos: 0.05, yaw: 0.5 * Math.PI / 180 };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const seen = (o) => !!o && (!!o.anchor || o.points >= SEEN);

  function quantile(v, q) {
    const s = v.slice().sort((a, b) => a - b);
    if (!s.length) return NaN;
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.min(lo + 1, s.length - 1);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }
  /** What the sensor saw of the object: extent of its points along the box axes; height from the box bottom (ground). */
  function extents(xyz, idx, box) {
    if (!idx.length) return null;
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, top = -Infinity;
    for (const i of idx) {
      const dx = xyz[3 * i] - box.x, dy = xyz[3 * i + 1] - box.y, u = dx * c + dy * s, v = -dx * s + dy * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); top = Math.max(top, xyz[3 * i + 2]);
    }
    return { l: u1 - u0, w: v1 - v0, h: top - (box.z - box.h / 2) };
  }
  /** One size for the ID: 90th percentile of each side over frames seen with ≥ 30 points (anchors count; an anchor
   *  with a size of its own does not). None: the fallback (the box as drawn). */
  function sizeOf(obs, fallback, q = 0.9) {
    const use = obs.filter((o) => o.size && !o.ownSize && (o.anchor || o.points >= MIN_SIZE_POINTS));
    if (!use.length) return { l: fallback.l, w: fallback.w, h: fallback.h };
    const pick = (k) => quantile(use.map((o) => o.size[k]), q);
    return { l: pick('l'), w: pick('w'), h: pick('h') };
  }
  const bySeen = (obs) => obs.filter(seen).sort((a, b) => a.frame - b.frame);
  function classify(obs) {
    const s = bySeen(obs), v = [];
    for (let i = 1; i < s.length; i++) {
      const df = s[i].frame - s[i - 1].frame;                   // two observations of one frame (an anchor and the LiDAR): no speed
      if (df) v.push(Math.hypot(s[i].box.x - s[i - 1].box.x, s[i].box.y - s[i - 1].box.y) / df);
    }
    return v.length && quantile(v, 0.5) > STATIC_SPEED ? 'moving' : 'static';
  }
  /** Where the object should be at frame k: straight on from the two seen frames nearest to k; slower than a still
   *  object's jitter: where it was last seen. */
  function predict(obs, k) {
    const s = obs.filter(seen).sort((a, b) => Math.abs(a.frame - k) - Math.abs(b.frame - k));
    if (!s.length) return null;
    const a = s[0], b = s.find((o) => o.frame !== a.frame);
    if (!b) return { ...a.box };
    const dt = a.frame - b.frame, vx = (a.box.x - b.box.x) / dt, vy = (a.box.y - b.box.y) / dt;
    if (Math.hypot(vx, vy) <= STATIC_SPEED) return { ...a.box };
    return { ...a.box, x: a.box.x + vx * (k - a.frame), y: a.box.y + vy * (k - a.frame) };
  }
  /** The other box the predicted one sits on (IoU 3D > limit), or null: the track must not jump onto it. */
  const clash = (box, others, iou, limit = 0.5) => others.find((o) => iou(box, o) > limit) || null;

  /** Weighted straight-line fit of rec[key] over frames, evaluated at f (one point: its value). */
  function line(recs, key, f) {
    let sw = 0, st = 0, sv = 0;
    for (const r of recs) { sw += r.w; st += r.w * r.frame; sv += r.w * r[key]; }
    const mt = st / sw, mv = sv / sw;
    let a = 0, b = 0;
    for (const r of recs) { a += r.w * (r.frame - mt) * (r[key] - mv); b += r.w * (r.frame - mt) ** 2; }
    return mv + (b > 1e-9 ? a / b : 0) * (f - mt);
  }
  const near = (recs, f) => {
    const inWin = recs.filter((r) => Math.abs(r.frame - f) <= WINDOW);
    return inWin.length >= 3 ? inWin : recs.slice().sort((a, b) => Math.abs(a.frame - f) - Math.abs(b.frame - f)).slice(0, 3);
  };
  /**
   * A box (world) for every frame of `frames`. Still (kind 'static' or by classify): one pose, mean of what was seen
   * weighted by points. Moving: local straight-line fit (±3 frames), far-off fits (> 1 m from a fit without them) dropped, hidden frames from
   * the path. Anchors are kept exactly: the difference to the solution fades linearly between two anchors and is held
   * beyond the outer ones ({frame, zero: true} = no difference there). Every box has `size`, bottom where it was seen;
   * pitch / roll: an anchor keeps its own, other frames take the nearest anchor's (none: flat).
   */
  function solve(obs, { size, frames, anchors = [], kind }) {
    kind ??= classify(obs);
    const s = obs.filter((o) => !o.anchor && o.points >= SEEN).sort((a, b) => a.frame - b.frame);
    let u = 0;
    let recs = s.map((o, i) => {
      if (i) u += wrap(o.box.yaw - s[i - 1].box.yaw); else u = o.box.yaw;
      return { frame: o.frame, x: o.box.x, y: o.box.y, b: o.box.z - o.box.h / 2, u, w: Math.min(o.points, 200) };
    });
    const firm = anchors.filter((a) => a.box);
    if (!recs.length && !firm.length) return new Map();
    if (!recs.length) recs = firm.map((a) => ({ frame: a.frame, x: a.box.x, y: a.box.y, b: a.box.z - a.box.h / 2, u: a.box.yaw, w: 1 }));
    let at;
    if (kind === 'static') {
      const W = recs.reduce((t, r) => t + r.w, 0), m = (k) => recs.reduce((t, r) => t + r.w * r[k], 0) / W;
      const yaw = Math.atan2(recs.reduce((t, r) => t + r.w * Math.sin(r.u), 0), recs.reduce((t, r) => t + r.w * Math.cos(r.u), 0));
      const pose = { x: m('x'), y: m('y'), b: m('b'), u: yaw };
      at = () => pose;
    } else {
      const fit = (rs) => (f) => { const n = near(rs, f); return { x: line(n, 'x', f), y: line(n, 'y', f), b: line(n, 'b', f), u: line(n, 'u', f) }; };
      // each fit is judged against a fit without it, or an outlier at a track end drags the fit towards itself
      const kept = recs.length < 3 ? recs : recs.filter((r) => {
        const p = fit(recs.filter((o) => o !== r))(r.frame);
        return Math.hypot(p.x - r.x, p.y - r.y) <= OUTLIER;
      });
      at = fit(kept.length >= 2 ? kept : recs);
    }
    // anchors: difference to the solution at each, faded between, held outside
    const pins = anchors.map((a) => {
      const p = at(a.frame);
      return { frame: a.frame, d: a.box ? { x: a.box.x - p.x, y: a.box.y - p.y, b: a.box.z - a.box.h / 2 - p.b, u: wrap(a.box.yaw - p.u) } : { x: 0, y: 0, b: 0, u: 0 } };
    }).sort((a, b) => a.frame - b.frame);
    const diff = (f) => {
      if (!pins.length) return { x: 0, y: 0, b: 0, u: 0 };
      if (f <= pins[0].frame) return pins[0].d;
      const j = pins.findIndex((p) => p.frame >= f);
      if (j < 0) return pins[pins.length - 1].d;
      const a = pins[j - 1], b = pins[j], r = (f - a.frame) / (b.frame - a.frame);
      return { x: a.d.x + (b.d.x - a.d.x) * r, y: a.d.y + (b.d.y - a.d.y) * r, b: a.d.b + (b.d.b - a.d.b) * r, u: a.d.u + (b.d.u - a.d.u) * r };
    };
    const tilt = (f) => {
      const a = firm.reduce((m, x) => (!m || Math.abs(x.frame - f) < Math.abs(m.frame - f) ? x : m), null);
      return { rx: (a && a.box.rx) || 0, ry: (a && a.box.ry) || 0 };
    };
    const out = new Map();
    for (const f of frames) {
      const p = at(f), d = diff(f), pin = firm.find((a) => a.frame === f);
      out.set(f, pin ? (pin.ownSize ? { ...pin.box } : { ...pin.box, ...size, z: pin.box.z - pin.box.h / 2 + size.h / 2, ...tilt(f) })
        : { x: p.x + d.x, y: p.y + d.y, z: p.b + d.b + size.h / 2, yaw: wrap(p.u + d.u), l: size.l, w: size.w, h: size.h, ...tilt(f) });
    }
    return out;
  }
  /**
   * Which frames the object is in: from f0 outwards in both directions over the frames walked, up to the last frame it
   * was seen. A moving object (kind, or kind(frame) per frame) hidden more than maxGap frames in a row has left: the
   * track ends at the last frame it was seen before; a hand anchor further out still belongs to it (the track reaches
   * it). Hidden frames inside are `outside`.
   */
  function visibility(obs, f0, kind, maxGap = MAX_GAP) {
    const kindAt = typeof kind === 'function' ? kind : () => kind;
    const at = new Map(obs.map((o) => [o.frame, seen(o)]));
    const end = {};
    for (const dir of [1, -1]) {
      let last = f0, run = 0;
      for (let k = f0 + dir; at.has(k); k += dir) {
        if (at.get(k)) { last = k; run = 0; } else if (kindAt(k) === 'moving' && ++run > maxGap) break;
      }
      end[dir] = last;
    }
    for (const o of obs) if (o.anchor) { end[-1] = Math.min(end[-1], o.frame); end[1] = Math.max(end[1], o.frame); }
    const outside = new Set([...at.keys()].filter((f) => f >= end[-1] && f <= end[1] && !at.get(f)).sort((a, b) => a - b));
    return { first: end[-1], last: end[1], outside };
  }

  const lerpRaw = (a, b, r) => ({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, z: a.z + (b.z - a.z) * r, yaw: a.yaw + (b.yaw - a.yaw) * r });
  /** CVAT rebuilds run[a..b] from keyframes at a and b within tol (it interpolates the raw numbers: no heading wrap). */
  function within(run, a, b, tol) {
    for (let i = a + 1; i < b; i++) {
      const p = lerpRaw(run[a].box, run[b].box, (run[i].frame - run[a].frame) / (run[b].frame - run[a].frame)), q = run[i].box;
      if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > tol.pos || Math.abs(wrap(p.yaw - q.yaw)) > tol.yaw) return false;
    }
    return true;
  }
  function simplify(run, must, tol) {
    const keys = [run[0]];
    for (let a = 0; a < run.length - 1;) {
      let b = a + 1;
      while (b + 1 < run.length && !must.has(run[b].frame) && within(run, a, b + 1, tol)) b++;
      keys.push(run[b]); a = b;
    }
    return keys;
  }
  /**
   * The keyframes CVAT needs (seq: one entry per frame, boxes in each frame's own sweep): every run of visible frames
   * keeps its first and last frame, `must` frames, and whatever linear interpolation cannot rebuild within tol; a run of
   * hidden frames is one outside keyframe at its start.
   */
  function keyframes(seq, must = new Set(), tol = TOL) {
    const keys = [];
    for (let i = 0; i < seq.length;) {
      let j = i;
      while (j + 1 < seq.length && !!seq[j + 1].outside === !!seq[i].outside) j++;
      if (seq[i].outside) keys.push(...seq.slice(i, j + 1).filter((x, n) => n === 0 || must.has(x.frame))); else keys.push(...simplify(seq.slice(i, j + 1), must, tol));
      i = j + 1;
    }
    return keys;
  }
  const sig = (points) => points.slice(0, 9).map((v) => v.toFixed(3)).join(',');
  /** Keyframes set by hand: those that differ from what the extension wrote (all of them when nothing is remembered).
   *  Visible ones carry their box; one the user gave a size of its own ("Chỉ frame này": `own`, the frames remembered
   *  for it) keeps it: ownSize. A hand-set outside keyframe (the object leaves the view) is an anchor too: {frame, outside: true}. */
  function anchorsFrom(shapes, written, own = []) {
    const mine = written && new Map(written.map((w) => [w.frame, w.sig]));
    return shapes.filter((s) => s.keyframe !== false && (!mine || mine.get(s.frame) !== (s.outside ? 'outside' : sig(s.points))))
      .map((s) => (s.outside ? { frame: s.frame, outside: true } : { frame: s.frame, ownSize: own.includes(s.frame),
        box: { x: s.points[0], y: s.points[1], z: s.points[2], rx: s.points[3], ry: s.points[4], yaw: s.points[5], l: s.points[6], w: s.points[7], h: s.points[8] } }));
  }
  /** What the extension has written into a track after a run: the earlier entries for frames the run did not touch, and
   *  the keys the run generated (not the anchors it kept: those are still the hand's). keys: [{frame, outside, points}]. */
  function writtenAfter(prev, keys, range, anchorFrames) {
    const hand = new Set(anchorFrames), [lo, hi] = range || [-Infinity, Infinity];
    return [...(prev || []).filter((w) => w.frame < lo || w.frame > hi),
      ...keys.filter((k) => !hand.has(k.frame)).map((k) => ({ frame: k.frame, sig: k.outside ? 'outside' : sig(k.points) }))]
      .sort((a, b) => a.frame - b.frame);
  }
  /** After a size change of the whole track: a remembered key that still matches the shape CVAT had (`before`) takes the
   *  signature of the patched shape (`after`); one that no longer matches was edited by hand and stays as it is (an anchor);
   *  the edited frame is dropped (a hand anchor now). */
  function resignedAfterSize(written, before, after, frame) {
    const at = (list, f) => list.find((s) => s.frame === f);
    return written.filter((w) => w.frame !== frame).map((w) => {
      const b = at(before, w.frame), a = at(after, w.frame);
      const same = b && (w.sig === 'outside' ? !!b.outside : !b.outside && w.sig === sig(b.points));
      return same && a && !a.outside && w.sig !== 'outside' ? { frame: w.frame, sig: sig(a.points) } : w;
    });
  }
  const HOLD = 3, FADE = 3;
  /** Still / moving stretches: speed between seen frames against 0.25 m/frame; a change counts once it holds 3 frames.
   *  overrides [{from, to, kind}] (⇄ in the panel) replace the kind found there. */
  function segments(obs, overrides = []) {
    const s = bySeen(obs);
    if (!s.length) return [];
    const raw = s.map((o, i) => {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, Math.max(1, i))];   // the step that arrives at this frame, so a stop starts on the frame it is reached
      const v = b.frame === a.frame ? 0 : Math.hypot(b.box.x - a.box.x, b.box.y - a.box.y) / (b.frame - a.frame);
      return { frame: o.frame, kind: v > STATIC_SPEED ? 'moving' : 'static' };
    });
    const segs = [];
    let cur = raw[0].kind, start = obs.reduce((m, o) => Math.min(m, o.frame), Infinity), startAt = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i].kind === cur) continue;
      let j = i; while (j < raw.length && raw[j].kind === raw[i].kind) j++;
      if (j - i < HOLD) continue;                                  // a short flicker: not a new segment
      if (!segs.length && i - startAt < HOLD) { cur = raw[i].kind; continue; }   // a first run under 3 frames takes the next kind
      segs.push({ from: start, to: raw[i].frame - 1, kind: cur });
      cur = raw[i].kind; start = raw[i].frame; startAt = i;
    }
    segs.push({ from: start, to: obs.reduce((m, o) => Math.max(m, o.frame), -Infinity), kind: cur });
    for (const o of overrides) for (const g of segs) if (g.from <= o.to && g.to >= o.from) g.kind = o.kind;
    return segs.reduce((m, g) => {                                 // neighbours of one kind are one segment
      if (m.length && m[m.length - 1].kind === g.kind) m[m.length - 1].to = g.to; else m.push(g);
      return m;
    }, []);
  }
  const kindAt = (segs) => (f) => (segs.length && f < segs[0].from ? segs[0] : segs.find((g) => f >= g.from && f <= g.to) || segs[segs.length - 1] || { kind: 'static' }).kind;
  /** solve() per segment; each one starts where the previous ended (the difference fades out over 3 frames). */
  function solveSegments(obs, { size, frames, anchors = [], segs }) {
    const out = new Map();
    let prevEnd = null;
    segs = segs.map((g) => ({ ...g }));                            // every asked frame belongs to a segment
    if (segs.length) {
      segs[0].from = Math.min(segs[0].from, ...frames);
      segs[segs.length - 1].to = Math.max(segs[segs.length - 1].to, ...frames);
    }
    for (const g of segs) {
      const fr = frames.filter((f) => f >= g.from && f <= g.to);
      if (!fr.length) continue;
      const pins = anchors.filter((a) => a.frame >= g.from && a.frame <= g.to);
      if (prevEnd) {
        const handNear = pins.some((a) => a.box && a.frame <= g.from - 1 + FADE);   // a hand anchor near the joint keeps its own difference
        pins.push({ frame: g.from - 1, box: prevEnd });
        if (!handNear) pins.push({ frame: g.from - 1 + FADE, zero: true });
      }
      const part = solve(obs.filter((o) => o.frame >= g.from && o.frame <= g.to), { size, frames: fr, anchors: pins, kind: g.kind });
      for (const [f, b] of part) out.set(f, b);
      prevEnd = out.get(fr[fr.length - 1]);
    }
    return out;
  }
  const api = { segments, solveSegments, kindAt, sig, anchorsFrom, writtenAfter, resignedAfterSize, SEEN, MIN_SIZE_POINTS, STATIC_SPEED, MAX_GAP, TOL, quantile, extents, sizeOf, classify, predict, clash, solve, visibility, keyframes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Trajectory = api;
})(typeof self !== 'undefined' ? self : this);
