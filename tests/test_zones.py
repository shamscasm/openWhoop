"""Tests for HR zones + Keytel calories."""

from __future__ import annotations

import math

from whoof import zones


def test_max_hr_default_formula():
    assert zones.max_hr(30) == 190
    assert zones.max_hr(50) == 170


def test_max_hr_override_wins():
    assert zones.max_hr(30, override=200) == 200


def test_max_hr_floor():
    assert zones.max_hr(120) >= 120  # don't return absurdly low values


def test_zone_for_hr_boundaries():
    mx = 200  # max HR → zone thresholds 100/120/140/160/180
    assert zones.zone_for_hr(99, mx) is None         # below Z1
    assert zones.zone_for_hr(100, mx) == 1
    assert zones.zone_for_hr(120, mx) == 2
    assert zones.zone_for_hr(140, mx) == 3
    assert zones.zone_for_hr(160, mx) == 4
    assert zones.zone_for_hr(180, mx) == 5
    assert zones.zone_for_hr(220, mx) == 5  # capped at Z5


def test_zone_seconds_from_series_distributes():
    # 200 bpm max → zone thresholds 100/120/140/160/180 bpm.
    # 50 bpm = below Z1, 110 bpm = Z1 (55%), 130 bpm = Z2 (65%), 180 bpm = Z5 (90%).
    series = [50] * 10 + [110] * 60 + [130] * 40 + [180] * 30
    out = zones.zone_seconds_from_hr_series(series, max_bpm=200)
    assert out[0] == 60      # Z1
    assert out[1] == 40      # Z2
    assert out[2] == 0       # Z3
    assert out[3] == 0       # Z4
    assert out[4] == 30      # Z5


def test_calories_per_minute_men_vs_women():
    m_cal = zones.calories_per_minute(150, 30, 80, "M")
    f_cal = zones.calories_per_minute(150, 30, 80, "F")
    assert m_cal > f_cal > 0
    # Should land within an order of magnitude of typical (~10-20 kcal/min)
    assert 5 < m_cal < 30


def test_calories_per_minute_unknown_sex_averages():
    m = zones.calories_per_minute(150, 30, 80, "M")
    f = zones.calories_per_minute(150, 30, 80, "F")
    u = zones.calories_per_minute(150, 30, 80, None)
    assert math.isclose(u, (m + f) / 2, rel_tol=1e-6)


def test_calories_zero_for_below_min_hr():
    assert zones.calories_per_minute(20, 30, 80, "M") == 0.0
    assert zones.calories_per_minute(None, 30, 80, "M") == 0.0


def test_calories_from_series_sums():
    # 60 seconds @ HR 150 should ≈ 1 minute of calories_per_minute(150)
    series = [150.0] * 60
    cals = zones.calories_from_hr_series(series, age=30, weight_kg=80, sex="M")
    expected = zones.calories_per_minute(150, 30, 80, "M")
    assert abs(cals - expected) < 0.5


def test_calories_default_weight_falls_back():
    cals = zones.calories_from_hr_series([100.0] * 60, age=30, weight_kg=None, sex="M")
    assert cals > 0
