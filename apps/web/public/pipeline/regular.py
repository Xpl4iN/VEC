"""Greedy line/arc segmentation with a GLOBAL residual test.

Walks the polyline and grows a straight (or circular) run as long as a single
total-least-squares line / algebraic circle fits every point of the run within
`tol`.  Accepted runs are projected exactly onto their primitive, with a short
cosine blend at both ends so the curve stays C0/C1-ish continuous.
"""
import numpy as np

MIN_LINE = 25.0    # min length of a straight run, source px
MIN_ARC = 40.0     # min length of a circular run, source px
BLEND = 3.0        # blend length at each end, source px


def tls_line(p):
    c = p.mean(0)
    _, _, vt = np.linalg.svd(p - c, full_matrices=False)
    d = vt[0] / np.hypot(*vt[0])
    n = np.array([-d[1], d[0]])
    return c, d, np.abs((p - c) @ n).max()


def fit_circle(p):
    x, y = p[:, 0], p[:, 1]
    A = np.column_stack([x, y, np.ones(len(x))])
    sol, *_ = np.linalg.lstsq(A, x**2 + y**2, rcond=None)
    ctr = np.array([sol[0] / 2, sol[1] / 2])
    r2 = sol[2] + ctr @ ctr
    if r2 <= 0:
        return ctr, 0.0, 1e9
    r = np.sqrt(r2)
    return ctr, r, np.abs(np.hypot(*(p - ctr).T) - r).max()


def segment(q, step, tol, allow_arcs, max_radius=4000.0):
    """-> list of (i, j, kind, params) covering disjoint index ranges."""
    n = len(q)
    grow = max(1, int(round(2.0 / step)))       # try to extend 2px at a time
    prims, i = [], 0
    while i < n - 3:
        best = None
        # --- straight run
        j = min(n - 1, i + int(MIN_LINE / step))
        while j < n:
            c, d, e = tls_line(q[i:j + 1])
            if e > tol:
                break
            best = ("L", i, j, (c, d))
            j += grow
        # --- circular run (only if it beats the line)
        if allow_arcs:
            j = min(n - 1, i + int(MIN_ARC / step))
            while j < n:
                ctr, r, e = fit_circle(q[i:j + 1])
                if e > tol or r > max_radius or r < 3:
                    break
                if best is None or (j - best[2]) > 0:
                    best = ("A", i, j, (ctr, r))
                j += grow
        if best is None:
            i += 1
            continue
        prims.append(best)
        i = best[2] + 1
    return prims


def apply(q, prims, step, blend=BLEND):
    out = q.copy()
    k = max(2, int(round(blend / step)))
    for kind, i, j, par in prims:
        seg = q[i:j + 1]
        if kind == "L":
            c, d = par
            tgt = c + np.outer((seg - c) @ d, d)
        else:
            ctr, r = par
            v = seg - ctr
            nn = np.hypot(*v.T)[:, None]
            nn[nn == 0] = 1
            tgt = ctr + v / nn * r
        m = len(seg)
        w = np.ones(m)
        kk = min(k, m // 3)
        if kk > 0:
            ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, kk + 2)[1:-1])
            w[:kk] = ramp
            w[-kk:] = ramp[::-1]
        out[i:j + 1] = seg * (1 - w[:, None]) + tgt * w[:, None]
    return out


def regularize(q, step, tol, allow_arcs):
    if len(q) < 40:
        return q, []
    prims = segment(q, step, tol, allow_arcs)
    return apply(q, prims, step), prims
