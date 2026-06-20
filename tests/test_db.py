"""End-to-end DB test: synthesize packets, insert, roll up, read back."""

from __future__ import annotations

import math
import random
import tempfile
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

from whoop_reader.parser import RealtimePacket

from whoof import db, metrics


def _packet(hr: float, rr: int, seq: int = 0) -> RealtimePacket:
    return RealtimePacket(
        sequence=seq,
        heart_rate_bpm=hr,
        rr_interval_ms=rr,
        spo2_pct=98,
        skin_temp_c=33.5,
        accel_x=10,
        accel_y=10,
        accel_z=10,
        motion_intensity=0,
        ppg_amplitude=1000,
        ambient_light=100,
        ppg_quality=200,
        unknown_20_91=b"\x00" * 72,
        crc_valid=True,
        raw=b"\x00" * 96,
    )


def test_schema_creates_tables():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.db"
        con = db.connect(path)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert {"samples", "sessions", "device_events", "daily_metrics"} <= tables


def test_insert_and_read_back():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.db"
        con = db.connect(path)
        sess = db.start_session(con, label="test")
        for i in range(10):
            db.insert_packet(con, _packet(60 + i, 1000 - i * 5, seq=i), session_id=sess)
        db.end_session(con, sess, 10)

        last = db.latest_sample(con)
        assert last is not None
        assert last["session_id"] == sess
        total = con.execute("SELECT COUNT(*) AS n FROM samples").fetchone()["n"]
        assert total == 10


def test_full_rollup_pipeline():
    """Insert a full synthetic 'day' of data and verify rollup produces sensible numbers."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.db"
        con = db.connect(path)
        sess = db.start_session(con, label="overnight")

        # Use a clearly-past date so timezone math is unambiguous.
        local = datetime.now().astimezone().tzinfo
        target_day = datetime.now(local).date() - timedelta(days=1)
        midnight_local = datetime.combine(target_day, time(0, 0), tzinfo=local)

        random.seed(42)
        # 24h, 1 sample/sec is overkill; use 1 sample / 10s = 8640 samples.
        for s in range(0, 24 * 3600, 10):
            ts_local = midnight_local + timedelta(seconds=s)
            ts_utc = ts_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
            hour = ts_local.hour
            # Asleep 0-7: low HR around 55, RR ~1090 with light jitter (good HRV).
            # Daytime 7-22: HR around 75 with bigger swings (some exertion).
            # Late evening 22-24: HR around 70.
            if hour < 7:
                hr = 55 + random.gauss(0, 3)
                rr = int(60_000 / hr + random.gauss(0, 30))
            elif hour < 22:
                hr = 75 + random.gauss(0, 10) + (40 if 16 <= hour < 17 else 0)  # 1h workout
                rr = int(60_000 / hr + random.gauss(0, 15))
            else:
                hr = 70 + random.gauss(0, 5)
                rr = int(60_000 / hr + random.gauss(0, 20))
            pkt = _packet(round(hr, 1), rr, seq=s % 256)
            db.insert_packet(con, pkt, session_id=sess, ts=ts_utc)
        db.end_session(con, sess, 24 * 360)

        # Seed some prior-day RMSSDs so recovery has a baseline.
        for i in range(1, 8):
            prev = target_day - timedelta(days=i)
            db.upsert_daily(con, {
                "date": prev.isoformat(),
                "rmssd_ms": 45.0 + random.gauss(0, 5),
                "avg_hr": 70,
                "min_hr": 50,
                "max_hr": 110,
                "resting_hr": 55,
                "sdnn_ms": 40.0,
                "pnn50_pct": 20.0,
                "avg_spo2": 97.0,
                "avg_skin_temp_c": 33.0,
                "sample_count": 8000,
                "strain_score": 8.0,
                "recovery_score": 60.0,
                "sleep_minutes": 420,
                "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            })

        m = metrics.compute_daily(con, target_day, age=30)
        assert m is not None
        # Resting HR should land in the low 50s given the sleep distribution.
        assert m["resting_hr"] is not None and 48 <= m["resting_hr"] <= 65
        # Average HR should be somewhere in the 70s.
        assert 60 <= m["avg_hr"] <= 90
        # RMSSD should compute (we have plenty of sleep-window RR data).
        assert m["rmssd_ms"] is not None and m["rmssd_ms"] > 0
        # Recovery score should be on the 0-100 scale.
        assert m["recovery_score"] is not None and 0 <= m["recovery_score"] <= 100
        # Strain score on the 0-21 scale.
        assert 0 <= m["strain_score"] <= 21


def test_event_log():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "w.db"
        con = db.connect(path)
        db.log_event(con, "connect", "AA:BB")
        db.log_event(con, "battery", "85%")
        bat = db.latest_battery(con)
        assert bat is not None
        assert bat["detail"] == "85%"
