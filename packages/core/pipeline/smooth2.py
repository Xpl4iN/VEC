"""Stage 2: replace Taubin with penalized smoothing splines.

For each arc between detected corners (or the whole closed contour if none),
fit a parametric cubic smoothing spline and bisect the smoothing weight `s`
until the maximum deviation from the subpixel source contour is just under
CAP source pixels.  That yields the smoothest curve the fidelity budget
allows -- wobble below the cap is erased, real shape is kept.
"""
import sys, json
import numpy as np
from scipy.interpolate import splprep, splev
from scipy.spatial import cKDTree
import pipeline as P

CAP = 0.60      # max deviation from source contour, source px
FIT_ERR = 0.08  # bezier fit tolerance against the smoothed spline, source px
DENSE = 0.25    # dense sampling step of the spline for the bezier fit


def _spline(pts, s, closed):
    x, y = pts[:, 0], pts[:, 1]
    if closed:
        x = np.append(x, x[0]); y = np.append(y, y[0])
    w = np.hypot(np.diff(x), np.diff(y))
    u = np.concatenate([[0], np.cumsum(w)])
    if u[-1] == 0:
        raise ValueError
    u = u / u[-1]
    tck, _ = splprep([x, y], u=u, s=s, k=3, per=1 if closed else 0)
    return tck, u


def smooth_arc(pts, closed, cap=CAP, tree=None):
    """Return densely sampled smoothed points for one arc."""
    n = len(pts)
    if n < 8:
        return pts
    ref = tree if tree is not None else cKDTree(pts)

    def dev(s):
        try:
            tck, u = _spline(pts, s, closed)
        except Exception:
            return None, 1e9
        uu = np.linspace(0, 1, max(64, int(n * P.STEP / DENSE)))
        q = np.column_stack(splev(uu, tck))
        d, _ = ref.query(q)
        # endpoints of open arcs must not drift (corners are pinned)
        if not closed:
            q[0], q[-1] = pts[0], pts[-1]
        return q, float(d.max())

    lo, hi = 0.0, max(1e-6, n * (cap ** 2) * 0.25)
    q, d = dev(hi)
    while d < cap and hi < n * cap ** 2 * 400:
        lo, hi = hi, hi * 4
        q, d = dev(hi)
    best, _ = dev(lo)
    for _ in range(18):
        mid = 0.5 * (lo + hi)
        q, d = dev(mid)
        if d <= cap:
            lo, best = mid, q
        else:
            hi = mid
    return best if best is not None else pts


def process(name):
    field, off = P.coverage(name)
    subpaths, stats = [], []
    for raw in P.contours_of(field):
        fine = P.resample(raw, P.STEP / 3)
        tree = cKDTree(fine)
        p0 = P.resample(raw)
        pin = P.corners(p0)
        n = len(p0)
        curves = []
        if len(pin) == 0:
            q = smooth_arc(p0, True, tree=tree)
            t1 = P.unit(q[1] - q[0]); t2 = P.unit(q[-2] - q[-1])
            # split the closed smooth curve into 3 arcs for a stable fit
            m = len(q); cuts = [0, m // 3, 2 * m // 3, m - 1]
            for a, b in zip(cuts, cuts[1:]):
                sub = q[a:b + 1]
                curves += P.fit_cubic(sub, P.unit(sub[1] - sub[0]),
                                      P.unit(sub[-2] - sub[-1]), err=FIT_ERR)
        else:
            pin = sorted(int(i) % n for i in set(pin.tolist()))
            for a, b in zip(pin, np.roll(pin, -1)):
                idx = np.arange(a, b if b > a else b + n) % n
                sub = p0[np.concatenate([idx, [b]])]
                q = smooth_arc(sub, False, tree=tree)
                curves += P.fit_cubic(q, P.unit(q[1] - q[0]),
                                      P.unit(q[-2] - q[-1]), err=FIT_ERR)
        if len(curves) == 0:
            continue
        # fidelity of the final beziers
        samp = np.vstack([P._bez(c, np.linspace(0, 1, 40)) for c in curves])
        d, _ = tree.query(samp)
        stats.append((len(curves), len(pin), float(d.max())))
        subpaths.append(P.beziers_to_d(curves, off, getattr(P, "SCALE", 2.0)))
    d = "".join(subpaths)
    json.dump({"name": name, "d": d, "stats": stats}, open(f"layer_{name}.json", "w"))
    print(f"{name}: contours={len(stats)} nodes={sum(s[0] for s in stats)} "
          f"corners={sum(s[1] for s in stats)} "
          f"maxdev={max((s[2] for s in stats), default=0):.3f}px chars={len(d)}")


if __name__ == "__main__":
    process(sys.argv[1])
