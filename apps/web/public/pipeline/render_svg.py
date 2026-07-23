"""Minimal but correct SVG renderer for the subset used here (M,L,H,V,C,Q,Z, abs+rel)."""
import re, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.path import Path
from matplotlib.patches import PathPatch

TOK = re.compile(r'([MmLlHhVvCcQqZz])|(-?\d*\.?\d+(?:[eE]-?\d+)?)')


def to_mpl(d):
    toks, i = [], 0
    for m in TOK.finditer(d):
        toks.append(m.group(1) or float(m.group(2)))
    verts, codes = [], []
    cur = np.zeros(2); start = np.zeros(2); cmd = None; i = 0
    while i < len(toks):
        if isinstance(toks[i], str):
            cmd = toks[i]; i += 1
            if cmd in "Zz":
                verts.append(start.copy()); codes.append(Path.CLOSEPOLY); cur = start.copy()
                continue
        rel = cmd.islower(); c = cmd.upper()
        def take(n):
            nonlocal i
            v = np.array(toks[i:i+n], float); i += n
            return v
        if c == "M":
            p = take(2); cur = cur + p if rel else p
            start = cur.copy(); verts.append(cur.copy()); codes.append(Path.MOVETO)
            cmd = "l" if rel else "L"
        elif c == "L":
            p = take(2); cur = cur + p if rel else p
            verts.append(cur.copy()); codes.append(Path.LINETO)
        elif c == "H":
            x = take(1)[0]; cur = np.array([cur[0]+x if rel else x, cur[1]])
            verts.append(cur.copy()); codes.append(Path.LINETO)
        elif c == "V":
            y = take(1)[0]; cur = np.array([cur[0], cur[1]+y if rel else y])
            verts.append(cur.copy()); codes.append(Path.LINETO)
        elif c == "C":
            a = take(6).reshape(3, 2)
            a = cur + a if rel else a
            verts += [a[0], a[1], a[2]]; codes += [Path.CURVE4]*3; cur = a[2].copy()
        elif c == "Q":
            a = take(4).reshape(2, 2)
            a = cur + a if rel else a
            verts += [a[0], a[1]]; codes += [Path.CURVE3]*2; cur = a[1].copy()
        else:
            raise ValueError(cmd)
    return Path(np.array(verts), codes)


def render(svg_file, out, px=900, bg="#cccccc"):
    svg = open(svg_file).read()
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    fig = plt.figure(figsize=(px/100, px/100*vb[3]/vb[2]), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.axis("off")
    ax.set_xlim(vb[0], vb[0]+vb[2]); ax.set_ylim(vb[1]+vb[3], vb[1])
    fig.patch.set_facecolor(bg)
    for m in re.finditer(r'<path\b[^>]*>', svg):
        tag = m.group(0)
        fill = re.search(r'fill="(#[0-9A-Fa-f]{6})"', tag)
        d = re.search(r'[\s"]d="([^"]+)"', tag).group(1)
        ax.add_patch(PathPatch(to_mpl(d), facecolor=fill.group(1) if fill else "#000000",
                               edgecolor="none"))
    fig.savefig(out, facecolor=bg)
    print("wrote", out)


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2], bg=sys.argv[3] if len(sys.argv) > 3 else "#cccccc")
