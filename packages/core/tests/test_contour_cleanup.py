"""Regression tests for adaptive raster-layer cleanup before curve fitting."""
import pathlib
import sys

import numpy as np

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
