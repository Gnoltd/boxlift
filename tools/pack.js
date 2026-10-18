// node tools/pack.js — one zip a user unpacks and loads (chrome://extensions → Load unpacked): extension + models.
// Models are not in git: missing ones are fetched from the release v1.0.0 (gh), and every model
// is checked against its SHA256 before packing. Output: dist/calib-overlay-v<version>.zip
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..'), EXT = path.join(ROOT, 'extension'), MODELS = path.join(EXT, 'models');
const REPO = 'Gnoltd/boxlift', MODEL_TAG = 'v1.0.0';
const SKIP = new Set(['calib.json', '.DS_Store', 'backup', 'database.json']);

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function sums() {
  const f = path.join(MODELS, 'SHA256SUMS');
  if (!fs.existsSync(f)) execFileSync('gh', ['release', 'download', MODEL_TAG, '-R', REPO, '-D', MODELS, '-p', 'SHA256SUMS', '--clobber'], { stdio: 'inherit' });
  return Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
}

const want = sums();
const missing = Object.keys(want).filter((n) => !fs.existsSync(path.join(MODELS, n)));
if (missing.length) {
  console.log('tải model thiếu:', missing.join(', '));
  execFileSync('gh', ['release', 'download', MODEL_TAG, '-R', REPO, '-D', MODELS, '--clobber', ...missing.flatMap((n) => ['-p', n])], { stdio: 'inherit' });
}
for (const [n, h] of Object.entries(want)) if (sha(path.join(MODELS, n)) !== h) throw new Error(`${n}: SHA256 không khớp, tải lại`);

const version = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
const name = `calib-overlay-v${version}`, dist = path.join(ROOT, 'dist'), stage = path.join(dist, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(EXT, stage, {
  recursive: true,
  filter: (src) => !SKIP.has(path.basename(src))
});
const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, name], { cwd: dist });
fs.rmSync(stage, { recursive: true });
console.log(`${path.relative(ROOT, zip)} · ${(fs.statSync(zip).size / 1e6).toFixed(0)} MB · ${Object.keys(want).length} model đã kiểm SHA256`);
