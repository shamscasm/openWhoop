"""Tiny web dashboard for browsing Whoop data.

Built on stdlib http.server so there are no extra runtime dependencies.
The HTML/JS lives in web/ and renders via small JSON endpoints served here.
"""

from __future__ import annotations

import hmac
import json
import logging
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import db, metrics, zones

logger = logging.getLogger(__name__)

def _safe_int(value: str | None, default: int, min_val: int = 0, max_val: int = 100_000) -> int:
    """Parse an int from a query string value, clamping to [min_val, max_val]."""
    try:
        v = int(value) if value is not None else default
        return max(min_val, min(max_val, v))
    except (ValueError, TypeError):
        return default

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HEALTH_FILE = DATA_DIR / "health-latest.json"

# Apple Health metric names we accept from Health Auto Export.
# Map → internal key.
HEALTH_METRIC_MAP = {
    "body mass": "weight_kg",
    "weight": "weight_kg",
    "height": "height_cm",
    "resting heart rate": "resting_hr",
    "vo2 max": "vo2_max",
    "step count": "steps",
    "steps": "steps",
    "active energy": "active_energy_kcal",
}


def _to_local_iso(dt_utc_iso: str) -> str:
    try:
        return datetime.fromisoformat(dt_utc_iso).astimezone().isoformat(timespec="seconds")
    except (ValueError, TypeError):
        return dt_utc_iso


def _today_range_utc(day: date | None = None) -> tuple[str, str]:
    local = datetime.now().astimezone().tzinfo
    d = day or date.today()
    start_local = datetime.combine(d, time(0, 0), tzinfo=local)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
        end_local.astimezone(timezone.utc).isoformat(timespec="milliseconds"),
    )


def _row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def _parse_date(s: str | None) -> date:
    if not s:
        return date.today()
    try:
        return date.fromisoformat(s)
    except (ValueError, TypeError):
        raise ValueError(f"Invalid date format: {s!r}. Expected YYYY-MM-DD.")


def _decode_json_field(v):
    if v is None:
        return None
    try:
        return json.loads(v)
    except (ValueError, TypeError):
        return v


# ---------------------------------------------------------------------------
# Endpoint handlers
# ---------------------------------------------------------------------------


def api_status(con: sqlite3.Connection) -> dict:
    latest = db.latest_sample(con)
    battery = db.latest_battery(con)
    last_event = con.execute(
        "SELECT * FROM device_events ORDER BY ts_utc DESC LIMIT 1"
    ).fetchone()
    sample_count = con.execute("SELECT COUNT(*) AS n FROM samples").fetchone()["n"]
    days_recorded = con.execute(
        "SELECT COUNT(*) AS n FROM daily_metrics"
    ).fetchone()["n"]
    return {
        "latest_sample": _row(latest),
        "latest_battery": _row(battery),
        "latest_event": _row(last_event),
        "sample_count": sample_count,
        "days_recorded": days_recorded,
        "now_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def api_today(con: sqlite3.Connection, downsample: int = 30) -> dict:
    start, end = _today_range_utc()
    rows = db.samples_between(con, start, end)
    points = []
    for i, r in enumerate(rows):
        if i % max(1, downsample) != 0:
            continue
        points.append(
            {
                "t": _to_local_iso(r["ts_utc"]),
                "hr": r["heart_rate_bpm"],
                "rr": r["rr_interval_ms"],
                "spo2": r["spo2_pct"],
                "temp": r["skin_temp_c"],
            }
        )
    today_metrics = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?",
        (date.today().isoformat(),),
    ).fetchone()
    m = _row(today_metrics)
    if m and m.get("zone_minutes"):
        m["zone_minutes"] = _decode_json_field(m["zone_minutes"])
    return {"points": points, "sample_count": len(rows), "metrics": m}


def api_history(con: sqlite3.Connection, days: int = 30) -> dict:
    rows = db.daily_history(con, days)
    out = []
    for r in rows:
        d = dict(r)
        if d.get("zone_minutes"):
            d["zone_minutes"] = _decode_json_field(d["zone_minutes"])
        out.append(d)
    return {"days": out}


def api_recompute(con: sqlite3.Connection, age: int | None = None) -> dict:
    today = date.today()
    computed = []
    for offset in range(7):
        d = today - timedelta(days=offset)
        m = metrics.compute_daily(con, d, age=age)
        if m is not None:
            computed.append(m["date"])
    return {"computed": computed}


# ---- v0.2 endpoints --------------------------------------------------------


def api_overview(con: sqlite3.Connection) -> dict:
    today = date.today()
    today_m = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?", (today.isoformat(),)
    ).fetchone()
    if today_m:
        m = dict(today_m)
        if m.get("zone_minutes"):
            m["zone_minutes"] = _decode_json_field(m["zone_minutes"])
    else:
        m = None
    latest = db.latest_sample(con)
    battery = db.latest_battery(con)
    workouts = db.workouts_for_range(
        con,
        (today - timedelta(days=2)).isoformat(),
        today.isoformat(),
    )
    # 7-day trend for baseline comparisons in the UI
    trend_rows = con.execute(
        "SELECT date, recovery_score, rmssd_ms, resting_hr, strain_score, "
        "sleep_minutes, sleep_performance_pct, skin_temp_deviation_c, "
        "respiratory_rate, avg_skin_temp_c, stress_avg, calories, "
        "deep_sleep_minutes, rem_sleep_minutes "
        "FROM daily_metrics ORDER BY date DESC LIMIT 7"
    ).fetchall()
    return {
        "date": today.isoformat(),
        "metrics": m,
        "latest_sample": _row(latest),
        "battery": _row(battery),
        "trend7": [dict(r) for r in reversed(trend_rows)],
        "recent_workouts": [
            {
                **dict(w),
                "zone_seconds": _decode_json_field(w["zone_seconds"]),
            }
            for w in workouts[:5]
        ],
    }


def api_sleep(con: sqlite3.Connection, day_iso: str | None = None) -> dict:
    day = _parse_date(day_iso)
    m = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?", (day.isoformat(),)
    ).fetchone()
    stages = db.sleep_stages_for_night(con, day.isoformat())
    summary = dict(m) if m else None
    return {
        "date": day.isoformat(),
        "summary": summary,
        "stages": [
            {
                "start": _to_local_iso(s["start_utc"]),
                "end": _to_local_iso(s["end_utc"]),
                "stage": s["stage"],
            }
            for s in stages
        ],
    }


def api_recovery(con: sqlite3.Connection, day_iso: str | None = None) -> dict:
    day = _parse_date(day_iso)
    m = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?", (day.isoformat(),)
    ).fetchone()
    if not m:
        return {"date": day.isoformat(), "summary": None, "trend": []}
    trend_rows = con.execute(
        "SELECT date, rmssd_ms, resting_hr, recovery_score, "
        "recovery_hrv_component, recovery_rhr_component, "
        "recovery_sleep_component, recovery_strain_component, "
        "skin_temp_deviation_c "
        "FROM daily_metrics WHERE date <= ? ORDER BY date DESC LIMIT 30",
        (day.isoformat(),),
    ).fetchall()
    return {
        "date": day.isoformat(),
        "summary": dict(m),
        "trend": [dict(r) for r in reversed(trend_rows)],
    }


def api_strain(con: sqlite3.Connection, day_iso: str | None = None) -> dict:
    day = _parse_date(day_iso)
    start, end = _today_range_utc(day)
    rows = db.samples_between(con, start, end)
    # Build a coarse strain curve: cumulative cardiovascular load per 10 min.
    bucket_minutes = 10
    bucket_seconds = bucket_minutes * 60
    profile = db.get_profile(con)
    age = profile.get("age") or 30
    max_bpm = zones.max_hr(age, profile.get("max_hr_override"))
    # Per-sample interval
    series: list[dict] = []
    if rows:
        local = datetime.now().astimezone().tzinfo
        bucket_start = datetime.combine(day, time(0, 0), tzinfo=local)
        cum_load = 0.0
        bi = 0
        bucket_end = bucket_start + timedelta(seconds=bucket_seconds)
        bucket_hrs: list[float] = []
        for r in rows:
            t = datetime.fromisoformat(r["ts_utc"]).astimezone(local)
            while t >= bucket_end:
                if bucket_hrs:
                    # Squared-intensity load contribution
                    intensities = [max(0.0, (h - 50) / (max_bpm - 50)) for h in bucket_hrs]
                    cum_load += sum(i * i for i in intensities) * (1.0 / 60.0)
                series.append(
                    {
                        "t": bucket_start.isoformat(timespec="minutes"),
                        "strain": round(21.0 * (1.0 - pow(2.71828, -cum_load / 100.0)), 2),
                    }
                )
                bucket_start = bucket_end
                bucket_end = bucket_start + timedelta(seconds=bucket_seconds)
                bucket_hrs = []
            if r["heart_rate_bpm"] is not None:
                bucket_hrs.append(float(r["heart_rate_bpm"]))
        if bucket_hrs:
            intensities = [max(0.0, (h - 50) / (max_bpm - 50)) for h in bucket_hrs]
            cum_load += sum(i * i for i in intensities) * (1.0 / 60.0)
            series.append(
                {
                    "t": bucket_start.isoformat(timespec="minutes"),
                    "strain": round(21.0 * (1.0 - pow(2.71828, -cum_load / 100.0)), 2),
                }
            )

    m = con.execute(
        "SELECT * FROM daily_metrics WHERE date = ?", (day.isoformat(),)
    ).fetchone()
    summary = dict(m) if m else None
    if summary and summary.get("zone_minutes"):
        summary["zone_minutes"] = _decode_json_field(summary["zone_minutes"])
    workouts = db.workouts_for_range(con, day.isoformat(), day.isoformat())
    return {
        "date": day.isoformat(),
        "summary": summary,
        "curve": series,
        "workouts": [
            {**dict(w), "zone_seconds": _decode_json_field(w["zone_seconds"])}
            for w in workouts
        ],
    }


VALID_TREND_METRICS = {
    "rmssd_ms", "resting_hr", "recovery_score", "strain_score",
    "sleep_minutes", "sleep_performance_pct", "sleep_debt_minutes",
    "avg_hr", "avg_spo2", "skin_temp_deviation_c", "respiratory_rate",
    "calories", "stress_avg", "steps", "active_energy_kcal",
}


def api_trends(
    con: sqlite3.Connection, metric: str = "recovery_score", days: int = 30
) -> dict:
    if metric not in VALID_TREND_METRICS:
        return {"error": f"unknown metric: {metric}", "valid": sorted(VALID_TREND_METRICS)}
    rows = con.execute(
        f"SELECT date, {metric} AS value FROM daily_metrics "
        "ORDER BY date DESC LIMIT ?",
        (days,),
    ).fetchall()
    # Weekday averages
    weekday_buckets: dict[int, list[float]] = {i: [] for i in range(7)}
    for r in rows:
        if r["value"] is not None:
            d = date.fromisoformat(r["date"])
            weekday_buckets[d.weekday()].append(float(r["value"]))
    weekday_avgs = {
        i: round(sum(v) / len(v), 1) if v else None for i, v in weekday_buckets.items()
    }
    return {
        "metric": metric,
        "series": [
            {"date": r["date"], "value": r["value"]}
            for r in reversed(rows)
        ],
        "weekday_averages": weekday_avgs,
    }


def api_workouts(con: sqlite3.Connection, days: int = 30) -> dict:
    today = date.today()
    start_date = (today - timedelta(days=days)).isoformat()
    rows = db.workouts_for_range(con, start_date, today.isoformat())
    return {
        "workouts": [
            {**dict(w), "zone_seconds": _decode_json_field(w["zone_seconds"])}
            for w in rows
        ],
    }


def api_profile_get(con: sqlite3.Connection) -> dict:
    return db.get_profile(con)


def api_profile_post(con: sqlite3.Connection, payload: dict) -> dict:
    # Validate & coerce
    clean: dict = {}
    if "age" in payload and payload["age"] is not None:
        try:
            clean["age"] = max(1, min(120, int(payload["age"])))
        except (ValueError, TypeError):
            pass
    if "sex" in payload:
        s = payload["sex"]
        if s in ("M", "F", None, ""):
            clean["sex"] = s if s in ("M", "F") else None
    if "weight_kg" in payload and payload["weight_kg"] is not None:
        try:
            clean["weight_kg"] = max(20.0, min(300.0, float(payload["weight_kg"])))
        except (ValueError, TypeError):
            pass
    if "height_cm" in payload and payload["height_cm"] is not None:
        try:
            clean["height_cm"] = max(50.0, min(250.0, float(payload["height_cm"])))
        except (ValueError, TypeError):
            pass
    if "max_hr_override" in payload:
        v = payload["max_hr_override"]
        if v in (None, ""):
            clean["max_hr_override"] = None
        else:
            try:
                clean["max_hr_override"] = max(120, min(230, int(v)))
            except (ValueError, TypeError):
                pass
    return db.upsert_profile(con, **clean)


def api_health_latest() -> dict:
    """Latest values persisted from Apple Health (via Health Auto Export)."""
    if not HEALTH_FILE.exists():
        return {"values": {}, "updated_at": None}
    try:
        return json.loads(HEALTH_FILE.read_text())
    except (ValueError, OSError):
        return {"values": {}, "updated_at": None}


def api_health_ingest(payload: dict) -> dict:
    """Accept a Health Auto Export REST API push.

    HAE sends:
      { "data": { "metrics": [ {"name": "Body Mass", "units": "kg",
                                 "data": [ {"qty": 75.5, "date": "..."} ] } ] } }
    or sometimes the flat form:
      { "name": "Body Mass", "units": "kg", "data": [ ... ] }

    We accept either and update the persisted snapshot.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing = api_health_latest()
    values: dict = dict(existing.get("values") or {})

    metrics_arr = []
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), dict) and isinstance(payload["data"].get("metrics"), list):
            metrics_arr = payload["data"]["metrics"]
        elif "name" in payload and "data" in payload:
            metrics_arr = [payload]

    accepted = []
    for m in metrics_arr:
        try:
            name = str(m.get("name", "")).strip().lower()
            internal = HEALTH_METRIC_MAP.get(name)
            if not internal:
                continue
            samples = m.get("data") or []
            if not samples:
                continue
            # Take the latest by date
            samples_sorted = sorted(
                samples,
                key=lambda s: str(s.get("date") or s.get("Date") or ""),
                reverse=True,
            )
            latest = samples_sorted[0]
            qty = float(latest.get("qty") or latest.get("Qty") or 0)
            units = (m.get("units") or "").lower()
            # Normalize weight to kg, height to cm
            if internal == "weight_kg" and units in ("lb", "lbs"):
                qty *= 0.45359237
            if internal == "height_cm" and units in ("in", "inch", "inches"):
                qty *= 2.54
            if internal == "height_cm" and units in ("m", "meters"):
                qty *= 100
            values[internal] = round(qty, 3)
            values[internal + "_date"] = latest.get("date") or latest.get("Date")
            values[internal + "_units"] = units or None
            accepted.append(internal)
        except (TypeError, ValueError):
            continue

    out = {
        "values": values,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "accepted": accepted,
    }
    try:
        HEALTH_FILE.write_text(json.dumps(out, indent=2))
    except OSError as exc:
        logger.warning("Could not persist health snapshot: %s", exc)
    return out


def api_live(con: sqlite3.Connection, seconds: int = 300) -> dict:
    """Recent stream window for the Live tab."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=max(30, min(3600, seconds)))
    rows = db.samples_between(
        con,
        start.isoformat(timespec="milliseconds"),
        end.isoformat(timespec="milliseconds"),
    )
    points = [
        {
            "t": _to_local_iso(r["ts_utc"]),
            "hr": r["heart_rate_bpm"],
            "rr": r["rr_interval_ms"],
            "spo2": r["spo2_pct"],
            "temp": r["skin_temp_c"],
            "motion": (abs(r["accel_x"] or 0) + abs(r["accel_y"] or 0) + abs(r["accel_z"] or 0)),
        }
        for r in rows
    ]
    last = db.latest_sample(con)
    battery = db.latest_battery(con)
    events = con.execute(
        "SELECT * FROM device_events ORDER BY ts_utc DESC LIMIT 20"
    ).fetchall()
    return {
        "points": points,
        "latest_sample": _row(last),
        "battery": _row(battery),
        "events": [dict(e) for e in events],
        "now_utc": end.isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    db_path: str | None = None
    auth_token: str | None = None
    _db_cache: sqlite3.Connection | None = None

    @classmethod
    def get_db(cls) -> sqlite3.Connection:
        if cls._db_cache is None:
            cls._db_cache = db.connect(cls.db_path)
        return cls._db_cache

    def _check_auth(self) -> bool:
        """Return True if auth passes (or no auth configured)."""
        if not self.auth_token:
            return True
        auth = self.headers.get("Authorization", "")
        if hmac.compare_digest(auth, f"Bearer {self.auth_token}"):
            return True
        # Allow token as query param for simple browser access
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        token_param = qs.get("token", [None])[0]
        if token_param and hmac.compare_digest(token_param, self.auth_token):
            return True
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized","message":"Missing or invalid Bearer token."}')
        return False

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # Permissive CORS so the iPhone Health Auto Export app on the LAN
        # can POST to this server.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def _static(self, rel_path: str) -> None:
        path = (WEB_DIR / rel_path).resolve()
        if not str(path).startswith(str(WEB_DIR.resolve())) or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        ext = path.suffix
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".webmanifest": "application/manifest+json",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Prevent the browser from caching dev assets — otherwise edits to
        # JS modules (which Chrome caches aggressively) don't show up on
        # reload. The whole app is local-only so there's no CDN benefit.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        logger.debug("HTTP " + fmt, *args)

    def do_GET(self) -> None:
        if not self._check_auth():
            return
        url = urlparse(self.path)
        qs = parse_qs(url.query)

        if url.path == "/" or url.path == "/index.html":
            return self._static("index.html")

        # Serve any static file out of web/ (app.js, styles.css, vendor/*, js/*, etc.)
        if url.path.startswith("/static/"):
            return self._static(url.path[len("/static/"):])
        if not url.path.startswith("/api/"):
            return self._static(url.path.lstrip("/"))

        con = self.get_db()
        try:
            day = qs.get("date", [None])[0]
            if url.path == "/api/status":
                return self._json(api_status(con))
            if url.path == "/api/today":
                step = _safe_int(qs.get("downsample", [None])[0], 30, 1, 3600)
                return self._json(api_today(con, downsample=step))
            if url.path == "/api/history":
                days = _safe_int(qs.get("days", [None])[0], 30, 1, 3650)
                return self._json(api_history(con, days=days))
            if url.path == "/api/recompute":
                age_arg = qs.get("age", [None])[0]
                age = _safe_int(age_arg, 0, 1, 120) if age_arg else None
                return self._json(api_recompute(con, age=age))
            if url.path == "/api/overview":
                return self._json(api_overview(con))
            if url.path == "/api/sleep":
                return self._json(api_sleep(con, day_iso=day))
            if url.path == "/api/recovery":
                return self._json(api_recovery(con, day_iso=day))
            if url.path == "/api/strain":
                return self._json(api_strain(con, day_iso=day))
            if url.path == "/api/trends":
                metric = qs.get("metric", ["recovery_score"])[0]
                days = _safe_int(qs.get("days", [None])[0], 30, 1, 3650)
                return self._json(api_trends(con, metric=metric, days=days))
            if url.path == "/api/workouts":
                days = _safe_int(qs.get("days", [None])[0], 30, 1, 3650)
                return self._json(api_workouts(con, days=days))
            if url.path == "/api/profile":
                return self._json(api_profile_get(con))
            if url.path == "/api/live":
                secs = _safe_int(qs.get("seconds", [None])[0], 300, 10, 3600)
                return self._json(api_live(con, seconds=secs))
            if url.path == "/api/health/latest":
                return self._json(api_health_latest())
        except Exception as exc:
            logger.exception("API error on %s", url.path)
            return self._json({"error": "internal_error", "message": "An unexpected error occurred. Check server logs for details."}, status=500)

        self.send_error(404, f"Not found: {url.path}")

    def do_POST(self) -> None:
        if not self._check_auth():
            return
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_048_576:  # 1 MB cap
            return self._json({"error": "payload_too_large", "message": "Request body exceeds 1 MB limit."}, status=413)
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except ValueError:
            return self._json({"error": "invalid json"}, status=400)
        if not isinstance(payload, dict):
            return self._json({"error": "bad_request", "message": "JSON body must be an object."}, status=400)

        con = self.get_db()
        try:
            if url.path == "/api/profile":
                return self._json(api_profile_post(con, payload))
            if url.path == "/api/recompute":
                age = payload.get("age")
                return self._json(api_recompute(con, age=age))
            if url.path == "/api/health/ingest":
                return self._json(api_health_ingest(payload))
        except Exception as exc:
            logger.exception("API POST error on %s", url.path)
            return self._json({"error": "internal_error", "message": "An unexpected error occurred. Check server logs for details."}, status=500)

        self.send_error(404, f"Not found: {url.path}")


def serve(host: str = "127.0.0.1", port: int = 8765, db_path: str | None = None, auth_token: str | None = None) -> None:
    Handler.db_path = db_path
    Handler.auth_token = auth_token
    server = ThreadingHTTPServer((host, port), Handler)
    if host != "127.0.0.1" and host != "localhost" and not auth_token:
        logger.warning("⚠️  Dashboard bound to %s without auth. Anyone on the network can read your health data. Pass --token to secure it.", host)
    logger.info("Dashboard running at http://%s:%d", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopping dashboard...")
    finally:
        server.server_close()
