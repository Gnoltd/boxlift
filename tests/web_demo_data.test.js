// node tests/web_demo_data.test.js — web/demo-data (Argoverse 2 sample, 10 frames) is complete, readable by the extension code, small, and gt-free.
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), DD = path.join(ROOT, 'web/demo-data');
const { parsePCD } = require('../extension/function/pcd.js');
const ZIP = require('../extension/function/zip.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

(async () => {
  const m = JSON.parse(fs.readFileSync(path.join(DD, 'demo-manifest.json'), 'utf8'));
  ok('manifest: 10 frames', m.frames.length === 10);
  ok('manifest: task name', m.task.name === 'argoverse2 av2-20dd185d');
  ok('manifest: 6 cuboid labels', m.labels.length === 6 && m.labels.every((l) => l.type === 'cuboid'));
  for (const f of m.frames) {
    const pts = parsePCD(ab(fs.readFileSync(path.join(ROOT, 'web', f.pcd))));
    ok(`pcd ${f.fid} parses (>1000 pts)`, pts.length / 3 > 1000);
    const entries = await ZIP.readZip(ab(fs.readFileSync(path.join(ROOT, 'web', f.ctx))));
    const names = [...entries.keys()];
    ok(`ctx ${f.fid}: 7 image entries`, names.length === 7 && names.every((n) => /image_[0-6]\.jpg$/.test(n)));
  }
  const files = walk(DD);
  const total = files.reduce((s, f) => s + fs.statSync(f).size, 0);
  ok(`demo-data <= 40 MB (${(total / 1e6).toFixed(1)} MB)`, total <= 40e6);
  ok('no ground truth under web/', !walk(path.join(ROOT, 'web')).filter((f) => !f.includes('/dist/')).some((f) => /(^|\/)(boxes\.json|frames\.json|gt)(\/|$)/.test(path.relative(ROOT, f))));
  const c = JSON.parse(fs.readFileSync(path.join(DD, 'calibs/av2-20dd185d.json'), 'utf8'));
  ok('calib: 7 cameras, camera_map of 7', Object.keys(c.cameras).length === 7 && Object.keys(c.camera_map).length === 7);
  ok('calib: no gt boxes', !('boxes' in c) && !('gt' in c));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
