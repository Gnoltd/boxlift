// node tests/xss.test.js — pages that build HTML from stored or loaded data (log rows, class names, calib files) must
// escape every text that is not a number or a fixed string. Static check on the expressions that carry such text.
const fs = require('fs');
const path = require('path');
const ui = path.join(__dirname, '..', 'extension', 'ui');
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };

// [file, raw expressions that must not sit in a template unescaped]
const RISKY = {
  'logtab.js': ['${r.job', '${r.frame', '${r.camera', '${r.how'],
  'lab.js': ['${c.name', '${q.status}', "'⚠ ' + q.status", 'lines.push(q.source)'],
  'session-popup.js': ['${c.name', '${l.camera', '${l.how', '${l.label', '${s.session_id}'],
};
for (const [file, bad] of Object.entries(RISKY)) {
  const src = fs.readFileSync(path.join(ui, file), 'utf8');
  for (const b of bad) ok(!src.includes(b), `${file}: no unescaped ${b}`);
  ok(/const esc = /.test(src), `${file}: defines esc()`);
}
process.exit(failed ? 1 : 0);
