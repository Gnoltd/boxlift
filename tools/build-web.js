// node tools/build-web.js [--model-base <url>] — static bundle for the Vercel web demo → web/dist/.
// Copies extension/ unchanged to ext/ (minus models, config, db, background/bridge/options), the shim, and the optional
// tour / demo-data / index.html / boot.js; patches ext/ui/detector.html to install the chrome.* shim; writes build-info.json.
// modelBase: --model-base, else env MODEL_BASE, else /models/.
const fs = require('fs'), path = require('path');

const SKIP_TOP = new Set(['config', 'db', 'background.js', 'bridge.js']); // relative to extension/
const OPTIONAL = ['web/tour', 'web/demo-data', 'web/index.html', 'web/boot.js'];

function build({ outDir, root, modelBase }) {
  root = root || path.resolve(__dirname, '..');
  outDir = outDir || path.join(root, 'web/dist');
  modelBase = modelBase || process.env.MODEL_BASE || '/models/';
  const EXT = path.join(root, 'extension');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  fs.cpSync(EXT, path.join(outDir, 'ext'), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(EXT, src).split(path.sep).join('/');
      if (!rel) return true;
      if (SKIP_TOP.has(rel) || rel === '.DS_Store' || rel.endsWith('/.DS_Store')) return false;
      if (rel.startsWith('models/') && rel.endsWith('.onnx')) return false;
      if (/^ui\/options\./.test(rel)) return false;
      if (['calib.json', 'backup'].includes(rel)) return false;
      return true;
    }
  });

  fs.cpSync(path.join(root, 'web/shim'), path.join(outDir, 'shim'), { recursive: true });
  for (const item of OPTIONAL) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) { console.log(`bỏ qua ${item} (chưa có)`); continue; }
    fs.cpSync(src, path.join(outDir, path.relative('web', item)), { recursive: true });
  }

  // Demo calibs (web/demo-data/calibs/*.json) are registered in the COPY of calibs/index.json only; extension/ stays untouched.
  const calDir = path.join(root, 'web/demo-data/calibs');
  const cals = fs.existsSync(calDir) ? fs.readdirSync(calDir).filter((f) => f.endsWith('.json')).sort() : [];
  if (cals.length) {
    const idxPath = path.join(outDir, 'ext/calibs/index.json');
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    for (const file of cals) {
      const id = file.replace(/\.json$/, '');
      fs.copyFileSync(path.join(calDir, file), path.join(outDir, 'ext/calibs', file));
      if (idx.profiles.some((p) => p.id === id)) continue;
      const av2 = /^av2/.test(id);
      idx.profiles.push({ id, name: av2 ? `Argoverse 2 ${id}` : id, match: av2 ? 'av2|argoverse' : id,
        dataset: av2 ? 'Argoverse 2 Sensor' : 'Demo', licence: 'CC BY-NC-SA 4.0', file });
    }
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1) + '\n');
  }

  // detector.html: shim goes before the first ort script (same trick as tools/dev/mock_cvat.py); extBase/modelBase embedded here.
  const detPath = path.join(outDir, 'ext/ui/detector.html');
  const tags = '<script src="/shim/chrome-shim.js"></script>\n' +
    `<script>ChromeShim.install(window, { extBase: new URL('/ext/', location.origin).href, modelBase: new URL(${JSON.stringify(modelBase)}, location.origin).href });</script>\n`;
  const html = fs.readFileSync(detPath, 'utf8');
  const re = /<script src="(\.\.\/)?ort\//;
  if (!re.test(html)) throw new Error('detector.html: không thấy <script src="…ort/"');
  fs.writeFileSync(detPath, html.replace(re, (m) => tags + m));

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify({ scripts: manifest.content_scripts[1].js, modelBase }, null, 2) + '\n');
  return outDir;
}

module.exports = { build };

if (require.main === module) {
  const a = process.argv, i = a.indexOf('--model-base');
  const out = build({ modelBase: i >= 0 ? a[i + 1] : undefined });
  console.log('web build →', path.relative(process.cwd(), out) || out);
}
