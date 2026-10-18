// node tests/heading.test.js -> front / back choice (extension/heading.js): observation angle of a box seen by a
// camera (same convention as tools/heading/rectify.py), the end the model's bins favour, rectified crop, input tensor.
const H = require('../extension/function/heading.js');
const rig = require('./fixtures/rig.json');

let fail = 0;
const check = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); };
const near = (a, b, tol = 0.05) => Math.abs(H.wrap(a - b)) < tol;
const box = (yaw) => ({ x: 20, y: 0, z: 0, yaw, l: 4.5, w: 1.9, h: 1.6 });   // straight ahead of CAM_FRONT

check('moving away from the camera: alpha 0 (rear seen)', near(H.alphaOf(box(0), rig, 'CAM_FRONT'), 0), H.alphaOf(box(0), rig, 'CAM_FRONT').toFixed(3));
check('coming towards it: alpha +-pi (front seen)', near(H.alphaOf(box(Math.PI), rig, 'CAM_FRONT'), Math.PI));
check('heading to the camera\'s right: alpha +pi/2', near(H.alphaOf(box(-Math.PI / 2), rig, 'CAM_FRONT'), Math.PI / 2));
check('alpha is relative to the ray: same heading, object off to the left', near(H.alphaOf({ ...box(0), y: 20 }, rig, 'CAM_FRONT'), Math.PI / 4, 0.1),
  H.alphaOf({ ...box(0), y: 20 }, rig, 'CAM_FRONT').toFixed(3));

// model says "rear seen" (all mass near alpha 0: bins 3 and 4 are centred at -22.5 and +22.5 deg)
const rear = H.softmax([0, 0, 0, 5, 5, 0, 0, 0]);
check('softmax sums to 1', Math.abs(rear.reduce((a, b) => a + b, 0) - 1) < 1e-9);
const keep = H.chooseEnd(box(0), rear, rig, 'CAM_FRONT'), flip = H.chooseEnd(box(Math.PI), rear, rig, 'CAM_FRONT');
check('box already pointing away: kept', !keep.flip && keep.conf > 10, JSON.stringify(keep));
check('box pointing at the camera: flipped', flip.flip && near(flip.alpha, 0));
const flat = H.chooseEnd(box(Math.PI), H.softmax(new Array(8).fill(0)), rig, 'CAM_FRONT');
check('no opinion: conf ~1', Math.abs(flat.conf - 1) < 1e-6);
const mild = H.softmax([0, 0, 0, 0.3, 0.3, 0, 0, 0]);
check('other opinion (odds) outweighs a weak image', !H.chooseEnd(box(Math.PI), mild, rig, 'CAM_FRONT', undefined, 0.2).flip && H.chooseEnd(box(Math.PI), mild, rig, 'CAM_FRONT').flip);
check('... but not a sure image', H.chooseEnd(box(Math.PI), rear, rig, 'CAM_FRONT', undefined, 0.2).flip);

// rectified crop: a fisheye camera looking forward; the image is white except a red disc where the box centre images,
// so the crop must be white all round with the red near its centre (the virtual camera looks straight at the box; the
// crop is centred on the box's outline, which perspective puts a little off the centre's image)
const P = require('../extension/function/projection.js');
const fish = { pcd_frame: 'ego', cameras: { F: { model: 'fisheye', K: [[400, 0, 640], [0, 400, 480], [0, 0, 1]], dist: [-0.05, 0, 0, 0],
  image_size: [1280, 960], ego2cam: [[0, -1, 0, 0], [0, 0, -1, 1.5], [1, 0, 0, 0], [0, 0, 0, 1]] } } };
const side = { x: 3, y: 6, z: 0.8, yaw: 0.3, l: 4.5, w: 1.85, h: 1.5 };            // 63 deg off the optical axis
const c = P.camToPixel(fish.cameras.F, null, -side.y, 1.5 - side.z, side.x);
const img = { width: 1280, height: 960, data: new Uint8ClampedArray(1280 * 960 * 4).fill(255) };
for (let v = 0; v < 960; v++) for (let u = 0; u < 1280; u++) if ((u - c[0]) ** 2 + (v - c[1]) ** 2 < 1600) { const o = 4 * (v * 1280 + u); img.data[o + 1] = 0; img.data[o + 2] = 0; }
const crop = H.rectify(side, fish, 'F', null, img), at = (x, y) => crop[4 * (y * H.SIZE + x) + 1];
let red = [0, 0, 0];                                                           // centroid of the red pixels
for (let y = 0; y < H.SIZE; y++) for (let x = 0; x < H.SIZE; x++) if (at(x, y) < 100) red = [red[0] + x, red[1] + y, red[2] + 1];
red = [red[0] / red[2], red[1] / red[2], red[2]];
check('rectified fisheye crop: box centre near the crop centre, white all round', crop && red[2] > 20 && Math.hypot(red[0] - 64, red[1] - 64) < 20 &&
  at(4, 4) > 200 && at(123, 123) > 200 && at(4, 123) > 200, crop && `red at ${red}`);
check('box off to the side: alpha relative to the ray, not the optical axis', Math.abs(H.wrap(H.alphaOf(side, fish, 'F') - (Math.atan2(6, 3) - 0.3))) < 0.05,
  H.alphaOf(side, fish, 'F').toFixed(3));
check('box behind the camera: no crop', H.rectify({ ...side, x: -5 }, fish, 'F', null, img) === null);
const S = H.SIZE, px = new Uint8ClampedArray(4 * S * S).fill(255), t = H.tensorFromRGBA(px);
check('tensor: CHW, ImageNet mean / std', t.length === 3 * S * S && Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-6 && Math.abs(t[2 * S * S] - (1 - 0.406) / 0.225) < 1e-6);

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
