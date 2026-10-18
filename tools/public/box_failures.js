#!/usr/bin/env node
/* Failure classes of eval_boxes.js --json outputs: node tools/public/box_failures.js work/public/t5-*.json */
const path = require('path');

function cls(r) {
  if (!r.ok) return 'not made';
  if (r.bev < 0.05 && r.dc > 1.5) return 'wrong object (IoU 0)';
  if (r.dl > 1.0 || r.dw > 0.8) return 'too big (merged with neighbour?)';
  if (r.dyaw > 30) return 'yaw off > 30°';
  if (r.dc <= 0.3 && r.dyaw <= 5) return 'good';
  if (r.dl < -1.0) return 'too short';
  return 'roughly right';
}

function main(files) {
  const rows = files.flatMap((f) => require(path.resolve(f)));
  for (const label of ['car', 'truck', 'pedestrian']) {
    const rs = rows.filter((r) => r.label === label);
    if (!rs.length) continue;
    const c = {};
    rs.forEach((r) => { const k = cls(r); c[k] = (c[k] || 0) + 1; });
    console.log(`${label} (${rs.length}): ` + Object.entries(c).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(100 * v / rs.length).toFixed(0)}%`).join(' · '));
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { cls };
