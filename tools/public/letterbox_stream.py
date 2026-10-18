"""Stream letterboxed camera images (YOLOX preprocessing: top-left, grey 114, BGR uint8) to stdout for eval_auto.js.

    .venv/bin/python tools/public/letterbox_stream.py <scene dir> <size>
For every frame (gt/frames.json order) and camera (image_N order): 8-byte header (uint32 width, height of the
original image) + size*size*3 bytes.
"""
import json, os, struct, sys
import numpy as np, cv2

d, size = sys.argv[1], int(sys.argv[2])
meta = json.load(open(os.path.join(d, 'gt', 'frames.json')))
imgs = sorted(meta['camera_map'], key=lambda k: int(k.split('_')[1]))
out = sys.stdout.buffer
for f in meta['frames']:
    for img in imgs:
        im = cv2.imread(os.path.join(d, 'related_images', f['fid'] + '_pcd', img + '.jpg'))
        h, w = im.shape[:2]
        r = min(size / w, size / h)
        pad = np.full((size, size, 3), 114, np.uint8)
        pad[:round(h * r), :round(w * r)] = cv2.resize(im, (round(w * r), round(h * r)), interpolation=cv2.INTER_LINEAR)
        out.write(struct.pack('<II', w, h)); out.write(pad.tobytes())
out.flush()
