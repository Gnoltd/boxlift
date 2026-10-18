"""Front/back on fisheye images: the old crop (projected outline, squashed) vs the rectified crop (rectify.py).

    .venv/bin/python tools/heading/eval_fisheye.py --old work/heading/heading_split.pt --new work/heading-rect/heading_split.pt \
        --root ~/public-data/cvat-upload --scenes 0103,0916

No public fisheye data with 3D boxes is on disk, so the held-out nuScenes images are warped into fisheye images:
equidistant Kannala-Brandt (dist [k1, 0, 0, 0]) with the focal length set so the pinhole's field fills the width,
same pose. The true boxes (>= 10 LiDAR points, >= 24 px, >= 60 % inside) are cropped both ways; front/back right =
the model's density at the true alpha beats the one at alpha + pi (true axis given, as train.py).
"""
import argparse, json, math, os, sys
import numpy as np, cv2, torch, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from train import model, SIZE, MEAN, STD, density
from camera import project
import rectify

CLS = [('vehicle.car', 'car'), ('vehicle.truck', 'truck'), ('vehicle.construction', 'truck'), ('vehicle.trailer', 'truck'),
       ('vehicle.bus', 'bus'), ('vehicle.motorcycle', 'motorcycle'), ('vehicle.bicycle', 'bicycle')]
wrap = lambda a: (a + math.pi) % (2 * math.pi) - math.pi


def fisheye_cam(g, k1):
    W, H = g['image_size']; K = np.array(g['K'], np.float64)
    th = math.atan((W / 2) / K[0, 0])                       # half field of the pinhole across
    f = (W / 2) / (th * (1 + k1 * th * th))
    return {'model': 'fisheye', 'K': [[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], 'dist': [k1, 0, 0, 0], 'image_size': [W, H]}


def warp(img, g, fc):
    """Pinhole image -> the same view through fisheye camera fc (black where the pinhole did not see)."""
    W, H = g['image_size']; K = np.array(g['K'], np.float64); Kf = np.array(fc['K'])
    u, v = np.meshgrid(np.arange(W) + 0.0, np.arange(H) + 0.0)
    xd, yd = (u - Kf[0, 2]) / Kf[0, 0], (v - Kf[1, 2]) / Kf[1, 1]
    thd = np.hypot(xd, yd); k1 = fc['dist'][0]
    th = thd.copy()
    for _ in range(8):                                      # invert thd = th (1 + k1 th^2)
        th = th - (th * (1 + k1 * th * th) - thd) / (1 + 3 * k1 * th * th)
    s = np.where(thd > 1e-9, np.sin(th) / np.maximum(thd, 1e-9), 1.0)
    x, y, z = xd * s, yd * s, np.cos(th)
    ok = z > 0.05
    mu = np.where(ok, K[0, 0] * x / np.maximum(z, 0.05) + K[0, 2], -10).astype(np.float32)
    mv = np.where(ok, K[1, 1] * y / np.maximum(z, 0.05) + K[1, 2], -10).astype(np.float32)
    return cv2.remap(img, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def old_crop(img, cam, b, M):
    """The 0.15.0 crop: bounding box of the projected outline, +15 %, clipped, squashed; alpha in the camera x-z plane."""
    W, H = cam['image_size']
    P = rectify.corners(b) @ M[:3, :3].T + M[:3, 3]
    u, v, ok = project(P, np.array(cam['K'], np.float64), cam['dist'], W, H, cam['model'])
    if ok.sum() < 4:
        return None, None
    u0, u1, v0, v1 = max(0, u[ok].min()), min(W, u[ok].max()), max(0, v[ok].min()), min(H, v[ok].max())
    mu, mv = 0.15 * (u1 - u0), 0.15 * (v1 - v0)
    x0, y0, x1, y1 = int(max(0, u0 - mu)), int(max(0, v0 - mv)), int(min(W, u1 + mu)), int(min(H, v1 + mv))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None, None
    im = cv2.resize(img[y0:y1, x0:x1], (SIZE, SIZE), interpolation=cv2.INTER_AREA)
    c = M[:3, :3] @ [b['x'], b['y'], b['z']] + M[:3, 3]; vv = M[:3, :3] @ [math.cos(b['yaw']), math.sin(b['yaw']), 0.0]
    return im, wrap(math.atan2(vv[0], vv[2]) - math.atan2(c[0], c[2]))


def score(net, crops, alphas):
    x = np.stack([((c[:, :, ::-1].astype(np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1) for c in crops])
    with torch.no_grad():
        p = torch.cat([F.softmax(net(torch.tensor(x[i:i + 256])), 1) for i in range(0, len(x), 256)])
    a = torch.tensor(alphas, dtype=torch.float32)
    return (density(p, a) > density(p, a + math.pi)).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', required=True); ap.add_argument('--new', required=True)
    ap.add_argument('--root', required=True); ap.add_argument('--scenes', default='0103,0916')
    ap.add_argument('--k1', type=float, default=-0.05)
    ap.add_argument('--save', default='')
    a = ap.parse_args()
    nets = {}
    for k in ('old', 'new'):
        n = model(); n.load_state_dict(torch.load(getattr(a, k), map_location='cpu')); n.eval(); nets[k] = n
    data = {k: ([], []) for k in ('pin/old', 'pin/new', 'fish/old', 'fish/new')}
    cls_of = []
    for sc in a.scenes.split(','):
        d = os.path.join(os.path.expanduser(a.root), f'nuscenes-{sc}-key')
        meta = json.load(open(os.path.join(d, 'gt', 'frames.json'))); cal = json.load(open(os.path.join(d, 'gt', 'calib-gt.json')))
        boxes = json.load(open(os.path.join(d, 'gt', 'boxes.json'))); L2E = np.array(cal['lidar']['sensor2ego'])
        for fr in meta['frames']:
            bs = [b for b in boxes.get(fr['fid'], []) if b['num_lidar_pts'] >= 10]
            for img_name, name in cal['camera_map'].items():
                g = cal['cameras'][name]; g = {**g, 'model': 'pinhole', 'dist': g.get('dist', [])}
                M = np.array(g['ego2cam']) @ np.linalg.inv(np.array(fr['cams'][name]['ego'])) @ np.array(fr['lidar_ego']) @ L2E
                fc, W, H = fisheye_cam(g, a.k1), *g['image_size']
                im = fim = None
                for b in bs:
                    cls = next((n for c, n in CLS if b['category'].startswith(c)), None)
                    if not cls:
                        continue
                    P = rectify.corners(b) @ M[:3, :3].T + M[:3, 3]
                    if (P[:, 2] < 0.5).any():
                        continue
                    u, v, _ = project(P, np.array(g['K'], np.float64), g['dist'], W, H, 'pinhole')
                    cu0, cv0, cu1, cv1 = max(u.min(), 0), max(v.min(), 0), min(u.max(), W), min(v.max(), H)
                    if cu1 - cu0 < 24 or cv1 - cv0 < 24 or (cu1 - cu0) * (cv1 - cv0) < 0.6 * (u.max() - u.min()) * (v.max() - v.min()):
                        continue
                    if im is None:
                        im = cv2.imread(os.path.join(d, 'related_images', fr['fid'] + '_pcd', img_name + '.jpg')); fim = warp(im, g, fc)
                    got = {}
                    for cam_k, cam, src in (('pin', g, im), ('fish', fc, fim)):
                        got[cam_k + '/old'] = old_crop(src, cam, b, M)
                        P2 = rectify.corners(b) @ M[:3, :3].T + M[:3, 3]
                        uu, vv, ok = project(P2, np.array(cam['K'], np.float64), cam['dist'], W, H, cam['model'])
                        span = max(np.ptp(uu[ok]), np.ptp(vv[ok])) if ok.sum() >= 2 else SIZE
                        c, al = rectify.crop(src, cam, b, M, SIZE, span=span)
                        got[cam_k + '/new'] = (c, al)
                    if any(v[0] is None for v in got.values()):
                        continue
                    for k, (c, al) in got.items():
                        data[k][0].append(c); data[k][1].append(al)
                    cls_of.append(cls)
                    if a.save and len(cls_of) % 60 == 1:
                        cv2.imwrite(os.path.join(a.save, f'{len(cls_of)}.jpg'), np.concatenate([got[k][0] for k in ('pin/old', 'fish/old', 'fish/new')], 1))
    cls_of = np.array(cls_of)
    res = {k: score(nets[k.split('/')[1]], *v) for k, v in data.items()}
    print(f'{len(cls_of)} objects, fisheye k1 {a.k1}: front/back right (true axis)')
    print(f"{'':12s} {'pinhole old':>12s} {'pinhole new':>12s} {'fisheye old':>12s} {'fisheye new':>12s}")
    for c in ['all'] + sorted(set(cls_of)):
        m = np.ones(len(cls_of), bool) if c == 'all' else cls_of == c
        print(f'{c:12s} n {m.sum():4d}' + ''.join(f' {100 * res[k][m].mean():11.1f}%' for k in ('pin/old', 'pin/new', 'fish/old', 'fish/new')))


if __name__ == '__main__':
    main()
