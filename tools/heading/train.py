"""Train the heading (observation angle) model on the crops of make_crops.py; export ONNX for the extension.

    .venv/bin/python tools/heading/train.py --data ~/public-data/heading \
        [--test scene-0103,scene-0916] [--epochs 15] [--out work/heading]   # --test '' : train on everything

Model: MobileNetV3-small (ImageNet weights, torchvision) -> 8 logits over the observation angle alpha (bins every
45 deg, soft von Mises targets so neighbouring bins share). Input: crop of the object's 2D box (+15 % margin),
squashed to 128x128, RGB, ImageNet mean/std. Augmentation: box jitter (what a detector or a person draws),
horizontal mirror (alpha -> -alpha), colour.
The box tool knows the object's axis from the LiDAR (+-2 deg) but not which end is the front: the model only has to
say which of alpha and alpha + pi is right. Reported on the held-out scenes: that front/back choice given the true
axis, per class, and the alpha error of the model alone.
"""
import argparse, json, math, os, time
import numpy as np, cv2, torch, torch.nn as nn, torch.nn.functional as F
import torchvision

BINS, KAPPA, SIZE, PRE = 8, 4.0, 128, 160
CENTRES = torch.tensor([-math.pi + (k + 0.5) * 2 * math.pi / BINS for k in range(BINS)])
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)


def soft_target(alpha):
    """von Mises weights of each bin centre for angles alpha (N,) -> (N, BINS)."""
    w = torch.exp(KAPPA * torch.cos(alpha[:, None] - CENTRES[None]))
    return w / w.sum(1, keepdim=True)


def density(prob, alpha):
    """Smoothed predicted density at angles alpha (N,) from bin probabilities (N, BINS)."""
    return (prob * torch.exp(KAPPA * torch.cos(alpha[:, None] - CENTRES[None].to(prob.device)))).sum(1)


class Crops(torch.utils.data.Dataset):
    def __init__(self, rows, root, train):
        self.rows, self.train = rows, train
        self.img = np.stack([cv2.resize(cv2.imread(os.path.join(root, r['file']))[:, :, ::-1], (PRE, PRE), interpolation=cv2.INTER_AREA) for r in rows])
        self.alpha = torch.tensor([r['alpha'] for r in rows], dtype=torch.float32)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        im, a = self.img[i], float(self.alpha[i])
        m = PRE * 0.15 / 1.3                                       # the margin added around the box, in PRE pixels
        if self.train:                                            # a box drawn a bit differently: shrink / shift each edge
            rnd = np.random.uniform
            x0, y0 = m + rnd(-0.7, 0.7) * m, m + rnd(-0.7, 0.7) * m
            x1, y1 = PRE - m + rnd(-0.7, 0.7) * m, PRE - m + rnd(-0.7, 0.7) * m
            # sometimes a tighter / partial box (occlusion, detector): cut up to 20 % of one side
            if rnd() < 0.3:
                side, cut = np.random.randint(4), rnd(0, 0.2) * (PRE - 2 * m)
                if side == 0: x0 += cut
                elif side == 1: x1 -= cut
                elif side == 2: y0 += cut
                else: y1 -= cut
            x0, y0 = max(0, x0 - m), max(0, y0 - m); x1, y1 = min(PRE, x1 + m), min(PRE, y1 + m)   # margin as at inference
            im = im[int(y0):int(y1), int(x0):int(x1)]
            if rnd() < 0.5:
                im, a = im[:, ::-1], -a
            im = np.clip(im.astype(np.float32) * rnd(0.7, 1.3) + rnd(-25, 25), 0, 255)
        x = cv2.resize(np.ascontiguousarray(im).astype(np.float32), (SIZE, SIZE), interpolation=cv2.INTER_LINEAR) / 255.0
        x = (x - MEAN) / STD
        return torch.from_numpy(x.transpose(2, 0, 1).copy()), torch.tensor(a, dtype=torch.float32)


def model():
    m = torchvision.models.mobilenet_v3_small(weights=torchvision.models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    m.classifier[-1] = nn.Linear(m.classifier[-1].in_features, BINS)
    return m


def evaluate(net, ds, rows, dev):
    net.eval(); probs = []
    with torch.no_grad():
        for x, _ in torch.utils.data.DataLoader(ds, batch_size=256):
            probs.append(F.softmax(net(x.to(dev)), 1).cpu())
    p = torch.cat(probs); a = ds.alpha
    right = density(p, a) > density(p, a + math.pi)                # front/back given the true axis
    grid = torch.linspace(-math.pi, math.pi, 361)[:-1]
    est = grid[torch.stack([density(p, torch.full((len(p),), float(g))) for g in grid], 1).argmax(1)]
    err = torch.abs((est - a + math.pi) % (2 * math.pi) - math.pi) * 180 / math.pi
    out = {'n': len(rows), 'front_back_acc': float(right.float().mean()), 'alpha_err_median_deg': float(err.median())}
    for c in sorted({r['cls'] for r in rows}):
        k = torch.tensor([r['cls'] == c for r in rows])
        out[c] = {'n': int(k.sum()), 'front_back_acc': float(right[k].float().mean()), 'alpha_err_median_deg': float(err[k].median())}
    big = torch.tensor([r['w'] >= 80 for r in rows])
    out['crop>=80px'] = {'n': int(big.sum()), 'front_back_acc': float(right[big].float().mean())}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--test', default='scene-0103,scene-0916')
    ap.add_argument('--epochs', type=int, default=15)
    ap.add_argument('--out', default='work/heading')
    a = ap.parse_args()
    root = os.path.expanduser(a.data); os.makedirs(a.out, exist_ok=True)
    rows = json.load(open(os.path.join(root, 'labels.json')))
    test = set(filter(None, a.test.split(',')))
    tr = [r for r in rows if r['scene'] not in test]; te = [r for r in rows if r['scene'] in test]
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    t0 = time.time()
    dtr = Crops(tr, root, True); dte = Crops(te, root, False) if te else None
    print(f'train {len(tr)} crops, test {len(te)} ({", ".join(sorted(test)) or "-"}), device {dev}, loaded {time.time() - t0:.0f}s', flush=True)
    net = model().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(dtr) / 128); sched = torch.optim.lr_scheduler.OneCycleLR(opt, 1e-3, total_steps=steps)
    for ep in range(a.epochs):
        net.train(); tot = 0.0
        for x, al in torch.utils.data.DataLoader(dtr, batch_size=128, shuffle=True, num_workers=0):
            x, tgt = x.to(dev), soft_target(al).to(dev)
            loss = -(tgt * F.log_softmax(net(x), 1)).sum(1).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += float(loss) * len(x)
        msg = f'epoch {ep + 1:2d} loss {tot / len(dtr):.3f}'
        if dte is not None and (ep % 3 == 2 or ep == a.epochs - 1):
            r = evaluate(net, dte, te, dev); msg += f" · held-out front/back {100 * r['front_back_acc']:.1f}% · alpha err {r['alpha_err_median_deg']:.1f}°"
        print(msg, f'[{time.time() - t0:.0f}s]', flush=True)
    res = {'train_scenes': sorted({r['scene'] for r in tr}), 'test_scenes': sorted(test), 'epochs': a.epochs}
    if dte is not None:
        res['held_out'] = evaluate(net, dte, te, dev)
        print(json.dumps(res['held_out'], indent=1))
    tag = 'heading_all' if not test else 'heading_split'
    net.eval().cpu()
    torch.save(net.state_dict(), os.path.join(a.out, tag + '.pt'))
    torch.onnx.export(net, torch.zeros(1, 3, SIZE, SIZE), os.path.join(a.out, tag + '.onnx'), input_names=['crop'], output_names=['logits'],
                      dynamic_axes={'crop': {0: 'n'}, 'logits': {0: 'n'}}, opset_version=17, dynamo=False)
    json.dump(res, open(os.path.join(a.out, tag + '.json'), 'w'), indent=1)
    print('wrote', os.path.join(a.out, tag + '.onnx'))


if __name__ == '__main__':
    main()
