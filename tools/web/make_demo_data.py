#!/usr/bin/env python3
"""Build web/demo-data (Argoverse 2 sample for the web demo) from a prepared AV2 scene folder.

  python3 tools/web/make_demo_data.py <scene-dir> --out web/demo-data --frames 10

scene-dir layout: pointcloud/<fid>.pcd, related_images/<fid>_pcd/image_0..6.jpg, gt/{frames,boxes,calib-gt}.json.

Frame choice (stride 1, start index 17 of 100 for av2-20dd185d -> frames 17..26): the window maximising the number of
vehicle instances (REGULAR_VEHICLE/LARGE_VEHICLE with >=50 lidar points) present in ALL frames (10 of them stay in
view throughout), ties broken by the mean count of objects with >=20 lidar points per frame (19 objects/frame).
Strides 1..3 are scanned; stride 1 wins, which keeps consecutive sweeps 0.1 s apart so tracking looks smooth.
The ground truth is read ONLY to pick the window; nothing from gt/ is written under --out except the camera
calibration (calib-gt.json), which is the extension's calib schema and holds no boxes.

Outputs: pcd/<fid>.pcd, ctx/frame-<fid>.ctx (ZIP STORED of image_0..6.jpg, original JPEGs; re-encoded at quality 80
only if the total would exceed --budget-mb), demo-manifest.json, calibs/<scene>.json.
"""
import argparse, json, os, shutil, struct, zlib, io

VEH = {'REGULAR_VEHICLE', 'LARGE_VEHICLE'}
LABELS = [{'id': 3 + i, 'name': n, 'type': 'cuboid'} for i, n in enumerate('car,truck,bus,motorcycle,bicycle,pedestrian'.split(','))]


def pick_window(fids, boxes, n):
    best = None
    for st in (1, 2, 3):
        for s in range(0, len(fids) - (n - 1) * st):
            idx = [s + i * st for i in range(n)]
            seen = {}
            for i in idx:
                for o in boxes[fids[i]]:
                    if o['category'] in VEH and o['num_lidar_pts'] >= 50:
                        seen[o['instance']] = seen.get(o['instance'], 0) + 1
            full = sum(1 for v in seen.values() if v == n)
            mean = sum(sum(1 for o in boxes[fids[i]] if o['num_lidar_pts'] >= 20) for i in idx) / n
            key = (full, mean, -st, -s)
            if best is None or key > best[0]:
                best = (key, idx)
    return best[1]


def stored_zip(entries):
    """entries: [(name, bytes)] -> ZIP bytes, method 0 (STORED)."""
    out, cd, off = io.BytesIO(), io.BytesIO(), 0
    for name, data in entries:
        nb, crc = name.encode(), zlib.crc32(data) & 0xffffffff
        lh = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 0, 0, 0x21, crc, len(data), len(data), len(nb), 0) + nb
        out.write(lh); out.write(data)
        cd.write(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 0, 0, 0x21, crc, len(data), len(data), len(nb), 0, 0, 0, 0, 0, off) + nb)
        off += len(lh) + len(data)
    cdb = cd.getvalue()
    out.write(cdb)
    out.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(entries), len(entries), len(cdb), off, 0))
    return out.getvalue()


def reencode(path, q=80):
    from PIL import Image
    b = io.BytesIO(); Image.open(path).convert('RGB').save(b, 'JPEG', quality=q); return b.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene'); ap.add_argument('--out', default='web/demo-data'); ap.add_argument('--frames', type=int, default=10)
    ap.add_argument('--budget-mb', type=float, default=36)
    a = ap.parse_args()
    gt = os.path.join(a.scene, 'gt')
    fr = json.load(open(os.path.join(gt, 'frames.json')))
    boxes = json.load(open(os.path.join(gt, 'boxes.json')))
    fids = [f['fid'] for f in fr['frames']]
    idx = pick_window(fids, boxes, a.frames)
    chosen = [fids[i] for i in idx]
    print('frames', idx[0], '..', idx[-1], 'stride', idx[1] - idx[0], chosen[0], '->', chosen[-1])

    def build(recode):
        shutil.rmtree(a.out, ignore_errors=True)
        for d in ('pcd', 'ctx', 'calibs'): os.makedirs(os.path.join(a.out, d))
        for fid in chosen:
            shutil.copyfile(os.path.join(a.scene, 'pointcloud', fid + '.pcd'), os.path.join(a.out, 'pcd', fid + '.pcd'))
            ents = []
            for k in range(7):
                p = os.path.join(a.scene, 'related_images', fid + '_pcd', f'image_{k}.jpg')
                ents.append((f'image_{k}.jpg', reencode(p) if recode else open(p, 'rb').read()))
            open(os.path.join(a.out, 'ctx', f'frame-{fid}.ctx'), 'wb').write(stored_zip(ents))
        return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(a.out) for f in fs)

    total = build(False)
    if total > a.budget_mb * 1e6:
        total = build(True); print('re-encoded JPEG q80')
    scene = os.path.basename(os.path.normpath(a.scene))
    shutil.copyfile(os.path.join(gt, 'calib-gt.json'), os.path.join(a.out, 'calibs', scene + '.json'))
    man = {'task': {'id': 1, 'name': 'argoverse2 ' + scene}, 'labels': LABELS,
           'frames': [{'fid': f, 'pcd': f'demo-data/pcd/{f}.pcd', 'ctx': f'demo-data/ctx/frame-{f}.ctx'} for f in chosen]}
    json.dump(man, open(os.path.join(a.out, 'demo-manifest.json'), 'w'), indent=1)
    print('size %.1f MB' % (total / 1e6))


if __name__ == '__main__':
    main()
