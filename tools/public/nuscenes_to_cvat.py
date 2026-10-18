"""nuScenes (v1.0-mini) scene -> CVAT 3D upload + ground-truth calibration, for testing the tool on public data.

    .venv/bin/python tools/public/nuscenes_to_cvat.py --root ~/public-data/nuscenes \
        --scene scene-0061 --out ~/public-data/cvat-upload/nuscenes-scene-0061 [--sweeps 2]

Writes, under --out:
  pointcloud/<sec>-<nsec>.pcd                    LIDAR_TOP sweep, lidar frame, binary x y z rgb (grey = intensity)
  related_images/<sec>-<nsec>_pcd/image_N.jpg   the 6 cameras (image_1 = CAM_FRONT, the reference)
  gt/calib-gt.json      every camera, our schema (lidar.sensor2ego, cameras.<name>.ego2cam/K/dist), from
                        nuScenes calibrated_sensor = the answer the tool is compared with
  gt/calib-ref.json     only CAM_FRONT: what autocalib gets as input (as for our own car)
  gt/frames.json        per frame: lidar time + ego pose, per camera: time + ego pose (global frame),
                        so exact projections (with the ego motion between lidar and camera) can be computed
  gt/boxes.json         keyframes only: the annotated 3D boxes per frame in the pcd (lidar) frame, CVAT
                        convention {x, y, z (centre), yaw, l, w, h} + category, visibility, lidar point count
  upload.zip            pointcloud/ + related_images/, ready for "Create task" on CVAT local

Frames: keyframes (2 Hz, cameras synchronised to the sweep) by default; --sweeps N uses every N-th LIDAR_TOP
sweep (20 Hz) with each camera's nearest image instead (more frames, less exact timing).
Data: nuScenes, CC BY-NC-SA 4.0 (https://www.nuscenes.org/terms-of-use).
"""
import argparse, json, os, shutil, zipfile
import numpy as np
from scipy.spatial.transform import Rotation as R

CAMS = {1: 'CAM_FRONT', 0: 'CAM_BACK', 2: 'CAM_FRONT_LEFT', 3: 'CAM_BACK_LEFT', 4: 'CAM_FRONT_RIGHT', 5: 'CAM_BACK_RIGHT'}


def T_of(rec):
    """4x4 from a nuScenes {translation, rotation (w x y z)} record (child -> parent)."""
    T = np.eye(4)
    w, x, y, z = rec['rotation']
    T[:3, :3] = R.from_quat([x, y, z, w]).as_matrix()
    T[:3, 3] = rec['translation']
    return T


def write_pcd(path, pts):
    """pts: (N, >=4) float32 x y z intensity -> binary PCD x y z rgb (PCL packed float)."""
    n = len(pts)
    g = np.clip(pts[:, 3], 0, 255).astype(np.uint32)
    rgb = ((g << 16) | (g << 8) | g).view(np.float32)
    arr = np.zeros(n, dtype=[('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('rgb', '<f4')])
    arr['x'], arr['y'], arr['z'], arr['rgb'] = pts[:, 0], pts[:, 1], pts[:, 2], rgb
    hdr = ('# .PCD v0.7 - Point Cloud Data file format\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F F\n'
           f'COUNT 1 1 1 1\nWIDTH {n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {n}\nDATA binary\n')
    with open(path, 'wb') as f:
        f.write(hdr.encode()); f.write(arr.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='folder with v1.0-mini/, samples/, sweeps/')
    ap.add_argument('--scene', default='scene-0061')
    ap.add_argument('--out', required=True)
    ap.add_argument('--sweeps', type=int, default=0, help='use every N-th lidar sweep instead of keyframes')
    a = ap.parse_args()
    root, ver = os.path.expanduser(a.root), 'v1.0-mini'
    tab = {t: json.load(open(os.path.join(root, ver, t + '.json')))
           for t in ('scene', 'sample', 'sample_data', 'calibrated_sensor', 'sensor', 'ego_pose',
                     'sample_annotation', 'instance', 'category', 'visibility')}
    by = {t: {r['token']: r for r in rows} for t, rows in tab.items()}
    scene = next(s for s in tab['scene'] if s['name'] == a.scene)
    samples = [s for s in tab['sample'] if s['scene_token'] == scene['token']]
    stoks = {s['token'] for s in samples}
    chan = lambda sd: by['sensor'][by['calibrated_sensor'][sd['calibrated_sensor_token']]['sensor_token']]['channel']
    sds = [sd for sd in tab['sample_data'] if sd['sample_token'] in stoks]
    stream = {}
    for sd in sds:
        stream.setdefault(chan(sd), []).append(sd)
    for v in stream.values():
        v.sort(key=lambda sd: sd['timestamp'])
    lidar = stream['LIDAR_TOP']
    if a.sweeps:
        lidar = lidar[::a.sweeps]
    else:
        lidar = [sd for sd in lidar if sd['is_key_frame']]

    out = os.path.expanduser(a.out)
    if os.path.exists(out):
        raise SystemExit(f'{out} exists; remove it first')
    os.makedirs(os.path.join(out, 'pointcloud')); os.makedirs(os.path.join(out, 'gt'))

    cs = lambda sd: by['calibrated_sensor'][sd['calibrated_sensor_token']]
    frames = []
    for sd in lidar:
        t = sd['timestamp']                                      # microseconds
        fid = f'{t // 10**6}-{(t % 10**6) * 1000:09d}'
        pts = np.fromfile(os.path.join(root, sd['filename']), dtype=np.float32).reshape(-1, 5)
        write_pcd(os.path.join(out, 'pointcloud', fid + '.pcd'), pts)
        d = os.path.join(out, 'related_images', fid + '_pcd'); os.makedirs(d)
        rec = {'fid': fid, 'lidar_t': t, 'lidar_ego': T_of(by['ego_pose'][sd['ego_pose_token']]).tolist(), 'cams': {}}
        for i, name in CAMS.items():
            if a.sweeps:
                c = min(stream[name], key=lambda x: abs(x['timestamp'] - t))
            else:
                c = next(x for x in stream[name] if x['sample_token'] == sd['sample_token'] and x['is_key_frame'])
            shutil.copy(os.path.join(root, c['filename']), os.path.join(d, f'image_{i}.jpg'))
            rec['cams'][name] = {'t': c['timestamp'], 'ego': T_of(by['ego_pose'][c['ego_pose_token']]).tolist()}
        frames.append(rec)

    first = {name: next(x for x in stream[name]) for name in list(CAMS.values()) + ['LIDAR_TOP']}
    calib = {'pcd_frame': 'lidar', 'lidar': {'sensor2ego': T_of(cs(first['LIDAR_TOP'])).tolist(), 'origin_pcd': [0, 0, 0]},
             'cameras': {},
             'camera_map': {f'image_{i}': n for i, n in sorted(CAMS.items())},
             'source': f'nuScenes {ver} {a.scene} calibrated_sensor (ground truth), CC BY-NC-SA 4.0'}
    for i, name in CAMS.items():
        c = cs(first[name])
        dts = [(f['cams'][name]['t'] - f['lidar_t']) * 1e-6 for f in frames]
        calib['cameras'][name] = {'model': 'pinhole', 'K': c['camera_intrinsic'], 'dist': [0.0] * 5,
                                  'ego2cam': np.linalg.inv(T_of(c)).tolist(), 'image_size': [1600, 900],
                                  'time_offset_s': float(np.median(dts))}
    json.dump(calib, open(os.path.join(out, 'gt', 'calib-gt.json'), 'w'), indent=2)
    ref = {k: v for k, v in calib.items() if k != 'cameras'}
    ref['cameras'] = {'CAM_FRONT': calib['cameras']['CAM_FRONT']}
    ref['camera_map'] = {'image_1': 'CAM_FRONT'}
    json.dump(ref, open(os.path.join(out, 'gt', 'calib-ref.json'), 'w'), indent=2)
    json.dump({'scene': a.scene, 'mode': f'sweeps/{a.sweeps}' if a.sweeps else 'keyframes', 'camera_map': calib['camera_map'],
               'frames': frames}, open(os.path.join(out, 'gt', 'frames.json'), 'w'))

    # ground-truth boxes (annotated on keyframes, global frame) -> pcd frame of their keyframe sweep
    anns = {}
    for an in tab['sample_annotation']:
        anns.setdefault(an['sample_token'], []).append(an)
    L2E = T_of(cs(first['LIDAR_TOP']))
    boxes = {}
    for sd in lidar:
        if not sd['is_key_frame']:
            continue
        t = sd['timestamp']; fid = f'{t // 10**6}-{(t % 10**6) * 1000:09d}'
        M = np.linalg.inv(T_of(by['ego_pose'][sd['ego_pose_token']]) @ L2E)          # global -> pcd
        out_b = []
        for an in anns.get(sd['sample_token'], []):
            B = T_of(an); B = M @ B
            w, l, h = an['size']
            out_b.append({'category': by['category'][by['instance'][an['instance_token']]['category_token']]['name'],
                          'instance': an['instance_token'], 'num_lidar_pts': an['num_lidar_pts'],
                          'visibility': by['visibility'][an['visibility_token']]['level'],
                          'x': B[0, 3], 'y': B[1, 3], 'z': B[2, 3], 'yaw': float(np.arctan2(B[1, 0], B[0, 0])),
                          'l': l, 'w': w, 'h': h})
        boxes[fid] = out_b
    json.dump(boxes, open(os.path.join(out, 'gt', 'boxes.json'), 'w'))

    with zipfile.ZipFile(os.path.join(out, 'upload.zip'), 'w', zipfile.ZIP_STORED) as z:
        for sub in ('pointcloud', 'related_images'):
            for dp, _, fs in os.walk(os.path.join(out, sub)):
                for f in sorted(fs):
                    p = os.path.join(dp, f); z.write(p, os.path.relpath(p, out))
    span = (frames[-1]['lidar_t'] - frames[0]['lidar_t']) * 1e-6
    print(f'{a.scene}: {len(frames)} frames over {span:.1f} s -> {out}')
    for name in CAMS.values():
        print(f'  {name:16s} camera - lidar time: median {1000 * calib["cameras"][name]["time_offset_s"]:+6.1f} ms')


if __name__ == '__main__':
    main()
