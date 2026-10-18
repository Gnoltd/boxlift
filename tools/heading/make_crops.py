"""Image crops of annotated objects + their observation angle, to train the front/back (heading) model.

    .venv/bin/python tools/heading/make_crops.py --root ~/public-data/cvat-upload \
        --out ~/public-data/heading

Input: converted nuScenes keyframe scenes (nuscenes_to_cvat.py: related_images/, gt/frames.json, gt/calib-gt.json,
gt/boxes.json). For every annotated vehicle / two-wheeler / pedestrian and every camera that sees it (projected box
>= 24 px, >= 60 % of it inside the image, >= 1 LiDAR point), its crop through a virtual camera looking straight at it (rectify.py: works the same for
fisheye cameras) is saved with alpha, the observation angle: heading of the object relative to the ray to its centre.
alpha = 0: moving away from the camera (rear seen), +-pi: towards it (front seen), +pi/2: heading to the right.
Output: <out>/crops/<scene>/<n>.jpg + <out>/labels.json [{file, scene, cls, alpha, vis, pts, w, h}].
"""
import argparse, glob, json, os, sys
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rectify

SIZE = 160          # train.py preloads at this size

CLS = [('vehicle.car', 'car'), ('vehicle.truck', 'truck'), ('vehicle.construction', 'truck'), ('vehicle.trailer', 'truck'),
       ('vehicle.bus', 'bus'), ('vehicle.motorcycle', 'motorcycle'), ('vehicle.bicycle', 'bicycle'), ('human.pedestrian', 'pedestrian')]


def corners(b):
    c, s = np.cos(b['yaw']), np.sin(b['yaw'])
    out = []
    for i in (-1, 1):
        for j in (-1, 1):
            for k in (-1, 1):
                x, y = i * b['l'] / 2, j * b['w'] / 2
                out.append([b['x'] + x * c - y * s, b['y'] + x * s + y * c, b['z'] + k * b['h'] / 2])
    return np.array(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    root, out = os.path.expanduser(a.root), os.path.expanduser(a.out)
    rows = []
    for d in sorted(glob.glob(os.path.join(root, 'nuscenes-*-key'))):
        meta = json.load(open(os.path.join(d, 'gt', 'frames.json')))
        cal = json.load(open(os.path.join(d, 'gt', 'calib-gt.json')))
        boxes = json.load(open(os.path.join(d, 'gt', 'boxes.json')))
        scene = meta['scene']
        os.makedirs(os.path.join(out, 'crops', scene), exist_ok=True)
        L2E = np.array(cal['lidar']['sensor2ego'])
        n0 = len(rows)
        for fr in meta['frames']:
            bs = [b for b in boxes.get(fr['fid'], []) if b['num_lidar_pts'] >= 1]
            if not bs:
                continue
            for img, name in cal['camera_map'].items():
                g, cm = cal['cameras'][name], fr['cams'][name]
                M = np.array(g['ego2cam']) @ np.linalg.inv(np.array(cm['ego'])) @ np.array(fr['lidar_ego']) @ L2E
                K = np.array(g['K']); W, H = g['image_size']
                im = None
                for b in bs:
                    cls = next((n for c, n in CLS if b['category'].startswith(c)), None)
                    if not cls:
                        continue
                    P = corners(b) @ M[:3, :3].T + M[:3, 3]
                    if (P[:, 2] < 0.5).any():
                        continue
                    uv = (P[:, :2] / P[:, 2:]) * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
                    u0, v0 = uv.min(0); u1, v1 = uv.max(0)
                    cu0, cv0, cu1, cv1 = max(u0, 0), max(v0, 0), min(u1, W), min(v1, H)
                    if cu1 - cu0 < 24 or cv1 - cv0 < 24 or (cu1 - cu0) * (cv1 - cv0) < 0.6 * (u1 - u0) * (v1 - v0):
                        continue
                    if im is None:
                        im = cv2.imread(os.path.join(d, 'related_images', fr['fid'] + '_pcd', img + '.jpg'))
                    out_im, al = rectify.crop(im, g, b, M, SIZE, span=max(cu1 - cu0, cv1 - cv0))
                    if out_im is None:
                        continue
                    f = os.path.join('crops', scene, f'{len(rows)}.jpg')
                    cv2.imwrite(os.path.join(out, f), out_im, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    rows.append({'file': f, 'scene': scene, 'cls': cls, 'alpha': al, 'vis': b['visibility'],
                                 'pts': b['num_lidar_pts'], 'w': int(cu1 - cu0), 'h': int(cv1 - cv0), 'cam': name, 'fid': fr['fid']})
        print(f'{scene}: {len(rows) - n0} crops', flush=True)
    json.dump(rows, open(os.path.join(out, 'labels.json'), 'w'))
    from collections import Counter
    print(len(rows), 'crops', dict(Counter(r['cls'] for r in rows)))


if __name__ == '__main__':
    main()
