"""Front / back of the box tool's boxes before and after the heading model, against nuScenes (full 360 deg).

    .venv/bin/python tools/heading/eval_end.py --model work/heading/heading_split.pt \
        --rows work/public/t5-0103-v13f.json work/public/t5-0916-v13f.json --root ~/public-data/cvat-upload

Rows: eval_boxes.js --json output (the tool's box `out` for a drawn 2D box, its camera, frame, the true box `gt`).
As in the extension (cvat.js headingFix): the tool box cropped through a virtual camera looking at it (rectify.py), the model's 8-bin alpha, and of the two ends of the box's axis the more likely one is kept.
A heading is right when it is within 90 deg of the truth. Only boxes whose axis is right (within 20 deg, mod 180)
count for the front/back question; the rest are a different error (axis).
--axis: also every box (any axis error), with the perpendicular axis taken when the model finds it R times more likely
than the box's own axis (R swept): % of boxes within 20 deg of the true heading (full 360), before / after.
"""
import argparse, json, math, os, sys
import numpy as np, cv2, torch, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import model, SIZE, MEAN, STD, density
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from camera import project
import rectify

wrap = lambda a: (a + math.pi) % (2 * math.pi) - math.pi


def decide(rows, scene_dir, net):
    """Run the heading step on the tool's boxes (rows of one scene, eval_boxes.js --json):
    [(row, flip)] for the rows that get a crop, flip = the model turns the box by 180 deg."""
    cal = json.load(open(os.path.join(scene_dir, 'gt', 'calib-gt.json')))
    S = np.array(cal['lidar']['sensor2ego'])
    imgs, batch, meta = {}, [], []
    for r in rows:
        cam = cal['cameras'][r['cam']]; img = next(k for k, v in cal['camera_map'].items() if v == r['cam'])
        M = np.array(cam['ego2cam']) @ S
        cam = {**cam, 'model': cam.get('model', 'pinhole'), 'dist': cam.get('dist', [])}
        b = r['out']
        key = (r['fid'], img)
        if key not in imgs:
            imgs[key] = cv2.imread(os.path.join(scene_dir, 'related_images', r['fid'] + '_pcd', img + '.jpg'))[:, :, ::-1].copy()
        W, H = cam['image_size']
        u, v, ok = project(rectify.corners(b) @ M[:3, :3].T + M[:3, 3], np.array(cam['K'], np.float64), cam['dist'], W, H, cam['model'], near=0.0)
        x, a0 = rectify.crop(imgs[key], cam, b, M, SIZE, span=max(np.ptp(u), np.ptp(v)))
        if x is None:
            continue
        batch.append(((x.astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1))
        meta.append((r, a0))
    if not batch:
        return []
    with torch.no_grad():
        prob = torch.cat([F.softmax(net(torch.tensor(np.stack(batch[i:i + 256]), dtype=torch.float32)), 1) for i in range(0, len(batch), 256)])
    return [(r, bool(density(p[None], torch.tensor([wrap(a0 + math.pi)])) > density(p[None], torch.tensor([a0]))), a0, p)
            for (r, a0), p in zip(meta, prob)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--rows', nargs='+', required=True)
    ap.add_argument('--root', required=True)
    ap.add_argument('--axis', action='store_true')
    a = ap.parse_args()
    net = model(); net.load_state_dict(torch.load(a.model, map_location='cpu')); net.eval()
    root = os.path.expanduser(a.root)
    stats = {}
    for f in a.rows:
        scene = 'scene-' + os.path.basename(f).split('-')[1]
        d = os.path.join(root, f'nuscenes-{scene[6:]}-key')
        rows = [r for r in json.load(open(f)) if r.get('ok') and r['label'] in ('car', 'truck', 'bus', 'motorcycle', 'bicycle') and (a.axis or r['dyaw'] <= 20)]
        for r, flip, a0, p in decide(rows, d, net):
            if a.axis:
                dk = [float(density(p[None], torch.tensor([wrap(a0 + k * math.pi / 2)]))) for k in range(4)]
                for R in (0, 1.5, 2, 3, 5, 1e9):
                    k = max(range(4), key=lambda k: dk[k]) if max(dk[1], dk[3]) > R * max(dk[0], dk[2]) else (0 if dk[0] >= dk[2] else 2)
                    for lab in (r['label'], 'all vehicles'):
                        s = stats.setdefault((lab, R), [0, 0, 0]); s[0] += 1
                        s[1] += abs(wrap(r['out']['yaw'] - r['gt']['yaw'])) < math.radians(20)
                        s[2] += abs(wrap(r['out']['yaw'] + k * math.pi / 2 - r['gt']['yaw'])) < math.radians(20)
                continue
            yaw_after = wrap(r['out']['yaw'] + (math.pi if flip else 0))
            ok_before = abs(wrap(r['out']['yaw'] - r['gt']['yaw'])) < math.pi / 2
            ok_after = abs(wrap(yaw_after - r['gt']['yaw'])) < math.pi / 2
            for k in (r['label'], 'all vehicles'):
                s = stats.setdefault(k, [0, 0, 0]); s[0] += 1; s[1] += ok_before; s[2] += ok_after
    if a.axis:
        print('held-out scenes, every box: heading within 20 deg (360)   before -> after, perpendicular axis taken when R x more likely')
        for (k, R), (n, b, af) in sorted(stats.items(), key=lambda kv: (-stats[(kv[0][0], 0)][0], kv[0][1])):
            print(f'  {k:13s} R {R:>4g}  n {n:5d}   {100 * b / n:5.1f}%  ->  {100 * af / n:5.1f}%')
        return
    print('held-out scenes, boxes with the right axis: front/back right   before  ->  after')
    for k, (n, b, af) in sorted(stats.items(), key=lambda kv: -kv[1][0]):
        print(f'  {k:13s} n {n:5d}   {100 * b / n:5.1f}%  ->  {100 * af / n:5.1f}%')


if __name__ == '__main__':
    main()
