"""HR zones, calorie estimation (Keytel), and continuous stress level."""

from __future__ import annotations

import math
import statistics
from datetime import datetime, time, timedelta, timezone
from typing import Sequence

# Zone boundaries as fractions of max HR (industry standard 5-zone model).
ZONE_BOUNDS = [
    ("z1", 0.50, 0.60),
    ("z2", 0.60, 0.70),
    ("z3", 0.70, 0.80),
    ("z4", 0.80, 0.90),
    ("z5", 0.90, 1.20),  # z5 = anything ≥ 90% (open-ended upper bound)
]


def max_hr(age: int, override: int | None = None) -> int:
    if override:
        return int(override)
    return max(120, 220 - max(1, int(age)))


def zone_for_hr(hr: float, max_bpm: int) -> int | None:
    """Return zone index 1-5 for an HR value, or None if below Z1."""
    if hr is None or max_bpm <= 0:
        return None
    frac = hr / max_bpm
    for idx, (_, lo, hi) in enumerate(ZONE_BOUNDS, start=1):
        if lo <= frac < hi:
            return idx
    return None


def zone_seconds_from_hr_series(
    hr_per_second: Sequence[float], max_bpm: int
) -> list[int]:
    """Given a per-second HR series, return [z1, z2, z3, z4, z5] seconds spent in each.

    Samples below Z1 are not counted in any zone. HR is assumed sampled once per
    second; if your sampling is different, scale the result accordingly.
    """
    counts = [0, 0, 0, 0, 0]
    for hr in hr_per_second:
        z = zone_for_hr(hr or 0.0, max_bpm)
        if z is not None:
            counts[z - 1] += 1
    return counts


# ---------------------------------------------------------------------------
# Calories — Keytel (2005) HR-based estimate
# ---------------------------------------------------------------------------


def calories_per_minute(
    hr: float,
    age: int,
    weight_kg: float,
    sex: str | None,
) -> float:
    """Kcal burned in one minute given mean HR.

    From Keytel et al. (2005). When sex is unknown we average the two formulas.
    When weight is unknown we assume 70 kg.
    """
    if hr is None or hr < 30 or hr > 230:
        return 0.0
    w = weight_kg if weight_kg and weight_kg > 0 else 70.0
    a = age if age and age > 0 else 30
    male = ((-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184)
    female = ((-20.4022 + 0.4472 * hr - 0.1263 * w + 0.0740 * a) / 4.184)
    if sex == "M":
        kpm = male
    elif sex == "F":
        kpm = female
    else:
        kpm = (male + female) / 2
    return max(0.0, kpm)


def calories_from_hr_series(
    hr_per_second: Sequence[float],
    age: int,
    weight_kg: float | None,
    sex: str | None,
) -> float:
    """Total kcal over a per-second HR series."""
    if not hr_per_second:
        return 0.0
    w = weight_kg if weight_kg and weight_kg > 0 else 70.0
    # Vectorless: compute per-second contribution and sum.
    total = 0.0
    for hr in hr_per_second:
        if hr is None or hr < 30:
            # below ~30 bpm: count basal-only, ~1.0 kcal/min for 70 kg → /60
            total += 1.0 / 60.0
            continue
        total += calories_per_minute(hr, age, w, sex) / 60.0
    return round(total, 1)


# ---------------------------------------------------------------------------
# Stress level (continuous 5-min RMSSD windows during wake hours)
# ---------------------------------------------------------------------------


def _rmssd(rr: Sequence[int]) -> float | None:
    if len(rr) < 3:
        return None
    rr = [v for v in rr if v is not None and 250 < v < 2000]
    if len(rr) < 3:
        return None
    diffs = [rr[i + 1] - rr[i] for i in range(len(rr) - 1)]
    return math.sqrt(sum(d * d for d in diffs) / len(diffs))


def stress_samples(
    rows, baseline_rmssd: float, sleep_window: tuple[datetime, datetime] | None = None
) -> list[dict]:
    """Compute 5-minute stress samples across `rows`.

    Stress = 100 - clamp(50 + (rmssd - baseline)/baseline * 50, 0, 100).
    Excludes samples inside the sleep window if provided.
    """
    if not rows or baseline_rmssd is None or baseline_rmssd <= 0:
        return []

    bucket_size = timedelta(minutes=5)
    out: list[dict] = []
    cur_start: datetime | None = None
    cur_rrs: list[int] = []

    def _flush(end: datetime) -> None:
        nonlocal cur_start, cur_rrs
        if cur_start is None or len(cur_rrs) < 8:
            cur_start, cur_rrs = None, []
            return
        rms = _rmssd(cur_rrs)
        if rms is not None:
            recovery_like = 50 + (rms - baseline_rmssd) / baseline_rmssd * 50
            recovery_like = max(0.0, min(100.0, recovery_like))
            stress = round(100 - recovery_like, 1)
            out.append(
                {
                    "start_utc": cur_start.isoformat(timespec="seconds"),
                    "end_utc": end.isoformat(timespec="seconds"),
                    "stress": stress,
                }
            )
        cur_start, cur_rrs = None, []

    for r in rows:
        if r["rr_interval_ms"] is None:
            continue
        t = datetime.fromisoformat(r["ts_utc"])
        if sleep_window and sleep_window[0] <= t < sleep_window[1]:
            continue
        if cur_start is None:
            cur_start = t
        if t - cur_start >= bucket_size:
            _flush(t)
            cur_start = t
        cur_rrs.append(r["rr_interval_ms"])
    if cur_start is not None:
        _flush(cur_start + bucket_size)

    return out
