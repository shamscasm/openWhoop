"""Tests for workout auto-detection."""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone

from whoof import workouts


class FakeRow(dict):
    def __getitem__(self, k):
        return super().__getitem__(k)


def _row(ts_utc, hr, rr=700, motion_amp=10):
    return FakeRow({
        "ts_utc": ts_utc,
        "heart_rate_bpm": hr,
        "rr_interval_ms": rr,
        "accel_x": motion_amp, "accel_y": motion_amp, "accel_z": motion_amp,
    })


def _series(day: date, samples_per_sec=1):
    """Helper to build minute-by-minute HR series for a day with workouts."""
    local = datetime.now().astimezone().tzinfo
    midnight = datetime.combine(day, time(0, 0), tzinfo=local)
    rows = []
    for s in range(0, 24 * 3600, 5):  # one sample every 5s
        t_local = midnight + timedelta(seconds=s)
        h_frac = t_local.hour + t_local.minute / 60.0
        # One workout from 17:00 to 17:35
        if 17.0 <= h_frac < 17 + 35 / 60:
            hr = 155
        elif h_frac < 7 or h_frac >= 23:
            hr = 55
        else:
            hr = 75
        rows.append(_row(
            t_local.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
            hr, motion_amp=5 if hr < 80 else 80,
        ))
    return rows


def test_detect_workout_finds_obvious_block():
    today = date.today() - timedelta(days=1)
    rows = _series(today)
    detected = workouts.detect_workouts(
        rows, age=30, max_hr_override=None,
        sleep_window=None, weight_kg=70, sex="M",
    )
    assert len(detected) == 1
    w = detected[0]
    assert w["date"] == today.isoformat()
    assert w["duration_seconds"] >= 30 * 60
    assert w["avg_hr"] > 140
    assert w["max_hr"] >= 150
    assert w["strain"] > 0
    assert w["calories"] > 0
    zs = json.loads(w["zone_seconds"])
    assert sum(zs) > 0
    assert w["auto_detected"] is True


def test_no_workouts_for_resting_day():
    today = date.today() - timedelta(days=1)
    local = datetime.now().astimezone().tzinfo
    rows = []
    midnight = datetime.combine(today, time(0, 0), tzinfo=local)
    for s in range(0, 24 * 3600, 30):
        t = midnight + timedelta(seconds=s)
        rows.append(_row(
            t.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
            65, motion_amp=10,
        ))
    detected = workouts.detect_workouts(
        rows, age=30, max_hr_override=None,
        sleep_window=None, weight_kg=70, sex="M",
    )
    assert detected == []


def test_workouts_excluded_inside_sleep_window():
    today = date.today() - timedelta(days=1)
    rows = _series(today)
    local = datetime.now().astimezone().tzinfo
    # Make the workout entirely inside the "sleep window"
    sleep_start = datetime.combine(today, time(16, 30), tzinfo=local).astimezone(timezone.utc)
    sleep_end = datetime.combine(today, time(18, 0), tzinfo=local).astimezone(timezone.utc)
    detected = workouts.detect_workouts(
        rows, age=30, max_hr_override=None,
        sleep_window=(sleep_start, sleep_end), weight_kg=70, sex="M",
    )
    assert detected == []


def test_short_workout_dropped():
    today = date.today() - timedelta(days=1)
    local = datetime.now().astimezone().tzinfo
    rows = []
    midnight = datetime.combine(today, time(0, 0), tzinfo=local)
    # Only a 5-minute "workout"
    for s in range(0, 24 * 3600, 5):
        t = midnight + timedelta(seconds=s)
        h_frac = t.hour + t.minute / 60.0
        if 17.0 <= h_frac < 17 + 5 / 60:
            hr = 160
        else:
            hr = 65
        rows.append(_row(
            t.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
            hr, motion_amp=10,
        ))
    detected = workouts.detect_workouts(
        rows, age=30, max_hr_override=None,
        sleep_window=None, weight_kg=70, sex="M",
    )
    assert detected == []
