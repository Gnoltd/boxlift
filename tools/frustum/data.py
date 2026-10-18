"""Training samples for the frustum models (tools/frustum/train.py): one per annotated object seen by a camera.

    .venv/bin/python tools/frustum/data.py nuscenes --root ~/public-data/nuscenes --version v1.0-mini \
        --scenes scene-0061,... | --exclude-scenes ... --out ~/public-data/frustum/nus-mini-train.npz
    .venv/bin/python tools/frustum/data.py kitti --root ~/public-data/kitti3d --split train|val \
        --out ~/public-data/frustum/kitti-train.npz

A sample = the LiDAR points (sensor frame: z up, as the tool's pcd frame) that project into the object's 2D box
grown by GROW on each side, with their pixel position (so training can re-draw the 2D box with jitter, the way a
person or the detector would), the 2D box, the true 3D box {x, y, z (centre), l, w, h, yaw} in the sensor frame and
the class. nuScenes: 2D box = the projected true box clipped to the image (largest view among the cameras);
KITTI: the dataset's 2D box (left colour camera).
Classes: car, truck, bus, motorcycle, bicycle, pedestrian (KITTI: Car/Van -> car, Truck -> truck, Cyclist -> bicycle,
Pedestrian/Person_sitting -> pedestrian). Objects with < MIN_PTS points in their box are left out.
Data: nuScenes CC BY-NC-SA 4.0, KITTI CC BY-NC-SA 3.0 — non-commercial; samples stay outside the repo.
"""
import argparse, json, math, os, sys
import numpy as np
from scipy.spatial.transform import Rotation as R
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from camera import project

CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']
NUS = [('vehicle.car', 'car'), ('vehicle.truck', 'truck'), ('vehicle.construction', 'truck'), ('vehicle.trailer', 'truck'),
       ('vehicle.bus', 'bus'), ('vehicle.motorcycle', 'motorcycle'), ('vehicle.bicycle', 'bicycle'), ('human.pedestrian', 'pedestrian')]
KIT = {'Car': 'car', 'Van': 'car', 'Truck': 'truck', 'Cyclist': 'bicycle', 'Pedestrian': 'pedestrian', 'Person_sitting': 'pedestrian'}
GROW, MIN_PTS, MIN_PX = 0.25, 5, 16
MINI = ['scene-0061', 'scene-0103', 'scene-0553', 'scene-0655', 'scene-0757', 'scene-0796', 'scene-0916', 'scene-1077', 'scene-1094', 'scene-1100']


def corners(b):
    c, s = math.cos(b[6]), math.sin(b[6])
    return np.array([[b[0] + i * b[3] / 2 * c - j * b[4] / 2 * s, b[1] + i * b[3] / 2 * s + j * b[4] / 2 * c, b[2] + k * b[5] / 2]
                     for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)])


def inside(pts, b, m=0.0):
    c, s = math.cos(-b[6]), math.sin(-b[6])
    d = pts[:, :3] - b[:3]
    return (np.abs(d[:, 0] * c - d[:, 1] * s) < b[3] / 2 + m) & (np.abs(d[:, 0] * s + d[:, 1] * c) < b[4] / 2 + m) & (np.abs(d[:, 2]) < b[5] / 2 + m)


class Writer:
    def __init__(self):
        self.pts, self.uv, self.off, self.meta = [], [], [0], []

    def add(self, pts, uv, rect, box, cls, src):
        self.pts.append(pts.astype(np.float32)); self.uv.append(uv.astype(np.float32)); self.off.append(self.off[-1] + len(pts))
        self.meta.append((rect, box, CLASSES.index(cls), src))

    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez(path, pts=np.concatenate(self.pts), uv=np.concatenate(self.uv), off=np.array(self.off, np.int64),
                 rect=np.array([m[0] for m in self.meta], np.float32), box=np.array([m[1] for m in self.meta], np.float32),
                 cls=np.array([m[2] for m in self.meta], np.int64), src=np.array([m[3] for m in self.meta]))
        n = np.bincount([m[2] for m in self.meta], minlength=len(CLASSES))
        print(f'{path}: {len(self.meta)} samples, {self.off[-1]} points ·', ', '.join(f'{c} {k}' for c, k in zip(CLASSES, n)), flush=True)


def take(w, xyz, M, cam, rect, box, cls, src):
    """Points of the frustum of `rect` (grown) on camera `cam` (M: sensor -> camera) -> one sample."""
    W, H = cam['image_size']
    u, v, ok = project(xyz @ M[:3, :3].T + M[:3, 3], np.array(cam['K'], np.float64), cam.get('dist', []), W, H, cam.get('model', 'pinhole'))
    u0, v0, u1, v1 = rect
    gu, gv = GROW * (u1 - u0), GROW * (v1 - v0)
    sel = ok & (u >= u0 - gu) & (u <= u1 + gu) & (v >= v0 - gv) & (v <= v1 + gv)
    if inside(xyz[sel], box).sum() < MIN_PTS:
        return
    w.add(xyz[sel], np.stack([u[sel], v[sel]], 1), rect, box, cls, src)


def T_of(rec):
    T = np.eye(4); w, x, y, z = rec['rotation']
    T[:3, :3] = R.from_quat([x, y, z, w]).as_matrix(); T[:3, 3] = rec['translation']
    return T


def nuscenes(a):
    root = os.path.expanduser(a.root)
    tab = lambda n: json.load(open(os.path.join(root, a.version, n + '.json')))
    scenes = {s['token']: s['name'] for s in tab('scene')}
    want = set(filter(None, a.scenes.split(','))) if a.scenes else None
    skip = set(filter(None, a.exclude_scenes.split(',')))
    samples = [s for s in tab('sample') if (want is None or scenes[s['scene_token']] in want) and scenes[s['scene_token']] not in skip]
    sd = {}
    for d in tab('sample_data'):
        if d['is_key_frame']:
            sd.setdefault(d['sample_token'], []).append(d)
    cs = {c['token']: c for c in tab('calibrated_sensor')}
    sensor = {s['token']: s['channel'] for s in tab('sensor')}
    pose = {p['token']: T_of(p) for p in tab('ego_pose')}
    cat = {c['token']: c['name'] for c in tab('category')}
    inst = {i['token']: cat[i['category_token']] for i in tab('instance')}
    ann = {}
    for x in tab('sample_annotation'):
        ann.setdefault(x['sample_token'], []).append(x)
    w = Writer()
    if a.sweeps:
        return nuscenes_sweeps(a, root, tab, scenes, want, skip, cs, sensor, pose, inst, ann, w)
    for n, s in enumerate(samples):
        ds = {sensor[cs[d['calibrated_sensor_token']]['sensor_token']]: d for d in sd.get(s['token'], [])}
        if 'LIDAR_TOP' not in ds or not os.path.exists(os.path.join(root, ds['LIDAR_TOP']['filename'])):
            continue                                         # blob not downloaded
        L = ds['LIDAR_TOP']; L2E = T_of(cs[L['calibrated_sensor_token']]); E2G = pose[L['ego_pose_token']]
        xyz = np.fromfile(os.path.join(root, L['filename']), np.float32).reshape(-1, 5)[:, :3].astype(np.float64)
        G2L = np.linalg.inv(E2G @ L2E)
        cams = []
        for ch, d in ds.items():
            if not ch.startswith('CAM'):
                continue
            c = cs[d['calibrated_sensor_token']]
            M = np.linalg.inv(T_of(c)) @ np.linalg.inv(pose[d['ego_pose_token']]) @ E2G @ L2E      # lidar -> camera
            cams.append(({'K': c['camera_intrinsic'], 'dist': [], 'image_size': [d['width'], d['height']]}, M, ch))
        for x in ann.get(s['token'], []):
            cls = next((k for p, k in NUS if inst[x['instance_token']].startswith(p)), None)
            if not cls or x['num_lidar_pts'] < MIN_PTS:
                continue
            Tg = T_of(x); Tl = G2L @ Tg
            yaw = math.atan2(Tl[1, 0], Tl[0, 0]); wd, ln, ht = x['size']
            box = np.array([*Tl[:3, 3], ln, wd, ht, yaw])
            best = None
            for cam, M, ch in cams:
                P = corners(box) @ M[:3, :3].T + M[:3, 3]
                if (P[:, 2] < 0.5).any():
                    continue
                K = np.array(cam['K']); uu = K[0, 0] * P[:, 0] / P[:, 2] + K[0, 2]; vv = K[1, 1] * P[:, 1] / P[:, 2] + K[1, 2]
                W, H = cam['image_size']
                r = [max(0, uu.min()), max(0, vv.min()), min(W, uu.max()), min(H, vv.max())]
                area = (r[2] - r[0]) * (r[3] - r[1])
                if r[2] - r[0] < MIN_PX or r[3] - r[1] < MIN_PX or area < 0.6 * np.ptp(uu) * np.ptp(vv):
                    continue
                if not best or area > best[0]:
                    best = (area, cam, M, r)
            if best:
                take(w, xyz, best[2], best[1], best[3], box, cls, f"nus:{scenes[s['scene_token']]}")
        if n % 200 == 0:
            print(f'{n}/{len(samples)} samples, {len(w.meta)} objects', flush=True)
    w.save(os.path.expanduser(a.out))


def nuscenes_sweeps(a, root, tab, scenes, want, skip, cs, sensor, pose, inst, ann, w):
    """LIDAR_TOP sweeps between keyframes (20 Hz) with each object's box interpolated between the two keyframes around
    it (position linear, rotation slerp; objects in both only); cameras of the earlier keyframe, ego pose of the sweep."""
    from scipy.spatial.transform import Slerp
    smp = {s['token']: s for s in tab('sample')}
    sds = tab('sample_data')
    lid = sorted([d for d in sds if sensor[cs[d['calibrated_sensor_token']]['sensor_token']] == 'LIDAR_TOP'], key=lambda d: d['timestamp'])
    key_cams = {}
    for d in sds:
        ch = sensor[cs[d['calibrated_sensor_token']]['sensor_token']]
        if d['is_key_frame'] and ch.startswith('CAM'):
            key_cams.setdefault(d['sample_token'], []).append((d, ch))
    kept = 0
    for n, L in enumerate(lid):
        if n % a.sweeps or L['is_key_frame']:
            continue
        s0 = smp.get(L['sample_token'])                      # the next keyframe's sample (nuScenes links sweeps forward)
        if not s0 or scenes[s0['scene_token']] in skip or (want is not None and scenes[s0['scene_token']] not in want):
            continue
        prev = smp.get(s0['prev'])
        if not prev or not os.path.exists(os.path.join(root, L['filename'])):
            continue
        t0, t1 = prev['timestamp'], s0['timestamp']
        f = (L['timestamp'] - t0) / max(1, t1 - t0)
        if not 0 <= f <= 1:
            continue
        L2E = T_of(cs[L['calibrated_sensor_token']]); E2G = pose[L['ego_pose_token']]
        G2L = np.linalg.inv(E2G @ L2E)
        xyz = np.fromfile(os.path.join(root, L['filename']), np.float32).reshape(-1, 5)[:, :3].astype(np.float64)
        cams = []
        for d, ch in key_cams.get(prev['token'], []):
            c = cs[d['calibrated_sensor_token']]
            M = np.linalg.inv(T_of(c)) @ np.linalg.inv(E2G) @ E2G @ L2E
            cams.append(({'K': c['camera_intrinsic'], 'dist': [], 'image_size': [d['width'], d['height']]}, M, ch))
        nxt = {x['instance_token']: x for x in ann.get(s0['token'], [])}
        for x0 in ann.get(prev['token'], []):
            x1 = nxt.get(x0['instance_token'])
            cls = next((k for p, k in NUS if inst[x0['instance_token']].startswith(p)), None)
            if not x1 or not cls:
                continue
            q = [[*r[1:], r[0]] for r in (x0['rotation'], x1['rotation'])]
            rot = Slerp([0, 1], R.from_quat(q))(f)
            Tg = np.eye(4); Tg[:3, :3] = rot.as_matrix(); Tg[:3, 3] = (1 - f) * np.array(x0['translation']) + f * np.array(x1['translation'])
            Tl = G2L @ Tg
            wd, ln, ht = x0['size']
            box = np.array([*Tl[:3, 3], ln, wd, ht, math.atan2(Tl[1, 0], Tl[0, 0])])
            best = None
            for cam, M, ch in cams:
                P = corners(box) @ M[:3, :3].T + M[:3, 3]
                if (P[:, 2] < 0.5).any():
                    continue
                K = np.array(cam['K']); uu = K[0, 0] * P[:, 0] / P[:, 2] + K[0, 2]; vv = K[1, 1] * P[:, 1] / P[:, 2] + K[1, 2]
                W, H = cam['image_size']
                r = [max(0, uu.min()), max(0, vv.min()), min(W, uu.max()), min(H, vv.max())]
                area = (r[2] - r[0]) * (r[3] - r[1])
                if r[2] - r[0] < MIN_PX or r[3] - r[1] < MIN_PX or area < 0.6 * np.ptp(uu) * np.ptp(vv):
                    continue
                if not best or area > best[0]:
                    best = (area, cam, M, r)
            if best:
                take(w, xyz, best[2], best[1], best[3], box, cls, f"nus-sweep:{scenes[s0['scene_token']]}")
        kept += 1
        if kept % 200 == 0:
            print(f'{kept} sweeps, {len(w.meta)} objects', flush=True)
    w.save(os.path.expanduser(a.out))


def kitti(a):
    root = os.path.expanduser(a.root)
    ids = [l.strip() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kitti_split', a.split + '.txt')) if l.strip()]
    w = Writer()
    for n, i in enumerate(ids):
        cal = {}
        for line in open(os.path.join(root, 'training', 'calib', i + '.txt')):
            if ':' in line:
                k, v = line.split(':', 1); cal[k] = np.array([float(t) for t in v.split()])
        P2 = cal['P2'].reshape(3, 4); R0 = np.eye(4); R0[:3, :3] = cal['R0_rect'].reshape(3, 3)
        Tr = np.eye(4); Tr[:3, :] = cal['Tr_velo_to_cam'].reshape(3, 4)
        # rectified camera with the principal point / focal of P2 (its small baseline shift folded into t)
        K = P2[:, :3]; t = np.linalg.solve(K, P2[:, 3])
        M = R0 @ Tr; M[:3, 3] += t
        xyz = np.fromfile(os.path.join(root, 'training', 'velodyne', i + '.bin'), np.float32).reshape(-1, 4)[:, :3].astype(np.float64)
        V2C = R0 @ Tr; C2V = np.linalg.inv(V2C)
        import cv2
        im = cv2.imread(os.path.join(root, 'training', 'image_2', i + '.png'))
        H, W = (im.shape[:2] if im is not None else (375, 1242))
        cam = {'K': K.tolist(), 'dist': [], 'image_size': [W, H]}
        for line in open(os.path.join(root, 'training', 'label_2', i + '.txt')):
            f = line.split()
            cls = KIT.get(f[0])
            if not cls:
                continue
            h, wd, ln = map(float, f[8:11]); x, y, z = map(float, f[11:14]); ry = float(f[14])
            c = C2V @ [x, y - h / 2, z, 1.0]                      # KITTI location = bottom centre, camera y down
            box = np.array([*c[:3], ln, wd, h, -ry - math.pi / 2])
            rect = list(map(float, f[4:8]))
            if rect[2] - rect[0] < MIN_PX or rect[3] - rect[1] < MIN_PX:
                continue
            take(w, xyz, M, cam, rect, box, cls, f'kitti:{i}')
        if n % 500 == 0:
            print(f'{n}/{len(ids)} frames, {len(w.meta)} objects', flush=True)
    w.save(os.path.expanduser(a.out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset', choices=['nuscenes', 'kitti'])
    ap.add_argument('--root', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--version', default='v1.0-mini')
    ap.add_argument('--scenes', default='')
    ap.add_argument('--exclude-scenes', default='')
    ap.add_argument('--split', default='train')
    ap.add_argument('--sweeps', type=int, default=0, help='nuScenes: every N-th non-key LIDAR_TOP sweep instead of the keyframes')
    a = ap.parse_args()
    nuscenes(a) if a.dataset == 'nuscenes' else kitti(a)


if __name__ == '__main__':
    main()
