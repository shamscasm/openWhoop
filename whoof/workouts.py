"""Auto-detect workouts from sustained elevated HR.

A workout is a contiguous period where the rolling-10-minute median HR sits
above 60% of max-HR AND we are not in the user's sleep window. Workouts
shorter than 10 minutes or completely inside the sleep window are dropped.
"""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
from datetime import datetime, timedelta, timezone
from typing import Sequence

from . import db, zones

# Tunables
MIN_WORKOUT_MINUTES = 10
MERGE_GAP_MINUTES = 5
HR_FRACTION_THRESHOLD = 0.60   # of max HR
ROLLING_WINDOW_SECONDS = 600   # 10 min


def _parse(t: str) -> datetime:
    return datetime.fromisoformat(t)


def _rolling_median(values: list[float], window: int) -> list[float]:
    """O(n*window) rolling median — fine for ~86k samples/day."""
    out: list[float] = []
    half = window // 2
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        seg = [v for v in values[lo:hi] if v is not None]
        out.append(statistics.median(seg) if seg else 0.0)
    return out


def detect_workouts(
    samples: Sequence[sqlite3.Row],
    age: int,
    max_hr_override: int | None,
    sleep_window: tuple[datetime, datetime] | None,
    weight_kg: float | None,
    sex: str | None,
) -> list[dict]:
    """Return a list of workout dicts ready for db.insert_workout."""
    if not samples:
        return []
    max_bpm = zones.max_hr(age, max_hr_override)
    threshold = max_bpm * HR_FRACTION_THRESHOLD

    # Build per-second HR view by collapsing to second resolution.
    times: list[datetime] = []
    hrs: list[float] = []
    for r in samples:
        if r["heart_rate_bpm"] is None:
            continue
        t = _parse(r["ts_utc"])
        times.append(t)
        hrs.append(float(r["heart_rate_bpm"]))
    if not hrs:
        return []

    # Median sample interval (seconds) — used to size rolling window
    intervals = [
        (times[i] - times[i - 1]).total_seconds()
        for i in range(1, min(len(times), 200))
    ]
    median_dt = statistics.median(intervals) if intervals else 1.0
    median_dt = max(0.5, min(10.0, median_dt))
    window_samples = max(10, int(ROLLING_WINDOW_SECONDS / median_dt))

    rolling = _rolling_median(hrs, window_samples)

    # Walk through, find continuous runs above threshold (outside sleep).
    raw_segments: list[tuple[datetime, datetime]] = []
    seg_start: datetime | None = None
    for t, rh in zip(times, rolling):
        in_sleep = sleep_window is not None and sleep_window[0] <= t < sleep_window[1]
        above = rh >= threshold and not in_sleep
        if above and seg_start is None:
            seg_start = t
        elif not above and seg_start is not None:
            raw_segments.append((seg_start, t))
            seg_start = None
    if seg_start is not None:
        raw_segments.append((seg_start, times[-1]))

    if not raw_segments:
        return []

    # Merge segments separated by < MERGE_GAP_MINUTES
    merged: list[tuple[datetime, datetime]] = [raw_segments[0]]
    for s, e in raw_segments[1:]:
        ls, le = merged[-1]
        if (s - le).total_seconds() <= MERGE_GAP_MINUTES * 60:
            merged[-1] = (ls, e)
        else:
            merged.append((s, e))

    # Filter by minimum duration, then build per-workout stats
    out: list[dict] = []
    for s, e in merged:
        dur_min = (e - s).total_seconds() / 60.0
        if dur_min < MIN_WORKOUT_MINUTES:
            continue
        # Per-second-ish HR for this window
        hr_window = [
            h for (tt, h) in zip(times, hrs) if s <= tt <= e
        ]
        if not hr_window:
            continue
        zs = zones.zone_seconds_from_hr_series(hr_window, max_bpm)
        # Scale zone counts by sample interval to get true seconds.
        zs = [int(round(c * median_dt)) for c in zs]
        cals = zones.calories_from_hr_series(hr_window, age, weight_kg, sex)
        # Scale calories: our per-second formula multiplied by actual seconds.
        cals = round(cals * median_dt, 1)
        avg_hr = round(statistics.mean(hr_window), 1)
        mx = round(max(hr_window), 1)
        strain = _workout_strain(hr_window, age, max_hr_override)
        local = datetime.now().astimezone().tzinfo
        out.append(
            {
                "date": s.astimezone(local).date().isoformat(),
                "start_utc": s.astimezone(timezone.utc).isoformat(timespec="seconds"),
                "end_utc": e.astimezone(timezone.utc).isoformat(timespec="seconds"),
                "duration_seconds": int((e - s).total_seconds()),
                "avg_hr": avg_hr,
                "max_hr": mx,
                "strain": strain,
                "calories": cals,
                "zone_seconds": json.dumps(zs),
                "label": None,
                "auto_detected": True,
            }
        )
    return out


def _workout_strain(
    hr_window: Sequence[float],
    age: int,
    max_hr_override: int | None,
) -> float:
    """Localised strain for a single workout (same shape as daily strain, smaller scale)."""
    if not hr_window:
        return 0.0
    max_bpm = zones.max_hr(age, max_hr_override)
    rest = min(hr_window)
    if max_bpm <= rest:
        return 0.0
    minutes = len(hr_window) / 60.0
    intensities = [max(0.0, (h - rest) / (max_bpm - rest)) for h in hr_window]
    load = sum(i * i for i in intensities)
    return round(21.0 * (1.0 - math.exp(-load * minutes / 1000.0)), 2)


def persist_workouts_for_day(
    con: sqlite3.Connection,
    day_iso: str,
    detected: list[dict],
) -> int:
    """Idempotent: removes prior auto-detected workouts for `day_iso`, inserts new ones."""
    db.delete_auto_workouts_on_date(con, day_iso)
    for w in detected:
        db.insert_workout(con, w)
    return len(detected)
