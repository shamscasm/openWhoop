"""SQLite persistence for Whoop sensor samples and derived metrics."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from whoop_reader.parser import RealtimePacket

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "whoop.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_utc          TEXT    NOT NULL,
    session_id      INTEGER,
    sequence        INTEGER,
    heart_rate_bpm  REAL,
    rr_interval_ms  INTEGER,
    spo2_pct        INTEGER,
    skin_temp_c     REAL,
    accel_x         INTEGER,
    accel_y         INTEGER,
    accel_z         INTEGER,
    motion          INTEGER,
    ppg_amp         INTEGER,
    ambient_light   INTEGER,
    ppg_quality     INTEGER,
    crc_ok          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_samples_ts      ON samples(ts_utc);
CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(session_id);

CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    label       TEXT,
    notes       TEXT,
    sample_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_utc      TEXT    NOT NULL,
    kind        TEXT    NOT NULL,        -- 'connect', 'disconnect', 'battery', 'error'
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON device_events(ts_utc);
CREATE INDEX IF NOT EXISTS idx_events_kind ON device_events(kind);

CREATE TABLE IF NOT EXISTS daily_metrics (
    date            TEXT PRIMARY KEY,    -- YYYY-MM-DD (local)
    rollup_version  INTEGER,
    avg_hr          REAL,
    min_hr          REAL,
    max_hr          REAL,
    resting_hr      REAL,                -- 5th percentile of HR for the day
    rmssd_ms        REAL,                -- HRV during sleep window
    sdnn_ms         REAL,
    pnn50_pct       REAL,
    avg_spo2        REAL,
    avg_skin_temp_c REAL,
    sample_count    INTEGER,
    strain_score    REAL,                -- 0-21 (Whoop-like)
    recovery_score  REAL,                -- 0-100 (Whoop-like)
    sleep_minutes   INTEGER,             -- approximated from low-motion + low-HR
    sleep_source    TEXT,
    sleep_confidence_pct REAL,
    steps           INTEGER,
    steps_source    TEXT,
    steps_confidence_pct REAL,
    active_energy_kcal REAL,
    computed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
    id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
    age             INTEGER,
    sex             TEXT,                -- 'M' | 'F' | NULL
    weight_kg       REAL,
    height_cm       REAL,
    max_hr_override INTEGER,
    updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sleep_stages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,        -- night-of date (YYYY-MM-DD, local)
    start_utc   TEXT    NOT NULL,
    end_utc     TEXT    NOT NULL,
    stage       TEXT    NOT NULL,        -- 'wake' | 'light' | 'deep' | 'rem'
    source      TEXT                     -- e.g. 'heuristic-v1'
);
CREATE INDEX IF NOT EXISTS idx_sleep_stages_date ON sleep_stages(date);

CREATE TABLE IF NOT EXISTS workouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT    NOT NULL,    -- date the workout started (local)
    start_utc       TEXT    NOT NULL,
    end_utc         TEXT    NOT NULL,
    duration_seconds INTEGER,
    avg_hr          REAL,
    max_hr          REAL,
    strain          REAL,
    calories        REAL,
    zone_seconds    TEXT,                -- JSON [z1,z2,z3,z4,z5]
    label           TEXT,
    auto_detected   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
"""

# Columns to add to daily_metrics for v0.2. Each runs only if missing.
_DAILY_METRICS_V02_COLUMNS = [
    ("rollup_version",            "INTEGER"),
    ("deep_sleep_minutes",        "INTEGER"),
    ("rem_sleep_minutes",         "INTEGER"),
    ("light_sleep_minutes",       "INTEGER"),
    ("wake_minutes",              "INTEGER"),
    ("sleep_need_minutes",        "INTEGER"),
    ("sleep_performance_pct",     "REAL"),
    ("sleep_debt_minutes",        "INTEGER"),
    ("sleep_consistency_pct",     "REAL"),
    ("sleep_source",              "TEXT"),
    ("sleep_confidence_pct",      "REAL"),
    ("steps",                     "INTEGER"),
    ("steps_source",              "TEXT"),
    ("steps_confidence_pct",      "REAL"),
    ("active_energy_kcal",        "REAL"),
    ("respiratory_rate",          "REAL"),
    ("skin_temp_deviation_c",     "REAL"),
    ("calories",                  "REAL"),
    ("zone_minutes",              "TEXT"),  # JSON [z1,z2,z3,z4,z5]
    ("recovery_hrv_component",    "REAL"),
    ("recovery_rhr_component",    "REAL"),
    ("recovery_sleep_component",  "REAL"),
    ("recovery_strain_component", "REAL"),
    ("stress_avg",                "REAL"),
    ("bedtime_local",             "TEXT"),   # ISO local time the user fell asleep
    ("wake_local",                "TEXT"),   # ISO local time the user woke up
]


def _migrate_daily_metrics(con: sqlite3.Connection) -> None:
    """Add v0.2 columns to daily_metrics if they don't yet exist."""
    existing = {r["name"] for r in con.execute("PRAGMA table_info(daily_metrics)")}
    for col, sql_type in _DAILY_METRICS_V02_COLUMNS:
        if col not in existing:
            con.execute(f"ALTER TABLE daily_metrics ADD COLUMN {col} {sql_type}")


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Open the database, creating the schema on first use."""
    db_path = Path(path) if path else DEFAULT_DB
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path, isolation_level=None)  # autocommit
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA synchronous=NORMAL;")
    con.executescript(SCHEMA)
    _migrate_daily_metrics(con)
    return con


@contextmanager
def session(path: Path | str | None = None) -> Iterator[sqlite3.Connection]:
    con = connect(path)
    try:
        yield con
    finally:
        con.close()


# -- Sessions ---------------------------------------------------------------


def start_session(con: sqlite3.Connection, label: str | None = None) -> int:
    cur = con.execute(
        "INSERT INTO sessions(started_at, label) VALUES (?, ?)",
        (_utc_now(), label),
    )
    return int(cur.lastrowid)


def end_session(con: sqlite3.Connection, session_id: int, sample_count: int) -> None:
    con.execute(
        "UPDATE sessions SET ended_at = ?, sample_count = ? WHERE id = ?",
        (_utc_now(), sample_count, session_id),
    )


# -- Samples ----------------------------------------------------------------


def insert_packet(
    con: sqlite3.Connection,
    pkt: RealtimePacket,
    session_id: Optional[int] = None,
    ts: Optional[str] = None,
) -> None:
    con.execute(
        """
        INSERT INTO samples (
            ts_utc, session_id, sequence,
            heart_rate_bpm, rr_interval_ms, spo2_pct, skin_temp_c,
            accel_x, accel_y, accel_z, motion,
            ppg_amp, ambient_light, ppg_quality, crc_ok
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            ts or _utc_now(),
            session_id,
            pkt.sequence,
            pkt.heart_rate_bpm,
            pkt.rr_interval_ms,
            pkt.spo2_pct,
            pkt.skin_temp_c,
            pkt.accel_x,
            pkt.accel_y,
            pkt.accel_z,
            pkt.motion_intensity,
            pkt.ppg_amplitude,
            pkt.ambient_light,
            pkt.ppg_quality,
            1 if pkt.crc_valid else 0,
        ),
    )


# -- Events -----------------------------------------------------------------


def log_event(con: sqlite3.Connection, kind: str, detail: str | None = None) -> None:
    con.execute(
        "INSERT INTO device_events(ts_utc, kind, detail) VALUES (?, ?, ?)",
        (_utc_now(), kind, detail),
    )


# -- Read helpers used by dashboard / metrics ------------------------------


def samples_between(
    con: sqlite3.Connection, start_iso: str, end_iso: str
) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM samples WHERE ts_utc >= ? AND ts_utc < ? ORDER BY ts_utc",
        (start_iso, end_iso),
    ).fetchall()


def latest_sample(con: sqlite3.Connection) -> sqlite3.Row | None:
    return con.execute(
        "SELECT * FROM samples ORDER BY ts_utc DESC LIMIT 1"
    ).fetchone()


def latest_battery(con: sqlite3.Connection) -> sqlite3.Row | None:
    return con.execute(
        "SELECT * FROM device_events WHERE kind = 'battery' "
        "ORDER BY ts_utc DESC LIMIT 1"
    ).fetchone()


def upsert_daily(con: sqlite3.Connection, metrics: dict) -> None:
    cols = list(metrics.keys())
    placeholders = ",".join(["?"] * len(cols))
    updates = ",".join(f"{c}=excluded.{c}" for c in cols if c != "date")
    con.execute(
        f"INSERT INTO daily_metrics ({','.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT(date) DO UPDATE SET {updates}",
        tuple(metrics.values()),
    )


def daily_history(con: sqlite3.Connection, days: int) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM daily_metrics ORDER BY date DESC LIMIT ?",
        (days,),
    ).fetchall()


# -- Profile (singleton) ----------------------------------------------------


DEFAULT_PROFILE = {
    "age": 30,
    "sex": None,
    "weight_kg": None,
    "height_cm": None,
    "max_hr_override": None,
}


def get_profile(con: sqlite3.Connection) -> dict:
    row = con.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    if row is None:
        return {**DEFAULT_PROFILE, "updated_at": None}
    return dict(row)


def upsert_profile(con: sqlite3.Connection, **fields) -> dict:
    """Insert or update the singleton profile row. Unknown keys are ignored."""
    allowed = {"age", "sex", "weight_kg", "height_cm", "max_hr_override"}
    payload = {k: v for k, v in fields.items() if k in allowed}
    current = get_profile(con)
    merged = {**current, **payload}
    con.execute(
        """
        INSERT INTO profile (id, age, sex, weight_kg, height_cm, max_hr_override, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            age=excluded.age,
            sex=excluded.sex,
            weight_kg=excluded.weight_kg,
            height_cm=excluded.height_cm,
            max_hr_override=excluded.max_hr_override,
            updated_at=excluded.updated_at
        """,
        (
            merged.get("age"),
            merged.get("sex"),
            merged.get("weight_kg"),
            merged.get("height_cm"),
            merged.get("max_hr_override"),
            _utc_now(),
        ),
    )
    return get_profile(con)


# -- Sleep stages -----------------------------------------------------------


def replace_sleep_stages(
    con: sqlite3.Connection, day: str, stages: list[dict]
) -> None:
    """Atomically replace all stage rows for a given night-of date."""
    con.execute("BEGIN")
    try:
        con.execute("DELETE FROM sleep_stages WHERE date = ?", (day,))
        if stages:
            con.executemany(
                "INSERT INTO sleep_stages(date, start_utc, end_utc, stage, source) "
                "VALUES (?, ?, ?, ?, ?)",
                [
                    (day, s["start_utc"], s["end_utc"], s["stage"], s.get("source"))
                    for s in stages
                ],
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def sleep_stages_for_night(con: sqlite3.Connection, day: str) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM sleep_stages WHERE date = ? ORDER BY start_utc",
        (day,),
    ).fetchall()


# -- Workouts ---------------------------------------------------------------


def insert_workout(con: sqlite3.Connection, w: dict) -> int:
    cur = con.execute(
        """
        INSERT INTO workouts(
            date, start_utc, end_utc, duration_seconds,
            avg_hr, max_hr, strain, calories, zone_seconds, label, auto_detected
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            w["date"], w["start_utc"], w["end_utc"], w.get("duration_seconds"),
            w.get("avg_hr"), w.get("max_hr"), w.get("strain"), w.get("calories"),
            w.get("zone_seconds"), w.get("label"), 1 if w.get("auto_detected", True) else 0,
        ),
    )
    return int(cur.lastrowid)


def delete_auto_workouts_on_date(con: sqlite3.Connection, day: str) -> None:
    """Idempotent re-runs: clear auto-detected workouts before recomputing."""
    con.execute(
        "DELETE FROM workouts WHERE date = ? AND auto_detected = 1",
        (day,),
    )


def workouts_for_range(
    con: sqlite3.Connection, start_date: str, end_date: str
) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM workouts WHERE date >= ? AND date <= ? ORDER BY start_utc DESC",
        (start_date, end_date),
    ).fetchall()


# -- Time helper ------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
