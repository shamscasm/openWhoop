"""HRV, recovery, and strain calculations.

These reproduce the *spirit* of Whoop's premium metrics without the
proprietary algorithm. They are based on standard published HRV and
training-load methods so the numbers are interpretable on their own,
even if they don't match Whoop's app exactly.
"""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
from datetime import date, datetime, time, timedelta, timezone
from typing import Sequence

from . import db, sleep as sleep_mod, workouts as workouts_mod, zones

# Fallback sleep window when stage detection fails — used only as a last-resort
# proxy for HRV. Stage-based detection in sleep.py supersedes this.
SLEEP_WINDOW_LOCAL = (time(2, 0), time(6, 0))

# Rolling window length (days) for recovery-score baseline.
RECOVERY_BASELINE_DAYS = 14
ROLLUP_VERSION = 2

# Recovery sub-score weights (must sum to 1.0)
RECOVERY_WEIGHTS = {
    "hrv": 0.40,
    "rhr": 0.20,
    "sleep": 0.30,
    "strain": 0.10,
}


# ---------------------------------------------------------------------------
# HRV
# ---------------------------------------------------------------------------


def filter_rr(rr_ms: Sequence[int]) -> list[int]:
    """Drop ectopic / artifact RR intervals.

    Standard guideline: discard any beat that differs from its predecessor
    by more than 20% (Malik 1996, ESC/NASPE Task Force).
    """
    if not rr_ms:
        return []
    out: list[int] = [rr_ms[0]]
    for r in rr_ms[1:]:
        if out and abs(r - out[-1]) / max(out[-1], 1) <= 0.20:
            out.append(r)
    return out


def rmssd(rr_ms: Sequence[int]) -> float | None:
    """Root mean square of successive RR differences (ms).

    The single most reported time-domain HRV index and the one Whoop
    surfaces in its app.
    """
    rr = filter_rr(rr_ms)
    if len(rr) < 5:
        return None
    diffs = [rr[i + 1] - rr[i] for i in range(len(rr) - 1)]
    mean_sq = sum(d * d for d in diffs) / len(diffs)
    return math.sqrt(mean_sq)


def sdnn(rr_ms: Sequence[int]) -> float | None:
    """Standard deviation of NN intervals (ms)."""
    rr = filter_rr(rr_ms)
    if len(rr) < 5:
        return None
    return statistics.pstdev(rr)


def pnn50(rr_ms: Sequence[int]) -> float | None:
    """Percentage of successive RR intervals differing by > 50 ms."""
    rr = filter_rr(rr_ms)
    if len(rr) < 5:
        return None
    diffs = [abs(rr[i + 1] - rr[i]) for i in range(len(rr) - 1)]
    over = sum(1 for d in diffs if d > 50)
    return 100.0 * over / len(diffs)


# ---------------------------------------------------------------------------
# Strain (cardiac load)
# ---------------------------------------------------------------------------


def strain_score(
    hr_bpm: Sequence[float],
    age: int = 30,
    resting_hr: float | None = None,
) -> float:
    """Whoop-like 0-21 daily strain score.

    Methodology
    -----------
    Whoop calculates strain on a logarithmic 0-21 scale (Borg-style) from
    cardiovascular load. We approximate with:

        load   = sum( max(0, (hr - rest) / (max - rest)) ^ 2 ) * minutes_per_sample
        strain = 21 * (1 - exp(-load / 100))

    The squared term emphasises higher intensities, matching the
    qualitative behaviour of Whoop's published scale (very low for resting
    days, rapidly climbing in zone 4/5).
    """
    if not hr_bpm:
        return 0.0
    samples = [h for h in hr_bpm if h is not None and 30 <= h <= 230]
    if not samples:
        return 0.0
    max_hr = 220 - age
    rest = resting_hr if resting_hr else min(samples)
    if max_hr <= rest:
        return 0.0
    # Each real-time packet is ~1 second; convert to minutes for load.
    minutes = len(samples) / 60.0
    intensities = [max(0.0, (h - rest) / (max_hr - rest)) for h in samples]
    load = sum(i * i for i in intensities) * (minutes / max(len(samples), 1) * 60)
    return round(21.0 * (1.0 - math.exp(-load / 100.0)), 2)


# ---------------------------------------------------------------------------
# Recovery
# ---------------------------------------------------------------------------


def recovery_score(today_rmssd: float, history_rmssd: Sequence[float]) -> float | None:
    """Whoop-like 0-100 recovery score (single-component, legacy).

    Maps today's RMSSD onto a normal distribution built from the rolling
    baseline. 50 means right at baseline; 100 means very high HRV relative
    to recent days; 0 means very low. Z-score is clamped to ±3 sigma.

    `recovery_breakdown` below is the preferred multi-component computation.
    """
    cleaned = [v for v in history_rmssd if v is not None and v > 0]
    if today_rmssd is None or len(cleaned) < 3:
        return None
    mu = statistics.mean(cleaned)
    sigma = statistics.pstdev(cleaned) or 1.0
    z = (today_rmssd - mu) / sigma
    z = max(-3.0, min(3.0, z))
    return round(50.0 + (z / 3.0) * 50.0, 1)


def _z_to_score(value: float, history: Sequence[float], inverted: bool = False) -> float | None:
    """Map a value vs. baseline onto a 0-100 score.

    Higher score is "better recovery." When `inverted=True`, a lower value
    relative to baseline is treated as better (e.g. resting HR).
    """
    cleaned = [v for v in history if v is not None and v > 0]
    if value is None or len(cleaned) < 3:
        return None
    mu = statistics.mean(cleaned)
    sigma = statistics.pstdev(cleaned) or 1.0
    z = (value - mu) / sigma
    if inverted:
        z = -z
    z = max(-3.0, min(3.0, z))
    return round(50.0 + (z / 3.0) * 50.0, 1)


def recovery_breakdown(
    today_rmssd: float | None,
    rmssd_history: Sequence[float],
    today_rhr: float | None,
    rhr_history: Sequence[float],
    sleep_performance_pct: float | None,
    yesterday_strain: float | None,
) -> dict:
    """Whoop-style 4-component recovery score.

    Returns a dict:
      {hrv, rhr, sleep, strain, total}
    Components that can't be computed (insufficient history) are None and
    drop out of the weighted average; remaining weights are renormalised.
    """
    hrv_s = _z_to_score(today_rmssd, rmssd_history)
    rhr_s = _z_to_score(today_rhr, rhr_history, inverted=True)
    sleep_s = round(sleep_performance_pct, 1) if sleep_performance_pct is not None else None
    strain_s = (
        round(max(0.0, min(100.0, 100.0 - (yesterday_strain * 100.0 / 21.0))), 1)
        if yesterday_strain is not None
        else None
    )

    components = {
        "hrv": hrv_s,
        "rhr": rhr_s,
        "sleep": sleep_s,
        "strain": strain_s,
    }
    used = {k: v for k, v in components.items() if v is not None}
    if not used:
        return {**components, "total": None}
    weight_sum = sum(RECOVERY_WEIGHTS[k] for k in used)
    total = sum(v * RECOVERY_WEIGHTS[k] for k, v in used.items()) / weight_sum
    return {**components, "total": round(total, 1)}


# ---------------------------------------------------------------------------
# Sleep approximation
# ---------------------------------------------------------------------------


def estimate_sleep_minutes(samples: Sequence[sqlite3.Row]) -> int:
    """Heuristic sleep estimate: motion under threshold AND HR low.

    Crude, but good enough to give the user a daily sleep-duration number
    from PPG+accelerometer alone.
    """
    if not samples:
        return 0
    motion_threshold = 60  # accelerometer magnitude (raw int16) heuristic
    hr_low_threshold = 70
    sleep_secs = 0
    for s in samples:
        if (
            s["heart_rate_bpm"] is not None
            and s["heart_rate_bpm"] < hr_low_threshold
            and abs(s["accel_x"] or 0) + abs(s["accel_y"] or 0) + abs(s["accel_z"] or 0)
            < motion_threshold * 3
        ):
            sleep_secs += 1
    return sleep_secs // 60


def _step_motion_value(row) -> float | None:
    motion = row["motion"] if "motion" in row.keys() else None
    if motion is not None:
        return abs(float(motion))
    ax = row["accel_x"] if "accel_x" in row.keys() else None
    ay = row["accel_y"] if "accel_y" in row.keys() else None
    az = row["accel_z"] if "accel_z" in row.keys() else None
    if ax is None and ay is None and az is None:
        return None
    return abs(ax or 0) + abs(ay or 0) + abs(az or 0)


def estimate_steps_from_accel(samples: Sequence[sqlite3.Row]) -> dict:
    points: list[tuple[datetime, float]] = []
    for row in samples:
        v = _step_motion_value(row)
        if v is None:
            continue
        points.append((datetime.fromisoformat(row["ts_utc"]), v))
    if len(points) < 20:
        return {"steps": None, "source": None, "confidence_pct": None}
    points.sort(key=lambda p: p[0])
    ema = points[0][1]
    alpha = 0.08
    hp: list[float] = []
    for _, v in points:
        ema = alpha * v + (1 - alpha) * ema
        hp.append(abs(v - ema))
    sorted_hp = sorted(hp)
    p75 = sorted_hp[int((len(sorted_hp) - 1) * 0.75)]
    p90 = sorted_hp[int((len(sorted_hp) - 1) * 0.90)]
    threshold = max(18.0, p75 * 1.6, p90 * 0.75)
    steps = 0
    last_step: datetime | None = None
    for i in range(1, len(hp) - 1):
        if hp[i] < threshold or hp[i] < hp[i - 1] or hp[i] < hp[i + 1]:
            continue
        t = points[i][0]
        if last_step is not None:
            dt_ms = (t - last_step).total_seconds() * 1000
            if dt_ms < 280 or dt_ms > 2500:
                continue
        steps += 1
        last_step = t
    span_hours = (points[-1][0] - points[0][0]).total_seconds() / 3600
    confidence = round(min(85, min(1, len(points) / 2000) * 45 + min(1, span_hours / 8) * 35 + (20 if p90 > 0 else 0)))
    return {
        "steps": steps or None,
        "source": "strap_accel" if steps else None,
        "confidence_pct": confidence if steps else None,
    }


# ---------------------------------------------------------------------------
# Daily roll-up
# ---------------------------------------------------------------------------


def compute_daily(
    con: sqlite3.Connection,
    day: date,
    age: int | None = None,
) -> dict | None:
    """Compute and persist all v0.2 daily metrics for a calendar day (local).

    `age` is optional — if not supplied we pull from the stored profile.
    """
    profile = db.get_profile(con)
    age = age if age is not None else (profile.get("age") or 30)
    sex = profile.get("sex")
    weight_kg = profile.get("weight_kg")
    max_hr_override = profile.get("max_hr_override")

    local = datetime.now().astimezone().tzinfo
    start_local = datetime.combine(day, time(0, 0), tzinfo=local)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    end_utc = end_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    rows = db.samples_between(con, start_utc, end_utc)
    if not rows:
        return None
    existing_today = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?", (day.isoformat(),)
    ).fetchone()

    hrs = [r["heart_rate_bpm"] for r in rows if r["heart_rate_bpm"] is not None]
    spo2s = [r["spo2_pct"] for r in rows if r["spo2_pct"] is not None]
    temps = [r["skin_temp_c"] for r in rows if r["skin_temp_c"] is not None]

    # --- Sleep: detect window, classify stages, derive nightly metrics -----
    sleep_summary = sleep_mod.compute_sleep_for_day(con, day, prior_strain=0.0)
    sleep_window = None
    if sleep_summary["window"]:
        sleep_window = (
            datetime.fromisoformat(sleep_summary["window"][0]),
            datetime.fromisoformat(sleep_summary["window"][1]),
        )
    totals = sleep_summary["totals"]
    asleep_minutes = sleep_summary["asleep_minutes"]
    respiratory = sleep_summary["respiratory_rate"]
    sleep_meta = sleep_mod.sleep_window_summary(rows, sleep_window)

    # RR intervals from inside the detected sleep window are the HRV source.
    if sleep_window:
        sleep_rrs = [
            r["rr_interval_ms"]
            for r in rows
            if r["rr_interval_ms"] is not None
            and sleep_window[0] <= datetime.fromisoformat(r["ts_utc"]) < sleep_window[1]
        ]
    else:
        # Fall back to fixed 02:00-06:00 local
        sleep_start_local = datetime.combine(day, SLEEP_WINDOW_LOCAL[0], tzinfo=local)
        sleep_end_local = datetime.combine(day, SLEEP_WINDOW_LOCAL[1], tzinfo=local)
        sleep_rrs = [
            r["rr_interval_ms"]
            for r in rows
            if r["rr_interval_ms"] is not None
            and sleep_start_local
            <= datetime.fromisoformat(r["ts_utc"]).astimezone(local)
            < sleep_end_local
        ]
    today_rmssd = rmssd(sleep_rrs)

    # --- Baselines from prior days for recovery components ------------------
    history_rows = con.execute(
        "SELECT rmssd_ms, resting_hr, strain_score, avg_skin_temp_c "
        "FROM daily_metrics WHERE date < ? ORDER BY date DESC LIMIT ?",
        (day.isoformat(), RECOVERY_BASELINE_DAYS),
    ).fetchall()
    rmssd_hist = [r["rmssd_ms"] for r in history_rows if r["rmssd_ms"] is not None]
    rhr_hist = [r["resting_hr"] for r in history_rows if r["resting_hr"] is not None]
    skin_temp_hist = [
        r["avg_skin_temp_c"] for r in history_rows if r["avg_skin_temp_c"] is not None
    ]

    # Yesterday's strain
    yesterday_row = con.execute(
        "SELECT strain_score FROM daily_metrics WHERE date = ?",
        ((day - timedelta(days=1)).isoformat(),),
    ).fetchone()
    yesterday_strain = yesterday_row["strain_score"] if yesterday_row else None

    # --- Resting HR (5th percentile across full day) -----------------------
    resting = None
    if hrs:
        srt = sorted(hrs)
        resting = srt[max(0, int(len(srt) * 0.05) - 1)]

    # --- Sleep need / debt / consistency / performance ---------------------
    history = sleep_mod.history_for_consistency(con, day, days=7)
    debt_prior = sleep_mod.sleep_debt_minutes_7d(history["asleep"], history["need"])
    need_minutes = sleep_mod.sleep_need_minutes(
        prior_debt_minutes=debt_prior,
        strain_yesterday=yesterday_strain or 0.0,
    )
    performance = sleep_mod.sleep_performance(asleep_minutes, need_minutes)
    # Sleep debt INCLUDING today (using today's need + asleep)
    asleep_history = ([asleep_minutes] + history["asleep"])[:7]
    need_history = ([need_minutes] + history["need"])[:7]
    debt = sleep_mod.sleep_debt_minutes_7d(asleep_history, need_history)
    consistency = sleep_mod.sleep_consistency_pct(history["beds"], history["wakes"])

    # --- HR zones over the whole day & calories ----------------------------
    zone_seconds = zones.zone_seconds_from_hr_series(hrs, zones.max_hr(age, max_hr_override))
    # Scale by median sample interval if it's not 1s
    if len(rows) >= 2:
        intervals = [
            (datetime.fromisoformat(rows[i]["ts_utc"]) - datetime.fromisoformat(rows[i - 1]["ts_utc"])).total_seconds()
            for i in range(1, min(len(rows), 200))
        ]
        median_dt = statistics.median(intervals) if intervals else 1.0
    else:
        median_dt = 1.0
    median_dt = max(0.5, min(10.0, median_dt))
    zone_minutes_arr = [round((c * median_dt) / 60.0, 1) for c in zone_seconds]
    calories_total = round(
        zones.calories_from_hr_series(hrs, age, weight_kg, sex) * median_dt, 1
    )

    # --- Strain (whole day) & workouts -------------------------------------
    today_strain = strain_score(hrs, age=age, resting_hr=resting)
    detected = workouts_mod.detect_workouts(
        rows,
        age=age,
        max_hr_override=max_hr_override,
        sleep_window=sleep_window,
        weight_kg=weight_kg,
        sex=sex,
    )
    workouts_mod.persist_workouts_for_day(con, day.isoformat(), detected)

    # --- Skin temp deviation ----------------------------------------------
    today_skin_temp = statistics.mean(temps) if temps else None
    skin_deviation = (
        round(today_skin_temp - statistics.mean(skin_temp_hist), 2)
        if today_skin_temp is not None and skin_temp_hist
        else None
    )

    # --- Stress (continuous wake-hour samples; we store the average only) --
    baseline_rmssd = statistics.mean(rmssd_hist) if rmssd_hist else (today_rmssd or 0.0)
    stress = zones.stress_samples(rows, baseline_rmssd, sleep_window=sleep_window)
    stress_avg = round(statistics.mean([s["stress"] for s in stress]), 1) if stress else None

    # --- Recovery breakdown ------------------------------------------------
    breakdown = recovery_breakdown(
        today_rmssd=today_rmssd,
        rmssd_history=rmssd_hist,
        today_rhr=resting,
        rhr_history=rhr_hist,
        sleep_performance_pct=performance,
        yesterday_strain=yesterday_strain,
    )

    bed_local = sleep_summary["bed_local"]
    wake_local = sleep_summary["wake_local"]
    accel_steps = estimate_steps_from_accel(rows)
    existing_source = existing_today["steps_source"] if existing_today and "steps_source" in existing_today.keys() else None
    if existing_source == "apple_health":
        steps = existing_today["steps"]
        steps_source = "apple_health"
        steps_confidence = 100
    else:
        steps = accel_steps["steps"] or (existing_today["steps"] if existing_today and "steps" in existing_today.keys() else None)
        steps_source = accel_steps["source"] or existing_source
        steps_confidence = accel_steps["confidence_pct"] or (existing_today["steps_confidence_pct"] if existing_today and "steps_confidence_pct" in existing_today.keys() else None)
    active_energy_kcal = existing_today["active_energy_kcal"] if existing_today and "active_energy_kcal" in existing_today.keys() else None

    metrics = {
        "date": day.isoformat(),
        "rollup_version": ROLLUP_VERSION,
        "avg_hr": round(statistics.mean(hrs), 1) if hrs else None,
        "min_hr": round(min(hrs), 1) if hrs else None,
        "max_hr": round(max(hrs), 1) if hrs else None,
        "resting_hr": round(resting, 1) if resting else None,
        "rmssd_ms": round(today_rmssd, 1) if today_rmssd else None,
        "sdnn_ms": round(sdnn(sleep_rrs) or 0.0, 1) if sleep_rrs else None,
        "pnn50_pct": round(pnn50(sleep_rrs) or 0.0, 1) if sleep_rrs else None,
        "avg_spo2": round(statistics.mean(spo2s), 1) if spo2s else None,
        "avg_skin_temp_c": round(today_skin_temp, 2) if today_skin_temp is not None else None,
        "sample_count": len(rows),
        "strain_score": today_strain,
        "recovery_score": breakdown["total"],
        "sleep_minutes": asleep_minutes,
        "sleep_source": sleep_meta["source"],
        "sleep_confidence_pct": sleep_meta["confidence_pct"],
        "steps": steps,
        "steps_source": steps_source,
        "steps_confidence_pct": steps_confidence,
        "active_energy_kcal": active_energy_kcal,
        # v0.2 columns
        "deep_sleep_minutes": totals["deep"],
        "rem_sleep_minutes": totals["rem"],
        "light_sleep_minutes": totals["light"],
        "wake_minutes": totals["wake"],
        "sleep_need_minutes": need_minutes,
        "sleep_performance_pct": performance,
        "sleep_debt_minutes": debt,
        "sleep_consistency_pct": consistency,
        "respiratory_rate": respiratory,
        "skin_temp_deviation_c": skin_deviation,
        "calories": calories_total,
        "zone_minutes": json.dumps(zone_minutes_arr),
        "recovery_hrv_component": breakdown["hrv"],
        "recovery_rhr_component": breakdown["rhr"],
        "recovery_sleep_component": breakdown["sleep"],
        "recovery_strain_component": breakdown["strain"],
        "stress_avg": stress_avg,
        "bedtime_local": bed_local,
        "wake_local": wake_local,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    db.upsert_daily(con, metrics)
    return metrics
