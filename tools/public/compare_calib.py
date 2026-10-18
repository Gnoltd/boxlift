"""T2 — a calibration against the ground truth, camera by camera (matched by image_N).

    .venv/bin/python tools/public/compare_calib.py <calib.json> <gt/calib-gt.json>

rotation: angle of R_calib · R_gt^T (deg), also as camera pan / tilt / roll; centre: camera position in the ego
frame (cm); f: focal length ratio. Pass (README T2): rotation <= 0.3 deg, centre <= 10 cm.
"""
import json, sys
import numpy as np
from scipy.spatial.transform import Rotation as R


def centre(E):
    return -E[:3, :3].T @ E[:3, 3]


def main(calib_path, gt_path):
    C, G = json.load(open(calib_path)), json.load(open(gt_path))
    print(f'{calib_path} vs {gt_path}')
    print('camera                     model    rot deg (pan  tilt  roll)     centre cm (dx  dy  dz)       f %    status')
    for img, gname in sorted(G['camera_map'].items(), key=lambda kv: int(kv[0].split('_')[1])):
        name = (C.get('camera_map') or {}).get(img)
        if not name or name not in C['cameras']:
            print(f'{img} {gname:16s}  -- not in calib'); continue
        c, g = C['cameras'][name], G['cameras'][gname]
        Ec, Eg = np.array(c['ego2cam'], float), np.array(g['ego2cam'], float)
        D = Ec[:3, :3] @ Eg[:3, :3].T                       # residual rotation in the camera frame
        rv = np.degrees(R.from_matrix(D).as_rotvec())        # x = tilt, y = pan, z = roll (camera axes)
        dc = 100 * (centre(Ec) - centre(Eg))
        f = 100 * (np.array(c['K'])[0, 0] / np.array(g['K'])[0, 0] - 1)
        ang, dist = np.linalg.norm(rv), np.linalg.norm(dc)
        ok = 'ref' if img == 'image_1' and ang < 1e-6 else ('PASS' if ang <= 0.3 and dist <= 10 else 'fail')
        print(f'{img} {gname:16s} {name:9s} {c.get("model", "pinhole"):8s} {ang:6.2f} ({rv[1]:+5.2f} {rv[0]:+5.2f} {rv[2]:+5.2f})   '
              f'{dist:6.1f} ({dc[0]:+6.1f} {dc[1]:+6.1f} {dc[2]:+6.1f})   {f:+5.1f}   {ok}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
