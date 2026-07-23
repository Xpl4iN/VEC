"""Turn a segmented polyline into exact primitives + fitted transitions.

Straight runs become genuinely straight cubics, circular runs become exact
circular arcs (<=90 deg per cubic, max radial error ~2.7e-4 * r), and the
free spans in between are bezier-fitted with tangents clamped to the
neighbouring primitives, so every junction is G1 continuous.
"""
import numpy as np
import pipeline as P

MAXSWEEP = np.pi / 2
MIN_TRANS = 10.0   # min transition length between two primitives, source px


def _line_curve(a, b):
    u = b - a
    return [np.array([a, a + u / 3.0, b - u / 3.0, b])]


def _arc_curves(ctr, r, a0, a1):
    sweep = a1 - a0
    k = max(1, int(np.ceil(abs(sweep) / MAXSWEEP)))
    out, step = [], sweep / k
    kappa = 4.0 / 3.0 * np.tan(step / 4.0)
    for i in range(k):
        t0 = a0 + i * step
        t1 = t0 + step
        p0 = ctr + r * np.array([np.cos(t0), np.sin(t0)])
        p1 = ctr + r * np.array([np.cos(t1), np.sin(t1)])
        d0 = r * np.array([-np.sin(t0), np.cos(t0)])
        d1 = r * np.array([-np.sin(t1), np.cos(t1)])
        out.append(np.array([p0, p0 + kappa * d0, p1 - kappa * d1, p1]))
    return out


def _prim_geom(kind, par, q, i, j):
    """-> (start, end, tangent_at_start, tangent_at_end, curves)"""
    if kind == "L":
        c, d = par
        a = c + np.dot(q[i] - c, d) * d
        b = c + np.dot(q[j] - c, d) * d
        u = P.unit(b - a)
        return a, b, u, u, _line_curve(a, b)
    ctr, r = par
    a0 = np.arctan2(*(q[i] - ctr)[::-1])
    a1 = np.arctan2(*(q[j] - ctr)[::-1])
    am = np.arctan2(*(q[(i + j) // 2] - ctr)[::-1])
    # unwrap so the arc passes through the midpoint sample
    while a1 - a0 > np.pi:
        a1 -= 2 * np.pi
    while a0 - a1 > np.pi:
        a1 += 2 * np.pi
    mid = 0.5 * (a0 + a1)
    if abs(np.angle(np.exp(1j * (am - mid)))) > np.pi / 2:
        a1 += 2 * np.pi * (1 if a1 < a0 else -1)
    sgn = 1.0 if a1 > a0 else -1.0
    a = ctr + r * np.array([np.cos(a0), np.sin(a0)])
    b = ctr + r * np.array([np.cos(a1), np.sin(a1)])
    t0 = sgn * np.array([-np.sin(a0), np.cos(a0)])
    t1 = sgn * np.array([-np.sin(a1), np.cos(a1)])
    return a, b, t0, t1, _arc_curves(ctr, r, a0, a1)


def _space_out(prims, q, step):
    """Trim neighbouring primitives back so every junction has a transition span
    of at least MIN_TRANS.  Trimming a line/arc keeps its exact geometry - only
    its endpoints move along it - so nothing is lost, and the transition can
    then be fitted tangent to both sides (no perpendicular connector stubs)."""
    need = max(4, int(round(MIN_TRANS / step)))
    prims = [list(p) for p in prims]
    for k in range(len(prims) - 1):
        a, b = prims[k], prims[k + 1]
        gap = b[1] - a[2]
        if gap >= need:
            continue
        short = need - gap
        room_a = int((a[2] - a[1]) * 0.4)
        room_b = int((b[2] - b[1]) * 0.4)
        ta = min(short // 2 + short % 2, room_a)
        tb = min(short - ta, room_b)
        a[2] -= ta
        b[1] += tb
    return [tuple(p) for p in prims if p[2] - p[1] > 3]


def to_curves(q, prims, fit_err=0.05, step=None):
    """q: dense polyline for one open arc; prims: list of (kind,i,j,par)."""
    n = len(q)
    if not prims:
        return P.fit_cubic(q, P.unit(q[1]-q[0]), P.unit(q[-2]-q[-1]), err=fit_err)
    if step is None:
        step = float(np.hypot(*(q[1] - q[0])))
    prims = _space_out(prims, q, step)
    if not prims:
        return P.fit_cubic(q, P.unit(q[1]-q[0]), P.unit(q[-2]-q[-1]), err=fit_err)
    geoms = [(_prim_geom(k, par, q, i, j), i, j) for k, i, j, par in prims]
    curves = []
    prev_end, prev_tan, cursor = None, None, 0
    for (a, b, t0, t1, cs), i, j in geoms:
        # transition span before this primitive
        gap = q[cursor:i + 1].copy()
        pts = [a] if len(gap) == 0 else list(gap)
        pts[-1] = a
        if prev_end is not None:
            pts[0] = prev_end
        pts = np.array(pts)
        if len(pts) >= 3 and np.hypot(*(pts[-1] - pts[0])) > 1e-9:
            t_in = prev_tan if prev_tan is not None else P.unit(pts[1] - pts[0])
            curves += P.fit_cubic(pts, t_in, -t0, err=max(fit_err, 0.15), depth=14)
        elif prev_end is not None and np.hypot(*(a - prev_end)) > 1e-9:
            curves += _line_curve(prev_end, a)
        curves += cs
        prev_end, prev_tan, cursor = b, t1, j
    # tail after the last primitive
    tail = q[cursor:].copy()
    if len(tail) >= 3:
        tail[0] = prev_end
        if np.hypot(*(tail[-1] - tail[0])) > 1e-9:
            curves += P.fit_cubic(tail, prev_tan, P.unit(tail[-2] - tail[-1]),
                                  err=max(fit_err, 0.15), depth=14)
    elif np.hypot(*(q[-1] - prev_end)) > 1e-9:
        curves += _line_curve(prev_end, q[-1])
    return curves
