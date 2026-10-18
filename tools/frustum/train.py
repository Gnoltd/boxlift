"""Frustum models for the box tool: which points of a 2D box's frustum are the object (seg), and its 3D box (box).

    .venv/bin/python tools/frustum/train.py --train a.npz,b.npz --test c.npz [--epochs 40] [--out work/frustum/run]
        [--epoch-size N --balance 0.5]   # large sets: N samples per epoch, drawn with class weight (count)^-balance
        [--init model.pt]                # start from a trained model; with --epochs 0: only evaluate it on --test

Frustum PointNet v1 (Qi et al. 2018), small: in the extension the 2D box comes from a person or the detector, the
points from the LiDAR (any density: they are sampled to a fixed count) and the two models run in the browser.
Input (same in extension/frustum.js): the points whose image position falls in the 2D box, turned about z by -phi
(phi = circular mean of their azimuths) so the frustum looks along +x; xyz only (no intensity: not every LiDAR has it).
 seg:  N1 = 1024 points + class one-hot -> per point object / background logits
 box:  N2 = 512 object points minus their centroid + class -> centre offset (T-Net + box net), heading (12 bins over
       2 pi + residual), size residual relative to the class mean size
Training: the 2D box is re-drawn with jitter (each side +-10 %, sometimes cut to a part), points dropped at random
(other LiDAR densities), mirrored; losses as the paper (seg CE, centre Huber x2, heading CE + residual, size,
corner loss against the true box or its 180 deg turn: front / back is the image heading model's job).
"""
import argparse, json, math, os, time
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']
MEAN_SIZE = np.array([[4.6, 1.95, 1.7], [7.5, 2.6, 3.1], [11.0, 2.9, 3.4], [2.1, 0.8, 1.5], [1.8, 0.65, 1.4], [0.75, 0.7, 1.75]], np.float32)
N1, N2, NH = 1024, 512, 12


def frustum_angle(p):
    a = np.arctan2(p[:, 1], p[:, 0])
    return math.atan2(np.sin(a).mean(), np.cos(a).mean())


def rot(p, phi):
    c, s = math.cos(phi), math.sin(phi)
    return np.stack([c * p[:, 0] + s * p[:, 1], -s * p[:, 0] + c * p[:, 1], p[:, 2]], 1)


def inside(p, b):
    c, s = math.cos(-b[6]), math.sin(-b[6])
    d = p - b[:3]
    return (np.abs(d[:, 0] * c - d[:, 1] * s) < b[3] / 2) & (np.abs(d[:, 0] * s + d[:, 1] * c) < b[4] / 2) & (np.abs(d[:, 2]) < b[5] / 2)


def arrays(f):
    """The arrays of a samples .npz, memory-mapped from a cache of .npy files next to it (made once): the loader
    workers (spawned processes on macOS) then share the page cache instead of each holding a copy."""
    f = os.path.expanduser(f); d = f[:-4] + '.cache'
    if not os.path.isdir(d) or os.path.getmtime(d) < os.path.getmtime(f):
        os.makedirs(d, exist_ok=True)
        with np.load(f) as z:
            for k in z.files:
                np.save(os.path.join(d, k + '.npy'), z[k])
    return {k[:-4]: np.load(os.path.join(d, k), mmap_mode='r') for k in os.listdir(d) if k.endswith('.npy')}


class Frustums(torch.utils.data.Dataset):
    def __init__(self, files, train):
        self.files = files
        d = [arrays(f) for f in files]
        self.pts = [x['pts'] for x in d]; self.uv = [x['uv'] for x in d]; self.off = [x['off'] for x in d]
        self.idx = [(k, i) for k, x in enumerate(d) for i in range(len(x['cls']))]
        self.rect = [x['rect'] for x in d]; self.box = [x['box'] for x in d]; self.cls = [x['cls'] for x in d]
        self.train = train

    def __getstate__(self):                              # to a loader worker: file names only, re-mapped there
        return {'files': self.files, 'train': self.train}

    def __setstate__(self, st):
        self.__init__(st['files'], st['train'])

    def __len__(self):
        return len(self.idx)

    def sample(self, k, i, rng):
        o0, o1 = self.off[k][i], self.off[k][i + 1]
        p, uv, (u0, v0, u1, v1) = self.pts[k][o0:o1].astype(np.float64), self.uv[k][o0:o1], self.rect[k][i]
        b, c = np.array(self.box[k][i], np.float64), int(self.cls[k][i])
        if self.train:                                   # a 2D box drawn differently
            w, h = u1 - u0, v1 - v0
            u0, u1 = u0 + rng.uniform(-0.1, 0.1) * w, u1 + rng.uniform(-0.1, 0.1) * w
            v0, v1 = v0 + rng.uniform(-0.1, 0.1) * h, v1 + rng.uniform(-0.1, 0.1) * h
            if rng.random() < 0.2:                       # only part of the object boxed (occlusion, truncation)
                side, cut = rng.integers(4), rng.uniform(0, 0.25)
                if side == 0: u0 += cut * w
                elif side == 1: u1 -= cut * w
                elif side == 2: v0 += cut * h
                else: v1 -= cut * h
        m = (uv[:, 0] >= u0) & (uv[:, 0] <= u1) & (uv[:, 1] >= v0) & (uv[:, 1] <= v1)
        p = p[m]
        if self.train and len(p) > 40 and rng.random() < 0.5:   # another LiDAR density
            p = p[rng.random(len(p)) < rng.uniform(0.3, 1.0)]
        if len(p) < 8:
            p = self.pts[k][o0:o1].astype(np.float64)
        phi = frustum_angle(p)
        p = rot(p, phi); bc = rot(b[None, :3], phi)[0]; b[:3] = bc; b[6] = b[6] - phi
        if self.train:
            if rng.random() < 0.5:                       # mirror (left / right of the frustum)
                p[:, 1] *= -1; b[1] *= -1; b[6] = -b[6]
            dz = rng.uniform(-0.2, 0.2); p[:, 2] += dz; b[2] += dz      # sensor height differs between cars
        lab = inside(p, b)
        s = rng.choice(len(p), N1, replace=len(p) < N1)
        return p[s].astype(np.float32), lab[s], b.astype(np.float32), c

    def __getitem__(self, j):
        rng = np.random.default_rng(None if self.train else j)
        p, lab, b, c = self.sample(*self.idx[j], rng)
        return torch.from_numpy(p), torch.from_numpy(lab.astype(np.int64)), torch.from_numpy(b), c


def mlp(dims, conv=True):
    L = []
    for a, b in zip(dims[:-1], dims[1:]):
        L += [nn.Conv1d(a, b, 1) if conv else nn.Linear(a, b), nn.BatchNorm1d(b), nn.ReLU()]
    return nn.Sequential(*L)


class SegNet(nn.Module):
    """points (B, N, 3), one-hot (B, 6) -> logits (B, N, 2)"""
    def __init__(self):
        super().__init__()
        self.local = mlp([3, 64, 64])
        self.deep = mlp([64, 128, 256])
        self.head = nn.Sequential(mlp([64 + 256 + len(CLASSES), 256, 128, 64]), nn.Conv1d(64, 2, 1))

    def forward(self, pts, onehot):
        x = pts.transpose(1, 2)
        l = self.local(x)
        g = self.deep(l).max(2, keepdim=True)[0]
        f = torch.cat([l, g.expand(-1, -1, l.shape[2]), onehot[:, :, None].expand(-1, -1, l.shape[2])], 1)
        return self.head(f).transpose(1, 2)


class BoxNet(nn.Module):
    """object points minus their centroid (B, N2, 3), one-hot -> centre offset (3), heading logits (NH),
    heading residuals (NH, in units of pi / NH), size residual (3, relative to the class mean)"""
    def __init__(self):
        super().__init__()
        self.tfeat = mlp([3, 64, 128, 256]); self.tfc = nn.Sequential(mlp([256 + len(CLASSES), 256, 128], conv=False), nn.Linear(128, 3))
        self.feat = mlp([3, 64, 128, 256, 512]); self.fc = nn.Sequential(mlp([512 + len(CLASSES), 512, 256], conv=False), nn.Linear(256, 3 + 2 * NH + 3))

    def forward(self, pts, onehot):
        x = pts.transpose(1, 2)
        d1 = self.tfc(torch.cat([self.tfeat(x).max(2)[0], onehot], 1))
        y = self.fc(torch.cat([self.feat(x - d1[:, :, None]).max(2)[0], onehot], 1))
        return torch.cat([d1 + y[:, :3], y[:, 3:]], 1), d1


def take_object(p, logits, rng=None):
    """Object points by the seg model (fallback: all), sampled to N2, and their centroid. p (N, 3) np."""
    m = logits[:, 1] > logits[:, 0]
    q = p[m] if m.sum() >= 3 else p
    c = q.mean(0)
    s = (rng or np.random).choice(len(q), N2, replace=len(q) < N2)
    return q[s] - c, c


def decode(out, cls):
    """box net output (B, 30) -> (B, 7) box in the frustum frame (relative to the object points' centroid)."""
    ctr = out[:, :3]
    hl, hr = out[:, 3:3 + NH], out[:, 3 + NH:3 + 2 * NH]
    k = hl.argmax(1)
    yaw = k.float() * (2 * math.pi / NH) + hr.gather(1, k[:, None])[:, 0] * (math.pi / NH)
    ms = torch.from_numpy(MEAN_SIZE).to(out.device)[cls]
    size = ms * (1 + out[:, 3 + 2 * NH:])
    return torch.cat([ctr, size, yaw[:, None]], 1)


def box_corners(b):
    """(B, 7) -> (B, 8, 3)"""
    c, s = torch.cos(b[:, 6]), torch.sin(b[:, 6])
    sx = torch.tensor([1, 1, 1, 1, -1, -1, -1, -1.], device=b.device); sy = torch.tensor([1, 1, -1, -1, 1, 1, -1, -1.], device=b.device)
    sz = torch.tensor([1, -1, 1, -1, 1, -1, 1, -1.], device=b.device)
    x = sx * b[:, 3:4] / 2; y = sy * b[:, 4:5] / 2; z = sz * b[:, 5:6] / 2
    return torch.stack([b[:, 0:1] + x * c[:, None] - y * s[:, None], b[:, 1:2] + x * s[:, None] + y * c[:, None], b[:, 2:3] + z], 2)


def huber(x, d=1.0):
    a = x.abs()
    return torch.where(a < d, 0.5 * a * a, d * (a - 0.5 * d))


def box_loss(out, d1, cen, gt, cls):
    """cen: object-point centroid (B, 3); gt: true box (B, 7) in the frustum frame."""
    t = gt[:, :3] - cen
    lc = huber((out[:, :3] - t).norm(dim=1), 2.0).mean(); l1 = huber((d1 - t).norm(dim=1), 2.0).mean()
    ang = torch.remainder(gt[:, 6], 2 * math.pi)
    k = torch.clamp((ang / (2 * math.pi / NH)).long(), 0, NH - 1)
    res = (ang - k.float() * (2 * math.pi / NH)) / (math.pi / NH)
    lh = F.cross_entropy(out[:, 3:3 + NH], k) + huber(out[:, 3 + NH:3 + 2 * NH].gather(1, k[:, None])[:, 0] - res).mean()
    ms = torch.from_numpy(MEAN_SIZE).to(out.device)[cls]
    ls = huber((out[:, 3 + 2 * NH:] - (gt[:, 3:6] / ms - 1))).sum(1).mean()
    # corner loss with the predicted heading taken from the true bin + residual (as the paper) and centre / size
    pred = torch.cat([out[:, :3] + cen, ms * (1 + out[:, 3 + 2 * NH:]),
                      (k.float() * (2 * math.pi / NH) + out[:, 3 + NH:3 + 2 * NH].gather(1, k[:, None])[:, 0] * (math.pi / NH))[:, None]], 1)
    pc = box_corners(pred); g1 = box_corners(gt); g2 = box_corners(torch.cat([gt[:, :6], gt[:, 6:] + math.pi], 1))
    lcor = torch.minimum((pc - g1).norm(dim=2).mean(1), (pc - g2).norm(dim=2).mean(1))
    return lc + l1 + lh + ls + 10 * huber(lcor).mean()


def bev_iou(a, b):
    """numpy boxes (7,) -> (bev IoU, 3d IoU), yaw-only, via polygon clipping."""
    def poly(x):
        c, s = math.cos(x[6]), math.sin(x[6])
        return [(x[0] + i * x[3] / 2 * c - j * x[4] / 2 * s, x[1] + i * x[3] / 2 * s + j * x[4] / 2 * c) for i, j in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
    def clip(sub, cl):
        out = sub
        for i in range(len(cl)):
            A, B = cl[i], cl[(i + 1) % len(cl)]; inp, out = out, []
            side = lambda p: (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0])
            for k in range(len(inp)):
                P, Q = inp[k], inp[(k + 1) % len(inp)]; sp, sq = side(P), side(Q)
                if sp >= 0: out.append(P)
                if (sp >= 0) != (sq >= 0):
                    t = sp / (sp - sq); out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
            if not out: break
        return out
    area = lambda p: abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2 if len(p) > 2 else 0
    inter = area(clip(poly(a), poly(b)))
    zo = max(0, min(a[2] + a[5] / 2, b[2] + b[5] / 2) - max(a[2] - a[5] / 2, b[2] - b[5] / 2))
    return inter / (a[3] * a[4] + b[3] * b[4] - inter), inter * zo / (a[3] * a[4] * a[5] + b[3] * b[4] * b[5] - inter * zo)


def evaluate(seg, box, ds, dev, limit=None):
    seg.eval(); box.eval()
    n = len(ds) if limit is None else min(limit, len(ds))
    res = []
    with torch.no_grad():
        for j0 in range(0, n, 256):
            items = [ds[j] for j in range(j0, min(n, j0 + 256))]
            p = torch.stack([x[0] for x in items]).to(dev); lab = torch.stack([x[1] for x in items]); gt = torch.stack([x[2] for x in items]).numpy()
            c = torch.tensor([x[3] for x in items]); oh = F.one_hot(c, len(CLASSES)).float().to(dev)
            lg = seg(p, oh).cpu().numpy()
            obj, cen = zip(*[take_object(p[k].cpu().numpy(), lg[k], np.random.default_rng(j0 + k)) for k in range(len(items))])
            out, _ = box(torch.tensor(np.stack(obj), dtype=torch.float32).to(dev), oh)
            bx = decode(out, c.to(dev)).cpu().numpy(); bx[:, :3] += np.stack(cen)
            for k in range(len(items)):
                pm = lg[k, :, 1] > lg[k, :, 0]; t = lab[k].numpy().astype(bool)
                res.append((int(c[k]), *bev_iou(bx[k], gt[k]), (pm == t).mean(), (pm & t).sum() / max(1, (pm | t).sum())))
    r = np.array(res)
    out = {}
    for ci, name in enumerate(CLASSES):
        m = r[:, 0] == ci
        if m.sum():
            out[name] = {'n': int(m.sum()), 'iou3d_p50': float(np.median(r[m, 2])), 'iou3d_05': float((r[m, 2] >= 0.5).mean()),
                         'iou3d_07': float((r[m, 2] >= 0.7).mean()), 'seg_acc': float(r[m, 3].mean()), 'seg_iou': float(r[m, 4].mean())}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', default=''); ap.add_argument('--test', default='')
    ap.add_argument('--epochs', type=int, default=40); ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--lr', type=float, default=1e-3); ap.add_argument('--out', default='work/frustum/run')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--epoch-size', type=int, default=0, help='samples per epoch, drawn at random (0: the whole set, shuffled)')
    ap.add_argument('--init', default='')
    ap.add_argument('--balance', type=float, default=0.0, help='rare classes drawn more: weight = class count ^ -balance')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    tr = Frustums(a.train.split(','), True) if a.train else None; te = Frustums(a.test.split(','), False) if a.test else None
    print(f'train {len(tr) if tr else 0}, test {len(te) if te else 0}, device {dev}', flush=True)
    seg, box = SegNet().to(dev), BoxNet().to(dev)
    if a.init:
        st = torch.load(a.init, map_location=dev); seg.load_state_dict(st['seg']); box.load_state_dict(st['box'])
    if a.epochs == 0:
        r = evaluate(seg, box, te, dev); json.dump(r, open(os.path.join(a.out, 'test.json'), 'w'), indent=1); print(json.dumps(r, indent=1))
        return
    print('params seg', sum(p.numel() for p in seg.parameters()), 'box', sum(p.numel() for p in box.parameters()), flush=True)
    opt = torch.optim.AdamW(list(seg.parameters()) + list(box.parameters()), lr=a.lr, weight_decay=1e-4)
    sampler = None
    if a.epoch_size or a.balance:
        cls = np.array([int(tr.cls[k][i]) for k, i in tr.idx])
        w = np.bincount(cls, minlength=len(CLASSES)).astype(np.float64).clip(1) ** -a.balance
        print('class counts', np.bincount(cls, minlength=len(CLASSES)).tolist(), flush=True)
        sampler = torch.utils.data.WeightedRandomSampler(torch.from_numpy(w[cls]), a.epoch_size or len(tr), replacement=True)
    dl = torch.utils.data.DataLoader(tr, batch_size=a.batch, shuffle=sampler is None, sampler=sampler, num_workers=a.workers,
                                     drop_last=True, persistent_workers=a.workers > 0)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=a.epochs * len(dl))
    t0, rng = time.time(), np.random.default_rng(0)
    for ep in range(a.epochs):
        seg.train(); box.train(); tot = [0.0, 0.0]
        for p, lab, gt, c in dl:
            p, lab, gt, c = p.to(dev), lab.to(dev), gt.to(dev), c.to(dev)
            oh = F.one_hot(c, len(CLASSES)).float()
            lg = seg(p, oh)
            ls = F.cross_entropy(lg.reshape(-1, 2), lab.reshape(-1))
            # the box net learns on the true object points half the time, on the seg model's the other half
            use = torch.where(torch.rand(len(p), 1, device=dev) < 0.5, lab.bool(), lg.detach().argmax(2).bool())
            pn = p.detach().cpu().numpy(); un = use.cpu().numpy()
            obj, cen = [], []
            for k in range(len(pn)):
                q = pn[k][un[k]] if un[k].sum() >= 3 else pn[k]
                cc = q.mean(0); s = rng.choice(len(q), N2, replace=len(q) < N2); obj.append(q[s] - cc); cen.append(cc)
            obj = torch.tensor(np.stack(obj), device=dev); cen = torch.tensor(np.stack(cen), device=dev)
            out, d1 = box(obj, oh)
            lb = box_loss(out, d1, cen, gt, c)
            loss = ls + lb
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot[0] += float(ls); tot[1] += float(lb)
        msg = f'epoch {ep + 1:3d} seg {tot[0] / len(dl):.3f} box {tot[1] / len(dl):.3f} [{time.time() - t0:.0f}s]'
        if te is not None and (ep % 5 == 4 or ep == a.epochs - 1):
            r = evaluate(seg, box, te, dev, limit=3000)
            msg += ' · ' + ' '.join(f"{k} IoU>=.5 {100 * v['iou3d_05']:.0f}% >=.7 {100 * v['iou3d_07']:.0f}% seg {100 * v['seg_iou']:.0f}" for k, v in r.items() if k in ('car', 'truck', 'pedestrian'))
        print(msg, flush=True)
        torch.save({'seg': seg.state_dict(), 'box': box.state_dict()}, os.path.join(a.out, 'model.pt'))
    if te is not None:
        r = evaluate(seg, box, te, dev)
        json.dump(r, open(os.path.join(a.out, 'test.json'), 'w'), indent=1)
        print(json.dumps(r, indent=1))


if __name__ == '__main__':
    main()
