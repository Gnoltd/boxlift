"""Object crop through a virtual pinhole camera looking straight at the object (same as extension/heading.js).

Any camera model (pinhole, fisheye) gives the same kind of crop: the virtual camera sits at the real camera's centre,
its optical axis on the ray to the box centre, its x axis level with the real camera's x-z plane (up = camera -y).
The 8 box corners projected into it bound the crop (+15 % each side), squashed to size x size; each crop pixel is a ray
looked up in the real image through the real camera model (bilinear, black outside the image; no crop when
< 30 % of it is in the image).
alpha (the label) = heading of the object in the virtual camera's x-z plane: 0 = moving away (rear seen),
+-pi = towards the camera (front seen), +pi/2 = heading to the right.
"""
import math, os, sys
import numpy as np, cv2
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from camera import project

MARGIN = 0.15
MIN_SEEN = 0.3      # share of the crop that must be in the image


def corners(b):
    c, s = math.cos(b['yaw']), math.sin(b['yaw'])
    return np.array([[b['x'] + i * b['l'] / 2 * c - j * b['w'] / 2 * s, b['y'] + i * b['l'] / 2 * s + j * b['w'] / 2 * c, b['z'] + k * b['h'] / 2]
                     for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)])


def view(b, M):
    """Rotation camera -> virtual camera (rows x', y', z') for box b (pcd frame) and pcd -> camera transform M."""
    c = M[:3, :3] @ [b['x'], b['y'], b['z']] + M[:3, 3]
    z = c / np.linalg.norm(c)
    x = np.cross([0.0, 1.0, 0.0], z)
    if np.linalg.norm(x) < 1e-6:
        return None
    x /= np.linalg.norm(x)
    return np.stack([x, np.cross(z, x), z])


def alpha(b, M, Rv):
    v = Rv @ (M[:3, :3] @ [math.cos(b['yaw']), math.sin(b['yaw']), 0.0])
    return math.atan2(v[0], v[2])


def crop(img, cam, b, M, size, span=None):
    """Rectified crop (size x size x 3, uint8, same channel order as img) and alpha, or (None, None).
    span: the object's size in the real image (px); a big object is rendered at up to 4x and averaged down (no aliasing)."""
    ss = int(min(4, max(1, math.ceil((span or size) / size))))
    out, al = _crop(img, cam, b, M, size * ss)
    if out is not None and ss > 1:
        out = cv2.resize(out, (size, size), interpolation=cv2.INTER_AREA)
    return out, al


def _crop(img, cam, b, M, size):
    Rv = view(b, M)
    if Rv is None:
        return None, None
    P = (corners(b) @ M[:3, :3].T + M[:3, 3]) @ Rv.T
    if (P[:, 2] < 0.1).any():
        return None, None
    xn, yn = P[:, 0] / P[:, 2], P[:, 1] / P[:, 2]
    a, A, c, C = xn.min(), xn.max(), yn.min(), yn.max()
    ma, mc = MARGIN * (A - a), MARGIN * (C - c)
    a, A, c, C = a - ma, A + ma, c - mc, C + mc
    t = (np.arange(size) + 0.5) / size
    gx, gy = np.meshgrid(a + t * (A - a), c + t * (C - c))
    rays = np.stack([gx, gy, np.ones_like(gx)], -1).reshape(-1, 3) @ Rv           # virtual -> camera frame
    W, H = cam['image_size']
    u, v, ok = project(rays * 10.0, np.array(cam['K'], np.float64), cam.get('dist', []), W, H, cam.get('model', 'pinhole'))
    u = np.where(ok, u, -10).astype(np.float32).reshape(size, size); v = np.where(ok, v, -10).astype(np.float32).reshape(size, size)
    inside = ok & (u.ravel() >= 0) & (u.ravel() < W - 1) & (v.ravel() >= 0) & (v.ravel() < H - 1)
    if inside.mean() < MIN_SEEN:                       # mostly outside the image
        return None, None
    out = cv2.remap(img, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return out, alpha(b, M, Rv)
