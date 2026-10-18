// node tests/handles.test.js — dragging a handle on the image moves the box to where the mouse is,
// on a pinhole (front) and a fisheye (right) camera.
const fs = require('fs'), path = require('path');
const P = require('../extension/function/projection.js'), BH = require('../extension/ui/handles.js');
const calib = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rig.json'), 'utf8'));
let fail = 0, worst = 0;
for (const [cam, box] of [['CAM_FRONT', { x: 14, y: 1.5, z: 0.7, yaw: 0.3, l: 4.5, w: 1.85, h: 1.55 }],
                          ['CAM_RIGHT', { x: 2, y: -7, z: 0.7, yaw: 1.2, l: 4.5, w: 1.85, h: 1.55, rx: 0.03, ry: -0.02 }]]) {
  const proj = (p) => { const r = P.projectCloud(new Float32Array(p), calib, cam, null); return r.u.length ? [r.u[0], r.v[0]] : null; };
  const H = BH.handles(box);
  const cases = [
    ['move', H.find((h) => h.id === 'move'), { ...box, x: box.x + 0.6, y: box.y - 0.4 }, {}],
    ['move z', H.find((h) => h.id === 'move'), { ...box, z: box.z + 0.3 }, { vertical: true }],
    ['front face', H.find((h) => h.id === 'face' && h.axis === 'l' && h.side === 1), null, {}],
    ['roof', H.find((h) => h.id === 'face' && h.axis === 'h' && h.side === 1), null, {}],
    ['yaw', H.find((h) => h.id === 'yaw'), { ...box, yaw: box.yaw + 0.2 }, {}],
  ];
  for (const [name, h, target, opts] of cases) {
    let want;
    if (target) {                                    // where that handle point lands on the target box
      const Ht = BH.handles(target).find((q) => q.id === h.id && q.axis === h.axis && q.side === h.side);
      want = { box: target, m: proj(Ht.p) };
    } else {                                         // face pushed 0.5 m outwards
      const p = h.p.map((v, k) => v + h.n[k] * 0.5);
      want = { box: null, m: proj(p) };
    }
    const got = BH.drag(box, h, want.m, proj, opts);
    const Hg = BH.handles(got).find((q) => q.id === h.id && q.axis === h.axis && q.side === h.side);
    const pg = proj(Hg.p), err = Math.hypot(pg[0] - want.m[0], pg[1] - want.m[1]);
    let extra = '';
    if (h.id === 'face') { const opp = BH.handles(got).find((q) => q.id === 'face' && q.axis === h.axis && q.side === -h.side), opp0 = BH.handles(box).find((q) => q.id === 'face' && q.axis === h.axis && q.side === -h.side);
      const moved = Math.hypot(...opp.p.map((v, k) => v - opp0.p[k])); extra = ` size ${box[h.axis].toFixed(2)}→${got[h.axis].toFixed(2)} opposite face moved ${moved.toFixed(4)} m`; if (moved > 1e-6 || Math.abs(got[h.axis] - box[h.axis] - 0.5) > 0.01) fail++; }
    worst = Math.max(worst, err);
    console.log(`${cam} ${name.padEnd(10)} handle lands ${err.toFixed(2)} px from the mouse${extra}`);
    if (err > 1) fail++;
  }
}
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
