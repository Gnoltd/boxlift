/*
 * Auto boxes: threshold and "why no box" (PLAN 4.2, 4.3). The detector runs once at a low score (LOW); each detection
 * becomes a candidate that either carries the reason it was dropped during the run (no label, already boxed, no LiDAR
 * fit, seen better by another camera) or a 3D box. split() applies the per-class threshold and the minimum number of
 * LiDAR points: moving them only re-filters, nothing runs again.
 */
(function (root) {
  'use strict';
  const LOW = 0.15, DEFAULT = 0.3, OVERLAP = 0.3;
  const REASONS = {
    low: 'dưới ngưỡng', few: 'ít điểm LiDAR', nofit: 'không đủ điểm LiDAR để dựng box', dup: 'đã có box',
    off: 'loại không có nhãn (ánh xạ: bỏ qua)', merged: 'trùng với camera khác',
  };
  /** cands: [{det: {label, score}, points, reason (set during the run) | null, done?}] -> {items, rejected: [{cand, reason}]} */
  function split(cands, { thr = {}, minPoints = 0, overlap = OVERLAP } = {}) {
    const items = [], rejected = [];
    for (const c of cands) {
      if (c.done) continue;
      let reason = c.reason || null;
      if (!reason && c.det.score < (thr[c.det.label] ?? DEFAULT)) reason = 'low';
      if (!reason && (c.overlap || 0) >= overlap) reason = 'dup';
      if (!reason && minPoints > 0 && (c.points ? c.points.length : 0) < minPoints) reason = 'few';
      if (reason) rejected.push({ cand: c, reason }); else items.push(c);
    }
    // one object seen by several cameras (same group): already there on one camera -> already there on all;
    // else the most confident one that passed stays
    const dupGroups = new Set(rejected.filter((r) => r.reason === 'dup' && r.cand.group != null).map((r) => r.cand.group));
    for (let i = items.length - 1; i >= 0; i--) if (dupGroups.has(items[i].group)) rejected.push({ cand: items.splice(i, 1)[0], reason: 'dup' });
    const best = new Map();
    for (const c of items) if (c.group != null && (!best.has(c.group) || c.det.score > best.get(c.group).det.score)) best.set(c.group, c);
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i];
      if (c.group != null && best.get(c.group) !== c) { items.splice(i, 1); rejected.push({ cand: c, reason: 'merged' }); }
    }
    return { items, rejected };
  }
  const counts = (rejected) => rejected.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {});

  const api = { LOW, DEFAULT, OVERLAP, REASONS, split, counts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoFilter = api;
})(typeof self !== 'undefined' ? self : this);
