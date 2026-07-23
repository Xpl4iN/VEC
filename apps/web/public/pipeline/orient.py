"""Normalise subpath winding: outer contours CCW, holes CW.

With correct winding the artwork fills identically under both the nonzero and
even-odd rules, so it survives naive consumers (cutting plotters, CNC, older
renderers) that ignore fill-rule.
"""
import json, re
import numpy as np
from matplotlib.path import Path

NUM = re.compile(r'-?\d*\.?\d+(?:[eE]-?\d+)?')


def parse(d):
    subs = []
    for s in re.findall(r'M[^M]*', d):
        v = [float(x) for x in NUM.findall(s)]
        start = np.array(v[:2]); pts = v[2:]
        curves, cur = [], start
        for i in range(0, len(pts) - 5, 6):
            c1 = np.array(pts[i:i+2]); c2 = np.array(pts[i+2:i+4]); e = np.array(pts[i+4:i+6])
            curves.append((cur, c1, c2, e)); cur = e
        subs.append(curves)
    return subs


def sample(curves, n=24):
    t = np.linspace(0, 1, n)[:, None]
    out = []
    for p0, c1, c2, p3 in curves:
        out.append((1-t)**3*p0 + 3*(1-t)**2*t*c1 + 3*(1-t)*t**2*c2 + t**3*p3)
    return np.vstack(out)


def area(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def emit(curves):
    def P(p):
        return f"{p[0]:g} {p[1]:g}"
    out = ["M" + P(curves[0][0])]
    for _, c1, c2, e in curves:
        out.append("C" + P(c1) + " " + P(c2) + " " + P(e))
    return "".join(out) + "Z"


def fix(d):
    subs = parse(d)
    polys = [sample(c) for c in subs]
    paths = [Path(p, closed=True) for p in polys]
    out = []
    for i, (c, p) in enumerate(zip(subs, polys)):
        depth = sum(1 for j, q in enumerate(paths)
                    if j != i and q.contains_point(p[0]))
        want_ccw = (depth % 2 == 0)
        # screen coords have y down: positive shoelace area == clockwise on screen
        is_ccw = area(p) < 0
        if is_ccw != want_ccw:
            c = [(e, c2, c1, p0) for p0, c1, c2, e in reversed(c)]
        out.append(emit(c))
    return "".join(out)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        f = f"layer_{name}.json"
        j = json.load(open(f))
        j["d"] = fix(j["d"])
        json.dump(j, open(f, "w"))
        print(name, "oriented", len(j["d"]), "chars")
