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

    assert min_area == 50
    assert cleaned[21, 21] == 0.0
    assert cleaned[401, 401] == 1.0
    assert cleaned[500, 500] == 1.0


def test_adaptive_cleanup_preserves_meaningful_small_regions():
    field = np.zeros((1000, 1000), dtype=float)
    field[50:60, 50:60] = 1.0

    cleaned, _ = P.clean_contour_field(field)

    assert cleaned[55, 55] == 1.0


def test_nearest_palette_coverage_keeps_intermediate_shade_as_solid_layer():
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
