"""Live recording: stream Whoop packets straight into SQLite.

Robust to BLE drops — auto-reconnects with exponential backoff.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from datetime import datetime, timezone
from typing import Optional

from whoop_reader.ble import WhoopConnection, scan_for_whoops

from . import db

logger = logging.getLogger(__name__)

RECONNECT_INITIAL = 5.0   # seconds
RECONNECT_MAX = 120.0
BATTERY_POLL_SECONDS = 600.0  # every 10 min


async def _battery_poller(con, whoop: WhoopConnection, stop: asyncio.Event) -> None:
    """Background task: log battery level periodically."""
    while not stop.is_set():
        try:
            if whoop.is_connected:
                lvl = await whoop.get_battery()
                db.log_event(con, "battery", f"{lvl}%")
                logger.info("Battery: %d%%", lvl)
        except Exception as exc:  # pragma: no cover - depends on hardware
            logger.warning("Battery poll failed: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=BATTERY_POLL_SECONDS)
        except asyncio.TimeoutError:
            pass


async def _record_once(
    address: Optional[str],
    db_path: str | None,
    label: Optional[str],
    stop: asyncio.Event,
) -> int:
    """Single connection attempt. Returns sample count for this session."""
    con = db.connect(db_path)
    sess_id: Optional[int] = None
    count = 0
    try:
        if address:
            device = address
        else:
            logger.info("Scanning for Whoop devices...")
            devs = await scan_for_whoops(timeout=10.0)
            if not devs:
                logger.error("No Whoop devices found. Make sure the band is awake.")
                return 0
            device = devs[0]
            logger.info("Using device: %s (%s)", device.name, device.address)

        async with WhoopConnection(device) as whoop:
            db.log_event(con, "connect", str(device))
            sess_id = db.start_session(con, label=label)
            logger.info("Session %d started.", sess_id)

            battery_task = asyncio.create_task(_battery_poller(con, whoop, stop))

            try:
                packets = await whoop.stream_realtime()
                async for pkt in packets:
                    if stop.is_set():
                        break
                    db.insert_packet(con, pkt, session_id=sess_id)
                    count += 1
                    if count % 60 == 0:
                        logger.info(
                            "Session %d: %d samples, HR=%s RR=%s",
                            sess_id,
                            count,
                            pkt.heart_rate_bpm,
                            pkt.rr_interval_ms,
                        )
            finally:
                battery_task.cancel()
                try:
                    await battery_task
                except asyncio.CancelledError:
                    pass

    except Exception as exc:
        logger.exception("Recording loop error: %s", exc)
        db.log_event(con, "error", str(exc))
    finally:
        if sess_id is not None:
            db.end_session(con, sess_id, count)
        db.log_event(con, "disconnect", f"samples={count}")
        con.close()
    return count


async def record(
    address: Optional[str] = None,
    db_path: Optional[str] = None,
    label: Optional[str] = None,
    once: bool = False,
) -> None:
    """Run the recorder. Auto-reconnects unless `once=True`."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    backoff = RECONNECT_INITIAL
    while not stop.is_set():
        count = await _record_once(address, db_path, label, stop)
        if stop.is_set() or once:
            break
        sleep_for = backoff
        logger.warning(
            "Connection ended after %d samples. Reconnecting in %.0fs...",
            count,
            sleep_for,
        )
        try:
            await asyncio.wait_for(stop.wait(), timeout=sleep_for)
        except asyncio.TimeoutError:
            pass
        # If we managed to record any data, reset backoff. Otherwise grow.
        backoff = RECONNECT_INITIAL if count > 0 else min(backoff * 2, RECONNECT_MAX)

    logger.info("Recorder stopped.")
