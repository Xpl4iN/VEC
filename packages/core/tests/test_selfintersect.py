"""Synthetic regression tests for emitted-path self-intersection cleanup."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "core" / "pipeline_ext"))

import deloop as DL  # noqa: E402

CLEAN_SQUARE = (
    "M0 0"
    "C3.333333 0 6.666667 0 10 0"
    "C10 3.333333 10 6.666667 10 10"
    "C6.666667 10 3.333333 10 0 10"
    "C0 6.666667 0 3.333333 0 0Z"
)

BOW_TIE = (
    "M0 0"
    "C3.333333 3.333333 6.666667 6.666667 10 10"
    "C6.666667 10 3.333333 10 0 10"
    "C3.333333 6.666667 6.666667 3.333333 10 0"
    "C6.666667 0 3.333333 0 0 0Z"
)


def test_production_module_matches_core_source_byte_for_byte():
    core_module = ROOT / "packages" / "core" / "pipeline_ext" / "deloop.py"
    production_module = ROOT / "apps" / "web" / "public" / "pipeline" / "deloop.py"
    assert production_module.read_bytes() == core_module.read_bytes()


def test_checker_parses_supported_geometry():
    assert DL.parse_is_trustworthy(CLEAN_SQUARE)
    assert DL.parse_is_trustworthy(BOW_TIE)
    assert sum(len(s) for s in DL.parse_subpaths(CLEAN_SQUARE)) == 4


def test_parser_rejects_unsupported_or_empty_geometry():
    for path in ("m0 0c1 0 1 1 0 1z", "M0 0Q1 1 2 0Z", "", "M0 0Z"):
        assert not DL.parse_is_trustworthy(path)


def test_parser_accepts_scientific_notation_and_explicit_signs():
    path = "M+1e-05,-2E+2C.5 0 1. 1 2e0 2Z"
    assert DL.parse_is_trustworthy(path)
    assert len(DL.parse_subpaths(path)) == 1


def test_parser_rejects_truncated_or_trailing_data():
    assert not DL.parse_is_trustworthy("M0 0C1 1 2 2Z")
    assert not DL.parse_is_trustworthy("M0 0C1 1 2 2 3 3Z garbage")
    assert not DL.parse_is_trustworthy("M1e999 0C1 1 2 2 3 3Z")


def test_deloop_removes_a_synthetic_self_intersection():
    # An odd sampling density keeps the exact centre crossing inside sampled
    # line segments rather than placing it on their shared endpoint.
    assert DL.has_self_intersection(BOW_TIE, dens=59)
    fixed, report = DL.deloop(BOW_TIE, dens=59)
    assert report
    assert DL.parse_is_trustworthy(fixed)
    assert not DL.has_self_intersection(fixed, dens=59)


def test_intersection_diagnostics_identify_crossing_curves():
    report = DL.intersection_diagnostics(BOW_TIE, dens=59)
    assert report["valid_contract"]
    assert report["has_self_intersection"]
    assert report["subpath"] == 0
    assert report["curve_a"] != report["curve_b"]
    assert len(report["point"]) == 2


def test_intersection_diagnostics_cover_clean_and_invalid_paths():
    clean = DL.intersection_diagnostics(CLEAN_SQUARE)
    invalid = DL.intersection_diagnostics("M0 0L1 1Z")
    assert clean["has_self_intersection"] is False
    assert invalid["valid_contract"] is False
    assert invalid["has_self_intersection"] is None


def test_clean_geometry_remains_byte_identical():
    fixed, report = DL.deloop(CLEAN_SQUARE)
    assert report == []
    assert fixed == CLEAN_SQUARE
