"""Local stand-in for the CVAT endpoints the extension uses, serving a converted public scene (127.0.0.1 only).

    python3 tools/dev/mock_cvat.py <scene dir (nuscenes_to_cvat.py output)> [--port 8790] [--frames 5]
    open http://127.0.0.1:8790/tasks/1/jobs/1

The page loads the extension's content scripts directly (no Chrome extension install), with chrome.runtime /
chrome.storage stand-ins (storage in localStorage, calibrations from extension/calibs/). No bridge.js: frames go
through the REST fallback. Annotations live in memory. For trying the extension without a CVAT server.
"""
import argparse, io, itertools, json, os, re, zipfile
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

EXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'extension')
ap = argparse.ArgumentParser(); ap.add_argument('scene'); ap.add_argument('--port', type=int, default=8790); ap.add_argument('--frames', type=int, default=5)
ap.add_argument('--labels', default='car,truck,bus,motorcycle,bicycle,pedestrian', help='label names of the task')
a = ap.parse_args()
SC = os.path.expanduser(a.scene)
META = json.load(open(os.path.join(SC, 'gt', 'frames.json')))
CAL = json.load(open(os.path.join(SC, 'gt', 'calib-gt.json')))
FIDS = [f['fid'] for f in META['frames']][:a.frames]
NAME = 'nuscenes ' + META.get('scene', os.path.basename(SC))
LABELS = [{'id': 3 + i, 'name': n, 'type': 'cuboid'} for i, n in enumerate(a.labels.split(','))]
ANN = {'version': 0, 'tags': [], 'shapes': [], 'tracks': []}; IDS = itertools.count(1)
MANIFEST = json.load(open(os.path.join(EXT, 'manifest.json')))
SCRIPTS = [s for cs in MANIFEST['content_scripts'] if cs.get('world') != 'MAIN' for s in cs['js']]
STUB = """<script>
// chrome.* stand-ins for content scripts / extension pages served from /extension/
window.chrome = { runtime: {
  getURL: (p) => location.origin + '/extension/' + p,
  async sendMessage(m) {
    const f = m.type === 'listCalibs' ? 'calibs/index.json' : m.type === 'getCalib' ? 'calibs/' + m.id + '.json' : null;
    if (!f) return undefined;
    const r = await fetch('/extension/' + f); return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: f + ' ' + r.status };
  } },
  storage: { local: {
    async get(k) { if (k === null) { const o = {}; for (const key of Object.keys(localStorage)) if (key.startsWith('ext:')) o[key.slice(4)] = JSON.parse(localStorage[key]); return o; }
      const v = localStorage.getItem('ext:' + k); return { [k]: v ? JSON.parse(v) : undefined }; },
    async set(o) { for (const k in o) localStorage.setItem('ext:' + k, JSON.stringify(o[k])); },
    async remove(ks) { for (const k of [].concat(ks)) localStorage.removeItem('ext:' + k); } } } };
</script>"""
PAGE = ("""<!doctype html><html><head><meta charset=utf-8><title>CVAT (mock) · %s</title>
<style>body{margin:0;font:13px system-ui;background:#1b1b1b;color:#ddd}.top{padding:8px;background:#2b2b2b}</style></head>
<body><div class=top>Mock CVAT · task "%s" · job 1 · frame <span class="cvat-player-frame-selector"><input type=number value=0 min=0 max=%d></span>
<button class="cvat-player-next-button" onclick="const i=document.querySelector('.cvat-player-frame-selector input');i.value=Math.min(+i.max,+i.value+1);history.replaceState(null,'','?frame='+i.value)">next</button></div>
<div style="height:90vh;display:grid;place-content:center;color:#666">(3D canvas)</div>
<script>document.cookie='csrftoken=mocktoken123; path=/';</script>%s%s</body></html>""")
class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def send(self, body, ctype='application/json', code=200):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/tasks/1/jobs/1':
            tags = ''.join(f'<script src="/extension/{s}"></script>' for s in SCRIPTS)
            return self.send((PAGE % (NAME, NAME, len(FIDS) - 1, STUB, tags)).encode(), 'text/html')
        if u.path == '/api/jobs/1': return self.send({'id': 1, 'task_id': 1, 'dimension': '3d', 'start_frame': 0, 'stop_frame': len(FIDS) - 1, 'data_chunk_size': 36})
        if u.path == '/api/tasks/1': return self.send({'id': 1, 'name': NAME, 'dimension': '3d', 'size': len(FIDS)})
        if u.path == '/api/jobs': return self.send({'count': 1, 'results': [{'id': 1, 'task_id': 1, 'start_frame': 0, 'stop_frame': len(FIDS) - 1}]})
        if u.path == '/api/jobs/1/data/meta': return self.send({'chunk_size': 36, 'frames': [{'name': f + '.pcd', 'related_files': len(META['camera_map'])} for f in FIDS]})
        if u.path == '/api/labels': return self.send({'count': len(LABELS), 'results': LABELS})
        if u.path == '/api/jobs/1/annotations': return self.send(ANN)
        if u.path == '/api/jobs/1/data':
            t = q['type'][0]
            if t == 'chunk':
                b = io.BytesIO()
                with zipfile.ZipFile(b, 'w', zipfile.ZIP_STORED) as z:
                    for i, f in enumerate(FIDS): z.write(os.path.join(SC, 'pointcloud', f + '.pcd'), f'{i:06d}.pcd')
                return self.send(b.getvalue(), 'application/zip')
            n = int(q['number'][0])
            if t == 'frame': return self.send(open(os.path.join(SC, 'pointcloud', FIDS[n] + '.pcd'), 'rb').read(), 'application/octet-stream')
            if t == 'context_image':
                b = io.BytesIO(); d = os.path.join(SC, 'related_images', FIDS[n] + '_pcd')
                with zipfile.ZipFile(b, 'w', zipfile.ZIP_STORED) as z:
                    for f in sorted(os.listdir(d)): z.write(os.path.join(d, f), f)
                return self.send(b.getvalue(), 'application/zip')
        if u.path.startswith('/extension/'):
            p = os.path.normpath(os.path.join(EXT, u.path[len('/extension/'):]))
            if not p.startswith(os.path.normpath(EXT)) or not os.path.isfile(p): return self.send(b'not found', 'text/plain', 404)
            body = open(p, 'rb').read()
            if p.endswith('detector.html'): body = body.replace(b'<script src="ort/', STUB.encode() + b'\n<script src="ort/', 1)
            ct = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.wasm': 'application/wasm'}.get(os.path.splitext(p)[1], 'application/octet-stream')
            return self.send(body, ct)
        self.send(b'not found', 'text/plain', 404)
    def do_PATCH(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if self.headers.get('X-CSRFTOKEN') != 'mocktoken123': return self.send({'detail': 'CSRF Failed'}, code=403)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if u.path != '/api/jobs/1/annotations': return self.send({'detail': 'nope'}, code=404)
        act = q['action'][0]
        if act == 'create':
            out = [dict(s, id=next(IDS)) for s in body['shapes']]; ANN['shapes'] += out
            return self.send({'version': 0, 'tags': [], 'shapes': out, 'tracks': []})
        if act == 'update':
            for s in body['shapes']:
                k = next(i for i, x in enumerate(ANN['shapes']) if x['id'] == s['id']); ANN['shapes'][k] = s
            return self.send({'version': 0, 'tags': [], 'shapes': body['shapes'], 'tracks': []})
        if act == 'delete':
            ids = {s['id'] for s in body['shapes']}; ANN['shapes'] = [s for s in ANN['shapes'] if s['id'] not in ids]
            return self.send(body)
        self.send({'detail': 'bad action'}, code=400)
print(f'mock CVAT: http://127.0.0.1:{a.port}/tasks/1/jobs/1  ({NAME}, {len(FIDS)} frames)', flush=True)
ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()
