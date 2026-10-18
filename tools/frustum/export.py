"""Export the frustum models to ONNX for the extension (extension/models/frustum_seg.onnx, frustum_box.onnx).

    .venv/bin/python tools/frustum/export.py work/frustum/run/model.pt extension/models

seg: points (n, 1024, 3), onehot (n, 6) -> logits (n, 1024, 2)
box: points (n, 512, 3) (object points minus their centroid), onehot (n, 6) -> out (n, 30) (see train.decode)
Also writes frustum.json (classes, mean sizes, N1, N2, NH) for extension/frustum.js.
"""
import json, os, sys
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import SegNet, BoxNet, CLASSES, MEAN_SIZE, N1, N2, NH


class BoxOnly(torch.nn.Module):
    def __init__(self, box):
        super().__init__(); self.box = box

    def forward(self, pts, onehot):
        return self.box(pts, onehot)[0]


def main():
    ck, out = sys.argv[1], sys.argv[2]
    st = torch.load(ck, map_location='cpu')
    seg, box = SegNet(), BoxNet()
    seg.load_state_dict(st['seg']); box.load_state_dict(st['box']); seg.eval(); box.eval()
    oh = torch.zeros(1, len(CLASSES)); oh[0, 0] = 1
    torch.onnx.export(seg, (torch.zeros(1, N1, 3), oh), os.path.join(out, 'frustum_seg.onnx'), input_names=['points', 'onehot'],
                      output_names=['logits'], dynamic_axes={'points': {0: 'n'}, 'onehot': {0: 'n'}, 'logits': {0: 'n'}}, opset_version=17, dynamo=False)
    torch.onnx.export(BoxOnly(box), (torch.zeros(1, N2, 3), oh), os.path.join(out, 'frustum_box.onnx'), input_names=['points', 'onehot'],
                      output_names=['out'], dynamic_axes={'points': {0: 'n'}, 'onehot': {0: 'n'}, 'out': {0: 'n'}}, opset_version=17, dynamo=False)
    json.dump({'classes': CLASSES, 'mean_size': MEAN_SIZE.tolist(), 'n1': N1, 'n2': N2, 'nh': NH}, open(os.path.join(out, 'frustum.json'), 'w'))
    print('wrote', out)


if __name__ == '__main__':
    main()
