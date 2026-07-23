"""Stage 3: geometric regularization on top of the smoothing spline.

Long low-curvature runs are snapped onto exact straight lines (total least
squares) and long constant-curvature runs onto exact circular arcs, with a
short blended transition at each junction so the curve stays continuous.
That removes wobble that the spline faithfully preserves, because a wobbly
straight edge is a defect of the source raster, not a feature of the artwork.
"""
import sys, json
import numpy as np
from scipy.spatial import cKDTree
import pipeline as P
import smooth2 as S
import regular as R
import emit as E

# Per-layer fidelity settings are injected by the caller at runtime.
# Tuple shape: (cap, line tolerance, allow arcs, minimum line, minimum arc).
CFG = {}
MIN_RUN = 14.0     # min run length (source px) to regularize
BLEND = 2.5        # transition length (source px) at each junction
FIT_ERR = 0.05


def _tls_line(pts):
    c = pts.mean(0)
    u, s, vt = np.linalg.svd(pts - c, full_matrices=False)
    d = vt[0]
    return c, d / np.hypot(*d)


def _proj_line(pts, c, d):
    return c + np.outer((pts - c) @ d, d)


def _fit_circle(pts):
    """Pratt/Kasa algebraic circle fit."""
    x, y = pts[:, 0], pts[:, 1]
    A = np.column_stack([x, y, np.ones(len(x))])
    b = x**2 + y**2
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0]/2, sol[1]/2
    r = np.sqrt(max(sol[2] + cx**2 + cy**2, 1e-9))
    return np.array([cx, cy]), r


def _proj_circle(pts, ctr, r):
    v = pts - ctr
    n = np.hypot(*v.T)[:, None]
    n[n == 0] = 1
    return ctr + v / n * r


def _runs(flag, step, min_len):
    """maximal True runs of at least min_len arclength (open polyline)."""
    out, i, n = [], 0, len(flag)
    while i < n:
        if flag[i]:
            j = i
            while j + 1 < n and flag[j + 1]:
                j += 1
            if (j - i) * step >= min_len:
                out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def regularize(q, line_tol, allow_arcs, step):
    """q: dense smoothed polyline (open arc). Returns regularized copy."""
    n = len(q)
    w = max(6, int(round(12.0 / step)))       # 12px analysis window
    if n < 2 * w + 4:
        return q
    is_line = np.zeros(n, bool)
    is_arc = np.zeros(n, bool)
    rad = np.full(n, np.inf)
    for i in range(n):
        a, b = max(0, i - w // 2), min(n, i + w // 2 + 1)
        seg = q[a:b]
        if len(seg) < 5:
            continue
        c, d = _tls_line(seg)
        res = np.abs((seg - c) @ np.array([-d[1], d[0]]))
        if res.max() < line_tol:
            is_line[i] = True
        elif allow_arcs:
            ctr, r = _fit_circle(seg)
            if r < 5000:
                e = np.abs(np.hypot(*(seg - ctr).T) - r)
                if e.max() < line_tol:
                    is_arc[i] = True
                    rad[i] = r
    out = q.copy()
    weight = np.zeros(n)
    blend = max(2, int(round(BLEND / step)))
    for (i, j), kind in ([(r, "L") for r in _runs(is_line, step, MIN_RUN)] +
                         [(r, "A") for r in _runs(is_arc & ~is_line, step, MIN_RUN)]):
        seg = q[i:j+1]
        if kind == "L":
            c, d = _tls_line(seg)
            tgt = _proj_line(seg, c, d)
        else:
            ctr, r = _fit_circle(seg)
            tgt = _proj_circle(seg, ctr, r)
        m = len(seg)
        wgt = np.ones(m)
        k = min(blend, m // 2)
        if k > 0:
            ramp = np.linspace(0, 1, k + 2)[1:-1]
            wgt[:k] = ramp
            wgt[-k:] = ramp[::-1]
        keep = wgt > weight[i:j+1]
        out[i:j+1][keep] = (q[i:j+1] * (1 - wgt[:, None]) + tgt * wgt[:, None])[keep]
        weight[i:j+1] = np.maximum(weight[i:j+1], wgt)
    return out


def close_loop(curves):
    """Snap the seam of a closed contour shut (primitive snapping can leave a
    sub-pixel gap where the loop wraps).  Both ends move to their midpoint and
    the neighbouring control points follow, so tangents are preserved."""
    if not curves:
        return curves
    a, b = curves[0][0], curves[-1][3]
    gap = np.hypot(*(b - a))
    if gap < 1e-9:
        return curves
    mid = 0.5 * (a + b)
    d0, d1 = mid - a, mid - b
    curves[0] = np.array([mid, curves[0][1] + d0, curves[0][2], curves[0][3]])
    curves[-1] = np.array([curves[-1][0], curves[-1][1], curves[-1][2] + d1, mid])
    return curves


def process(name):
    cap, tol, arcs_on, min_line, min_arc = CFG[name]
    field, off = P.coverage(name)
    subpaths, stats, nprim = [], [], 0
    for raw in P.contours_of(field):
        tree = cKDTree(P.resample(raw, P.STEP / 3))
        p0 = P.resample(raw)
        pin = P.corners(p0)
        n = len(p0)
        arcs, curves = [], []
        if len(pin) == 0:
            q = S.smooth_arc(p0, True, cap=cap, tree=tree)
            m = len(q); cuts = [0, m // 3, 2 * m // 3, m - 1]
            arcs = [q[a:b + 1] for a, b in zip(cuts, cuts[1:])]
        else:
            pins = sorted(int(i) % n for i in set(pin.tolist()))
            for a, b in zip(pins, np.roll(pins, -1)):
                idx = np.arange(a, b if b > a else b + n) % n
                arcs.append(S.smooth_arc(p0[np.concatenate([idx, [b]])], False,
                                         cap=cap, tree=tree))
        for q in arcs:
            if len(q) < 4:
                continue
            step = float(np.hypot(*(q[1] - q[0])))
            if tol is not None:
                R.MIN_LINE, R.MIN_ARC = min_line, (min_arc or 1e9)
                prims = R.segment(q, step, tol, arcs_on)
                nprim += len(prims)
                curves += E.to_curves(q, prims, fit_err=FIT_ERR, step=step)
            else:
                curves += P.fit_cubic(q, P.unit(q[1] - q[0]),
                                      P.unit(q[-2] - q[-1]), err=FIT_ERR)
        curves = close_loop(curves)
        samp = np.vstack([P._bez(c, np.linspace(0, 1, 40)) for c in curves])
        d, _ = tree.query(samp)
        stats.append((len(curves), len(pin), float(d.max())))
        subpaths.append(P.beziers_to_d(curves, off))
    d = "".join(subpaths)
    json.dump({"name": name, "d": d, "stats": stats}, open(f"layer_{name}.json", "w"))
    print(f"{name}: contours={len(stats)} nodes={sum(s[0] for s in stats)} "
          f"corners={sum(s[1] for s in stats)} primitives={nprim} "
          f"maxdev={max((s[2] for s in stats), default=0):.2f}px chars={len(d)}")


if __name__ == "__main__":
    for a in sys.argv[1:]:
        process(a)
