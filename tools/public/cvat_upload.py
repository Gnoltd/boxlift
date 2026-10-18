"""Create a CVAT 3D task from a converted public scene (nuscenes_to_cvat.py / kitti_to_cvat.py) on a local CVAT.

    CVAT_USER=... CVAT_PASSWORD=... .venv/bin/python tools/public/cvat_upload.py \
        ~/public-data/cvat-upload/nuscenes-0061-key [--host http://localhost:8080] [--gt]

The task is named after the scene ("nuscenes scene-0061 ..."), so the extension picks the scene's bundled
calibration by itself. Labels: car, truck, bus, motorcycle, bicycle, pedestrian, barrier, traffic_cone (cuboids).
--gt also imports the dataset's ground-truth boxes as annotations (a reference task to compare the tool with;
name gets " [đáp án]"). Credentials: CVAT_USER / CVAT_PASSWORD, else asked in the terminal (password hidden).
Only for a CVAT you run locally: refuses hosts other than localhost / 127.0.0.1 unless --any-host.
"""
import argparse, base64, getpass, json, os, sys, time, urllib.error, urllib.parse, urllib.request, uuid

LABELS = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian', 'barrier', 'traffic_cone']
CATEGORY = [('vehicle.car', 'car'), ('vehicle.truck', 'truck'), ('vehicle.construction', 'truck'), ('vehicle.trailer', 'truck'),
            ('vehicle.bus', 'bus'), ('vehicle.motorcycle', 'motorcycle'), ('vehicle.bicycle', 'bicycle'),
            ('human.pedestrian', 'pedestrian'), ('movable_object.barrier', 'barrier'), ('movable_object.trafficcone', 'traffic_cone')]


class Cvat:
    def __init__(self, host, user, password):
        self.host = host.rstrip('/')
        self.auth = 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()

    def call(self, method, path, body=None, ctype='application/json'):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        req = urllib.request.Request(self.host + '/api' + path, data=data, method=method,
                                     headers={'Authorization': self.auth, 'Content-Type': ctype, 'Accept': 'application/vnd.cvat+json'})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raise SystemExit(f'{method} {path}: HTTP {e.code} {e.read()[:300].decode(errors="replace")}')


def multipart(fields, files):
    b = uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, path in files.items():
        out += (f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{os.path.basename(path)}"\r\n'
                f'Content-Type: application/zip\r\n\r\n').encode()
        out += open(path, 'rb').read() + b'\r\n'
    out += f'--{b}--\r\n'.encode()
    return bytes(out), f'multipart/form-data; boundary={b}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('scene_dir')
    ap.add_argument('--host', default='http://localhost:8080')
    ap.add_argument('--name', default=None)
    ap.add_argument('--gt', action='store_true', help='import the ground-truth boxes as annotations')
    ap.add_argument('--any-host', action='store_true')
    a = ap.parse_args()
    if urllib.parse.urlparse(a.host).hostname not in ('localhost', '127.0.0.1') and not a.any_host:
        raise SystemExit(f'{a.host}: not a local CVAT (use --any-host if you really mean it)')
    user = os.environ.get('CVAT_USER') or input(f'CVAT user ({a.host}): ').strip()
    pw = os.environ.get('CVAT_PASSWORD') or getpass.getpass('CVAT password (not shown): ')
    if not user or not pw:
        raise SystemExit('no CVAT user / password')
    d = os.path.expanduser(a.scene_dir)
    calib = json.load(open(os.path.join(d, 'gt', 'calib-gt.json')))
    src = calib.get('source', '')
    base = ('nuscenes ' + src.split()[2]) if src.startswith('nuScenes') else ('kitti ' + src.split()[2]) if src.startswith('KITTI') else os.path.basename(d)
    name = a.name or (base + (' [đáp án]' if a.gt else ''))
    api = Cvat(a.host, user, pw)

    task = api.call('POST', '/tasks', {'name': name, 'labels': [{'name': n, 'type': 'cuboid', 'attributes': []} for n in LABELS]})
    tid = task['id']
    print(f'task {tid} "{name}" created; uploading {os.path.join(d, "upload.zip")} …', flush=True)
    body, ctype = multipart({'image_quality': 95, 'sorting_method': 'lexicographical'}, {'client_files[0]': os.path.join(d, 'upload.zip')})
    res = api.call('POST', f'/tasks/{tid}/data', body, ctype)
    rq = res.get('rq_id')
    for _ in range(600):                                         # wait for CVAT to unpack and index the data
        time.sleep(2)
        if rq:
            r = api.call('GET', f'/requests/{urllib.parse.quote(rq, safe="")}')
            stt = r.get('status')
            if stt == 'failed':
                raise SystemExit(f'CVAT could not create the task data: {r.get("message")}')
            if stt == 'finished':
                break
        elif api.call('GET', f'/tasks/{tid}').get('size'):
            break
    t = api.call('GET', f'/tasks/{tid}')
    jobs = api.call('GET', f'/jobs?task_id={tid}&page_size=100').get('results', [])
    print(f'task {tid}: {t.get("size")} frames, {len(jobs)} job(s) — ' + ', '.join(f'{a.host}/tasks/{tid}/jobs/{j["id"]}' for j in jobs), flush=True)

    if a.gt:
        boxes = json.load(open(os.path.join(d, 'gt', 'boxes.json')))
        frames = sorted(boxes)                                   # CVAT orders the frames by file name, as here
        meta = api.call('GET', f'/tasks/{tid}/data/meta')
        names = [os.path.splitext(os.path.basename(f['name']))[0] for f in meta.get('frames', [])]
        index = {n: i for i, n in enumerate(names)} if names else {f: i for i, f in enumerate(frames)}
        lid = {l['name']: l['id'] for l in api.call('GET', f'/labels?task_id={tid}&page_size=100')['results']}
        shapes = []
        for fid, bs in boxes.items():
            if fid not in index:
                continue
            for b in bs:
                lab = next((n for c, n in CATEGORY if b['category'].startswith(c)), None)
                if not lab:
                    continue
                shapes.append({'type': 'cuboid', 'frame': index[fid], 'label_id': lid[lab], 'group': 0, 'source': 'manual',
                               'occluded': False, 'attributes': [],
                               'points': [b['x'], b['y'], b['z'], 0, 0, b['yaw'], b['l'], b['w'], b['h']] + [0] * 7})
        api.call('PUT', f'/tasks/{tid}/annotations', {'version': 0, 'tags': [], 'shapes': shapes, 'tracks': []})
        print(f'imported {len(shapes)} ground-truth cuboids', flush=True)


if __name__ == '__main__':
    main()
