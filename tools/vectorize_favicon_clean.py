"""Create a clean two-family SVG from the XyourP raster favicon.

This prototype deliberately interprets colour transitions as gradients inside
stable silhouettes. It does not promote antialiasing or AI texture colours to
independent vector layers.
"""
from pathlib import Path
import html

import numpy as np
import potrace
from PIL import Image
from scipy import ndimage
from skimage import measure, morphology


SOURCE = Path(r"C:\XyourP\xyourp-lp\public\XyourP Favicon.png")
OUTPUT = Path(__file__).resolve().parents[1] / "artifacts" / "xyourp-favicon-clean.svg"


def clean_mask(mask: np.ndarray) -> np.ndarray:
    mask = morphology.remove_small_objects(mask, min_size=180)
    mask = morphology.binary_closing(mask, morphology.disk(2))
    mask = morphology.binary_opening(mask, morphology.disk(1))
    labels, count = ndimage.label(mask)
    if count:
        sizes = np.bincount(labels.ravel())
        keep = sizes >= 180
        keep[0] = False
        mask = keep[labels]
    return mask


def clean_tone(mask: np.ndarray, min_size: int = 75, radius: int = 3) -> np.ndarray:
    """Regularize a tonal region without allowing isolated raster freckles."""
    mask = morphology.binary_closing(mask, morphology.disk(radius))
    mask = morphology.remove_small_objects(mask, min_size=min_size)
    mask = ndimage.binary_fill_holes(mask)
    return mask


def fmt(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def hybrid_closed_path(points: np.ndarray) -> str:
    """Use cubic segments on curves and literal line joins at real corners."""
    if len(points) < 4:
        return ""
    if np.hypot(*(points[0] - points[-1])) < 1e-6:
        points = points[:-1]
    hard = []
    for index in range(len(points)):
        before = points[index] - points[(index - 1) % len(points)]
        after = points[(index + 1) % len(points)] - points[index]
        before /= max(np.hypot(*before), 1e-9)
        after /= max(np.hypot(*after), 1e-9)
        turn = np.degrees(np.arccos(np.clip(np.dot(before, after), -1, 1)))
        hard.append(turn >= 28)
    commands = [f"M{fmt(points[0, 0])} {fmt(points[0, 1])}"]
    tension = 0.72
    for index in range(len(points)):
        p0 = points[(index - 1) % len(points)]
        p1 = points[index]
        p2 = points[(index + 1) % len(points)]
        p3 = points[(index + 2) % len(points)]
        if hard[index] or hard[(index + 1) % len(points)]:
            commands.append(f"L{fmt(p2[0])} {fmt(p2[1])}")
            continue
        c1 = p1 + (p2 - p0) * (tension / 6.0)
        c2 = p2 - (p3 - p1) * (tension / 6.0)
        commands.append(
            f"C{fmt(c1[0])} {fmt(c1[1])} "
            f"{fmt(c2[0])} {fmt(c2[1])} "
            f"{fmt(p2[0])} {fmt(p2[1])}"
        )
    commands.append("Z")
    return "".join(commands)


def contour_path(mask: np.ndarray, min_points: int = 20, tolerance: float = 0.08) -> str:
    """Fit corner-aware cubic paths with Potrace's optimized curve model."""
    del min_points
    traced = potrace.Bitmap(~mask.astype(bool)).trace(
        turdsize=8,
        alphamax=0.85,
        opticurve=True,
        opttolerance=tolerance,
    )
    paths = []

    def emit_curve(curve) -> None:
        start = curve.start_point
        commands = [f"M{fmt(start.x)} {fmt(start.y)}"]
        for segment in curve:
            end = segment.end_point
            if segment.is_corner:
                commands.append(
                    f"L{fmt(segment.c.x)} {fmt(segment.c.y)}"
                    f"L{fmt(end.x)} {fmt(end.y)}"
                )
            else:
                commands.append(
                    f"C{fmt(segment.c1.x)} {fmt(segment.c1.y)} "
                    f"{fmt(segment.c2.x)} {fmt(segment.c2.y)} "
                    f"{fmt(end.x)} {fmt(end.y)}"
                )
        commands.append("Z")
        paths.append("".join(commands))
        for child in curve.children or ():
            emit_curve(child)

    for top_curve in traced:
        emit_curve(top_curve)
    return "".join(paths)


def main() -> None:
    rgba = np.asarray(Image.open(SOURCE).convert("RGBA"))
    rgb = rgba[..., :3].astype(np.float32)
    alpha = rgba[..., 3] >= 24
    red, green, blue = np.moveaxis(rgb, -1, 0)

    green_family = alpha & (green > red * 1.08) & (green > blue * 1.22)
    purple_family = alpha & (red > green * 1.12) & (blue > green * 1.18)

    green_mask = clean_mask(green_family)
    purple_mask = clean_mask(purple_family)
    yy, xx = np.indices(green_mask.shape)
    green_path = contour_path(green_mask)
    purple_path = contour_path(purple_mask)
    if not green_path or not purple_path:
        raise RuntimeError("Expected both green and purple silhouettes")

    # Recover deliberate depth cues from darker pixels, but erode the family
    # silhouettes first so ordinary antialiasing along the perimeter is ignored.
    green_inner = morphology.binary_erosion(green_mask, morphology.disk(2))
    purple_inner = morphology.binary_erosion(purple_mask, morphology.disk(2))
    green_centers = np.array([
        [139, 213, 100],  # light
        [81, 217, 16],    # base
        [84, 193, 20],    # mid
        [77, 152, 26],    # dark
    ], dtype=np.float32)
    green_tone = np.argmin(
        np.sum((rgb[:, :, None, :] - green_centers[None, None, :, :]) ** 2, axis=3),
        axis=2,
    )
    green_light = clean_tone(green_inner & (green_tone == 0), min_size=55, radius=3)
    green_mid = clean_tone(green_inner & (green_tone == 2), min_size=90, radius=4)
    green_shadow = clean_tone(green_inner & (green_tone == 3), min_size=75, radius=4)

    purple_centers = np.array([[127, 28, 141], [96, 27, 100]], dtype=np.float32)
    purple_tone = np.argmin(
        np.sum((rgb[:, :, None, :] - purple_centers[None, None, :, :]) ** 2, axis=3),
        axis=2,
    )
    # The second purple tone is the deliberate overlap wedge at the upper join.
    # Restricting it spatially prevents dark antialiasing around the outer edge
    # from becoming a false vector layer.
    purple_shadow = clean_tone(
        purple_inner & (purple_tone == 1) & (yy < 205) & (xx < 430),
        min_size=65,
        radius=4,
    )
    green_light_path = contour_path(green_light, min_points=12)
    green_mid_path = contour_path(green_mid, min_points=12)
    green_shadow_path = contour_path(green_shadow, min_points=12)
    purple_shadow_path = contour_path(purple_shadow, min_points=12)

    width, height = Image.open(SOURCE).size
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" shape-rendering="geometricPrecision">
  <title>{html.escape("XyourP logo")}</title>
  <defs>
    <linearGradient id="purple" gradientUnits="userSpaceOnUse" x1="210" y1="540" x2="620" y2="105">
      <stop offset="0" stop-color="#7f1c8d"/>
      <stop offset="1" stop-color="#7f1c8d"/>
    </linearGradient>
    <linearGradient id="green" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#51d910"/>
      <stop offset="1" stop-color="#51d910"/>
    </linearGradient>
    <linearGradient id="greenShadow" gradientUnits="userSpaceOnUse" x1="110" y1="500" x2="430" y2="150">
      <stop offset="0" stop-color="#4d981a"/>
      <stop offset="1" stop-color="#4d981a"/>
    </linearGradient>
    <linearGradient id="purpleShadow" gradientUnits="userSpaceOnUse" x1="250" y1="250" x2="520" y2="80">
      <stop offset="0" stop-color="#601b64"/>
      <stop offset="1" stop-color="#601b64"/>
    </linearGradient>
  </defs>
  <path fill="url(#purple)" fill-rule="evenodd" d="{purple_path}"/>
  <path fill="url(#purpleShadow)" fill-rule="evenodd" d="{purple_shadow_path}"/>
  <path fill="url(#green)" fill-rule="evenodd" d="{green_path}"/>
  <path fill="#8bd564" fill-rule="evenodd" d="{green_light_path}"/>
  <path fill="#54c114" fill-rule="evenodd" d="{green_mid_path}"/>
  <path fill="url(#greenShadow)" fill-rule="evenodd" d="{green_shadow_path}"/>
</svg>
"""
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(svg, encoding="utf-8")
    print(OUTPUT)


if __name__ == "__main__":
    main()
