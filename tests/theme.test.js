// node tests/theme.test.js — light / dark colours of the LiDAR ↔ Camera window (the CSS string in extension/cvat.js).
// Both themes set the same colour tokens, every var(--x) used is set, no colour is written outside the tokens except on
// what stays dark in both themes (camera image, point-cloud panes, text drawn over them), and text reads on its
// background in both themes (WCAG 4.5:1).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../extension/cvat.js'), 'utf8');
const css = ((src.match(/const CSS = `([\s\S]*?)`;/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '');
let fail = 0;
const check = (name, ok, why = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${why}`}`); };

// innermost rules only: "@media (...) {" is never part of a selector here
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const tokens = (sel) => Object.fromEntries([...((rules.find((r) => r.sel === sel) || {}).body || '')
  .matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/i;
const dark = tokens(':host'), light = tokens(':host([data-theme="light"])');
const colours = Object.keys(dark).filter((k) => COLOUR.test(dark[k]));

check('dark (default) sets the colour tokens', colours.length >= 10, `${colours.length} found`);
check('light sets every colour token', colours.every((k) => k in light), colours.filter((k) => !(k in light)).join(' '));
check('light sets only colour tokens', Object.keys(light).every((k) => colours.includes(k)),
  Object.keys(light).filter((k) => !colours.includes(k)).join(' '));
const used = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
check('every var(--x) used is set', used.every((k) => k in dark), used.filter((k) => !(k in dark)).join(' '));

// a colour outside the tokens is only allowed on the parts that are dark in both themes
const STAYS_DARK = /^(\.backdrop|\.view|\.bv|\.bvt|\.msg|\.hud)$/;
const stray = rules.filter((r) => !r.sel.startsWith(':host') && COLOUR.test(r.body) &&
  !r.sel.split(',').every((s) => STAYS_DARK.test(s.trim())));
check('no colour outside the tokens', !stray.length, stray.map((r) => r.sel).join(' | '));

const rgb = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(c || ''); return m && [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255); };
const lum = (c) => rgb(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const READS = [['--text', ['--bg', '--surface', '--raised']], ['--text-2', ['--bg', '--surface']], ['--muted', ['--bg', '--surface', '--raised']],
  ['--warn', ['--bg', '--surface', '--raised']], ['--err', ['--bg', '--surface', '--raised']], ['--on-accent', ['--accent']]];
for (const [name, t] of [['dark', dark], ['light', { ...dark, ...light }]]) {
  for (const [fg, bgs] of READS) for (const bg of bgs) {
    const ok = rgb(t[fg]) && rgb(t[bg]) && ratio(t[fg], t[bg]) >= 4.5;
    check(`${name}: ${fg} on ${bg}`, ok, rgb(t[fg]) && rgb(t[bg]) ? ratio(t[fg], t[bg]).toFixed(2) : 'not a #rrggbb colour');
  }
}

console.log(fail ? `FAIL (${fail})` : 'all ok');
process.exit(fail ? 1 : 0);
