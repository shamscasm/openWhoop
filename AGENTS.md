# whoof — Agent Summary

## Goal
Redesign Overview page with Bevel-inspired layout, move strap sync behind gear icon, improve typography, extract accel data, fix device events, and polish sync UX.

## Constraints & Preferences
- Score ribbon: horizontal scroll on mobile, full row on desktop
- Strap sync/BLE panel behind gear icon (settings drawer), not on overview
- Wake alarm and journal removed from overview entirely
- Premium feel: glass refinements, subtle gradients, elevated shadows
- Typography: Bebas Neue for big numbers, Plus Jakarta Sans for card headers, Inter for body
- Battery ring with last-synced time in Today grid
- Accel X/Y/Z and motion extracted from realtime raw packets automatically
- Device events container: no overflow, deduplicated, nicely formatted
- App footer: "Made by Shams Khan · Vibeset Technology Inc." with LinkedIn link

## Progress

### Done
- Typography: Bebas Neue for display, Plus Jakarta Sans for headers, Inter for body
- Score ribbon with horizontal scroll on mobile, full row on desktop
- Hero card (3-stats), vitals strip (HR/HRV/RR), timeline, insights card
- Battery ring card with SVG ring fill + last-synced relative time from battery event
- Status-line as structured data bar in overview (samples, days, last sync, battery)
- Strap sync/BLE moved behind gear icon in settings drawer
- Wake alarm and journal removed from overview (JS null-safe)
- App footer (Made by Shams Khan · Vibeset Technology Inc.) in main and drawer
- Accel X/Y/Z (i16 LE) + motion (uint8) extracted from REALTIME_RAW_DATA packets
- Auto-start raw data mode on connect for 4.0 straps
- Motion card in Live tab
- Device events container: overflow hidden, max-height 240px + scroll, deduplication by kind|detail|minute, formatted display (hello with model+firmware, battery, clock)
- `trend7` (7-day daily_metrics history) added to `/api/overview`
- Removed old mvp-panel display toggle, `mvp-data-status` updates for drawer
- Cloud sync indicator in top bar (cloud icon with colored status dot) — locked/unlocked/syncing/ok/err
- Enhanced sync section in settings drawer: head with last-sync label, copy-id button, pass-row with unlock button, sync-now with icon, sync-status-row with icon+text
- Complete CSS for enhanced sync UI and sync indicator
- Rewrote `initSyncUI()`: auto-sync timer (every 5 min when unlocked), persistent last sync time in localStorage (`whoof-sync-status`), sync indicator dot updates, copy sync ID, click sync indicator to open drawer
- Periodic refresh of last-sync relative time (every 60s)
- Tooltip on sync indicator shows last sync relative + absolute time

### Done
- Verified R2 sync pipeline end-to-end: `whoof-sync` bucket exists (created 2026-06-18), wrangler authenticated, Pages Function deployed and responds at `getwhoof-92j.pages.dev/api/sync`
- Curl tests confirmed: PUT (create) → 204, PUT (duplicate) → 412, GET → 200, GET (missing) → 404, DELETE → 204, PUT (correct ETag update) → 204, PUT (wrong ETag) → 412 — all CRUD + concurrency control working correctly

### Blocked
- *(none)*

## Key Decisions
- Accel extraction auto-starts on connect for 4.0 straps (no manual button needed)
- `/api/live` computes `motion = |accel_x| + |accel_y| + |accel_z|` — storing accel auto-populates Live Motion card
- Sync dedup uses `kind|detail|minute` key
- Settings drawer footer uses `margin-top: auto` on flex column
- Sync status persisted in localStorage under `whoof-sync-status` key `{lastSync, lastResult, lastDetail}`
- Auto-sync timer runs only while unlocked; interval cleared on lock

## Next Steps
1. Debug R2 sync pipeline — verify `wrangler.toml` bucket binding `SYNC` → `whoof-sync` matches a real R2 bucket in the Cloudflare account; test with manual push/pull via dev toolbar
2. Add simple static passphrase auth prompt before dashboard loads (optional)

## Critical Context
- Sync is fully coded end-to-end: `functions/api/sync.js` handles R2 GET/PUT with ETag; `web/js/sync/client.js` pull-merge-push with crypto; `web/js/sync/crypto.js` PBKDF2-SHA-256 (600k) + AES-GCM-256
- R2 bucket `whoof-sync` bound as `env.SYNC` in `wrangler.toml` — if account lacks this bucket, all requests 404 silently
- Sync ID is UUID in localStorage → R2 key prefix `sync/{syncId}/snapshot` + Bearer token
- IndexedDB stores all data locally; SQLite (Python server) is only for local `./run.sh dash` mode
- Accel data flows only while raw data mode is active (auto-started on connect for 4.0)

## Relevant Files
- `web/index.html`: overview (lines 91-245), settings drawer (lines 688-751), battery card, motion card, app footer, device events
- `web/styles.css`: all component styles including `.status-line`, `.battery-card`, `.event-log`, `.ev`, `.drawer-footer`, `.app-footer`, `.sync-indicator`, `.sync-dot`, `.sync-section`
- `web/app.js`: `loadOverview()` (line 555), `loadLive()` (line 1553), `refreshStatus()` (line 251), device events rendering (line 1588)
- `web/js/app-mvp.js`: `sensorSample` handler with accel DB write (line 178), auto-start raw data on connect (line 133), sync UI init with auto-sync timer (line 610)
- `web/js/ble/parsers.js`: `parseRealtimeRaw()` returning `accelX`, `accelY`, `accelZ`, `motion` (line 87)
- `web/js/ble/client.js`: `startRawData()`/`stopRawData()` (line 579)
- `web/js/sync/client.js`: full pull-merge-push sync client (line 1-240)
- `web/js/sync/crypto.js`: PBKDF2 + AES-GCM-256
- `functions/api/sync.js`: Pages Function for R2 GET/PUT with ETag concurrency
- `wrangler.toml`: R2 bucket binding `SYNC` → `whoof-sync` (line 22)
- `AGENTS.md`: this file
