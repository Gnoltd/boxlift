"""Evaluation metrics of topic N1-01B (cuboid from a 2D box through the LiDAR frustum): IoU 3D, yaw error, time.

    node tools/public/eval_boxes.js <scene dir> --json work/public/m-<scene>.json      # per scene, the box tool
    .venv/bin/python tools/public/metrics.py --scenes 0103,0916 --rows 'work/public/m-{scene}.json' \
        --model work/heading-rect/heading_split.pt [--root ~/public-data/cvat-upload] [--json out.json]

Input rows: eval_boxes.js (a drawn 2D box = projection of the true box +-3 px, the tool's 3D box, the true box).
The heading step of the extension (image model, tools/heading) is run on the tool's boxes; use scenes the model given
by --model was not trained on (heading_split.pt: trained without 0103 and 0916).
Per class: n, made (a box came out), IoU 3D (median, >= 0.5, >= 0.7; the 180 deg turn does not change it), yaw error
mod 180 (the axis) and over 360 deg (front / back too) before and after the heading step (median, <= 10 deg), box
centre error (top view), machine time per cuboid (fit; the heading model adds ~10-70 ms per object in the browser).
Person time per cuboid comes from the timed CVAT sessions: tools/public/time_study.py.
"""
import argparse, json, math, os, sys
import numpy as np, torch
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'heading'))
from eval_end import decide
from train import model, density

CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']
LEARNED = {'car', 'truck', 'bus', 'bicycle', 'pedestrian'}   # extension/frustum.js USE
PRIOR_W = 2                                       # extension/heading.js PRIOR_W
wrap = lambda a: (a + math.pi) % (2 * math.pi) - math.pi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scenes', required=True)
    ap.add_argument('--rows', required=True, help="path pattern with {scene}")
    ap.add_argument('--model', required=True)
    ap.add_argument('--root', default='~/public-data/cvat-upload')
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    net = model(); net.load_state_dict(torch.load(a.model, map_location='cpu')); net.eval()
    rows = []
    for sc in a.scenes.split(','):
        rs = json.load(open(a.rows.format(scene=sc)))
        for r in rs:            # learned boxes (eval_boxes.js --learned) only for the classes the extension uses them for
            if 'geo' in r and r['label'] not in LEARNED:
                r.update(out=r['geo']['out'], iou3d=r['geo']['iou3d'], dc=r['geo']['dc'], dyaw=r['geo']['dyaw'], ok=r['geo']['ok'])
                r.pop('endOdds', None)
            elif 'msLearned' in r:
                r['ms'] += r['msLearned']
        flips = {}
        for r, f, a0, p in decide([r for r in rs if r.get('ok')], os.path.join(os.path.expanduser(a.root), f'nuscenes-{sc}-key'), net):
            if 'endOdds' in r:  # fused with the box model's own front / back odds, as extension/heading.js chooseEnd
                d0 = float(density(p[None], torch.tensor([a0]))); d1 = float(density(p[None], torch.tensor([wrap(a0 + math.pi)])))
                f = d1 * r['endOdds'] ** PRIOR_W > d0
            flips[id(r)] = f
        for r in rs:
            if r.get('ok'):
                r['yaw_after'] = wrap(r['out']['yaw'] + (math.pi if flips.get(id(r)) else 0))
                r['dyaw360_after'] = abs(wrap(r['yaw_after'] - r['gt']['yaw'])) * 180 / math.pi
                r['dyaw360'] = abs(wrap(r['out']['yaw'] - r['gt']['yaw'])) * 180 / math.pi
        rows += rs
    med = lambda v: float(np.median(v)) if len(v) else float('nan')
    pc = lambda k, n: 100.0 * k / n if n else float('nan')
    out = {}
    print(f"scenes {a.scenes}, {len(rows)} objects (>= 10 LiDAR points), drawn box = true projection +-3 px, heading model {os.path.basename(a.model)}")
    print(f"{'':11s} {'n':>5s} {'made':>6s} | {'IoU3D p50':>9s} {'>=0.5':>6s} {'>=0.7':>6s} | {'centre p50':>10s} | {'yaw180 p50':>10s} | "
          f"{'yaw360 p50':>10s} {'<=10°':>6s} -> {'p50':>6s} {'<=10°':>6s} | {'ms p50':>6s}")
    for c in CLASSES + ['vehicles']:
        rs = [r for r in rows if (r['label'] in CLASSES[:5] if c == 'vehicles' else r['label'] == c)]
        if not rs:
            continue
        ok = [r for r in rs if r.get('ok')]
        m = {'n': len(rs), 'made': pc(len(ok), len(rs)),
             'iou3d_p50': med([r['iou3d'] for r in ok]), 'iou3d_05': pc(sum(r['iou3d'] >= 0.5 for r in ok), len(rs)),
             'iou3d_07': pc(sum(r['iou3d'] >= 0.7 for r in ok), len(rs)), 'centre_p50': med([r['dc'] for r in ok]),
             'yaw180_p50': med([r['dyaw'] for r in ok]),
             'yaw360_p50_before': med([r['dyaw360'] for r in ok]), 'yaw360_10_before': pc(sum(r['dyaw360'] <= 10 for r in ok), len(ok)),
             'yaw360_p50_after': med([r['dyaw360_after'] for r in ok]), 'yaw360_10_after': pc(sum(r['dyaw360_after'] <= 10 for r in ok), len(ok)),
             'ms_p50': med([r['ms'] for r in rs if 'ms' in r])}
        out[c] = m
        print(f"{c:11s} {m['n']:5d} {m['made']:5.1f}% | {m['iou3d_p50']:9.2f} {m['iou3d_05']:5.1f}% {m['iou3d_07']:5.1f}% | {m['centre_p50']:8.2f} m | "
              f"{m['yaw180_p50']:9.1f}° | {m['yaw360_p50_before']:9.1f}° {m['yaw360_10_before']:5.1f}% -> {m['yaw360_p50_after']:5.1f}° "
              f"{m['yaw360_10_after']:5.1f}% | {m['ms_p50']:6.0f}")
    print('IoU >= 0.5 / 0.7 out of every object (a box not made counts as a miss); yaw <= 10° out of the boxes made.')
    print('pedestrian: heading of a person is barely defined by its box; shown for completeness.')
    if a.json:
        json.dump({'scenes': a.scenes, 'model': a.model, 'metrics': out}, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
