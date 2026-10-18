// node tests/manifest.test.js — what a web page may read from the extension (web_accessible_resources) is only what the
// content script loads into the CVAT page; models, calibrations, runtime and scripts stay private.
const fs = require('fs');
const path = require('path');
const ext = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };

const patterns = manifest.web_accessible_resources.flatMap((w) => w.resources);
const covered = (f) => patterns.some((p) => (p.endsWith('/*') ? f.startsWith(p.slice(0, -1)) : p === f));

// every extension file the content script hands to the page
const cvat = fs.readFileSync(path.join(ext, 'cvat.js'), 'utf8');
const used = [...new Set([...cvat.matchAll(/getURL\('([^')]+)'\)/g)].map((m) => m[1]).filter((f) => f))];
ok(used.length >= 4, `cvat.js loads ${used.length} extension files into the page`);
for (const f of used) ok(covered(f), `web-accessible: ${f}`);

for (const secret of ['models/frustum_box.onnx', 'models/mtrans.onnx', 'calibs/index.json', 'ort/ort.webgpu.min.js',
  'config/database.json', 'function/supalog.js', 'ui/detector.js']) {
  ok(!covered(secret), `private: ${secret}`);
}
process.exit(failed ? 1 : 0);
