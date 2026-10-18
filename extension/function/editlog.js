/*
 * "Box đã sửa" (PLAN 2.3): how much of what the machine proposed the annotator had to change.
 * A machine box (hand fit from a drawn rectangle, auto box from T, or a box carried by L) is compared with
 * the box that was saved: edited when 3D IoU < 0.9, or the heading moved > 5°, or the label changed.
 * One record per accepted (save) or rejected (skip) proposal; exported as CSV for the time study.
 *
 * Supabase integration (PLAN: Log thao tác):
 * Mỗi record được push lên Supabase bất đồng bộ qua SupaLog.push() (supalog.js).
 * Gọi EditLog.setSession(uuid) ở đầu phiên làm việc để gắn session_id vào mọi record.
 */
(function (root) {
  'use strict';
  const BF = typeof module !== 'undefined' && module.exports ? require('./boxfit.js') : root.BoxFit;

  /** Session UUID đặt từ cvat.js khi mở extension. */
  let _sessionId = null;
  function setSession(id) { _sessionId = id; }
  const EDIT_IOU = 0.9, EDIT_YAW_DEG = 5;
  const COLUMNS = ['time', 'job', 'frame', 'camera', 'action', 'how', 'model', 'label', 'score', 'points', 'edited', 'iou', 'dyaw_deg', 'label_changed'];

  /** 3D IoU of two boxes {x, y, z, yaw, l, w, h} (yaw only: the small pitch / roll is ignored). */
  function iou3d(a, b) {
    const bev = BF.bevIoU(a, b);
    if (!(bev > 0)) return 0;
    const area = bev * (a.l * a.w + b.l * b.w) / (1 + bev);
    const dz = Math.min(a.z + a.h / 2, b.z + b.h / 2) - Math.max(a.z - a.h / 2, b.z - b.h / 2);
    if (dz <= 0) return 0;
    const inter = area * dz;
    return inter / (a.l * a.w * a.h + b.l * b.w * b.h - inter);
  }
  /** Heading difference in degrees, 0..180 (a flipped front is 180). */
  function yawDiffDeg(a, b) {
    const d = Math.abs(((b.yaw - a.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return d * 180 / Math.PI;
  }
  /** machine: candidate boxes the machine offered (fit, prediction); the closest one is the reference. */
  function judge({ machine, saved, machineLabel, savedLabel }) {
    let best = null;
    for (const m of machine || []) {
      const iou = iou3d(m, saved);
      if (!best || iou > best.iou) best = { iou, dyaw: yawDiffDeg(m, saved) };
    }
    if (!best) best = { iou: 0, dyaw: 0 };
    const labelChanged = machineLabel != null && savedLabel != null && machineLabel !== savedLabel;
    return { ...best, labelChanged, edited: best.iou < EDIT_IOU || best.dyaw > EDIT_YAW_DEG || labelChanged };
  }
  /** One log line. action: 'save' (accepted, maybe edited) | 'skip' (proposal thrown away). how: 'tay' | 'T' | 'lan'. */
  function record(o) {
    const r = { time: o.time || new Date().toISOString(), session_id: _sessionId, job: o.job ?? '', frame: o.frame ?? '', camera: o.camera || '', action: o.action,
      how: o.how || '', model: o.model || '', label: o.labelName || '', score: o.score ?? null, points: o.points ?? null,
      trackId: o.trackId ?? null, nAdjust: o.nAdjust ?? null, arm: o.arm ?? null,
      edited: null, iou: null, dyaw: null, labelChanged: null };
    if (o.action === 'save' && o.saved) Object.assign(r, judge(o));
    // Push lên Supabase bất đồng bộ — không chặn, không throw
    if (typeof root.SupaLog !== 'undefined') {
      root.SupaLog.push(r, _sessionId).catch(() => {});
    }
    return r;
  }
  function summary(recs) {
    const saved = recs.filter((r) => r.action === 'save'), edited = saved.filter((r) => r.edited).length;
    return { saved: saved.length, edited, skipped: recs.filter((r) => r.action === 'skip').length, pct: saved.length ? 100 * edited / saved.length : 0 };
  }
  // A plain number, written as a number would be: 12, -3.5, +.5, 5., 1e3, -1.2E-4.
  const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  // Spreadsheets may drop spaces / tabs / zero-width marks in front of a formula, so look past them for = + - @; a leading tab or CR is unsafe by itself.
  const FORMULA = /^[\s\u00a0\u200b-\u200d\u2060\ufeff]*[=+\-@]|^[\t\r]/;
  /** One CSV cell. Text that could start a formula in Excel / Sheets gets a leading ' (a value that is a plain number stays as it is). */
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v !== 'number' && FORMULA.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v, d) => (v == null ? '' : (+v).toFixed(d));
  const flag = (v) => (v == null ? '' : v ? 1 : 0);
  function toCsv(recs) {
    const rows = recs.map((r) => [r.time, r.job, r.frame, r.camera, r.action, r.how, r.model, r.label, num(r.score, 3), r.points ?? '',
      flag(r.edited), num(r.iou, 3), num(r.dyaw, 1), flag(r.labelChanged)].map(cell).join(','));
    return [COLUMNS.join(','), ...rows].join('\n') + '\n';
  }
  /**
   * CVAT attributes for a saved box: only the names the label already has (source / edited / score; the
   * extension never changes a project's labels). A select / radio value outside its list is left out.
   */
  function cvatAttributes(label, r) {
    const want = { source: r.how, edited: r.edited == null ? null : String(!!r.edited), score: r.score == null ? null : (+r.score).toFixed(2) };
    const out = [];
    for (const a of (label && label.attributes) || []) {
      const v = want[a.name];
      if (v == null || v === '') continue;
      if ((a.input_type === 'select' || a.input_type === 'radio') && !(a.values || []).includes(v)) continue;
      out.push({ spec_id: a.id, value: v });
    }
    return out;
  }

  const api = { iou3d, yawDiffDeg, judge, record, summary, toCsv, csvCell: cell, cvatAttributes, setSession, COLUMNS, EDIT_IOU, EDIT_YAW_DEG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EditLog = api;
})(typeof self !== 'undefined' ? self : this);
