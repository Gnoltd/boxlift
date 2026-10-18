/*
 * Ctrl+Z for what was already sent to CVAT (P-017): one step per user action (one enqueue: Enter, Del, Shift+Enter on a
 * review batch, one Track 3D run …). Each outbox item CVAT confirms leaves its inverse here, built from the server copy
 * before and after it; undoing a step drops its items that were not sent yet and sends the inverses, newest first.
 * A deleted shape or track comes back with a new id: later inverses that name the old id are remapped.
 */
(function (root) {
  'use strict';
  const MAX_STEPS = 50;

  function create() { return { steps: [], ids: { shape: new Map(), track: new Map() } }; }
  /** A new step (one user action); returns its id. */
  function open(stack, label) {
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    stack.steps.push({ id, label: label || '', inv: [] });
    if (stack.steps.length > MAX_STEPS) stack.steps.shift();
    return id;
  }
  const find = (stack, id) => stack.steps.find((s) => s.id === id) || null;
  /** Keep the inverses of a confirmed item in its step (no step: an undo itself, or a step already undone / dropped). */
  function add(stack, id, inv) {
    const s = id && find(stack, id);
    if (s && inv && inv.length) s.inv.push(...inv);
    return !!s;
  }
  /** The newest step, taken off the stack. */
  function takeLast(stack) { return stack.steps.pop() || null; }
  /** A server copy without ids, to be created again. */
  function fresh(t) {
    const out = { ...t }; delete out.id;
    if (out.shapes) out.shapes = out.shapes.map((x) => { const y = { ...x }; delete y.id; return y; });
    if (out.elements) out.elements = out.elements.map(fresh);
    return out;
  }
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  /**
   * Outbox items that take a confirmed item `o` back. before / after: the server copy (shape or track) before and after
   * it, null when there was none (created / deleted); memo: what the extension remembered of the track before it.
   * fromPoints: CVAT cuboid points -> box. Every inverse carries `undo: true` (it is not undone in turn) and, for what
   * comes back with a new id, `restores` (the old id).
   */
  function inverse(o, before, after, fromPoints, memo) {
    const mark = (x) => ({ ...x, undo: true });
    switch (o.op) {
      case 'create':
        return after && after.id != null ? [mark({ op: 'delete', shape: after, frame: after.frame, labelId: after.label_id, box: fromPoints(after.points) })] : [];
      case 'update':
        return before ? [mark({ op: 'update', shape: after || before, frame: before.frame, labelId: before.label_id, box: fromPoints(before.points) })] : [];
      case 'delete':
        return before ? [mark({ op: 'create', frame: before.frame, labelId: before.label_id, box: fromPoints(before.points),
          attrs: before.attributes || [], restores: before.id })] : [];
      case 'track-create':
        return after && after.id != null ? [mark({ op: 'track-delete', trackId: after.id, frame: o.frame, labelId: after.label_id })] : [];
      case 'track-delete':
        return before ? [mark({ op: 'track-create', frame: o.frame, labelId: before.label_id, track: fresh(clone(before)),
          memo: clone(memo) || null, restores: before.id })] : [];
      default:                     // track-key / -size / -outside / -keyframe / -set / -update: the whole track as it was
        if (o.op === 'track-set' && o.trackId == null) return inverse({ ...o, op: 'track-create' }, before, after, fromPoints, memo);
        return before ? [mark({ op: 'track-update', trackId: before.id, frame: o.frame, labelId: before.label_id, track: clone(before),
          memo: clone(memo) || null })] : [];
    }
  }
  /** A shape / track that came back under a new id. */
  function moved(stack, kind, from, to) { if (from != null && to != null) stack.ids[kind].set(from, to); }
  const follow = (m, id) => { let k = id, n = 0; while (m.has(k) && n++ < 100) k = m.get(k); return k; };
  /** An inverse with the ids it names brought up to date. */
  function remap(stack, op) {
    const out = { ...op };
    if (out.trackId != null) out.trackId = follow(stack.ids.track, out.trackId);
    if (out.track && out.track.id != null) out.track = { ...out.track, id: follow(stack.ids.track, out.track.id) };
    if (out.shape && out.shape.id != null) out.shape = { ...out.shape, id: follow(stack.ids.shape, out.shape.id) };
    return out;
  }
  /** The outbox items to send for an undone step: its inverses, newest first, ids remapped. */
  function plan(stack, step) { return step.inv.slice().reverse().map((x) => remap(stack, x)); }

  const api = { create, open, add, takeLast, inverse, moved, remap, plan, fresh, MAX_STEPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Undo = api;
})(typeof self !== 'undefined' ? self : this);
