# whoof v0.3 — Browser PWA

Date: 2026-05-20
Status: design approved, ready for implementation plan
Supersedes (in part): `2026-05-20-whoof-redesign-design.md` (v0.2 Python+Mac dashboard)

## Goal

Replace the Python recorder + HTTP server with a pure browser web app that uses Web Bluetooth to talk to the Whoop 4.0 directly, stores everything in IndexedDB, and computes all metrics in JavaScript. Single codebase runs in Mac Chrome for development and iPhone Bluefy for production.

## Why now

The v0.2 Python dashboard (built earlier today) is Mac-tethered. The end goal is phone-only, no Mac, no recurring cost. A pure-browser PWA achieves this with one codebase, no native iOS work, no cloud infrastructure, and no $99/yr Apple Developer fee. Mac Chrome supports Web Bluetooth natively for development; iPhone uses Bluefy ($0.99 one-time) since Apple's Safari doesn't expose Web Bluetooth.

## Non-goals

- Native iOS app (Apple Developer fees, 7-day sideload re-sign).
- Cloud sync / multi-device data merge (per-browser data acceptable for v1).
- Background recording on iOS (browser context cannot run when backgrounded).
- Decoding bytes 20–91 of the 96-byte BLE packet (still publicly undecoded).
- Workout start/stop UI (auto-detection from `workouts.py` is sufficient).
- Migrating data from existing `data/whoop.db` (start fresh; one-shot import via SQL.js is a follow-up option).

## Architecture

```
┌─────────────────────────────────────┐
│  Browser                            │
│  (Mac Chrome / iPhone Bluefy /      │  Web Bluetooth
│   Android Chrome)                   │ ◄──────────────► Whoop 4.0
│                                     │   GATT service
│  ┌──────────────────────────────┐   │   61080000-…
│  │  PWA (no backend)            │   │
│  │   • BLE client + decoder     │   │
│  │   • IndexedDB ◄ all data     │   │
│  │   • Metrics computed in JS   │   │
│  │   • Whoop-style dashboard    │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘

Dev hosting:  existing ./run.sh dash (Python static server, no API logic)
Prod hosting: deferred (GitHub Pages / Cloudflare Pages / Vercel — all free)
Storage:      IndexedDB
Network:      none after page load
```

## Relationship to v0.2

| v0.2 component | Fate in v0.3 |
|---|---|
| `whoof/db.py` (SQLite + helpers) | Replaced by `web/js/data/db.js` (IndexedDB) |
| `whoof/dashboard.py` (HTTP API) | API routes deleted; static-file serving kept |
| `whoof/recorder.py` (background BLE) | Deleted — browser does BLE |
| `whoof/metrics.py` (HRV/recovery/strain) | Ported → `web/js/metrics/{hrv,recovery,strain}.js` |
| `whoof/sleep.py` | Ported → `web/js/metrics/sleep.js` |
| `whoof/zones.py` | Ported → `web/js/metrics/zones.js` |
| `whoof/workouts.py` | Ported → `web/js/metrics/workouts.js` |
| `whoof/cli.py` | Trimmed to `dash` only |
| `vendor/whoop-reader` (Python BLE driver) | Reference only — not used at runtime |
| `web/index.html` | Kept — minor edits (Connect button) |
| `web/styles.css` | Kept as-is |
| `web/app.js` | Refactored: `fetch('/api/...')` → IndexedDB queries; render functions reused |

Estimated reuse: roughly half the v0.2 work survives — the UI/CSS/HTML and the algorithmic logic in Python modules (as targets to port). The HTTP server, SQLite layer, and Python recorder are deleted.

## File layout (post v0.3)

```
web/
  index.html              (kept; add Connect button + status pill)
  styles.css              (kept as-is)
  manifest.json           (NEW — deferred until phone deploy)
  sw.js                   (NEW — service worker for offline shell; deferred)
  vendor/
    chart.umd.min.js      (vendored Chart.js — was CDN, now offline-capable)
    idb.min.js            (Jake Archibald's idb wrapper, ~3KB gzipped)
  js/
    app.js                (refactor of v0.2 app.js)
    ble/
      client.js           (Web Bluetooth: connect, subscribe, reconnect)
      protocol.js         (port of vendor/whoop-reader/whoop_reader/protocol.py)
      crc.js              (CRC-32, Whoop's custom params)
      uuids.js            (service + characteristic UUIDs)
    data/
      db.js               (IndexedDB open + versioned upgrade)
      schema.js           (single source of truth: stores + indexes)
      queries.js          (typed queries — samples_in_range, today_metrics, etc.)
    metrics/
      hrv.js              (RMSSD, SDNN, pNN50, Malik filter)
      recovery.js         (z-score + 4-component breakdown)
      strain.js           (Borg-style strain curve)
      sleep.js
      zones.js
      workouts.js
      rollup.js           (orchestrator — fills missing daily_metrics on load)
    util/
      time.js             (local-day boundaries, formatters)
      events.js           (tiny event emitter for BLE → UI)
    dev/
      seed.js             (port of seed-demo; hidden behind ?demo=1)

whoof/                (trimmed Python)
  cli.py                  (just `dash` — runs static_server)
  static_server.py        (renamed from dashboard.py; no API routes)
```

Deprecated and removed from runtime path (kept on disk for reference until v0.3 ships):
- `whoof/recorder.py`, `whoof/db.py`, `whoof/metrics.py`, `whoof/sleep.py`, `whoof/zones.py`, `whoof/workouts.py`

## Schema (IndexedDB)

Object stores mirror v0.2 SQLite schema. All keys, indexes, and column names preserved so the Python tests can serve as porting references.

- **samples** — autoincrement `id`; indexes: `ts_utc`, `session_id`, `[session_id+sequence]`
- **sessions** — autoincrement `id`; index: `start_ts`
- **device_events** — autoincrement `id`; index: `ts_utc`
- **daily_metrics** — keyPath `date`
- **profile** — single record, key `id=1`
- **sleep_stages** — autoincrement `id`; indexes: `date`, `start_ts`
- **workouts** — autoincrement `id`; index: `date`

Migrations handled via the IndexedDB `onupgradeneeded` event in `web/js/data/db.js`. Initial DB version = 1.

## Data flow

**Recording:**
1. User clicks **Connect** → `navigator.bluetooth.requestDevice({ filters: [{ services: [WHOOP_SERVICE_UUID] }] })` → native device picker.
2. App connects, gets the 5 characteristics from the custom service.
3. App writes "start streaming" command to CHAR_CMD (same byte sequence Python uses).
4. App subscribes to CHAR_DATA notifications.
5. Each notification → `ble/protocol.js` decodes 96-byte packet → emits `sample` event.
6. `app.js` batches samples and writes to IndexedDB (one transaction per second).
7. Live HR card updates on every sample (high-rate UI, low-rate persistence).

**Dashboard load:**
1. Open IndexedDB; read `profile` (prompt for age if missing).
2. Read last 24 h samples downsampled to 1-minute resolution; render Overview immediately.
3. Background: scan `daily_metrics` for missing dates within last 14 days → run `rollup.js` per day → write back → re-render affected tabs.

**Reconnect:**
1. On `gattserverdisconnected` → exponential backoff (1, 2, 4, 8, max 30 s).
2. Status pill: *Connected* / *Reconnecting…* / *Disconnected*.
3. On reconnect → reissue start-streaming command if needed.

## Tradeoffs explicitly accepted

1. **Per-browser data.** Mac Chrome and iPhone Bluefy each hold their own dataset. Mitigation: *Export JSON* / *Import JSON* buttons in Settings (v1 scope).
2. **Foreground-only recording.** Browser tab must be active. No background overnight recording on iOS.
3. **On-demand rollups.** Daily metrics computed when dashboard loads, not in background. Catch-up handles multi-day gaps.
4. **Phone hosting deferred.** Mac dev uses `http://localhost`. Phone production needs https — choose Cloudflare Pages / GitHub Pages / Vercel later. Doesn't block MVP.
5. **One device at a time.** BLE only allows one central per peripheral; toggle by disconnecting on one side before pairing on the other.

## Risks

- **Web Bluetooth command sequence.** If the band requires a specific "start streaming" command before sending packets, port the exact byte sequence from Python. Verify in Phase 1 by sending Python's bytes verbatim. CHAR_DATA may also auto-stream once subscribed — untested.
- **IndexedDB write throughput at 1 Hz.** Negligible. Single transaction per batched second.
- **Chart.js perf with ≈86,400 points/day.** Downsample to 1-minute averages for charts. Use raw samples only inside HRV windows and the 5-minute Live view.
- **iOS IndexedDB quota.** Historically ~50 MB – 1 GB depending on iOS version + PWA-install status. ~50 bytes/sample × 86,400/day ≈ 4 MB/day. 90 days ≈ 400 MB — could hit quota on older iOS. Mitigation: prune raw samples older than N days; keep `daily_metrics` indefinitely.
- **Bluefy quirks.** Untested. Fallback plan = Capacitor-wrapped PWA via free Apple ID (7-day re-sign). Not committed until Mac MVP works.
- **Web Bluetooth has no persistent pairing.** User clicks Connect each session. Acceptable.

## Implementation order

**Phase 1 — BLE + storage, prove the wire works**
1. CRC + protocol decoder + tests
2. IndexedDB layer + tests
3. BLE client (connect, subscribe, decode, reconnect)
4. Minimal UI: Connect button + live HR card. No metrics. Verify real Whoop data appears in IndexedDB.

**Phase 2 — Metrics port**
5. HRV (RMSSD/SDNN/pNN50/Malik) + tests
6. Recovery (z-score + 4-component breakdown) + tests
7. Strain (Borg curve, HR zones) + tests
8. Sleep (stages, need, debt, consistency, respiratory rate) + tests
9. Workouts (auto-detect) + tests

**Phase 3 — UI rewire**
10. Refactor v0.2 `app.js`: IndexedDB queries replace `fetch('/api/...')`.
11. Wire each tab's render function to its corresponding query.
12. Settings: profile form + Export/Import JSON.

**Phase 4 — Polish**
13. Reconnect logic + status pill.
14. Demo data button (port `seed.py` → `web/js/dev/seed.js`).
15. Strip Python API routes; rename `dashboard.py` → `static_server.py`.
16. README update.

**Phase 5 — Deferred (post-MVP)**
- PWA manifest + service worker.
- Phone hosting decision + deploy.
- Historical sync from band's onboard storage (port from `vendor/whoomp`).

## Testing strategy

- **Unit (JS):** packet decoder, CRC, HRV math, recovery, strain, sleep classifier, zones, workouts. Synthetic-data tests mirror existing Python tests one-for-one.
- **Manual E2E in Mac Chrome:** wake band, Connect, record ≥1 hour, verify samples in IndexedDB devtools, verify live HR card, simulate disconnect and verify auto-reconnect.
- **Existing Python tests:** retained as the porting spec until the corresponding JS tests pass. Retired only when JS coverage matches.

## Decisions deferred to writing-plans

- JS test runner: vitest (Node + jsdom) vs browser-based runner.
- Build: pure ES modules (preferred — preserves zero-build property) vs esbuild/Vite.
- Specific Chart.js + idb versions to vendor.
- Whether `seed-demo` ships in v1 or moves to a hidden dev-only path.
