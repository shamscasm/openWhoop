# Edge Cases & How whoof Handles Them

A grimoire of edge cases we've thought about and what the code does about
them. Add to this file whenever you discover a new one in the wild.

## Connection / disconnection

### "Mac was away when I worked out"
**Handled.** The strap buffers HR + RR samples to its onboard flash whenever
it's not connected. On every reconnect, `WhoopClient._postConnectFlow()`
runs `downloadHistory()` (`SEND_HISTORICAL_DATA` → flood of metadata + data
packets → `HISTORICAL_DATA_RESULT` ACK with trim pointer → eventually
`HISTORY_COMPLETE`). The samples land in IndexedDB before realtime
streaming starts so they don't intermingle. After the dump, daily metrics
are re-rolled-up for the last 14 days.

### "Mac was away for a month"
Strap flash will fill long before that — the strap proactively fires
`HIGH_FREQ_SYNC_PROMPT` on the event channel when buffer pressure is high.
Our event handler triggers `downloadHistory()` on receipt. The dump can be
many minutes long; progress is shown in the panel and the user can cancel
by disconnecting (`abortHistoricalTransmits` is sent server-side via cmd
20 on disconnect via the strap's internal handling).

### "BLE drops mid-historical-dump"
**Handled.** `_onDisconnected()` clears the metadata queue and emits
`historyError` with "disconnected during dump". The in-flight `downloadHistory()`
promise rejects. On reconnect the dump resumes from wherever the strap left
off — we ACKed up to a known `trim` so the strap will replay from there.

### "BLE drops every few minutes (macOS being macOS)"
**Handled.** `_onDisconnected()` (not intentional) triggers `_tryReconnect()`
with exponential backoff starting at 1 s, doubling up to 30 s max. Once
reconnected, the post-connect flow re-runs (which means another small
backfill if any).

### "Another tab in the same browser is connected"
**Handled.** `multitab.js` uses BroadcastChannel: before connecting, we ping
peers. If anyone responds, we refuse and show a friendly error. After we
connect we announce ourselves so other tabs know to back off too.

### "User closes the tab while connected"
The browser closes the GATT connection. The strap notices, fires
`BLE_CONNECTION_DOWN`, and resumes flash logging. Next time the page opens
and reconnects, the backfill picks up the missed window.

### "User refreshes the page mid-sync"
Connection drops cleanly. Reload starts a fresh client; `autoConnect()`
finds the still-paired device and re-establishes. Backfill restarts.

## RTC / clock drift

### "Strap's internal clock drifted from real time"
**Handled.** `_postConnectFlow()` calls `getClock()`, compares to
`Date.now()`, and calls `setClock()` if drift > 5 s.

### "RTC_LOST event fires (battery died and the RTC backup was lost)"
**Handled.** Event handler calls `setClock()` immediately.

### "User crosses time zones / DST transition"
Sample timestamps are stored as UTC ISO strings. Local-time display uses
`Intl` / `toLocaleString()` which respects current TZ. Daily rollups bucket
by **local-time day** (using `localDateKey()` in `util/time.js`) so the
"day" you see in the dashboard matches your wrist watch even right after
crossing into a new TZ. Cross-DST samples from before the switch keep
their UTC timestamps; the bucket they belong to is whichever local day
that UTC time maps into in the *current* zone.

## Data integrity

### "Packet CRC fails"
**Handled.** `WhoopPacket.fromData()` throws if either CRC-8 (length) or
CRC-32 (body) doesn't match. The notification handler catches and emits
'error' rather than crashing.

### "HR is out of plausible range"
**Handled.** `parseRealtime()` returns `heartRateBpm: null` if not in
20..250. Rollup math skips null values.

### "RR interval is out of plausible range"
**Handled.** `parseRealtime()` filters RR values to 200..2000 ms (matches
the Whoop firmware's own physiological filter).

### "Strap sends 4 RR intervals for one sample"
**Handled.** Each RR gets its own row in the `samples` store so HRV math
sees all of them. Total sample count reflects RR count not "packets received".

### "IndexedDB hits quota"
Partially handled. Browsers give ~50-100 MB per origin without prompting.
At 30 s / sample × 4 RR × 100 bytes/row that's ~10 MB/year, well under
quota. Captures store enforces a per-capture row cap (50k = ~5 MB). If
quota is ever hit, the write fails silently — TODO is to surface a quota
banner.

### "Capture grows unbounded"
**Handled.** Per-capture row cap of 50k. A "capped" sentinel row is added
so the user knows further packets were dropped.

## Apple Health sync

### "iPhone HAE can't reach the Mac"
LAN-only — if the Mac and iPhone aren't on the same Wi-Fi or the Mac
firewall blocks port 8765, the POST silently fails. Run dashboard with
`--host 0.0.0.0` (we default to 0.0.0.0 in `cli.py`).

### "HAE sends weight in lbs, but we expect kg"
**Handled.** `api_health_ingest()` converts lb → kg using
`× 0.45359237` based on the `units` field. Same for in → cm and m → cm.

### "HAE sends multiple weight samples in one POST"
**Handled.** We sort by `date` desc and keep the latest only.

### "HAE sends an unknown metric"
**Handled.** Ignored silently; `accepted` list in the response shows what
we kept.

### "Shortcut callback URL gets out-of-range value"
**Handled.** `readShortcutResult()` rejects anything outside 0 < kg ≤ 500.

### "Shortcut callback opens in Safari but PWA was in Bluefy"
Documented limitation in `docs/SHORTCUT.md`. The `x-success` URL opens in
the system default browser, not necessarily the calling app.

## Hardware quirks

### "iOS Safari doesn't support Web Bluetooth"
**Handled.** UA-detect on connect; if iPhone Safari, suggest Bluefy.

### "Strap is on charger and won't advertise"
Documented in the README and as part of the error returned when the
device picker has no results.

### "Strap firmware updates change packet format"
We trust the firmware-extracted enums in `vendor/whoomp/packet.js`. If the
format changes, our CRC checks will start failing and we'll emit 'error'
events. The `📸 Capture raw packets` button gives us the hex dump needed
to diagnose.

## Concurrency / async ordering

### "Sample arrives before currentSession is set"
The sample is buffered with `session_id: currentSession` which may be
`null` for the first ~50 ms after connect. These samples are still HR-valid
and get rolled up by date, just not associated to a session. Acceptable.

### "User clicks Sync now while a dump is already running"
**Handled.** `downloadHistory()` returns `{ alreadyRunning: true }`
without sending a second SEND_HISTORICAL_DATA.

### "Battery poll fires before connection completes"
**Handled.** `getBatteryLevel()` checks `this.connected` and returns
early if false.

### "User clicks Connect twice rapidly"
The first click awaits `requestAndConnect()`; the second creates a fresh
`WhoopClient` that races with the first. **Partially handled** — the
multi-tab guard catches this within the same tab too if the first
completed; otherwise the second client overwrites `client` and the first's
notifications go to garbage. TODO: button debounce.

## Privacy / security

### "Captures contain identifiable HRV / RR data"
Captures live in the user's IndexedDB only. They never leave the device
unless the user manually downloads + shares the NDJSON file. Document this
in the UI when adding share/upload features.

### "Apple Health snapshot file on disk"
`data/health-latest.json` contains the user's weight/height/etc. in
plaintext. Same security tier as the SQLite DB. Add to `.gitignore`
(already excluded via `data/`).

### "CORS on Python health endpoint is wildcard"
Acceptable on a localhost / LAN-only server. Document loudly in the README
if anyone wants to serve this publicly (they shouldn't).
