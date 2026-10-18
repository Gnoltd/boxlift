// node tests/pairs_report.test.js -> tools/pairs_report.js on synthetic exports: a camera off by a known
// rotation is fixed from pairs of several files/jobs, a correct camera is left alone, nothing private used.
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('../extension/function/projection.js');
const R = require('../tools/pairs_report.js');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const calib = {
  camera_map: { image_1: 'F', image_2: 'L' }, pcd_frame: 'lidar', lidar: { sensor2ego: I4 },
  cameras: {
    F: { model: 'pinhole', K: [[1840, 0, 955], [0, 1838, 780], [0, 0, 1]], dist: [-0.3, 0.1, 0, 0, 0], image_size: [1920, 1536],
      ego2cam: [[0, -1, 0, 0], [0, 0, -1, 1.6], [1, 0, 0, -1.2], [0, 0, 0, 1]] },
    L: { model: 'fisheye', K: [[720, 0, 959.5], [0, 718, 767.5], [0, 0, 1]], dist: [0.03, -0.01, 0.004, -0.001], image_size: [1920, 1536],
      ego2cam: [[1, 0, 0, 0], [0, 0, -1, 1.6], [0, 1, 0, -0.9], [0, 0, 0, 1]] },
  },
};
const truth = { F: null, L: { pan: 0.7, tilt: -0.5, roll: 0.3, dx: 0, dy: 0, dz: 0, fscale: 1 } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-report-'));
const calibPath = path.join(dir, 'calib.json');
fs.writeFileSync(calibPath, JSON.stringify(calib));
const files = [];
for (let f = 0; f < 2; f++) {
  const cams = {};
  for (const cam of ['F', 'L']) {
    const pairs = [];
    while (pairs.length < 12) {
      const d = 5 + 30 * rnd(), s = -1 + 2 * rnd(), h = -1 + 5 * rnd();
      const p = cam === 'F' ? [d, s * d * 0.5, h] : [s * d * 0.9, d, h];
      const r = P.projectCloud(new Float32Array(p), calib, cam, truth[cam]);
      if (r.u.length) pairs.push({ xyz: p, uv: [r.u[0] + rnd() - 0.5, r.v[0] + rnd() - 0.5], job: 100 + f, frame: 0 });
    }
    cams[cam] = { pairs, adj: {}, bundled: {} };
  }
  const file = path.join(dir, `pairs-${f}.json`);
  fs.writeFileSync(file, JSON.stringify({ kind: 'lidar-cam-pairs', version: 1, calib_hash: R.hashOf(JSON.parse(fs.readFileSync(calibPath))), cameras: cams }));
  files.push(file);
}
const out = path.join(dir, 'solved.json'), log = [];
const orig = console.log; console.log = (...a) => log.push(a.join(' '));
const code = R.main(['--calib', calibPath, '--solve', out, ...files]);
console.log = orig;
check('report runs', code === 0, log.join('\n').includes('image_2 L') ? '' : log.join('\n'));
check('no hash warning for matching calib', !log.some((l) => l.includes('another calib')));
const solved = JSON.parse(fs.readFileSync(out, 'utf8'));
check('correct camera untouched', JSON.stringify(solved.cameras.F.ego2cam) === JSON.stringify(calib.cameras.F.ego2cam));
const probe = new Float32Array([2, 8, 1, -6, 12, 0.5, 9, 20, 2]);
const t = P.projectCloud(probe, calib, 'L', truth.L), s = P.projectCloud(probe, solved, 'L', null);
const e = t.u.map((u, j) => Math.hypot(u - s.u[j], t.v[j] - s.v[j]));
check(`rotated camera fixed: max ${Math.max(...e).toFixed(2)} px on unseen points`, t.u.length === 3 && Math.max(...e) < 1.0);
check('edit note lists the changed camera', solved.edited.cameras.join() === 'L');
fs.rmSync(dir, { recursive: true });

if (fail) { console.error(`FAIL (${fail})`); process.exit(1); }
console.log('PASS');
