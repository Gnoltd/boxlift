// node tests/web_build.test.js — tools/build-web.js: the static Vercel bundle (web/dist) = extension copy minus
// models/config/db/background, shim, optional tour/demo-data/index/boot, patched detector.html, build-info.json.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { build } = require('../tools/build-web.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webbuild-'));
const outDir = path.join(tmp, 'dist');
build({ outDir, root: ROOT, modelBase: 'https://cdn.example/models/' });
const files = walk(outDir).map((f) => path.relative(outDir, f));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));

ok('no .onnx in output', !files.some((f) => f.endsWith('.onnx')));
ok('no database.json / background.js / bridge.js / options.* in output', !files.some((f) => /(^|\/)(database\.json|background\.js|bridge\.js)$|ui\/options\./.test(f)));
ok('no config/ or db/ dirs', !files.some((f) => /^ext\/(config|db)\//.test(f)));
ok('keeps models/frustum.json and SHA256SUMS', files.includes('ext/models/frustum.json') && files.includes('ext/models/SHA256SUMS'));
ok('copies shim', files.includes('shim/chrome-shim.js') && files.includes('shim/mock-cvat.js'));
const info = JSON.parse(fs.readFileSync(path.join(outDir, 'build-info.json'), 'utf8'));
assert.deepStrictEqual(info.scripts, manifest.content_scripts[1].js);
ok('build-info scripts == content_scripts[1].js in order', true);
ok('cvat.js loads last', info.scripts[info.scripts.length - 1] === 'cvat.js');
ok('build-info modelBase', info.modelBase === 'https://cdn.example/models/');
const det = fs.readFileSync(path.join(outDir, 'ext/ui/detector.html'), 'utf8');
const iShim = det.indexOf('chrome-shim.js'), iOrt = det.search(/<script src="(\.\.\/)?ort\//);
ok('detector.html has chrome-shim.js before ort/', iShim >= 0 && iOrt > iShim);
ok('detector.html embeds modelBase', det.includes('https://cdn.example/models/') && det.includes('ChromeShim.install'));
ok('detector.html derives absolute extBase at runtime', det.includes("new URL('/ext/', location.origin).href") && !det.includes("extBase: '/ext/'"));
ok('source detector.html untouched', !fs.readFileSync(path.join(ROOT, 'extension/ui/detector.html'), 'utf8').includes('chrome-shim'));
const size = files.filter((f) => !f.includes('models/')).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
ok(`output <= 90 MB (${(size / 1e6).toFixed(1)} MB)`, size <= 90e6);

// optional inputs: copied when present, skipped (not an error) when absent
// each optional source: present in the repo under test -> must be in the output, absent -> must not be
for (const [src, out] of [['web/tour', /^tour\//], ['web/demo-data', /^demo-data\//], ['web/index.html', /^index\.html$/], ['web/boot.js', /^boot\.js$/]]) {
  const present = fs.existsSync(path.join(ROOT, src));
  ok(`optional ${src}: ${present ? 'copied' : 'skipped'} to match repo`, files.some((f) => out.test(f)) === present);
}
const fx = path.join(tmp, 'root');
fs.cpSync(path.join(ROOT, 'extension'), path.join(fx, 'extension'), { recursive: true, filter: (s) => !s.endsWith('.onnx') });
fs.cpSync(path.join(ROOT, 'web/shim'), path.join(fx, 'web/shim'), { recursive: true });
for (const [f, c] of [['web/index.html', '<html>'], ['web/boot.js', '//boot'], ['web/tour/t.js', '//t'], ['web/demo-data/d.json', '{}']]) {
  fs.mkdirSync(path.dirname(path.join(fx, f)), { recursive: true }); fs.writeFileSync(path.join(fx, f), c);
}
const bare = path.join(tmp, 'bare');
fs.cpSync(path.join(fx, 'extension'), path.join(bare, 'extension'), { recursive: true });
fs.cpSync(path.join(fx, 'web/shim'), path.join(bare, 'web/shim'), { recursive: true });
const outBare = path.join(tmp, 'distBare');
build({ outDir: outBare, root: bare });
ok('absent optional inputs are skipped (bare fixture root)', !walk(outBare).map((f) => path.relative(outBare, f)).some((f) => /^(tour|demo-data)\//.test(f) || f === 'index.html' || f === 'boot.js'));
const out2 = path.join(tmp, 'dist2');
build({ outDir: out2, root: fx });
const f2 = walk(out2).map((f) => path.relative(out2, f));
ok('optional inputs copied when present', ['index.html', 'boot.js', 'tour/t.js', 'demo-data/d.json'].every((f) => f2.includes(f)));
ok('default modelBase is /models/', JSON.parse(fs.readFileSync(path.join(out2, 'build-info.json'), 'utf8')).modelBase === '/models/');
// calib profiles shipped in web/demo-data/calibs are injected into the dist COPY of calibs/index.json (never the source)
const srcIdx = fs.readFileSync(path.join(ROOT, 'extension/calibs/index.json'), 'utf8');
ok('no demo calibs: index.json byte-identical to source', fs.readFileSync(path.join(out2, 'ext/calibs/index.json'), 'utf8') === srcIdx);
const fx3 = path.join(tmp, 'root3');
fs.cpSync(fx, fx3, { recursive: true });
fs.mkdirSync(path.join(fx3, 'web/demo-data/calibs'), { recursive: true });
fs.writeFileSync(path.join(fx3, 'web/demo-data/calibs/x.json'), '{"cameras":{}}');
const out3 = path.join(tmp, 'dist3');
build({ outDir: out3, root: fx3 });
const idx3 = JSON.parse(fs.readFileSync(path.join(out3, 'ext/calibs/index.json'), 'utf8'));
const e3 = idx3.profiles.filter((p) => p.id === 'x');
ok('demo calib: one profile entry appended', e3.length === 1 && e3[0].file === 'x.json' && idx3.profiles[idx3.profiles.length - 1] === e3[0]);
ok('demo calib: file copied to ext/calibs', fs.existsSync(path.join(out3, 'ext/calibs/x.json')));
ok('demo calib: source index untouched', fs.readFileSync(path.join(fx3, 'extension/calibs/index.json'), 'utf8') === srcIdx);
const av = JSON.parse(fs.readFileSync(path.join(outDir, 'ext/calibs/index.json'), 'utf8')).profiles.filter((p) => p.id === 'av2-20dd185d');
ok('real build: av2 profile exact', av.length === 1 && av[0].match === 'av2|argoverse' && av[0].name === 'Argoverse 2 av2-20dd185d' && av[0].dataset === 'Argoverse 2 Sensor' && av[0].licence === 'CC BY-NC-SA 4.0' && av[0].file === 'av2-20dd185d.json' && new RegExp(av[0].match, 'i').test('argoverse2 av2-20dd185d'));
const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
ok('vercel.json output/build', vc.outputDirectory === 'web/dist' && vc.buildCommand === 'node tools/build-web.js');
const hdr = (src) => { const h = vc.headers.find((x) => x.source === src); return h && Object.fromEntries(h.headers.map((k) => [k.key, k.value])); };
ok('vercel.json SPA rewrite /tasks/* -> /index.html', JSON.stringify(vc.rewrites) === JSON.stringify([{ source: '/tasks/:path*', destination: '/index.html' }]));
const IMM = 'public, max-age=31536000, immutable', HOUR = 'public, max-age=3600';
ok('cache: immutable only for pcd/ctx', hdr('/demo-data/pcd/(.*)')['Cache-Control'] === IMM && hdr('/demo-data/ctx/(.*)')['Cache-Control'] === IMM);
ok('cache: 1h for manifest, calibs, ort', hdr('/demo-data/demo-manifest.json')['Cache-Control'] === HOUR && hdr('/demo-data/calibs/(.*)')['Cache-Control'] === HOUR && hdr('/ext/ort/(.*)')['Cache-Control'] === HOUR);
ok('no broad immutable /demo-data/(.*) rule', !vc.headers.some((h) => h.source === '/demo-data/(.*)') && vc.headers.filter((h) => h.headers.some((k) => /immutable/.test(k.value))).every((h) => /^\/demo-data\/(pcd|ctx)\//.test(h.source)));
ok('wasm MIME kept', hdr('/(.*)\\.wasm')['Content-Type'] === 'application/wasm');
ok('X-Frame-Options SAMEORIGIN on all paths', hdr('/(.*)')['X-Frame-Options'] === 'SAMEORIGIN');
// modelBase: on Vercel a missing MODEL_BASE must fail the build instead of silently shipping /models/
const { resolveModelBase } = require('../tools/build-web.js');
ok('resolveModelBase: explicit wins', resolveModelBase('https://a/', { VERCEL: '1', MODEL_BASE: 'https://b/' }) === 'https://a/');
ok('resolveModelBase: env MODEL_BASE', resolveModelBase(undefined, { VERCEL: '1', MODEL_BASE: 'https://b/' }) === 'https://b/');
ok('resolveModelBase: local fallback /models/', resolveModelBase(undefined, {}) === '/models/');
let thrown = ''; try { resolveModelBase(undefined, { VERCEL: '1' }); } catch (e) { thrown = e.message; }
ok('resolveModelBase: throws on Vercel without MODEL_BASE', /MODEL_BASE/.test(thrown));
const sp = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'tools/build-web.js')], { env: { ...process.env, VERCEL: '1', MODEL_BASE: '' }, encoding: 'utf8' });
ok('build-web.js exits non-zero on Vercel without MODEL_BASE', sp.status !== 0 && /MODEL_BASE/.test(sp.stderr));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
