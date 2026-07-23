"""Regression tests for compact, editor-friendly cubic contours."""
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
PIPELINE = ROOT / "packages" / "core" / "pipeline"
sys.path.insert(0, str(PIPELINE))

import smooth2  # noqa: E402


def _line_curve(start, end):
    start = np.asarray(start, dtype=float)
    end = np.asarray(end, dtype=float)
    delta = (end - start) / 3.0
    return np.vstack([start, start + delta, start + 2 * delta, end])


def test_tiny_curve_is_absorbed_without_breaking_closed_contour():
    curves = [
        _line_curve((0, 0), (10, 0)),
        _line_curve((10, 0), (10, 0.8)),
        _line_curve((10, 0.8), (10, 10)),
        _line_curve((10, 10), (0, 10)),
        _line_curve((0, 10), (0, 0)),
    ]

    cleaned = smooth2.drop_tiny_curves(curves, min_len=2.0)

    assert len(cleaned) == 4
    for curve, following in zip(cleaned, cleaned[1:] + cleaned[:1]):
        np.testing.assert_allclose(curve[3], following[0])
    np.testing.assert_allclose(cleaned[0][3], (10, 0.4))


def test_meaningful_short_accent_edge_is_preserved():
    curves = [
        _line_curve((0, 0), (10, 0)),
        _line_curve((10, 0), (10, 4)),
        _line_curve((10, 4), (0, 10)),
        _line_curve((0, 10), (0, 0)),
    ]

    cleaned = smooth2.drop_tiny_curves(curves, min_len=2.0)

    assert len(cleaned) == len(curves)


def test_runtime_smoothing_cap_is_not_frozen_as_a_default_argument():
    assert smooth2.smooth_arc.__defaults__[0] is None


def test_production_smoothing_module_matches_core_source_byte_for_byte():
    core_module = PIPELINE / "smooth2.py"
    production_module = ROOT / "apps" / "web" / "public" / "pipeline" / "smooth2.py"
    assert production_module.read_bytes() == core_module.read_bytes()


def test_verifier_uses_runtime_output_scale_and_matches_production():
    core_module = PIPELINE / "verify.py"
    production_module = ROOT / "apps" / "web" / "public" / "pipeline" / "verify.py"
    source = core_module.read_text(encoding="utf-8")

    assert 'getattr(P, "SCALE", 2.0)' in source
    assert production_module.read_bytes() == core_module.read_bytes()
