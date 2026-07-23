"""Self-intersection removal for closed cubic-bezier subpaths.

A closed subpath that crosses itself can make boolean, CAD, and plotter
operations ambiguous even when a fill-rule renderer looks correct. This module
splits a crossing subpath into two lobes, keeps the larger by area, discards the
smaller, and re-closes at the exact crossing point. Cubics are subdivided with
De Casteljau and are never re-fitted.

The parser intentionally supports absolute M/C/Z path data only. Callers must
validate the grammar and confirm that geometry was parsed before trusting a
negative intersection result.
"""
import re
import numpy as np

NUM_TEXT = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?'
TOKEN = re.compile(rf'[MCZ]|{NUM_TEXT}')


def _tokenize(d):
    """Return command/number tokens, or None when any input is unparsed."""
    tokens, end = [], 0
    for match in TOKEN.finditer(d):
        if d[end:match.start()].strip(' \t\r\n,'):
            return None
        tokens.append(match.group())
        end = match.end()
    if d[end:].strip(' \t\r\n,'):
        return None
    return tokens


def _parse_tokens(d):
    """Parse the exact absolute M (C+ ) Z grammar emitted by the pipeline."""
    tokens = _tokenize(d)
    if not tokens:
        return None
    subs, i = [], 0
    try:
        while i < len(tokens):
            if tokens[i] != 'M':
                return None
            cur = np.array([float(tokens[i + 1]), float(tokens[i + 2])])
            if not np.isfinite(cur).all():
                return None
            curves, i = [], i + 3
            while i < len(tokens) and tokens[i] == 'C':
                values = [float(value) for value in tokens[i + 1:i + 7]]
                if len(values) != 6:
                    return None
                c1 = np.array(values[:2])
                c2 = np.array(values[2:4])
                end = np.array(values[4:6])
                if not all(np.isfinite(points).all() for points in (c1, c2, end)):
                    return None
                curves.append((cur, c1, c2, end))
                cur, i = end, i + 7
            if not curves or i >= len(tokens) or tokens[i] != 'Z':
                return None
            subs.append(curves)
            i += 1
    except (IndexError, ValueError):
        return None
    return subs


def parse_subpaths(d):
    """Absolute M/C/Z only. Returns list of subpaths, each a list of
    (p0, c1, c2, p3) cubic tuples. Reads nothing from relative/quadratic data."""
    return _parse_tokens(d) or []


def parse_is_trustworthy(d):
    """True only if the input is absolute M/C/Z AND parsed to real geometry.
    Guards against the silent-no-op failure on relative/quadratic input."""
    return _parse_tokens(d) is not None


def emit_subpath(curves):
    def P(p): return f"{p[0]:g} {p[1]:g}"
    out = ["M" + P(curves[0][0])]
    for _, c1, c2, e in curves:
        out.append("C" + P(c1) + " " + P(c2) + " " + P(e))
    return "".join(out) + "Z"


def _bez(c, t):
    p0, c1, c2, p3 = c; mt = 1 - t
    return mt**3*p0 + 3*mt**2*t*c1 + 3*mt*t**2*c2 + t**3*p3


def _split(c, t):
    p0, p1, p2, p3 = c
    a = p0 + (p1-p0)*t; b = p1 + (p2-p1)*t; cc = p2 + (p3-p2)*t
    d = a + (b-a)*t; e = b + (cc-b)*t; f = d + (e-d)*t
    return (p0, a, d, f), (f, e, cc, p3)


def _flatten(curves, dens=60):
    pts, prov = [], []; ts = np.linspace(0, 1, dens, endpoint=False)
    for bi, c in enumerate(curves):
        for t in ts:
            pts.append(_bez(c, t)); prov.append((bi, t))
    return np.array(pts), prov


def _find_intersection(curves, dens=60):
    P, prov = _flatten(curves, dens); n = len(P); A = P; B = np.roll(P, -1, axis=0)
    for i in range(n):
        p, r = A[i], B[i]-A[i]; q, s = A, (B-A)
        rxs = r[0]*s[:, 1] - r[1]*s[:, 0]; qp = q-p
        with np.errstate(divide='ignore', invalid='ignore'):
            t = np.where(np.abs(rxs) > 1e-12, (qp[:, 0]*s[:, 1]-qp[:, 1]*s[:, 0])/rxs, np.nan)
            u = np.where(np.abs(rxs) > 1e-12, (qp[:, 0]*r[1]-qp[:, 1]*r[0])/rxs, np.nan)
        ok = (t > 1e-6) & (t < 1-1e-6) & (u > 1e-6) & (u < 1-1e-6)
        ok[i] = ok[(i-1) % n] = ok[(i+1) % n] = False
        js = np.where(ok)[0]; js = js[js > i]
        if len(js):
            j = int(js[0]); return prov[i], prov[j], p + t[j]*r
    return None


def _arc(curves, bi0, t0, bi1, t1, xp):
    _, right = _split(curves[bi0], t0); right = (xp, right[1], right[2], right[3])
    if bi0 == bi1:
        tt = (t1-t0)/(1-t0); left, _ = _split(right, tt); return [(xp, left[1], left[2], xp)]
    out = [right]; bi = (bi0+1) % len(curves)
    while bi != bi1:
        out.append(curves[bi]); bi = (bi+1) % len(curves)
    left, _ = _split(curves[bi1], t1); out.append((left[0], left[1], left[2], xp)); return out


def _area(curves):
    P = np.array([c[0] for c in curves] + [_bez(c, 0.5) for c in curves])
    x, y = P[:, 0], P[:, 1]; return 0.5*abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def deloop_subpath(curves, dens=60, max_passes=8):
    removed = []
    for _ in range(max_passes):
        hit = _find_intersection(curves, dens)
        if hit is None:
            break
        (bi0, t0), (bi1, t1), xp = hit
        lobeA = _arc(curves, bi0, t0, bi1, t1, xp)
        lobeB = _arc(curves, bi1, t1, bi0, t0, xp)
        aA, aB = _area(lobeA), _area(lobeB)
        keep = lobeA if aA >= aB else lobeB
        removed.append(min(aA, aB)); curves = keep
        if len(curves) < 2:
            break
    return curves, removed


def has_self_intersection(d, dens=60):
    for sub in parse_subpaths(d):
        if len(sub) >= 2 and _find_intersection(sub, dens) is not None:
            return True
    return False


def intersection_diagnostics(d, dens=60):
    """Return JSON-safe details for the first detected crossing."""
    subs = _parse_tokens(d)
    if subs is None:
        return {
            "valid_contract": False,
            "path_chars": len(d),
            "subpaths": 0,
            "cubics": 0,
            "has_self_intersection": None,
        }
    total = sum(len(sub) for sub in subs)
    base = {
        "valid_contract": True,
        "path_chars": len(d),
        "subpaths": len(subs),
        "cubics": total,
        "density": dens,
    }
    for si, sub in enumerate(subs):
        if len(sub) < 2:
            continue
        hit = _find_intersection(sub, dens)
        if hit is None:
            continue
        (bi0, t0), (bi1, t1), point = hit
        return {
            **base,
            "has_self_intersection": True,
            "subpath": si,
            "subpath_cubics": len(sub),
            "curve_a": bi0,
            "curve_b": bi1,
            "t_a": round(float(t0), 6),
            "t_b": round(float(t1), 6),
            "point": [round(float(point[0]), 4), round(float(point[1]), 4)],
        }
    return {**base, "has_self_intersection": False}


def deloop(d, dens=60):
    """De-loop every subpath of an absolute-M/C/Z `d` string. -> (new_d, report)."""
    out, report = [], []
    chunks = re.findall(r'M[^M]*', d)
    for si, chunk in enumerate(chunks):
        parsed = parse_subpaths(chunk)
        sub = parsed[0] if parsed else []
        if len(sub) < 2:
            out.append(chunk)
            continue
        if _find_intersection(sub, dens) is None:
            out.append(chunk)
            continue
        fixed, removed = deloop_subpath(sub, dens)
        if removed:
            report.append((si, [round(a, 4) for a in removed]))
            out.append(emit_subpath(fixed))
        else:
            out.append(chunk)
    return "".join(out), report
