"""Camera models used by the calibration.

pinhole : Brown-Conrady, dist = [k1, k2, p1, p2, k3]            (OpenCV cv2.projectPoints)
fisheye : Kannala-Brandt / equidistant, dist = [k1, k2, k3, k4]  (OpenCV cv2.fisheye)
          theta_d = theta * (1 + k1 th^2 + k2 th^4 + k3 th^6 + k4 th^8), r_px = f * theta_d
"""
import numpy as np, cv2


def fold_r2(dist):
    """Largest undistorted r^2 where the pinhole radial model is still monotonic."""
    k1, k2, p1, p2, k3 = (list(dist) + [0] * 5)[:5]
    r2s = np.linspace(1e-6, 25, 200000); rd = np.sqrt(r2s) * (1 + k1 * r2s + k2 * r2s ** 2 + k3 * r2s ** 3)
    idx = np.where(np.diff(rd) <= 0)[0]
    return r2s[idx[0]] if len(idx) else 25.0


_fc = {}
def fold_r2_cached(d):
    if d not in _fc: _fc[d] = fold_r2(d)
    return _fc[d]

FISHEYE_MAX_THETA = np.radians(100.0)


def project(Pc, K, dist, W, H, model='pinhole', near=0.3):
    """Pc: Nx3 camera-frame points -> (u, v, ok) in full-resolution pixels."""
    x, y, z = Pc[:, 0], Pc[:, 1], Pc[:, 2]
    if model == 'fisheye':
        rho = np.hypot(x, y)
        th = np.arctan2(rho, z)
        ok = (th < FISHEYE_MAX_THETA) & (np.linalg.norm(Pc, axis=1) > near)
        k1, k2, k3, k4 = (list(dist) + [0] * 4)[:4]
        t2 = th * th
        thd = th * (1 + k1 * t2 + k2 * t2 ** 2 + k3 * t2 ** 3 + k4 * t2 ** 4)
        # monotonic check: distorted angle must keep growing
        ok &= thd > 0
        s = np.where(rho > 1e-9, thd / np.maximum(rho, 1e-9), 0.0)
        xd, yd = x * s, y * s
    else:
        ok = z > near
        zs = np.where(ok, z, 1.0)
        xn, yn = x / zs, y / zs
        k1, k2, p1, p2, k3 = (list(dist) + [0] * 5)[:5]
        r2 = xn * xn + yn * yn
        ok &= r2 < fold_r2_cached(tuple(float(v) for v in dist)) * 0.98
        rad = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
        xd = xn * rad + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn)
        yd = yn * rad + p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn
    u = K[0, 0] * xd + K[0, 1] * yd + K[0, 2]
    v = K[1, 1] * yd + K[1, 2]
    ok &= (u >= 0) & (u < W - 1) & (v >= 0) & (v < H - 1)
    return u, v, ok


def unproject(pts, K, dist, model='pinhole'):
    """Pixels -> unit-depth normalized coords (x/z, y/z). Rays beyond ~85 deg are clipped."""
    p = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    if model == 'fisheye':
        D = np.array((list(dist) + [0] * 4)[:4], np.float64).reshape(4, 1)
        return cv2.fisheye.undistortPoints(p, np.asarray(K, np.float64), D).reshape(-1, 2)
    K = np.asarray(K, np.float64)
    n = cv2.undistortPoints(p, K, np.array(dist, np.float64)).reshape(-1, 2)   # initial guess
    yd = (p[:, 0, 1] - K[1, 2]) / K[1, 1]
    xd = (p[:, 0, 0] - K[0, 2] - K[0, 1] * yd) / K[0, 0]
    tgt = np.c_[xd, yd]
    for _ in range(8):           # Newton refinement (OpenCV's 5 fixed-point steps leave ~0.1 deg)
        f0 = _distort(n, dist) - tgt
        e = 1e-6
        jx = (_distort(n + [e, 0], dist) - _distort(n, dist)) / e
        jy = (_distort(n + [0, e], dist) - _distort(n, dist)) / e
        det = jx[:, 0] * jy[:, 1] - jy[:, 0] * jx[:, 1]
        det = np.where(np.abs(det) > 1e-12, det, 1e-12)
        dx = (jy[:, 1] * f0[:, 0] - jy[:, 0] * f0[:, 1]) / det
        dy = (-jx[:, 1] * f0[:, 0] + jx[:, 0] * f0[:, 1]) / det
        n = n - np.c_[dx, dy]
    return n


def _distort(n, dist):
    k1, k2, p1, p2, k3 = (list(dist) + [0] * 5)[:5]
    x, y = n[:, 0], n[:, 1]
    r2 = x * x + y * y
    rad = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
    return np.c_[x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y]


def unproject_ray(pts, K, dist, model='pinhole'):
    """Pixels -> unit ray directions in the camera frame (valid beyond 90 deg for fisheye)."""
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    if model == 'fisheye':
        mx = (pts[:, 0] - K[0, 2] - K[0, 1] * (pts[:, 1] - K[1, 2]) / K[1, 1]) / K[0, 0]
        my = (pts[:, 1] - K[1, 2]) / K[1, 1]
        thd = np.hypot(mx, my)
        k1, k2, k3, k4 = (list(dist) + [0] * 4)[:4]
        th = thd.copy()
        for _ in range(10):   # Newton on theta*(1+k1 t^2+...) = theta_d
            t2 = th * th
            f = th * (1 + k1 * t2 + k2 * t2 ** 2 + k3 * t2 ** 3 + k4 * t2 ** 4) - thd
            df = 1 + 3 * k1 * t2 + 5 * k2 * t2 ** 2 + 7 * k3 * t2 ** 3 + 9 * k4 * t2 ** 4
            th = th - f / np.where(np.abs(df) > 1e-6, df, 1e-6)
        phi = np.arctan2(my, mx)
        return np.c_[np.sin(th) * np.cos(phi), np.sin(th) * np.sin(phi), np.cos(th)]
    n = unproject(pts, K, dist, model)
    r = np.c_[n, np.ones(len(n))]
    return r / np.linalg.norm(r, axis=1, keepdims=True)
