"""High-fidelity re-vectorization of the raster layers.

Pipeline per layer:
  1. subpixel coverage field (unmix antialiased colors -> per-color alpha)
  2. bicubic upsample + marching-squares 0.5 iso-contour  (subpixel edge position)
  3. uniform arclength resample
  4. corner detection (turning angle over a fixed arclength window)
  5. Taubin low-pass smoothing, corners pinned, displacement clamped to CAP px
     (measured against the original contour polyline via KD-tree, so the shape
      can never drift more than CAP source pixels)
  6. Schneider cubic-bezier fit with G1 tangent continuity, corners split
  7. emit path data in ORIGINAL source-pixel coords (scaled later)
"""
import sys, json, math
import numpy as np
from PIL import Image
from scipy.ndimage import label, zoom
from scipy.spatial import cKDTree
from skimage.measure import find_contours

Z = 4          # upsample factor of the coverage field before contouring
STEP = 0.30    # arclength resample step, source px
SCALE = 2.0    # output coordinate scale (default 2x source)
MAXHI = 8192   # cap on upsampled contour-grid dimension (browser memory guard).
CORNER_WIN = 5.0   # reject pixel-scale stair steps while retaining structural corners
CORNER_DEG = 50.0  # turn angle above this = real corner, pinned + sharp
CAP = 0.50     # max smoothing deviation, source px
ITERS = 600    # Taubin iterations
LAM, MU = 0.55, -0.58
FIT_ERR = 0.25     # bezier fit tolerance, source px
MIN_AREA = 2.0     # drop specks smaller than this, source px^2
MIN_AREA_FRACTION = 0.0002  # discard palette freckles below 0.02% of the canvas
COVERAGE_MODE = "nearest"  # parity with the UI color-reduction preview

# Layer definitions are injected by the caller at runtime.
# name: (file, offset, palette, index-of-color-to-extract or None for alpha)
LAYERS = {}


# ---------------------------------------------------------------- coverage
def coverage(name):
    f, off, palette, idx = LAYERS[name]
    a = np.array(Image.open(f).convert("RGBA")).astype(np.float64)
    alpha = a[..., 3] / 255.0
    if palette is None:
        return alpha, off
    C = a[..., :3]
    P = np.array(palette, float)                       # k x 3
    if COVERAGE_MODE == "nearest":
        best = np.zeros(alpha.shape, dtype=np.int16)
        best_dist = np.full(alpha.shape, np.inf, dtype=np.float64)
        for pi, color in enumerate(P):
            dist = np.sum((C - color) ** 2, axis=2)
            take = dist < best_dist
            best[take] = pi
            best_dist[take] = dist[take]
        return alpha * (best == idx), off
    # barycentric weights: minimise |P^T w - C| s.t. sum w = 1  (soft constraint)
    W = 1000.0
    M = np.vstack([P.T, np.full((1, len(P)), W)])      # 4 x k
    rhs = np.concatenate([C.reshape(-1, 3).T, np.full((1, C[..., 0].size), W)])
    w, *_ = np.linalg.lstsq(M, rhs, rcond=None)        # k x N
    w = np.clip(w, 0, 1)
    s = w.sum(0)
    s[s == 0] = 1
    w = w / s
    return alpha * w[idx].reshape(alpha.shape), off


# ---------------------------------------------------------------- contours
def clean_contour_field(field):
    """Remove tiny islands and fill tiny holes before curve fitting."""
    cleaned = field.copy()
    min_pixels = max(int(MIN_AREA), int(round(field.size * MIN_AREA_FRACTION)))
    mask = cleaned >= 0.5
    components, count = label(mask)
    if count:
        sizes = np.bincount(components.ravel())
        remove = sizes < min_pixels
        remove[0] = False
        cleaned[remove[components]] = 0.0

    mask = cleaned >= 0.5
    holes, count = label(~mask)
    if count:
        sizes = np.bincount(holes.ravel())
        border_ids = np.unique(np.concatenate([
            holes[0, :], holes[-1, :], holes[:, 0], holes[:, -1],
        ]))
        fill = sizes < min_pixels
        fill[border_ids] = False
        fill[0] = False
        cleaned[fill[holes]] = 1.0
    return cleaned, float(min_pixels)


def contours_of(field):
    pad = 3
    field, min_area = clean_contour_field(field)
    f = np.pad(field, pad, mode="constant")
    # Upsample by Z, but cap the grid so large uploads do not exhaust browser
    # memory. The effective factor never exceeds Z.
    z_eff = min(float(Z), max(1.0, MAXHI / max(f.shape)))
    hi = zoom(f, z_eff, order=3, mode="constant", cval=0.0)
    hi = np.clip(hi, 0, 1)
    out = []
    for c in find_contours(hi, 0.5):
        pts = np.column_stack([c[:, 1] / z_eff - pad, c[:, 0] / z_eff - pad])  # x, y
        if len(pts) < 8:
            continue
        x, y = pts[:, 0], pts[:, 1]
        area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
        if area < min_area:
            continue
        if np.hypot(*(pts[0] - pts[-1])) < 1e-6:
            pts = pts[:-1]
        out.append(pts)
    return out


def resample(pts, step=STEP):
    p = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(p, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(16, int(round(s[-1] / step)))
    t = np.linspace(0, s[-1], n, endpoint=False)
    return np.column_stack([np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])])


def corners(pts, win=CORNER_WIN, deg=CORNER_DEG):
    k = max(1, int(round(win / STEP)))
    a = pts - np.roll(pts, k, axis=0)
    b = np.roll(pts, -k, axis=0) - pts
    na, nb = np.hypot(*a.T), np.hypot(*b.T)
    na[na == 0] = 1e-9; nb[nb == 0] = 1e-9
    cosang = np.clip((a * b).sum(1) / (na * nb), -1, 1)
    turn = np.degrees(np.arccos(cosang))
    cand = turn > deg
    # keep only the local maximum of each corner cluster
    idx = np.where(cand)[0]
    keep = []
    for i in idx:
        w = [(j % len(pts)) for j in range(i - k, i + k + 1)]
        if turn[i] >= turn[w].max() - 1e-9:
            keep.append(i)
    return np.array(sorted(set(keep)), dtype=int)


def taubin(pts, pin, ref_tree, iters=ITERS, cap=CAP):
    p = pts.copy()
    mask = np.ones(len(p), bool)
    mask[pin] = False
    for _ in range(iters):
        for f in (LAM, MU):
            avg = 0.5 * (np.roll(p, 1, axis=0) + np.roll(p, -1, axis=0))
            p[mask] += f * (avg - p)[mask]
        d, j = ref_tree.query(p)
        bad = d > cap
        if bad.any():
            near = ref_tree.data[j[bad]]
            v = p[bad] - near
            n = np.hypot(*v.T)[:, None]
            p[bad] = near + v / n * cap
    return p


# ---------------------------------------------------------------- bezier fit
def _bez(c, t):
    mt = 1 - t
    return (mt**3)[:, None]*c[0] + (3*mt**2*t)[:, None]*c[1] + \
           (3*mt*t**2)[:, None]*c[2] + (t**3)[:, None]*c[3]


def _chord(pts):
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    return d / d[-1] if d[-1] > 0 else d


def _fit_one(pts, t, t1, t2):
    A = np.empty((len(pts), 2, 2))
    mt = 1 - t
    A[:, 0] = t1 * (3 * mt**2 * t)[:, None]
    A[:, 1] = t2 * (3 * mt * t**2)[:, None]
    p0, p3 = pts[0], pts[-1]
    base = (mt**3)[:, None]*p0 + (t**3)[:, None]*p3 + \
           (3*mt**2*t)[:, None]*p0 + (3*mt*t**2)[:, None]*p3
    r = pts - base
    C = np.array([[np.sum(A[:, 0]*A[:, 0]), np.sum(A[:, 0]*A[:, 1])],
                  [np.sum(A[:, 0]*A[:, 1]), np.sum(A[:, 1]*A[:, 1])]])
    X = np.array([np.sum(A[:, 0]*r), np.sum(A[:, 1]*r)])
    det = C[0, 0]*C[1, 1] - C[0, 1]*C[1, 0]
    seg = np.hypot(*(p3 - p0))
    if abs(det) < 1e-12:
        a1 = a2 = seg / 3.0
    else:
        a1 = (X[0]*C[1, 1] - C[0, 1]*X[1]) / det
        a2 = (C[0, 0]*X[1] - X[0]*C[1, 0]) / det
        if a1 < 1e-6 or a2 < 1e-6:
            a1 = a2 = seg / 3.0
    return np.array([p0, p0 + t1*a1, p3 + t2*a2, p3])


def _reparam(pts, c, t):
    d = _bez(c, t) - pts
    q1 = 3*((1-t)**2)[:, None]*(c[1]-c[0]) + 6*((1-t)*t)[:, None]*(c[2]-c[1]) + \
         3*(t**2)[:, None]*(c[3]-c[2])
    q2 = 6*(1-t)[:, None]*(c[2]-2*c[1]+c[0]) + 6*t[:, None]*(c[3]-2*c[2]+c[1])
    num = (d*q1).sum(1)
    den = (q1*q1).sum(1) + (d*q2).sum(1)
    tt = np.where(np.abs(den) < 1e-12, t, t - num/den)
    return np.clip(tt, 0, 1)


def fit_cubic(pts, t1, t2, err=FIT_ERR, depth=0):
    if len(pts) < 3:
        seg = np.hypot(*(pts[-1] - pts[0])) / 3.0
        return [np.array([pts[0], pts[0]+t1*seg, pts[-1]+t2*seg, pts[-1]])]
    t = _chord(pts)
    c = _fit_one(pts, t, t1, t2)
    for _ in range(24):
        e = np.hypot(*(_bez(c, t) - pts).T)
        if e.max() <= err:
            return [c]
        t = _reparam(pts, c, t)
        c = _fit_one(pts, t, t1, t2)
    e = np.hypot(*(_bez(c, t) - pts).T)
    if e.max() <= err or depth > 24:
        return [c]
    split = int(np.argmax(e))
    split = min(max(split, 2), len(pts) - 3)
    tm = pts[split+1] - pts[split-1]
    n = np.hypot(*tm)
    tm = tm / (n if n else 1)
    return fit_cubic(pts[:split+1], t1, -tm, err, depth+1) + \
           fit_cubic(pts[split:], tm, t2, err, depth+1)


def unit(v):
    n = np.hypot(*v)
    return v / (n if n else 1.0)


def contour_to_beziers(p, pin):
    n = len(p)
    if len(pin) == 0:
        pin = np.array([0, n // 3, 2 * n // 3])
    pin = np.array(sorted(set(int(i) % n for i in pin)))
    out = []
    for a, b in zip(pin, np.roll(pin, -1)):
        idx = np.arange(a, b if b > a else b + n) % n
        sub = p[np.concatenate([idx, [b]])]
        # tangents: at pinned ends use the local chord of the sub-arc (corner => sharp)
        t1 = unit(sub[min(2, len(sub)-1)] - sub[0])
        t2 = unit(sub[max(-3, -len(sub))] - sub[-1])
        out.extend(fit_cubic(sub, t1, t2))
    return out


def beziers_to_d(curves, off, scale=None):
    if scale is None:
        scale = SCALE
    ox, oy = off
    def P(pt):
        return f"{round((ox + pt[0]) * scale, 3):g} {round((oy + pt[1]) * scale, 3):g}"
    parts = []
    for i, c in enumerate(curves):
        if i == 0:
            parts.append("M" + P(c[0]))
        parts.append("C" + P(c[1]) + " " + P(c[2]) + " " + P(c[3]))
    parts.append("Z")
    return "".join(parts)


# ---------------------------------------------------------------- main
def run(name):
    field, off = coverage(name)
    subpaths, stats = [], []
    for raw in contours_of(field):
        p0 = resample(raw)
        tree = cKDTree(resample(raw, STEP / 3))
        pin = corners(p0)
        p = taubin(p0, pin, tree)
        d, _ = tree.query(p)
        stats.append((len(p), len(pin), float(d.max())))
        subpaths.append(beziers_to_d(contour_to_beziers(p, pin), off))
    d = "".join(subpaths)
    json.dump({"name": name, "d": d, "stats": stats},
              open(f"layer_{name}.json", "w"))
    tot = sum(s[0] for s in stats)
    print(f"{name}: {len(stats)} contours, {tot} pts, "
          f"corners={sum(s[1] for s in stats)}, "
          f"max_dev={max((s[2] for s in stats), default=0):.3f}px, "
          f"d={len(d)} chars")


if __name__ == "__main__":
    run(sys.argv[1])
