"""KITTI raw (synced + rectified) drive -> CVAT 3D upload + ground-truth calibration.

    .venv/bin/python tools/public/kitti_to_cvat.py --root ~/public-data/kitti \
        --drive 2011_09_26_drive_0005 --out ~/public-data/cvat-upload/kitti-0005 [--every 2]

Cameras: image_1 = cam 02 (left colour, the reference), image_0 = cam 00 (left grey), image_2 = cam 03 (right
colour), image_3 = cam 01 (right grey); rectified, so K = P_rect[:, :3] and no distortion. Ego frame = Velodyne
frame (x forward, y left, z up), so lidar.sensor2ego = I. Writes the same layout as nuscenes_to_cvat.py
(pointcloud/, related_images/, gt/calib-gt.json, gt/calib-ref.json, upload.zip); no ego poses (gt/frames.json
has only timestamps).
Data: KITTI raw, CC BY-NC-SA 3.0 (https://www.cvlibs.net/datasets/kitti/raw_data.php).
"""
import argparse, datetime, json, os, shutil, sys, zipfile
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nuscenes_to_cvat import write_pcd

CAMS = {1: '02', 0: '00', 2: '03', 3: '01'}


def read_kv(path):
    out = {}
    for line in open(path):
        k, _, v = line.partition(':')
        try:
            out[k.strip()] = np.array([float(x) for x in v.split()])
        except ValueError:
            pass
    return out


def stamps(path):
    t = []
    for line in open(path):
        d, frac = line.strip().split('.')
        t.append(datetime.datetime.strptime(d, '%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()
                 + float('0.' + frac))
    return np.array(t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='folder with <date>/ (calib txt files + <drive>_sync/)')
    ap.add_argument('--drive', default='2011_09_26_drive_0005')
    ap.add_argument('--out', required=True)
    ap.add_argument('--every', type=int, default=1)
    a = ap.parse_args()
    root, date = os.path.expanduser(a.root), a.drive[:10]
    ddir = os.path.join(root, date, a.drive + '_sync')
    c2c, v2c = read_kv(os.path.join(root, date, 'calib_cam_to_cam.txt')), read_kv(os.path.join(root, date, 'calib_velo_to_cam.txt'))
    T_c0_v = np.eye(4); T_c0_v[:3, :3] = v2c['R'].reshape(3, 3); T_c0_v[:3, 3] = v2c['T']
    Rr = np.eye(4); Rr[:3, :3] = c2c['R_rect_00'].reshape(3, 3)

    tv = stamps(os.path.join(ddir, 'velodyne_points', 'timestamps.txt'))
    n = len(tv)
    out = os.path.expanduser(a.out)
    if os.path.exists(out):
        raise SystemExit(f'{out} exists; remove it first')
    os.makedirs(os.path.join(out, 'pointcloud')); os.makedirs(os.path.join(out, 'gt'))
    tc = {cid: stamps(os.path.join(ddir, f'image_{cid}', 'timestamps.txt')) for cid in CAMS.values()}
    frames, W, H = [], None, None
    for k in range(0, n, a.every):
        sec = int(tv[k]); fid = f'{sec}-{int(round((tv[k] - sec) * 1e9)):09d}'
        pts = np.fromfile(os.path.join(ddir, 'velodyne_points', 'data', f'{k:010d}.bin'), dtype=np.float32).reshape(-1, 4).copy()
        pts[:, 3] *= 255.0                                       # reflectance 0..1 -> grey
        write_pcd(os.path.join(out, 'pointcloud', fid + '.pcd'), pts)
        d = os.path.join(out, 'related_images', fid + '_pcd'); os.makedirs(d)
        for i, cid in CAMS.items():
            src = os.path.join(ddir, f'image_{cid}', 'data', f'{k:010d}.png')
            im = cv2.imread(src)
            H, W = im.shape[:2]
            cv2.imwrite(os.path.join(d, f'image_{i}.jpg'), im, [cv2.IMWRITE_JPEG_QUALITY, 95])
        frames.append({'fid': fid, 'lidar_t': tv[k], 'cams': {f'CAM_{cid}': {'t': float(tc[cid][k])} for cid in CAMS.values()}})

    calib = {'pcd_frame': 'lidar', 'lidar': {'sensor2ego': np.eye(4).tolist(), 'origin_pcd': [0, 0, 0]}, 'cameras': {},
             'camera_map': {f'image_{i}': f'CAM_{cid}' for i, cid in sorted(CAMS.items())},
             'source': f'KITTI raw {a.drive} calib_cam_to_cam + calib_velo_to_cam (ground truth), CC BY-NC-SA 3.0'}
    for i, cid in CAMS.items():
        P = c2c[f'P_rect_{cid}'].reshape(3, 4); K = P[:, :3]
        Ti = np.eye(4); Ti[0, 3] = P[0, 3] / K[0, 0]; Ti[1, 3] = P[1, 3] / K[1, 1]      # rectified camera i <- rectified cam 0
        dts = [f['cams'][f'CAM_{cid}']['t'] - f['lidar_t'] for f in frames]
        calib['cameras'][f'CAM_{cid}'] = {'model': 'pinhole', 'K': K.tolist(), 'dist': [0.0] * 5,
                                          'ego2cam': (Ti @ Rr @ T_c0_v).tolist(), 'image_size': [W, H],
                                          'time_offset_s': float(np.median(dts))}
    json.dump(calib, open(os.path.join(out, 'gt', 'calib-gt.json'), 'w'), indent=2)
    ref = {k: v for k, v in calib.items() if k != 'cameras'}
    ref['cameras'] = {'CAM_02': calib['cameras']['CAM_02']}; ref['camera_map'] = {'image_1': 'CAM_02'}
    json.dump(ref, open(os.path.join(out, 'gt', 'calib-ref.json'), 'w'), indent=2)
    json.dump({'drive': a.drive, 'camera_map': calib['camera_map'], 'frames': frames}, open(os.path.join(out, 'gt', 'frames.json'), 'w'))
    with zipfile.ZipFile(os.path.join(out, 'upload.zip'), 'w', zipfile.ZIP_STORED) as z:
        for sub in ('pointcloud', 'related_images'):
            for dp, _, fs in os.walk(os.path.join(out, sub)):
                for f in sorted(fs):
                    p = os.path.join(dp, f); z.write(p, os.path.relpath(p, out))
    print(f'{a.drive}: {len(frames)} frames, images {W}x{H} -> {out}')
    for i, cid in sorted(CAMS.items()):
        print(f'  image_{i} CAM_{cid}: camera - lidar time median {1000 * calib["cameras"][f"CAM_{cid}"]["time_offset_s"]:+.1f} ms')


if __name__ == '__main__':
    main()
