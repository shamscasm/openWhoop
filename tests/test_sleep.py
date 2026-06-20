"""Tests for sleep-window detection, stage classifier, and sleep need/debt/consistency."""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta, timezone

from whoof import sleep


class FakeRow(dict):
    """sqlite3.Row-like: subscript access."""
    def __getitem__(self, k):
        return super().__getitem__(k)


def _row(ts_utc, hr, rr, motion_amp=10):
    row = {
        "ts_utc": ts_utc,
        "heart_rate_bpm": hr,
        "rr_interval_ms": rr,
        "spo2_pct": 98,
        "skin_temp_c": 33.5,
    }
    if motion_amp is not None:
        row["accel_x"] = motion_amp
        row["accel_y"] = motion_amp
        row["accel_z"] = motion_amp
    return FakeRow(row)


def _build_samples(day: date, sleep_block=(23, 7), sample_dt=30):
    """Build a synthetic day: low HR + low motion during sleep_block, normal otherwise."""
    local = datetime.now().astimezone().tzinfo
    midnight = datetime.combine(day, time(0, 0), tzinfo=local)
    rows = []
    bedtime_h, wake_h = sleep_block
    for s in range(0, 24 * 3600, sample_dt):
        t_local = midnight + timedelta(seconds=s)
        h_frac = t_local.hour + t_local.minute / 60.0
        in_sleep = (h_frac >= bedtime_h) or (h_frac < wake_h)
        if in_sleep:
            hr = 54 + (s % 3)
            rr = int(60_000 / hr + (s % 30 - 15) * 0.5)
            motion = 4
        else:
            hr = 76 + ((s // 60) % 7)
            rr = int(60_000 / hr + (s % 60 - 30))
            motion = 60
        rows.append(_row(t_local.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
                         hr, rr, motion_amp=motion))
    return rows


def test_detect_sleep_window_finds_overnight_block():
    today = date.today() - timedelta(days=1)
    samples = _build_samples(today, sleep_block=(23, 7))
    win = sleep.detect_sleep_window(samples, today)
    assert win is not None
    start, end = win
    duration_h = (end - start).total_seconds() / 3600
    # We seeded 8 hours; allow modest slack for edge sampling
    assert 6.0 <= duration_h <= 9.0


def test_detect_sleep_window_returns_none_with_no_low_motion():
    today = date.today()
    samples = [_row(
        (datetime.combine(today, time(12, 0)).astimezone(timezone.utc)
         + timedelta(seconds=s)).isoformat(timespec="milliseconds"),
        90, 670, motion_amp=200,
    ) for s in range(0, 3600, 30)]
    assert sleep.detect_sleep_window(samples, today) is None


def test_detect_sleep_window_falls_back_to_hr_only_when_motion_missing():
    today = date.today() - timedelta(days=1)
    samples = _build_samples(today, sleep_block=(23, 7))
    for row in samples:
        row.pop("accel_x", None)
        row.pop("accel_y", None)
        row.pop("accel_z", None)
    win = sleep.detect_sleep_window(samples, today)
    assert win is not None


def test_classify_stages_produces_segments():
    today = date.today() - timedelta(days=1)
    samples = _build_samples(today, sleep_block=(23, 7))
    win = sleep.detect_sleep_window(samples, today)
    assert win is not None
    stages = sleep.classify_stages(samples, win)
    assert stages, "classify_stages should produce at least one segment"
    valid_stages = {"wake", "light", "deep", "rem"}
    for s in stages:
        assert s["stage"] in valid_stages
        assert s["source"] == "heuristic-v1"
        start = datetime.fromisoformat(s["start_utc"])
        end = datetime.fromisoformat(s["end_utc"])
        assert end > start
    # The first segment starts at the window start, last ends at window end
    assert datetime.fromisoformat(stages[0]["start_utc"]) == win[0]
    assert datetime.fromisoformat(stages[-1]["end_utc"]) == win[1]


def test_sleep_window_summary_falls_back_to_hr_only():
    today = date.today() - timedelta(days=1)
    samples = _build_samples(today, sleep_block=(23, 7))
    for row in samples:
        row.pop("accel_x", None)
        row.pop("accel_y", None)
        row.pop("accel_z", None)
    win = sleep.detect_sleep_window(samples, today)
    summary = sleep.sleep_window_summary(samples, win)
    assert summary["source"] == "hr-only"
    assert summary["confidence_pct"] is not None


def test_stage_totals_sum_to_window_duration():
    today = date.today() - timedelta(days=1)
    samples = _build_samples(today, sleep_block=(23, 7))
    win = sleep.detect_sleep_window(samples, today)
    stages = sleep.classify_stages(samples, win)
    totals = sleep.stage_totals(stages)
    window_minutes = (win[1] - win[0]).total_seconds() / 60.0
    total_min = sum(totals.values())
    assert abs(total_min - round(window_minutes)) <= 2  # rounding tolerance


def test_sleep_need_formula():
    # No debt, no strain → exactly base
    assert sleep.sleep_need_minutes(0, 0) == sleep.BASE_SLEEP_MINUTES
    # Big debt is capped at +120
    assert sleep.sleep_need_minutes(1000, 0) == sleep.BASE_SLEEP_MINUTES + 120
    # Strain capped at +60
    assert sleep.sleep_need_minutes(0, 21) == sleep.BASE_SLEEP_MINUTES + 60
    # Combined
    assert sleep.sleep_need_minutes(120, 10) == sleep.BASE_SLEEP_MINUTES + 60 + 30


def test_sleep_performance_basic():
    assert sleep.sleep_performance(480, 480) == 100.0
    assert sleep.sleep_performance(240, 480) == 50.0
    assert sleep.sleep_performance(700, 480) == 100.0  # capped


def test_sleep_debt_calculation():
    asleep = [400, 420, 400, 480, 480, 460, 420]
    need   = [480, 480, 480, 480, 480, 480, 480]
    debt = sleep.sleep_debt_minutes_7d(asleep, need)
    assert debt == 80 + 60 + 80 + 0 + 0 + 20 + 60


def test_sleep_consistency_perfect_when_identical():
    beds  = [datetime(2026, 5, 14, 23, 0)] * 7
    wakes = [datetime(2026, 5, 15, 7, 0)]  * 7
    val = sleep.sleep_consistency_pct(beds, wakes)
    assert val == 100.0


def test_sleep_consistency_lower_when_scattered():
    beds  = [datetime(2026, 5, 14, h, 0) for h in [22, 23, 1, 22, 0, 23, 22]]
    wakes = [datetime(2026, 5, 15, h, 0) for h in [6, 7, 9, 5, 8, 7, 6]]
    val = sleep.sleep_consistency_pct(beds, wakes)
    assert val is not None
    assert val < 90.0


def test_sleep_consistency_returns_none_without_enough_data():
    assert sleep.sleep_consistency_pct([], []) is None
    assert sleep.sleep_consistency_pct(
        [datetime(2026, 5, 14, 23)], [datetime(2026, 5, 15, 7)]
    ) is None


def test_respiratory_rate_returns_plausible_value():
    # Build synthetic RR series with sinusoidal modulation at ~15 breaths/min
    today = date.today() - timedelta(days=1)
    local = datetime.now().astimezone().tzinfo
    start = datetime.combine(today, time(2, 0), tzinfo=local)
    rows = []
    breath_period_s = 60 / 15  # 4 seconds per breath
    cur = 0.0
    for i in range(800):
        cur_t = start + timedelta(seconds=i * 1.0)
        base = 1000
        modulation = 40 * math.sin(2 * math.pi * (i * 1.0) / breath_period_s)
        rr = int(base + modulation)
        rows.append(_row(
            cur_t.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
            60, rr, motion_amp=2,
        ))
    win = (rows[0]["ts_utc"], rows[-1]["ts_utc"])
    bpm = sleep.respiratory_rate(
        rows,
        (datetime.fromisoformat(win[0]), datetime.fromisoformat(win[1]) + timedelta(seconds=1)),
    )
    assert bpm is not None
    assert 8 <= bpm <= 24


def test_respiratory_rate_none_when_window_missing():
    assert sleep.respiratory_rate([], None) is None
