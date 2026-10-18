/*
 * The tag on a machine box (PLAN 3.2): what the model saw and how sure it is, read at a glance while reviewing.
 * "car 82%" coloured by level (high ≥ 70 %, mid 50–70 %, low < 50 %; blue / yellow / orange stay apart for
 * colour-blind eyes), "· kiểm tra" when the box rests on few LiDAR points or the front could be the back.
 */
(function (root) {
  'use strict';
  const HIGH = 0.7, MID = 0.5, MIN_POINTS = 30, SURE_HEADING = 1.5;
  const COLORS = { high: '#4ea1ff', mid: '#ffd23f', low: '#ff7a45' };

  /** o: {label, score (0..1 | null), points, headingConf (odds front:back, optional)}. */
  function tagOf({ label, score, points, headingConf }) {
    const level = score == null ? null : score >= HIGH ? 'high' : score >= MID ? 'mid' : 'low';
    const check = (points != null && points < MIN_POINTS) || (headingConf != null && headingConf < SURE_HEADING);
    const text = [label || '?', score == null ? '' : ` ${Math.round(100 * score)}%`, check ? ' · kiểm tra' : ''].join('');
    return { text, level, check };
  }
  /** Put a tag rect {x (centre), y (bottom), w, h} where it covers no tag in `placed` (moves it up); returns it. */
  function place(placed, r) {
    const hit = (q) => placed.some((p) => Math.abs(p.x - q.x) < (p.w + q.w) / 2 && Math.abs(p.y - q.y) < (p.h + q.h) / 2);
    const out = { ...r };
    for (let k = 0; k < 6 && hit(out); k++) out.y -= r.h + 2;
    placed.push(out);
    return out;
  }

  const api = { tagOf, place, COLORS, HIGH, MID, MIN_POINTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxTag = api;
})(typeof self !== 'undefined' ? self : this);
