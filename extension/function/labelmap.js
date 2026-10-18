/*
 * Model class -> job label (PLAN 4.1). The detector and the 3D models know six classes; a job has its own labels
 * (often fewer: one "vehicles" for car + truck + bus). The tool suggests a mapping from the label names once, the user
 * confirms or changes it, and it is kept per project. The 3D model is chosen by class, never by the label's name.
 */
(function (root) {
  'use strict';
  const CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian'];
  // words that point a label at a class, most specific first; "vehicle" covers the three four-wheelers
  const WORDS = {
    car: ['car', 'xe con', 'xe hơi', 'ô tô', 'oto', 'sedan', 'vehicle'],
    truck: ['truck', 'lorry', 'xe tải', 'construction', 'trailer', 'vehicle'],
    bus: ['bus', 'xe buýt', 'xe khách', 'vehicle'],
    motorcycle: ['motorcycle', 'motorbike', 'moto', 'scooter', 'xe máy'],
    bicycle: ['bicycle', 'bike', 'cyclist', 'xe đạp'],
    pedestrian: ['pedestrian', 'person', 'people', 'human', 'người'],
  };
  const norm = (s) => String(s).toLowerCase().trim();

  /** {class: labelId | null}: an exact name first, then the first label containing one of the class's words. */
  function suggest(labels) {
    const out = {};
    for (const c of CLASSES) {
      const exact = labels.find((l) => norm(l.name) === c);
      let hit = exact || null;
      for (const w of WORDS[c]) {
        if (hit) break;
        hit = labels.find((l) => { const n = norm(l.name); return n === w || n.split(/[\s_\-/]+/).some((t) => t === w || t === w + 's' || t === w + 'es') || (w.includes(' ') && n.includes(w)); }) || null;
      }
      out[c] = hit ? hit.id : null;
    }
    return out;
  }
  const classesOf = (map, labelId) => CLASSES.filter((c) => map[c] === labelId && labelId != null);
  /** The class a box of this label most likely is (by size when the label takes several classes). */
  function classFor(map, labelId, box) {
    const cs = classesOf(map, labelId);
    if (cs.length <= 1) return cs[0] || null;
    if (!box) return cs[0];
    const pick = (c) => (cs.includes(c) ? c : null);
    if (box.l >= 10) return pick('bus') || pick('truck') || cs[0];
    if (box.l >= 6 || box.h >= 2.6) return pick('truck') || pick('bus') || cs[0];
    return pick('car') || cs[0];
  }
  const confirm = (map) => ({ map: { ...map }, confirmed: true, at: Date.now() });
  /** A stored record checked against the job's labels now (a label deleted since then maps to nothing). */
  function valid(rec, labels) {
    const ids = new Set(labels.map((l) => l.id)), map = {};
    for (const c of CLASSES) map[c] = rec && rec.map && ids.has(rec.map[c]) ? rec.map[c] : null;
    return { map, confirmed: !!(rec && rec.confirmed) };
  }

  const api = { CLASSES, suggest, classesOf, classFor, confirm, valid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelMap = api;
})(typeof self !== 'undefined' ? self : this);
