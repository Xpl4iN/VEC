"""Enforce G1 (tangent) continuity at every junction of a closed bezier chain.

Independent line and arc fits meet at slightly different tangent angles, which
reads as a visible kink or flat spot.  This rotates the handles either side of
each junction so they become exactly collinear.  Straight segments win the
argument: if one side is a true straight line, the curved side adopts the
line's direction, so exact straightness is never destroyed.
"""
import json, sys
import numpy as np
from orient import parse, emit

STRAIGHT_TOL = 1e-3


def is_straight(c):
    p0, c1, c2, p3 = c
    d = p3 - p0
    n = np.hypot(*d)
    if n < 1e-12:
        return False
    u = np.array([-d[1], d[0]]) / n
    return abs((c1 - p0) @ u) < STRAIGHT_TOL and abs((c2 - p0) @ u) < STRAIGHT_TOL


def _rot_to(p_anchor, p_handle, direction):
    """Move handle so it lies along `direction` from the anchor, same length."""
    L = np.hypot(*(p_handle - p_anchor))
    return p_anchor + direction * L


def drop_tiny(cs, min_len=6.0):
    """Remove degenerate micro-segments (they carry meaningless tangents and
    show up as visible jogs).  Neighbours are joined at the midpoint."""
    cs = [c.astype(float).copy() for c in cs]
    changed = True
    while changed and len(cs) > 3:
        changed = False
        for i in range(len(cs)):
            c = cs[i]
            if np.hypot(*(c[3] - c[0])) >= min_len:
                continue
            m = 0.5 * (c[0] + c[3])
            p, nx = cs[i - 1], cs[(i + 1) % len(cs)]
            p[2] += m - p[3]; p[3] = m
            nx[1] += m - nx[0]; nx[0] = m
            cs.pop(i)
            changed = True
            break
    return cs


def enforce(curves, corner_idx=(), tol_deg=0.05):
    """curves: list of 4x2 arrays forming a closed loop."""
    n = len(curves)
    if n < 2:
        return curves, 0.0
    cs = [c.astype(float).copy() for c in curves]
    flags = [is_straight(c) for c in cs]
    worst_before = worst_after = 0.0
    for i in range(n):
        j = (i + 1) % n
        if j in corner_idx:
            continue
        a, b = cs[i], cs[j]
        t_in = a[3] - a[2]
        t_out = b[1] - b[0]
        na, nb = np.hypot(*t_in), np.hypot(*t_out)
        if na < 1e-12 or nb < 1e-12:
            continue
        t_in, t_out = t_in / na, t_out / nb
        ang = np.degrees(np.arccos(np.clip(t_in @ t_out, -1, 1)))
        worst_before = max(worst_before, ang)
        if ang < tol_deg or ang > 60.0:      # >60 deg = a real corner, leave it
            worst_after = max(worst_after, ang if ang > 60 else 0.0)
            continue
        # rotate the side that moves least: a straight run always wins, then the
        # shorter handle (rotating a long handle would visibly distort the curve)
        if flags[i] and not flags[j]:
            d, move_i, move_j = t_in, False, True
        elif flags[j] and not flags[i]:
            d, move_i, move_j = t_out, True, False
        elif na > 2 * nb:
            d, move_i, move_j = t_in, False, True
        elif nb > 2 * na:
            d, move_i, move_j = t_out, True, False
        else:
            d = t_in + t_out
            d = d / np.hypot(*d)
            move_i = move_j = True
        if move_i and not flags[i]:
            cs[i][2] = _rot_to(a[3], a[2], -d)
        if move_j and not flags[j]:
            cs[j][1] = _rot_to(b[0], b[1], d)
    for i in range(n):
        j = (i + 1) % n
        if j in corner_idx:
            continue
        t_in = cs[i][3] - cs[i][2]
        t_out = cs[j][1] - cs[j][0]
        na, nb = np.hypot(*t_in), np.hypot(*t_out)
        if na < 1e-12 or nb < 1e-12:
            continue
        ang = np.degrees(np.arccos(np.clip((t_in/na) @ (t_out/nb), -1, 1)))
        if ang < 60:
            worst_after = max(worst_after, ang)
    return cs, (worst_before, worst_after)


def process_layer(name):
    f = f"layer_{name}.json"
    j = json.load(open(f))
    out, wb, wa = [], 0.0, 0.0
    for sub in parse(j["d"]):
        cs = drop_tiny([np.array(c, float) for c in sub])
        cs, (b, a) = enforce(cs)
        wb, wa = max(wb, b), max(wa, a)
        out.append(emit([tuple(c) for c in cs]))
    j["d"] = "".join(out)
    j["nodes"] = sum(len(parse(j["d"])[k]) for k in range(len(parse(j["d"]))))
    json.dump(j, open(f, "w"))
    print(f"{name}: worst kink {wb:.2f} deg -> {wa:.2f} deg")


if __name__ == "__main__":
    for a in sys.argv[1:]:
        process_layer(a)
