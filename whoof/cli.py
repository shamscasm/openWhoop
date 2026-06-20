"""Top-level CLI: `whoof <command>`.

Commands
--------
    scan        Discover nearby Whoop devices.
    info        Show device info (firmware, serial, hardware rev).
    battery     Print battery level.
    record      Stream sensor data into the local SQLite DB.
    rollup      Re-compute daily HRV / recovery / strain metrics.
    dashboard   Launch the web dashboard at http://localhost:8765/.
    status      One-shot status snapshot (latest sample, battery, totals).
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import click

from . import __version__, db, dashboard, metrics, recorder


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    if not verbose:
        logging.getLogger("bleak").setLevel(logging.WARNING)


@click.group()
@click.version_option(__version__, prog_name="whoof")
@click.option("-v", "--verbose", is_flag=True)
@click.option(
    "--db",
    "db_path",
    default=None,
    help="Path to SQLite DB (default: data/whoop.db).",
)
@click.pass_context
def cli(ctx: click.Context, verbose: bool, db_path: Optional[str]) -> None:
    """whoof — unofficial, educational BLE client for the WHOOP 4.0 strap.

    Reads sensor data from your own strap over Bluetooth and stores it locally.
    Not affiliated with, endorsed by, or sponsored by WHOOP, Inc. WHOOP is a
    trademark of WHOOP, Inc. Use at your own risk; not for medical or
    clinical use. See DISCLAIMER.md.
    """
    ctx.ensure_object(dict)
    ctx.obj["db_path"] = db_path
    _setup_logging(verbose)


# -- Pass-throughs to whoop-reader -----------------------------------------


@cli.command()
@click.option("-t", "--timeout", default=10.0, help="Scan duration (s).")
def scan(timeout: float) -> None:
    """Scan for nearby Whoop devices."""
    from whoop_reader.ble import scan_for_whoops

    async def _go() -> None:
        click.echo(f"Scanning for {timeout:.0f}s...")
        devs = await scan_for_whoops(timeout=timeout)
        if not devs:
            click.echo("No Whoop devices found. Wake the band by tapping it.")
            return
        for d in devs:
            click.echo(f"  {d.name or 'Unknown':20s}  {d.address}")

    asyncio.run(_go())


@cli.command()
@click.option("-a", "--address", default=None)
def info(address: Optional[str]) -> None:
    """Show device firmware / serial / hardware revision."""
    from whoop_reader.ble import WhoopConnection, scan_for_whoops

    async def _go() -> None:
        dev = address
        if not dev:
            devs = await scan_for_whoops(timeout=10.0)
            if not devs:
                click.echo("No Whoop devices found.")
                sys.exit(1)
            dev = devs[0]
        async with WhoopConnection(dev) as w:
            d = await w.get_device_info()
            for k, v in d.items():
                click.echo(f"  {k:20s} {v}")

    asyncio.run(_go())


@cli.command()
@click.option("-a", "--address", default=None)
def battery(address: Optional[str]) -> None:
    """Print current battery level."""
    from whoop_reader.ble import WhoopConnection, scan_for_whoops

    async def _go() -> None:
        dev = address
        if not dev:
            devs = await scan_for_whoops(timeout=10.0)
            if not devs:
                click.echo("No Whoop devices found.")
                sys.exit(1)
            dev = devs[0]
        async with WhoopConnection(dev) as w:
            pct = await w.get_battery()
            click.echo(f"Battery: {pct}%")

    asyncio.run(_go())


# -- Recording -------------------------------------------------------------


@cli.command()
@click.option("-a", "--address", default=None, help="Device MAC / UUID (skip scan).")
@click.option("-l", "--label", default=None, help="Optional session label.")
@click.option("--once", is_flag=True, help="Don't auto-reconnect on drop.")
@click.pass_context
def record(ctx: click.Context, address: Optional[str], label: Optional[str], once: bool) -> None:
    """Stream Whoop data into SQLite. Reconnects automatically. Ctrl+C to stop."""
    asyncio.run(
        recorder.record(
            address=address,
            db_path=ctx.obj["db_path"],
            label=label,
            once=once,
        )
    )


# -- Metrics rollup --------------------------------------------------------


@cli.command()
@click.option("--days", default=7, help="Number of recent days to recompute.")
@click.option("--age", default=None, type=int, help="Override profile age for this run.")
@click.pass_context
def rollup(ctx: click.Context, days: int, age: int | None) -> None:
    """Recompute daily HRV / recovery / strain / sleep / workouts for the last N days."""
    con = db.connect(ctx.obj["db_path"])
    try:
        today = date.today()
        for offset in range(days):
            d = today - timedelta(days=offset)
            m = metrics.compute_daily(con, d, age=age)
            if m is None:
                click.echo(f"  {d}: no samples")
                continue
            click.echo(
                f"  {d}: HR avg={m['avg_hr']} rest={m['resting_hr']}  "
                f"RMSSD={m['rmssd_ms']}  rec={m['recovery_score']}  "
                f"strain={m['strain_score']}  sleep={m['sleep_minutes']}m "
                f"perf={m['sleep_performance_pct']}%  samples={m['sample_count']}"
            )
    finally:
        con.close()


# -- Profile ---------------------------------------------------------------


@cli.command()
@click.option("--age", default=None, type=int)
@click.option("--sex", default=None, type=click.Choice(["M", "F"], case_sensitive=False))
@click.option("--weight-kg", default=None, type=float)
@click.option("--height-cm", default=None, type=float)
@click.option("--max-hr", "max_hr_override", default=None, type=int, help="Override 220-age.")
@click.option("--show", is_flag=True, help="Print current profile and exit.")
@click.pass_context
def profile(
    ctx: click.Context,
    age: int | None,
    sex: str | None,
    weight_kg: float | None,
    height_cm: float | None,
    max_hr_override: int | None,
    show: bool,
) -> None:
    """Read or update the singleton user profile."""
    con = db.connect(ctx.obj["db_path"])
    try:
        if show or all(v is None for v in (age, sex, weight_kg, height_cm, max_hr_override)):
            p = db.get_profile(con)
            for k, v in p.items():
                click.echo(f"  {k:18s} {v}")
            return
        fields = {}
        if age is not None: fields["age"] = age
        if sex is not None: fields["sex"] = sex.upper()
        if weight_kg is not None: fields["weight_kg"] = weight_kg
        if height_cm is not None: fields["height_cm"] = height_cm
        if max_hr_override is not None: fields["max_hr_override"] = max_hr_override
        p = db.upsert_profile(con, **fields)
        click.echo("Profile updated:")
        for k, v in p.items():
            click.echo(f"  {k:18s} {v}")
    finally:
        con.close()


# -- Dashboard -------------------------------------------------------------


@cli.command()
@click.option("--host", default="127.0.0.1")
@click.option("--port", default=8765, type=int)
@click.pass_context
def dash(ctx: click.Context, host: str, port: int) -> None:
    """Launch the web dashboard at http://HOST:PORT/."""
    dashboard.serve(host=host, port=port, db_path=ctx.obj["db_path"])


# -- Status snapshot -------------------------------------------------------


@cli.command("seed-demo")
@click.option("--days", default=14, help="How many days of synthetic data to insert.")
@click.option("--age", default=30)
@click.option("--weight-kg", default=72.0)
@click.option("--sex", default="M", type=click.Choice(["M", "F"], case_sensitive=False))
@click.pass_context
def seed_demo(ctx: click.Context, days: int, age: int, weight_kg: float, sex: str) -> None:
    """Insert synthetic data so the dashboard shows realistic-looking trends.

    Useful for trying the UI before your first overnight recording. Run on a
    throwaway DB path: `whoof --db /tmp/demo.db seed-demo`.

    The generated data has realistic-looking nights (low HR + low motion in a
    bedtime → waketime band), a couple of workouts per week, and varied
    daytime activity — enough to exercise every metric and chart in the
    dashboard.
    """
    import random
    from datetime import date, datetime, time, timedelta, timezone
    from whoop_reader.parser import RealtimePacket

    con = db.connect(ctx.obj["db_path"])
    try:
        db.upsert_profile(con, age=age, sex=sex.upper(), weight_kg=weight_kg)
        local = datetime.now().astimezone().tzinfo
        random.seed(42)
        today = date.today()
        SAMPLE_INTERVAL = 30  # seconds — dense enough for HRV + sleep stages

        now_local = datetime.now(local)
        for offset in range(days, -1, -1):
            d = today - timedelta(days=offset)
            sess = db.start_session(con, label=f"demo {d}")
            day_start_local = datetime.combine(d, time(0, 0), tzinfo=local)
            # For today, stop at the current local time so we don't fabricate the future.
            day_end_local = (
                now_local if offset == 0 else day_start_local + timedelta(days=1)
            )
            day_seconds = int((day_end_local - day_start_local).total_seconds())
            if day_seconds <= 0:
                continue

            # Per-day variability: vary bedtime, wake, and recovery quality.
            bedtime_hour = 22 + random.gauss(0, 0.6)        # ~22:00 ± 36 min
            wake_hour = 6.5 + random.gauss(0, 0.4)          # ~06:30
            sleep_baseline_hr = 52 + random.gauss(0, 3)
            rr_jitter = max(8, random.gauss(28, 6))         # nightly HRV varies
            workout_today = (offset % 2 == 0)
            workout_start = 17 + random.gauss(0, 0.5)
            workout_dur_min = 35 + random.randint(0, 25)
            workout_peak_hr = 155 + random.randint(-10, 10)
            day_avg_hr = 76 + random.gauss(0, 4)

            for s in range(0, day_seconds, SAMPLE_INTERVAL):
                ts_local = day_start_local + timedelta(seconds=s)
                t = ts_local.hour + ts_local.minute / 60.0 + ts_local.second / 3600.0

                # ── Sleep window (bedtime → next-day 00:00) and 00:00 → wake ──
                in_sleep = (t >= bedtime_hour) or (t < wake_hour)
                # Workout window
                in_workout = (
                    workout_today
                    and workout_start <= t < workout_start + workout_dur_min / 60
                )
                # Wind-down: 1 hour before bed
                in_winddown = (
                    bedtime_hour - 1 <= t < bedtime_hour
                )

                if in_sleep:
                    hr = sleep_baseline_hr + random.gauss(0, 2.5)
                    rr = int(60_000 / hr + random.gauss(0, rr_jitter))
                    motion = abs(random.gauss(0, 6))         # very low
                    accel_amp = max(1, int(motion / 3) + random.randint(0, 4))
                elif in_workout:
                    # Ramp up, plateau, ramp down
                    phase = (t - workout_start) / (workout_dur_min / 60)
                    if phase < 0.15:
                        hr = day_avg_hr + (workout_peak_hr - day_avg_hr) * (phase / 0.15)
                    elif phase > 0.85:
                        hr = workout_peak_hr * (1 - (phase - 0.85) / 0.15 * 0.4)
                    else:
                        hr = workout_peak_hr + random.gauss(0, 6)
                    rr = int(60_000 / hr + random.gauss(0, 5))
                    motion = 120 + random.gauss(0, 30)
                    accel_amp = max(1, int(motion))
                elif in_winddown:
                    hr = day_avg_hr - 6 + random.gauss(0, 4)
                    rr = int(60_000 / hr + random.gauss(0, 18))
                    motion = 20 + random.gauss(0, 8)
                    accel_amp = max(1, int(motion))
                else:  # daytime
                    hr = day_avg_hr + random.gauss(0, 8)
                    rr = int(60_000 / hr + random.gauss(0, 16))
                    motion = 60 + random.gauss(0, 30)
                    accel_amp = max(1, int(motion))

                hr = max(40, min(200, hr))
                rr = max(300, min(1500, rr))

                pkt = RealtimePacket(
                    sequence=s % 256,
                    heart_rate_bpm=round(hr, 1),
                    rr_interval_ms=rr,
                    spo2_pct=97 + random.randint(-1, 1) if in_sleep else 98,
                    skin_temp_c=round(33.2 + random.gauss(0, 0.4) - (offset * 0.005), 2),
                    accel_x=random.randint(-accel_amp, accel_amp),
                    accel_y=random.randint(-accel_amp, accel_amp),
                    accel_z=random.randint(-accel_amp, accel_amp),
                    motion_intensity=int(max(0, motion)),
                    ppg_amplitude=random.randint(800, 1500),
                    ambient_light=0 if in_sleep else random.randint(50, 600),
                    ppg_quality=random.randint(180, 250),
                    unknown_20_91=b"\x00" * 72,
                    crc_valid=True,
                    raw=b"\x00" * 96,
                )
                ts_utc = ts_local.astimezone(timezone.utc).isoformat(timespec="milliseconds")
                db.insert_packet(con, pkt, session_id=sess, ts=ts_utc)

            db.end_session(con, sess, day_seconds // SAMPLE_INTERVAL)
            m = metrics.compute_daily(con, d, age=age)
            if m:
                click.echo(
                    f"  {d}: HR={m['avg_hr']} RMSSD={m['rmssd_ms']}  "
                    f"rec={m['recovery_score']} strain={m['strain_score']}  "
                    f"sleep={m['sleep_minutes']}m perf={m['sleep_performance_pct']}%"
                )
        db.log_event(con, "demo", f"seeded {days} days")
    finally:
        con.close()


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """One-shot summary: latest sample, battery, totals."""
    con = db.connect(ctx.obj["db_path"])
    try:
        latest = db.latest_sample(con)
        bat = db.latest_battery(con)
        total = con.execute("SELECT COUNT(*) AS n FROM samples").fetchone()["n"]
        sessions = con.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
        click.echo(f"  Database:        {db.DEFAULT_DB if not ctx.obj['db_path'] else ctx.obj['db_path']}")
        click.echo(f"  Total samples:   {total}")
        click.echo(f"  Total sessions:  {sessions}")
        if latest:
            click.echo(
                f"  Latest sample:   {latest['ts_utc']}  HR={latest['heart_rate_bpm']}  RR={latest['rr_interval_ms']}"
            )
        else:
            click.echo("  Latest sample:   (none yet)")
        if bat:
            click.echo(f"  Latest battery:  {bat['detail']} at {bat['ts_utc']}")
    finally:
        con.close()


if __name__ == "__main__":
    cli()
