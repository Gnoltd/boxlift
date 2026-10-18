/* Per-frame ego-pose metadata for propagation.
 * Required input for pose-first nuScenes propagation: the CVAT PCD/image upload does not retain
 * per-frame ego poses, and calib.json contains only fixed sensor calibration. The user must load
 * the converter's lidar_metadata.json (or older gt/frames.json) separately in the extension. */
(function (root) {
  'use strict';
  const P = root.LidarProjection || (typeof require !== 'undefined' ? require('./projection.js') : null);

  function matrix4(M, name) {
    if (!Array.isArray(M) || M.length !== 4 || M.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v)))) {
      throw new Error(`${name} phải là ma trận 4×4 hữu hạn`);
    }
    return M.map((r) => r.map(Number));
  }

  function stem(name) {
    return String(name || '').replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.pcd\.bin$/i, '').replace(/\.(pcd|bin)$/i, '').toLowerCase();
  }

  function timestampFromName(name) {
    const s = stem(name);
    let m = s.match(/__(\d{15,16})$/);                  // original nuScenes file: microseconds
    if (m) return Number(m[1]);
    m = s.match(/(?:^|[^\d])(\d{9,11})-(\d{9})$/);   // converter fid: seconds-nanoseconds
    return m ? Number(m[1]) * 1e6 + Number(m[2]) / 1e3 : null;
  }

  function parse(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames) || !raw.frames.length) throw new Error('metadata không có frames');
    const frames = raw.frames.map((r, i) => {
      const ego = matrix4(r.ego_to_global || r.lidar_ego || r.ego, `frames[${i}].ego`);
      const timestamp = Number(r.timestamp_us ?? r.lidar_t ?? r.timestamp);
      if (!Number.isFinite(timestamp)) throw new Error(`frames[${i}] thiếu timestamp`);
      const filename = String(r.filename || r.file || (r.fid ? `${r.fid}.pcd` : ''));
      return { index: i, filename, fid: String(r.fid || ''), timestamp, ego };
    });
    const sensor = raw.lidar && raw.lidar.sensor2ego ? matrix4(raw.lidar.sensor2ego, 'lidar.sensor2ego')
      : raw.sensor2ego ? matrix4(raw.sensor2ego, 'sensor2ego') : null;
    const byName = new Map(), byTime = new Map();
    for (const f of frames) {
      for (const n of [f.filename, f.fid]) if (n && stem(n)) byName.set(stem(n), f);
      byTime.set(String(Math.round(f.timestamp)), f);
    }
    return { raw, scene: String(raw.scene || ''), mode: String(raw.mode || ''), sensor2ego: sensor, frames, byName, byTime };
  }

  function find(meta, name) {
    if (!meta) return null;
    const named = meta.byName.get(stem(name));
    if (named) return named;
    const t = timestampFromName(name);
    return t == null ? null : meta.byTime.get(String(Math.round(t))) || null;
  }

  function coverage(meta, names) {
    const missing = [], matches = [];
    for (const name of names) {
      const f = find(meta, name);
      if (f) matches.push(f); else missing.push(String(name || ''));
    }
    return { matched: matches.length, total: names.length, missing };
  }

  /** Previous lidar coordinates -> current lidar coordinates for the same world point. */
  function between(meta, previousName, currentName, fallbackSensor2ego) {
    const a = find(meta, previousName), b = find(meta, currentName);
    if (!a || !b) return null;
    const S = meta.sensor2ego || (fallbackSensor2ego && matrix4(fallbackSensor2ego, 'calib.lidar.sensor2ego'));
    if (!S) throw new Error('metadata và calib đều thiếu LiDAR sensor2ego');
    const globalFromA = P.matMul(a.ego, S), globalFromB = P.matMul(b.ego, S);
    const M = P.matMul(P.inv4(globalFromB), globalFromA);
    const dt = Math.abs(b.timestamp - a.timestamp) * 1e-6;
    return { th: Math.atan2(M[1][0], M[0][0]), tx: M[0][3], ty: M[1][3], tz: M[2][3], matrix: M,
      inlier: 1, source: 'pose', dt: Number.isFinite(dt) && dt > 0 ? dt : null, fromTimestamp: a.timestamp, toTimestamp: b.timestamp };
  }

  const api = { parse, find, coverage, between, stem, timestampFromName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PoseMetadata = api;
})(typeof self !== 'undefined' ? self : this);
