/*
 * Cuboid tracks the way CVAT keeps them (PLAN 2.1). A track is CVAT's own object {frame, label_id, shapes: [...]}:
 * shapes are keyframes sorted by frame; between two keyframes the cuboid numbers are interpolated linearly; after the
 * last one the box holds; a keyframe with outside = true hides the track from that frame on. Every function returns a
 * new track (the server copy is never changed in place), ready for PATCH ?action=update.
 */
(function (root) {
  'use strict';
  const keyOf = (frame, points, outside = false, attributes = []) => ({ type: 'cuboid', frame, points: points.slice(), outside, occluded: false,
    keyframe: true, z_order: 0, rotation: 0, attributes, elements: [] });
  const copy = (t) => ({ ...t, shapes: t.shapes.map((s) => ({ ...s, points: s.points.slice() })) });
  const sorted = (t) => { t.shapes.sort((a, b) => a.frame - b.frame); return t; };

  function newTrack({ frame, labelId, points, attributes = [] }) {
    return { frame, label_id: labelId, group: 0, source: 'semi-auto', attributes: [], elements: [], shapes: [keyOf(frame, points, false, attributes)] };
  }
  /** What the track shows at `frame`: {points, key (a keyframe here)} or null (not started / outside). */
  function at(t, frame) {
    let prev = null, next = null;
    for (const s of t.shapes) { if (s.frame <= frame) prev = s; else { next = s; break; } }
    if (!prev || prev.outside) return null;
    if (prev.frame === frame || !next || next.outside) return { points: prev.points.slice(), key: prev.frame === frame };
    const r = (frame - prev.frame) / (next.frame - prev.frame);
    return { points: prev.points.map((v, i) => v + (next.points[i] - v) * r), key: false };
  }
  /** The box a track had when it left the scene, if it is outside at `frame` (null: showing, or not started yet). */
  function leftAt(t, frame) {
    let prev = null;
    for (const s of t.shapes) { if (s.frame <= frame) prev = s; else break; }
    return prev && prev.outside ? prev.points.slice() : null;
  }
  /** Keyframe at `frame` with these points (edit or new); an existing one keeps its id and attributes. */
  function upsertKey(t, frame, points) {
    const o = copy(t), k = o.shapes.find((s) => s.frame === frame);
    if (k) Object.assign(k, { points: points.slice(), outside: false, keyframe: true });
    else o.shapes.push(keyOf(frame, points, false, (o.shapes[0] && o.shapes[0].attributes) || []));
    return sorted(o);
  }
  /** O: the track leaves the scene at `frame` (outside keyframe), or comes back (normal keyframe, box as last shown). */
  function setOutside(t, frame, outside) {
    const shown = at(t, frame) || at(t, frame - 1), o = copy(t), k = o.shapes.find((s) => s.frame === frame);
    const points = (k && k.points) || (shown && shown.points) || o.shapes[0].points;
    if (k) Object.assign(k, { outside, keyframe: true }); else o.shapes.push(keyOf(frame, points, outside));
    return sorted(o);
  }
  /** K: an interpolated frame becomes a keyframe with the box it shows; a keyframe (not the first) stops being one. */
  function toggleKey(t, frame) {
    const k = t.shapes.find((s) => s.frame === frame);
    if (k) {
      if (t.shapes[0] === k) return copy(t);
      const o = copy(t); o.shapes = o.shapes.filter((s) => s.frame !== frame); return o;
    }
    const shown = at(t, frame);
    return shown ? upsertKey(t, frame, shown.points) : copy(t);
  }

  /** The track with these keyframes ({frame, points, outside}); a frame that had a keyframe keeps its shape id and
   *  attributes. With range [lo, hi] only keyframes inside it are replaced. */
  function fromFrames(t, keys, range) {
    const attrs = (t.shapes[0] && t.shapes[0].attributes) || [], old = new Map(t.shapes.map((s) => [s.frame, s]));
    const kept = range ? t.shapes.filter((s) => s.frame < range[0] || s.frame > range[1]).map((s) => ({ ...s, points: s.points.slice() })) : [];
    const made = keys.map((k) => { const o = old.get(k.frame) || {}; return { ...o, ...keyOf(k.frame, k.points, !!k.outside, o.attributes || attrs) }; });
    const o = sorted({ ...t, shapes: [...kept, ...made] });
    return { ...o, frame: o.shapes[0].frame };
  }
  /** One size on every keyframe; the bottom stays where it was. */
  function setSize(t, { l, w, h }) {
    const o = copy(t);
    for (const s of o.shapes) { s.points[2] += (h - s.points[8]) / 2; s.points[6] = l; s.points[7] = w; s.points[8] = h; }
    return o;
  }
  const key = (frame, points, outside = false) => ({
    type: 'cuboid', frame, points: [...points], outside, occluded: false,
    z_order: 0, rotation: 0, attributes: [],
  });
  const end = (frame, stop) => Math.min(frame + 1, stop);

  // An outside key immediately after the last real key prevents CVAT from
  // interpolating a newly-created track through the rest of the job.
  function create(labelId, firstFrame, firstPoints, frame, points, stop) {
    const shapes = [key(firstFrame, firstPoints)];
    if (frame !== firstFrame) shapes.push(key(frame, points));
    if (stop != null && frame < stop) shapes.push(key(end(frame, stop), points, true));
    return { label_id: labelId, frame: firstFrame, group: 0, source: 'semi-auto', attributes: [], elements: [], shapes };
  }
  function extend(track, frame, points, stop) {
    const shapes = (track.shapes || []).filter((s) => s.frame < frame && !s.outside)
      .map((s) => ({ ...s, points: [...s.points] }));
    shapes.push(key(frame, points));
    if (stop != null && frame < stop) shapes.push(key(end(frame, stop), points, true));
    return { ...track, shapes };
  }
  function createRange(labelId, firstFrame, firstPoints, keys, stop) {
    const shapes = [key(firstFrame, firstPoints)];
    for (const k of keys.sort((a, b) => a.frame - b.frame)) if (k.frame > firstFrame) shapes.push(key(k.frame, k.points));
    const last = shapes[shapes.length - 1];
    if (last && stop != null && last.frame < stop) shapes.push(key(end(last.frame, stop), last.points, true));
    return { label_id: labelId, frame: firstFrame, group: 0, source: 'semi-auto', attributes: [], elements: [], shapes };
  }
  function sameAt(track, frame, points) {
    return (track.shapes || []).some((s) => !s.outside && s.frame === frame && s.points.length === points.length &&
      s.points.every((v, i) => Math.abs(v - points[i]) < 1e-4));
  }
  const standaloneShapeIds = (items) => items.flatMap((item) => item.shape && item.shape.id != null ? [item.shape.id] : []);

  const api = { newTrack, at, leftAt, upsertKey, setOutside, toggleKey, fromFrames, setSize, key, create, createRange, extend, sameAt, standaloneShapeIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Tracks = api;
  root.CvatTracks = api;
})(typeof self !== 'undefined' ? self : this);
