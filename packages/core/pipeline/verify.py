"""Verification: rasterize the delivered vector layers and diff them against the
source coverage fields.  Reports IoU and boundary deviation in source pixels."""
import json, re
import numpy as np
from scipy.ndimage import zoom, distance_transform_edt, binary_erosion
import matplotlib
matplotlib.use("Agg")
from matplotlib.path import Path
from matplotlib.transforms import Affine2D
import pipeline as P

K = 2  # raster oversampling (samples per source pixel)


def path_from_d(d):
    verts, codes = [], []
    for m in re.finditer(r'([MCZ])([^MCZ]*)', d):
        c = m.group(1)
        a = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?(?:e-?\d+)?', m.group(2))]
        if c == 'M':
            verts.append(a[:2]); codes.append(Path.MOVETO)
        elif c == 'C':
            for i in range(0, len(a), 6):
                verts += [a[i:i+2], a[i+2:i+4], a[i+4:i+6]]
                codes += [Path.CURVE4]*3
        else:
            verts.append([0, 0]); codes.append(Path.CLOSEPOLY)
    return Path(np.array(verts), codes)


def rasterize(path, shape, off, k=K):
    """shape: (h,w) in source px; off: layer offset in source coords."""
    h, w = shape
    hk, wk = h * k, w * k
    inside = np.zeros((hk, wk), dtype=bool)
    chunk_rows = 512
    for r in range(0, hk, chunk_rows):
        r_end = min(r + chunk_rows, hk)
        ys, xs = np.mgrid[r:r_end, 0:wk]
        pts = np.column_stack([(xs.ravel() + 0.5) / k + off[0],
                               (ys.ravel() + 0.5) / k + off[1]]) * getattr(P, "SCALE", 2.0)
        inside[r:r_end, :] = path.contains_points(pts).reshape(r_end - r, wk)
    return inside


rows = []
import sys
for name in sys.argv[1:]:
    field, off = P.coverage(name)
    d = json.load(open(f"layer_{name}.json"))["d"]
    got = np.zeros((field.shape[0]*K, field.shape[1]*K), bool)
    for sub in re.findall(r'M[^M]*', d):          # even-odd fill: XOR subpaths
        got ^= rasterize(path_from_d(sub), field.shape, off)
    ref = zoom(field.astype(np.float32), K, order=1) >= 0.5
    ref = ref[:got.shape[0], :got.shape[1]]
    inter = (got & ref).sum(); union = (got | ref).sum()
    iou = inter / union if union else 1.0
    # boundary deviation: distance from each mismatching pixel to the reference edge
    mism = got ^ ref
    if not mism.any():
        dev = np.array([0.0])
    else:
        edge = ~(ref ^ binary_erosion(ref))
        ys, xs = np.where(mism)
        pad = 64
        y0, y1 = max(0, int(ys.min()) - pad), min(ref.shape[0], int(ys.max()) + pad + 1)
        x0, x1 = max(0, int(xs.min()) - pad), min(ref.shape[1], int(xs.max()) + pad + 1)
        dt_sub = distance_transform_edt(edge[y0:y1, x0:x1], return_distances=True, return_indices=False)
        mism_sub = mism[y0:y1, x0:x1]
        dev = dt_sub[mism_sub] / K if mism_sub.any() else np.array([0.0])
    rows.append((name, iou, dev.mean(), np.percentile(dev, 99.9), dev.max(),
                 mism.sum() / union * 100 if union else 0))
    print(f"{name:7s} IoU={iou:.5f}  mean_dev={dev.mean():.3f}px  "
          f"p99.9={np.percentile(dev,99.9):.3f}px  max={dev.max():.3f}px  "
          f"mismatch={rows[-1][5]:.3f}% of area")

json.dump([[r[0]] + [float(x) for x in r[1:]] for r in rows], open("verify.json", "w"), indent=1)
