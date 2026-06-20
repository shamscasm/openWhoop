"""Sleep window detection, stage classification, and derived sleep metrics.

All heuristics are deterministic and based on motion + HR + RR-interval
variability. They are intentionally simple so they run on the data we already
capture (no FFT libraries, no ML models). They approximate Whoop's published
metrics but do not match exactly.
"""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Sequence

from . import db

# How long we group samples for classification. 30 s = one polysomnography epoch.
EPOCH_SECONDS = 30

# Minimum contiguous low-motion span (minutes) to count as a sleep block.
MIN_SLEEP_BLOCK_MINUTES = 30

# Local hour bounds we consider for the nightly sleep window. We look for the
# longest contiguous low-motion block whose midpoint falls inside this range.
NIGHT_WINDOW_LOCAL = (time(20, 0), time(11, 0))

# Stages
STAGES = ("wake", "light", "deep", "rem")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _motion_magnitude(row) -> int | None:
    ax = _field(row, "accel_x")
    ay = _field(row, "accel_y")
    az = _field(row, "accel_z")
    motion = _field(row, "motion")
    if ax is None and ay is None and az is None and motion is None:
        return None
    if motion is not None:
        return abs(motion)
    ax = abs(ax or 0)
    ay = abs(ay or 0)
    az = abs(az or 0)
    return ax + ay + az


def _local_tz():
    return datetime.now().astimezone().tzinfo


def _parse_ts(row) -> datetime:
    return datetime.fromisoformat(row["ts_utc"])


def _field(row, key, default=None):
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Sleep window detection
# ---------------------------------------------------------------------------


def detect_sleep_window(samples: Sequence[sqlite3.Row], night_of: date) -> tuple[datetime, datetime] | None:
    """Find the contiguous low-motion+low-HR block that constitutes 'last night'.

    Strategy: walk samples in time order, group into contiguous runs where motion
    magnitude is below a threshold AND HR is below the daily mean. Return the
    longest such run whose midpoint lies in NIGHT_WINDOW_LOCAL and which is
    at least MIN_SLEEP_BLOCK_MINUTES long. Returns (start_utc, end_utc) as
    timezone-aware datetimes, or None if no plausible window found.
    """
    if not samples:
        return None

    local = _local_tz()
    hrs = [r["heart_rate_bpm"] for r in samples if r["heart_rate_bpm"] is not None]
    if not hrs:
        return None
    hr_min = min(hrs)
    hr_threshold = max(statistics.mean(hrs) * 0.95, hr_min + 25)  # below average HR, but keep REM together
    motion_threshold = 180
    gap_tolerance = 6

    runs: list[list[sqlite3.Row]] = []
    cur: list[sqlite3.Row] = []
    gap = 0
    for r in samples:
        motion = _motion_magnitude(r)
        is_sleeping = (r["heart_rate_bpm"] or 999) < hr_threshold and (motion is None or motion < motion_threshold)
        if is_sleeping:
            cur.append(r)
            gap = 0
        elif cur:
            gap += 1
            if gap > gap_tolerance:
                runs.append(cur)
                cur = []
                gap = 0
            else:
                cur.append(r)
        else:
            gap = 0
    if cur:
        runs.append(cur)

    best: tuple[datetime, datetime, int] | None = None
    night_start_h, night_end_h = NIGHT_WINDOW_LOCAL[0].hour, NIGHT_WINDOW_LOCAL[1].hour
    for run in runs:
        start = _parse_ts(run[0]).astimezone(local)
        end = _parse_ts(run[-1]).astimezone(local)
        duration_min = (end - start).total_seconds() / 60
        if duration_min < MIN_SLEEP_BLOCK_MINUTES:
            continue
        mid = start + (end - start) / 2
        h = mid.hour
        # Night window spans midnight (20:00 → 11:00). Hours 20-23 OR 0-10.
        in_window = (h >= night_start_h) or (h < night_end_h)
        if not in_window:
            continue
        score = int(duration_min)
        if best is None or score > best[2]:
            best = (start.astimezone(timezone.utc), end.astimezone(timezone.utc), score)

    if best is None:
        return None
    return (best[0], best[1])


# ---------------------------------------------------------------------------
# Stage classification (30-second epochs)
# ---------------------------------------------------------------------------


def _bucket_into_epochs(
    samples: Sequence[sqlite3.Row],
    start: datetime,
    end: datetime,
) -> list[list[sqlite3.Row]]:
    """Group samples into EPOCH_SECONDS-second consecutive buckets between [start, end)."""
    epochs: list[list[sqlite3.Row]] = []
    cur_bucket_start = start
    cur: list[sqlite3.Row] = []
    bucket_end = cur_bucket_start + timedelta(seconds=EPOCH_SECONDS)
    for r in samples:
        t = _parse_ts(r)
        if t < start or t >= end:
            continue
        while t >= bucket_end:
            epochs.append(cur)
            cur = []
            cur_bucket_start = bucket_end
            bucket_end = cur_bucket_start + timedelta(seconds=EPOCH_SECONDS)
        cur.append(r)
    if cur:
        epochs.append(cur)
    return epochs


def _rmssd_quick(rr: Sequence[int]) -> float | None:
    """Cheap RMSSD without the Malik filter — used per-epoch for relative comparison."""
    rr = [r for r in rr if r is not None and 250 < r < 2000]
    if len(rr) < 3:
        return None
    diffs = [rr[i + 1] - rr[i] for i in range(len(rr) - 1)]
    return math.sqrt(sum(d * d for d in diffs) / len(diffs))


def classify_stages(
    samples: Sequence[sqlite3.Row],
    window: tuple[datetime, datetime],
) -> list[dict]:
    """Return a list of stage segments covering the sleep window.

    Output is consolidated: consecutive epochs of the same stage are merged.
    Each entry: {start_utc, end_utc, stage}.
    """
    start, end = window
    epochs = _bucket_into_epochs(samples, start, end)
    if not epochs:
        return []

    # Per-epoch stats
    epoch_stats: list[dict] = []
    for ep in epochs:
        if not ep:
            epoch_stats.append({"hr": None, "motion": None, "rmssd": None})
            continue
        hrs = [r["heart_rate_bpm"] for r in ep if r["heart_rate_bpm"] is not None]
        rrs = [r["rr_interval_ms"] for r in ep if r["rr_interval_ms"] is not None]
        motions = [m for r in ep if (m := _motion_magnitude(r)) is not None]
        epoch_stats.append(
            {
                "hr": statistics.mean(hrs) if hrs else None,
                "motion": statistics.mean(motions) if motions else None,
                "rmssd": _rmssd_quick(rrs),
            }
        )

    # Nightly baselines
    hr_vals = [e["hr"] for e in epoch_stats if e["hr"] is not None]
    rmssd_vals = [e["rmssd"] for e in epoch_stats if e["rmssd"] is not None]
    if not hr_vals:
        return []
    hr_min = min(hr_vals)
    hr_baseline = statistics.median(hr_vals)
    rmssd_baseline = statistics.median(rmssd_vals) if rmssd_vals else 30.0
    has_motion_signal = any(e["motion"] is not None for e in epoch_stats)

    # Classify each epoch
    raw_stages: list[str] = []
    for e in epoch_stats:
        hr, motion, rmssd = e["hr"], e["motion"], e["rmssd"]
        if hr is None:
            raw_stages.append("wake")
            continue
        if (has_motion_signal and motion is not None and motion > 200) or hr > hr_baseline + 12:
            raw_stages.append("wake")
        elif (motion is None or motion < 30) and hr <= hr_min + 5 and (
            rmssd is None or rmssd <= rmssd_baseline
        ):
            raw_stages.append("deep")
        elif (motion is None or motion < 60) and hr >= hr_min + 6 and (
            rmssd is not None and rmssd > rmssd_baseline * 1.1
        ):
            raw_stages.append("rem")
        else:
            raw_stages.append("light")

    # Smooth: a single-epoch wake surrounded by sleep stays as light.
    smoothed = raw_stages[:]
    for i in range(1, len(smoothed) - 1):
        if smoothed[i] == "wake" and smoothed[i - 1] != "wake" and smoothed[i + 1] != "wake":
            smoothed[i] = "light"

    # Consolidate runs
    out: list[dict] = []
    cur_stage = smoothed[0]
    cur_start = start
    for i in range(1, len(smoothed)):
        if smoothed[i] != cur_stage:
            seg_end = start + timedelta(seconds=EPOCH_SECONDS * i)
            out.append(
                {
                    "start_utc": cur_start.isoformat(timespec="milliseconds"),
                    "end_utc": seg_end.isoformat(timespec="milliseconds"),
                    "stage": cur_stage,
                    "source": "heuristic-v1",
                }
            )
            cur_stage = smoothed[i]
            cur_start = seg_end
    out.append(
        {
            "start_utc": cur_start.isoformat(timespec="milliseconds"),
            "end_utc": end.isoformat(timespec="milliseconds"),
            "stage": cur_stage,
            "source": "heuristic-v1",
        }
    )
    return out


def sleep_window_summary(samples: Sequence[sqlite3.Row], window: tuple[datetime, datetime] | None) -> dict:
    if window is None or not samples:
        return {"source": None, "confidence_pct": None}
    start, end = window
    window_samples = [r for r in samples if start <= _parse_ts(r) < end]
    if not window_samples:
        return {"source": None, "confidence_pct": None}

    motion_samples = sum(1 for r in window_samples if _motion_magnitude(r) is not None)
    rr_samples = sum(1 for r in window_samples if r["rr_interval_ms"] is not None)
    hr_samples = sum(1 for r in window_samples if r["heart_rate_bpm"] is not None)
    motion_coverage = motion_samples / len(window_samples)
    rr_coverage = rr_samples / len(window_samples)
    hr_coverage = hr_samples / len(window_samples)
    source = "motion+hr" if motion_coverage >= 0.2 else "hr-only"
    confidence_pct = int(round(min(100.0, 35 + motion_coverage * 35 + rr_coverage * 20 + hr_coverage * 10)))
    return {"source": source, "confidence_pct": confidence_pct}


def stage_totals(stages: Iterable[dict]) -> dict:
    """Return total minutes per stage."""
    totals = {s: 0.0 for s in STAGES}
    for seg in stages:
        start = datetime.fromisoformat(seg["start_utc"])
        end = datetime.fromisoformat(seg["end_utc"])
        totals[seg["stage"]] += (end - start).total_seconds() / 60.0
    return {k: int(round(v)) for k, v in totals.items()}


# ---------------------------------------------------------------------------
# Sleep need / debt / consistency
# ---------------------------------------------------------------------------


BASE_SLEEP_MINUTES = 480  # 8h default need


def sleep_need_minutes(prior_debt_minutes: float, strain_yesterday: float) -> int:
    """Whoop-style sleep-need formula.

    Base 8h. Adds up to 2h for accumulated debt (half of debt, capped 120 min)
    and up to 1h proportional to yesterday's strain (~3 min per strain point,
    capped 60 min).
    """
    debt_bump = min(120.0, max(0.0, prior_debt_minutes) / 2.0)
    strain_bump = min(60.0, max(0.0, strain_yesterday) * 3.0)
    return int(round(BASE_SLEEP_MINUTES + debt_bump + strain_bump))


def sleep_performance(asleep_minutes: int, need_minutes: int) -> float:
    if need_minutes <= 0:
        return 0.0
    return round(min(100.0, 100.0 * asleep_minutes / need_minutes), 1)


def sleep_debt_minutes_7d(
    asleep_history: Sequence[int], need_history: Sequence[int]
) -> int:
    """Sum of max(0, need - asleep) over up to 7 recent days."""
    debt = 0
    for asleep, need in zip(asleep_history[:7], need_history[:7]):
        debt += max(0, (need or 0) - (asleep or 0))
    return debt


def sleep_consistency_pct(
    bedtimes_local: Sequence[datetime], waketimes_local: Sequence[datetime]
) -> float | None:
    """Stddev (in minutes) of bedtimes and waketimes mapped to 0-100.

    Lower stddev = more consistent = higher score. Uses circular wrapping for
    bedtimes that straddle midnight.
    """
    if len(bedtimes_local) < 3 or len(waketimes_local) < 3:
        return None

    def _minutes_of_day(dt: datetime) -> float:
        m = dt.hour * 60 + dt.minute + dt.second / 60.0
        # If bedtime is before noon, treat as "next day" for averaging.
        if m < 720:
            m += 1440
        return m

    bed_m = [_minutes_of_day(b) for b in bedtimes_local]
    wake_m = [w.hour * 60 + w.minute + w.second / 60.0 for w in waketimes_local]
    sigma = (statistics.pstdev(bed_m) + statistics.pstdev(wake_m)) / 2
    return round(max(0.0, min(100.0, 100.0 - sigma / 1.2)), 1)


# ---------------------------------------------------------------------------
# Respiratory rate from RR-interval modulation
# ---------------------------------------------------------------------------


def respiratory_rate(
    samples: Sequence[sqlite3.Row], window: tuple[datetime, datetime] | None
) -> float | None:
    """Estimate breaths/min from RR-interval modulation in deep sleep.

    Uses respiratory sinus arrhythmia (RSA): the heart speeds up on inhale,
    slows on exhale. The RR-interval series oscillates at the breathing
    frequency. We detrend the series and count zero-crossings to estimate
    cycles/sec without needing FFT.

    Returns breaths-per-minute, clamped to a plausible 8-24 range, or None if
    not enough signal.
    """
    if window is None:
        return None
    start, end = window
    rrs: list[tuple[datetime, int]] = []
    for r in samples:
        if r["rr_interval_ms"] is None:
            continue
        t = _parse_ts(r)
        if start <= t < end:
            rrs.append((t, r["rr_interval_ms"]))
    if len(rrs) < 60:
        return None

    # Detrend with a simple moving average (window ~30 beats)
    win = 30
    vals = [v for _, v in rrs]
    detrended: list[float] = []
    for i, v in enumerate(vals):
        lo = max(0, i - win // 2)
        hi = min(len(vals), i + win // 2 + 1)
        baseline = sum(vals[lo:hi]) / (hi - lo)
        detrended.append(v - baseline)

    # Count zero crossings -> half-cycles
    zc = 0
    for i in range(1, len(detrended)):
        if (detrended[i - 1] >= 0 and detrended[i] < 0) or (
            detrended[i - 1] < 0 and detrended[i] >= 0
        ):
            zc += 1

    total_seconds = (rrs[-1][0] - rrs[0][0]).total_seconds()
    if total_seconds <= 0:
        return None
    # Each breathing cycle ~= 2 zero crossings (up and down)
    breaths_per_sec = (zc / 2.0) / total_seconds
    bpm = breaths_per_sec * 60.0
    if not 6.0 <= bpm <= 30.0:
        return None
    return round(max(8.0, min(24.0, bpm)), 1)


# ---------------------------------------------------------------------------
# Persistence-side rollup helpers
# ---------------------------------------------------------------------------


def bed_wake_times_local(stages: Sequence[dict]) -> tuple[datetime | None, datetime | None]:
    """First non-wake start and last non-wake end, in local time."""
    if not stages:
        return (None, None)
    local = _local_tz()
    asleep = [s for s in stages if s["stage"] != "wake"]
    if not asleep:
        return (None, None)
    bed = datetime.fromisoformat(asleep[0]["start_utc"]).astimezone(local)
    wake = datetime.fromisoformat(asleep[-1]["end_utc"]).astimezone(local)
    return (bed, wake)


def compute_sleep_for_day(
    con: sqlite3.Connection, day: date, prior_strain: float = 0.0
) -> dict:
    """Detect sleep window for `day`, classify stages, persist them, and return summary.

    The 'night of day' is interpreted as the sleep window whose midpoint falls
    after 20:00 on (day - 1) or before 11:00 on day. We pull samples from
    18:00 the prior day through 14:00 of the given day for safety.
    """
    local = _local_tz()
    start_local = datetime.combine(day - timedelta(days=1), time(18, 0), tzinfo=local)
    end_local = datetime.combine(day, time(14, 0), tzinfo=local)
    start_utc = start_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    end_utc = end_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    samples = db.samples_between(con, start_utc, end_utc)

    window = detect_sleep_window(samples, day)
    if window is None:
        db.replace_sleep_stages(con, day.isoformat(), [])
        return {
            "date": day.isoformat(),
            "window": None,
            "totals": {s: 0 for s in STAGES},
            "asleep_minutes": 0,
            "bed_local": None,
            "wake_local": None,
            "respiratory_rate": None,
            "stages": [],
        }

    stages = classify_stages(samples, window)
    db.replace_sleep_stages(con, day.isoformat(), stages)
    totals = stage_totals(stages)
    asleep = totals["light"] + totals["deep"] + totals["rem"]
    bed, wake = bed_wake_times_local(stages)
    rr_bpm = respiratory_rate(samples, window)

    return {
        "date": day.isoformat(),
        "window": [window[0].isoformat(timespec="milliseconds"), window[1].isoformat(timespec="milliseconds")],
        "totals": totals,
        "asleep_minutes": asleep,
        "bed_local": bed.isoformat(timespec="minutes") if bed else None,
        "wake_local": wake.isoformat(timespec="minutes") if wake else None,
        "respiratory_rate": rr_bpm,
        "stages": stages,
    }


def history_for_consistency(con: sqlite3.Connection, day: date, days: int = 7) -> dict:
    """Pull recent bed/wake/asleep/need data for consistency + debt calculation."""
    rows = con.execute(
        """
        SELECT date, bedtime_local, wake_local, sleep_minutes, sleep_need_minutes
        FROM daily_metrics
        WHERE date < ? ORDER BY date DESC LIMIT ?
        """,
        (day.isoformat(), days),
    ).fetchall()
    local = _local_tz()
    beds: list[datetime] = []
    wakes: list[datetime] = []
    asleep: list[int] = []
    need: list[int] = []
    for r in rows:
        if r["bedtime_local"]:
            try:
                beds.append(datetime.fromisoformat(r["bedtime_local"]))
            except ValueError:
                pass
        if r["wake_local"]:
            try:
                wakes.append(datetime.fromisoformat(r["wake_local"]))
            except ValueError:
                pass
        asleep.append(r["sleep_minutes"] or 0)
        need.append(r["sleep_need_minutes"] or BASE_SLEEP_MINUTES)
    return {"beds": beds, "wakes": wakes, "asleep": asleep, "need": need}
