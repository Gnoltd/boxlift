"""Person time per cuboid on a local CVAT: by hand (CVAT's own cuboid tool) vs with the extension, same frames.

    # one timed session (the script is the stopwatch): Enter to start, Enter when done
    .venv/bin/python tools/public/time_study.py run --mode tool   --job 161 --frames 21 \
        --scene ~/public-data/cvat-upload/nuscenes-0916-key
    .venv/bin/python tools/public/time_study.py run --mode manual --job 162 --frames 21 --scene ...
    # table over all sessions
    .venv/bin/python tools/public/time_study.py report

A session counts the cuboids that are new in the job when you press Enter the second time (made during the session,
by hand or saved by the extension) on the given frames, and compares each with the dataset's true boxes:
matched = the true box of the frame it overlaps most (else the nearest within 2 m, top view), its class, IoU 3D, centre error, yaw error over
360 deg (front / back too). Targets = true boxes of --labels with >= 10 LiDAR points on those frames (what the
tool study of eval_boxes.js uses); recall = matched targets / targets.
Time per cuboid = session time / cuboids made; also per matched target.
Credentials: CVAT_USER / CVAT_PASSWORD, else asked (password hidden). Local CVAT only. Sessions are written to
work/time-study/ (no images or point clouds, only numbers and boxes).
"""
import argparse, datetime, getpass, glob, json, math, os, sys, time, urllib.parse
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cvat_upload import Cvat, CATEGORY

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'work', 'time-study')
wrap = lambda a: (a + math.pi) % (2 * math.pi) - math.pi


def iou3d(a, b):
    """IoU of two yaw-only cuboids {x, y, z, yaw, l, w, h}."""
    ra = ((a['x'], a['y']), (a['l'], a['w']), math.degrees(a['yaw']))
    rb = ((b['x'], b['y']), (b['l'], b['w']), math.degrees(b['yaw']))
    kind, pts = cv2.rotatedRectangleIntersection(ra, rb)
    inter = cv2.contourArea(cv2.convexHull(pts)) if kind != cv2.INTERSECT_NONE and pts is not None else 0.0
    dz = max(0.0, min(a['z'] + a['h'] / 2, b['z'] + b['h'] / 2) - max(a['z'] - a['h'] / 2, b['z'] - b['h'] / 2))
    v = inter * dz
    return v / (a['l'] * a['w'] * a['h'] + b['l'] * b['w'] * b['h'] - v)


def frames_arg(s):
    out = []
    for part in s.split(','):
        lo, _, hi = part.partition('-')
        out += list(range(int(lo), int(hi or lo) + 1))
    return out


def login(host):
    if urllib.parse.urlparse(host).hostname not in ('localhost', '127.0.0.1'):
        raise SystemExit(f'{host}: not a local CVAT')
    user = os.environ.get('CVAT_USER') or input(f'CVAT user ({host}): ').strip()
    pw = os.environ.get('CVAT_PASSWORD') or getpass.getpass('CVAT password (not shown): ')
    return Cvat(host, user, pw)


def cuboids(api, job):
    return [s for s in api.call('GET', f'/jobs/{job}/annotations')['shapes'] if s['type'] == 'cuboid']


def run(a):
    api = login(a.host)
    job = api.call('GET', f'/jobs/{a.job}')
    frames = frames_arg(a.frames)
    meta = api.call('GET', f'/jobs/{a.job}/data/meta')
    names = [os.path.splitext(os.path.basename(f['name']))[0] for f in meta['frames']]
    start = job.get('start_frame', 0)
    fid_of = {start + i: n for i, n in enumerate(names)}
    labels = {l['id']: l['name'] for l in api.call('GET', f'/labels?job_id={a.job}&page_size=100')['results']}
    before = {s['id'] for s in cuboids(api, a.job)}
    want = set(a.labels.split(','))
    d = os.path.expanduser(a.scene)
    gt = json.load(open(os.path.join(d, 'gt', 'boxes.json')))
    cls = lambda c: next((n for k, n in CATEGORY if c.startswith(k)), None)
    targets = {f: [b for b in gt.get(fid_of[f], []) if cls(b['category']) in want and b['num_lidar_pts'] >= 10] for f in frames}
    print(f'job {a.job} (task {job["task_id"]}), mode {a.mode}: frames {frames}, {sum(map(len, targets.values()))} target '
          f'{"/".join(sorted(want))} with >= 10 LiDAR points; {len(before)} cuboids already in the job (not counted).')
    print(f'Label every {"/".join(sorted(want))} you can see on these frames, as well as you would for delivery.')
    input('Enter = START the clock … ')
    t0 = time.time()
    input('working … Enter = DONE (after the last cuboid is saved in CVAT) ')
    secs = time.time() - t0
    new = [s for s in cuboids(api, a.job) if s['id'] not in before and s['frame'] in targets]
    rows, used = [], set()
    for s in new:
        p = s['points']
        box = {'x': p[0], 'y': p[1], 'z': p[2], 'yaw': p[5], 'l': p[6], 'w': p[7], 'h': p[8]}
        # the true box it overlaps most; none overlapping: the nearest within 2 m (a long truck's centre can be
        # farther than a pedestrian standing next to it)
        cand = [(iou3d(box, b), -math.hypot(b['x'] - box['x'], b['y'] - box['y']), k) for k, b in enumerate(gt.get(fid_of[s['frame']], []))]
        iou, nd, k = max(cand) if cand else (0, -1e9, -1)
        r = {'frame': s['frame'], 'label': labels.get(s['label_id']), 'source': s.get('source'), 'box': box}
        if iou > 0 or -nd <= 2.0:
            b = gt[fid_of[s['frame']]][k]
            r.update({'gt_class': cls(b['category']), 'gt_key': f"{s['frame']}:{k}", 'gt_pts': b['num_lidar_pts'],
                      'iou3d': iou, 'centre': -nd, 'yaw360': abs(wrap(box['yaw'] - b['yaw'])) * 180 / math.pi})
        rows.append(r)
    hit = {r['gt_key'] for r in rows if 'gt_key' in r}
    tkeys = {f"{f}:{gt[fid_of[f]].index(b)}" for f, bs in targets.items() for b in bs}
    res = {'when': datetime.datetime.now().isoformat(timespec='seconds'), 'mode': a.mode, 'job': a.job, 'task': job['task_id'],
           'scene': os.path.basename(d), 'frames': frames, 'labels': sorted(want), 'seconds': secs, 'made': len(new),
           'targets': len(tkeys), 'recall': len(hit & tkeys) / max(1, len(tkeys)), 'note': a.note, 'cuboids': rows}
    os.makedirs(OUT, exist_ok=True)
    f = os.path.join(OUT, f"{res['when'].replace(':', '')}-{a.mode}-job{a.job}.json")
    json.dump(res, open(f, 'w'), indent=1)
    print(f'{secs / 60:.1f} min, {len(new)} new cuboids → {secs / max(1, len(new)):.0f} s per cuboid; recall {100 * res["recall"]:.0f}% → {f}')
    report(argparse.Namespace(files=[f]))


def report(a):
    files = a.files or sorted(glob.glob(os.path.join(OUT, '*.json')))
    if not files:
        raise SystemExit('no sessions yet (time_study.py run …)')
    med = lambda v: float(np.median(v)) if v else float('nan')
    print(f"{'session':34s} {'mode':7s} {'min':>5s} {'made':>5s} {'s/cuboid':>8s} {'recall':>6s} {'s/target':>8s} | "
          f"{'IoU3D p50':>9s} {'>=0.5':>6s} {'>=0.7':>6s} {'centre':>7s} {'yaw360 p50':>10s} {'<=10°':>6s} {'class ok':>8s}")
    for f in files:
        s = json.load(open(f))
        m = [r for r in s['cuboids'] if 'iou3d' in r]
        n = len(m)
        hits = s['recall'] * s['targets']
        print(f"{os.path.basename(f)[:34]:34s} {s['mode']:7s} {s['seconds'] / 60:5.1f} {s['made']:5d} {s['seconds'] / max(1, s['made']):8.0f} "
              f"{100 * s['recall']:5.0f}% {s['seconds'] / max(1, hits):8.0f} | {med([r['iou3d'] for r in m]):9.2f} "
              f"{100 * sum(r['iou3d'] >= 0.5 for r in m) / max(1, n):5.0f}% {100 * sum(r['iou3d'] >= 0.7 for r in m) / max(1, n):5.0f}% "
              f"{med([r['centre'] for r in m]):6.2f}m {med([r['yaw360'] for r in m]):9.1f}° {100 * sum(r['yaw360'] <= 10 for r in m) / max(1, n):5.0f}% "
              f"{100 * sum(r['label'] == r['gt_class'] for r in m) / max(1, n):7.0f}%")
    print('s/cuboid = session time / cuboids made; s/target = session time / true objects found; quality over the cuboids matched '
          'to a true box (overlapping, else <= 2 m).')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run')
    r.add_argument('--mode', required=True, choices=['manual', 'tool'])
    r.add_argument('--job', type=int, required=True)
    r.add_argument('--frames', required=True, help='e.g. 21 or 20-22')
    r.add_argument('--scene', required=True, help='converted scene dir (gt/boxes.json)')
    r.add_argument('--labels', default='car')
    r.add_argument('--host', default='http://localhost:8080')
    r.add_argument('--note', default='')
    p = sub.add_parser('report')
    p.add_argument('files', nargs='*')
    a = ap.parse_args()
    run(a) if a.cmd == 'run' else report(a)


if __name__ == '__main__':
    main()
