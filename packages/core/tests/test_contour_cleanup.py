"""Regression tests for adaptive raster-layer cleanup before curve fitting."""
import pathlib
import sys
import tempfile

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "core" / "pipeline"))

import pipeline as P  # noqa: E402


def test_adaptive_cleanup_removes_freckles_and_fills_pinholes():
    field = np.zeros((1000, 1000), dtype=float)
    field[200:800, 200:800] = 1.0
    field[400:403, 400:403] = 0.0
    field[20:23, 20:23] = 1.0

    cleaned, min_area = P.clean_contour_field(field)

    assert min_area == 200
    assert cleaned[21, 21] == 0.0
    assert cleaned[401, 401] == 1.0
    assert cleaned[500, 500] == 1.0


def test_adaptive_cleanup_preserves_meaningful_small_regions():
    field = np.zeros((1000, 1000), dtype=float)
    field[50:70, 50:70] = 1.0

    cleaned, _ = P.clean_contour_field(field)

    assert cleaned[55, 55] == 1.0


def test_corner_window_rejects_stair_steps_but_keeps_square_corners():
    points = []
    for a, b in [
        ((0, 0), (20, 0)),
        ((20, 0), (20, 20)),
        ((20, 20), (0, 20)),
        ((0, 20), (0, 0)),
    ]:
        count = int(np.hypot(b[0] - a[0], b[1] - a[1]) / P.STEP)
        for t in np.linspace(0, 1, count, endpoint=False):
            points.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    assert len(P.corners(np.array(points))) == 4

    t = np.linspace(0, 2 * np.pi, 1000, endpoint=False)
    noisy_circle = np.column_stack([50 * np.cos(t), 50 * np.sin(t)])
    noisy_circle[:, 0] += 0.25 * np.sign(np.sin(47 * t))
    assert len(P.corners(noisy_circle)) == 0


def test_isolated_palette_coverage_keeps_only_the_selected_shade():
    pixels = np.array([[
        [65, 220, 0, 255],
        [70, 170, 15, 255],
        [75, 120, 30, 255],
    ]], dtype=np.uint8)
    palette = [[65, 220, 0], [70, 170, 15], [75, 120, 30]]

    with tempfile.TemporaryDirectory() as directory:
        source = pathlib.Path(directory) / "palette.png"
        Image.fromarray(pixels, "RGBA").save(source)
        P.LAYERS["middle"] = (str(source), [0, 0], palette, 1)
        try:
            field, offset = P.coverage("middle")
        finally:
            del P.LAYERS["middle"]

    assert offset == [0, 0]
    assert field.tolist() == [[0.0, 1.0, 0.0]]


def test_enclosed_near_color_island_merges_but_contrasting_accent_survives():
    bright = [78, 216, 16]
    near = [83, 181, 18]
    accent = [75, 152, 22]
    pixels = np.zeros((9, 9, 4), dtype=np.uint8)
    pixels[..., :3] = bright
    pixels[..., 3] = 255
    pixels[2:7, 2:7, :3] = near
    pixels[4, 4, :3] = accent

    best = np.zeros((9, 9), dtype=np.int16)
    best[2:7, 2:7] = 1
    best[4, 4] = 2
    cleaned = P.clean_palette_assignments(
        best,
        np.ones((9, 9), dtype=float),
        [bright, near, accent],
    )

    assert np.all(cleaned[2:4, 2:7] == 0)
    assert cleaned[4, 4] == 2


def test_compact_near_color_accent_is_not_absorbed():
    bright = [78, 216, 16]
    near = [83, 181, 18]
    best = np.zeros((100, 100), dtype=np.int16)
    best[48:53, 48:53] = 1

    cleaned = P.clean_palette_assignments(
        best,
        np.ones((100, 100), dtype=float),
        [bright, near],
    )

    assert np.all(cleaned[48:53, 48:53] == 1)
