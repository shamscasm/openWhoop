# openWhoop

> **Your WHOOP strap, fully open. No subscription. No cloud dependency.**

openWhoop is a **fully local, browser-based** BLE client for WHOOP 4.0 and 5.0
straps. It reads live sensor data over Bluetooth Low Energy, computes HRV,
recovery, strain, sleep, steps, and more — all inside your browser's IndexedDB.
Nothing leaves your machine unless you choose to sync.

Built from the reverse-engineering work of the open-source community and
maintained by [Shams Khan](https://linkedin.com/in/shamscasm).

---

## ✨ Features

### 📊 Dashboard tabs

| Tab | What it shows |
|-----|---------------|
| **Overview** | Score ribbon (recovery/strain/sleep), hero metrics (HRV/RHR/resp/temp), vitals strip, battery ring with last-sync, steps card (strap or Apple Health), timeline, insights, cloud sync indicator |
| **Recovery** | Recovery ring score, HRV/RHR/ST components vs 14-day baselines, 7-day trend, Poincaré plot, health monitor, ACWR, strain target |
| **Sleep** | Hypnogram (Deep/REM/Light/Wake), sleep totals, performance %, quality score (ring + breakdown), need fulfillment, debt, consistency, stages breakdown, bedtime/wake time, RR, SpO₂, 30-day trends, **wake alarm** with BLE + browser notification |
| **Strain** | Day strain curve, ACWR (acute:chronic ratio), zone minutes bar, workout cards, 30-day strain trend |
| **Activity** | Steps (source + confidence), active kcal, strain score, HR zone minutes (Z1–Z5 bars), recent workouts list, 7-day steps & kcal bar charts |
| **Trends** | Metric picker chart + 7-day rolling avg, weekday averages, full daily metrics table (HRV/RHR/HR/sleep/steps/kcal/…), personal records, weekly summary with week-over-week deltas, tag correlations (Cohen's d), 30-day heatmap calendar with date drill-down |
| **Live** | Real-time HR/RR/temp/motion/steps/battery, 5-min HR chart, device events log, session stats, motion source/age |
| **Body / Nutrition** | Body composition (weight BLE scale + manual), BMR, TDEE, food diary with AI macro estimate via Cloudflare Workers AI, macros tracking, weight trend |
| **Coach** | AI chat grounded in today's recovery/strain/sleep/s stress data — asks your strap what it knows and answers in plain English |

### 📈 Computed metrics

| Metric | Method | Source |
|--------|--------|--------|
| **Heart rate** | Direct BLE decode | Live packet bytes 1–2 |
| **RR interval** | Direct BLE decode | Live packet bytes 3–4 |
| **SpO₂** | Direct BLE decode | Live packet byte 5 |
| **Skin temperature** | Offset decode (`byte − 25 °C`) | Live packet byte 6 |
| **Accelerometer (X/Y/Z)** | i16 LE decode | Live raw data bytes 7–12 |
| **Motion intensity** | `\|x\| + \|y\| + \|z\|` | Live raw data byte 13 |
| **HRV (RMSSD)** | √(mean of squared successive RR diffs) | Sleep window RR intervals |
| **HRV (SDNN / pNN50)** | Standard deviation / % of NN50 | Sleep window RR intervals |
| **Recovery score** | z-score vs 14-day RMSSD baseline → 0–100 | Daily rollup |
| **Strain score** | Borg-like `21·(1 − e^(−load/100))` | HR throughout the day |
| **Resting HR** | 5th percentile of daily HR | Daily rollup |
| **Sleep detection** | HR + RR + motion window analysis | Overnight samples |
| **Sleep stages** | HMM-inspired classifier (Deep/REM/Light/Wake) | Sleep window + HR |
| **Sleep source** | `motion+hr` or `hr-only` (fallback when no accel) | Per-night |
| **Sleep quality** | Composite: performance, efficiency, restorative, consistency, debt | Daily rollup |
| **Steps (strap)** | High-pass filter + peak detection on accel | Live raw accel stream |
| **Steps (Apple Health)** | Imported via Apple Health Export | Phone-side only |
| **VO₂max** | Uth-Sørensen formula | Submax HR + profile |
| **Fitness age** | From VO₂max | Tabular lookup |
| **Physiological age** | Multivariate: VO₂max + RHR + HRV + sleep + recovery | Composite model |
| **Heart rate recovery** | HR drop 60s/120s post-workout peak | Per-workout |
| **ACWR** | Acute (7d) / Chronic (28d) strain ratio | Rolling windows |
| **Stress avg** | HR-derived daytime stress estimate | Daytime hours |
| **Energy burn** | MET-based resting + active caloric estimate | HR + profile |
| **Sleep architecture** | Latency, efficiency, WASO, cycles, disturbances | Sleep window |

### 🔌 Connectivity

| Feature | Description |
|---------|-------------|
| **BLE 4.0 / 5.0** | Pair with Whoop 4.0 and 5.0 straps over Web Bluetooth |
| **Auto raw data mode** | Automatically starts raw accel stream on connect (4.0) |
| **Historical backfill** | Drains strap's flash buffer on connect — catches up missed data |
| **Auto-reconnect** | Exponential backoff on disconnect, preserves session |
| **Clock sync** | Compares strap RTC to system clock, auto-corrects drift |
| **BLE alarm** | Set / disable / test haptic vibration on the strap |
| **Generic HR profile** | Expose strap as standard BLE HR monitor for Strava/Zwift/Peloton |
| **BT scale** | Pair with Weight Scale Service (0x181D) scales (Beurer, A&D, etc.) |
| **Multi-tab guard** | Prevents multiple GATT connections from different tabs |
| **Raw packet capture** | NDJSON dump of every framed packet for protocol research |

### ☁️ Cloud sync

- **End-to-end encrypted** backup across devices via Cloudflare R2
- **PBKDF2-SHA-256 (600k)** key derivation + **AES-GCM-256** encryption
- Passphrase never leaves your browser, never stored server-side
- Sync ID stored in localStorage, Bearer token for API auth
- ETag concurrency control (last-write-wins with conflict detection)
- Auto-sync every 5 minutes (while unlocked)
- Visual sync indicator with lock/unlock/syncing/ok/error states

### 💾 Data & export

| Feature | Description |
|---------|-------------|
| **IndexedDB** | All data stored locally in your browser (samples, metrics, journals, workouts, profile) |
| **CSV export** | Raw samples, daily metrics, journal entries, detected workouts |
| **JSON backup** | Full export/import for cross-device restore |
| **PWA** | Installable, cache-first assets, offline-capable |
| **Push notifications** | Opt-in for backfill complete, low recovery, low battery, HR anomaly |
| **Apple Health** | Import steps, active energy via Apple Health Export or Shortcut |

### 🧠 Analysis & coaching

- **Health insights engine** — 12 generators tracking HRV, RHR, sleep, strain, ACWR, skin temp, SpO₂, respiratory rate
- **Tag correlation** — Log lifestyle tags (alcohol, caffeine, meditation, etc.) → Cohen's d effect size on recovery
- **Daily training plan** — Rest / Active / Train / Push recommendation from recovery + strain + sleep debt
- **Weekly summary** — 7-day recap with week-over-week ✅/⚠️ deltas
- **Recovery calendar** — 30-day heatmap, click any day to drill into Recovery tab
- **Historical date nav** — Browse any past day in Recovery, Sleep, Strain
- **Personal records** — All-time bests for HRV, RHR, recovery, sleep, strain, sleep performance
- **Poincaré plot** — SD1/SD2 scatter from night's RR intervals
- **Recovery coach** — One-line recommendation with strain target

---

## 🚀 Quick start

```bash
# Option 1: Python dev server
python3 -m http.server 8765 --directory web

# Option 2: Included script (supports --host for LAN access)
./run.sh dash --host 0.0.0.0 --port 8765
```

Open **Chrome** (Web Bluetooth) at `http://localhost:8765/`.

1. Tap your WHOOP band to wake it (LEDs flash)
2. Click **Connect Whoop** → select your band from the device picker
3. Watch live data stream in — the dashboard populates automatically

> **iPhone?** Use [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser (Web Bluetooth support). Same URL.

---

## 🗺️ Project layout

```
openWhoop/
├── web/                          # Browser PWA (the whole app)
│   ├── index.html                # Dashboard HTML (all tabs)
│   ├── app.js                    # Tab routing, overview/sleep/strain/live/activity rendering
│   ├── styles.css                # All component & layout styles
│   ├── sw.js                     # Service worker (cache-first, v8)
│   ├── manifest.json             # PWA manifest
│   ├── vendor/                   # Vendored deps (Chart.js 4.4, idb 8.0)
│   └── js/
│       ├── app-mvp.js            # BLE lifecycle, sync UI, health import, sensor handlers
│       ├── ble/                  # BLE stack
│       │   ├── client.js         # WhoopClient — connect, commands, streaming
│       │   ├── parsers.js        # Packet parsing (HR, RR, accel, raw data)
│       │   ├── protocol.js       # Build commands, parse responses
│       │   ├── crc.js            # Whoop custom CRC-32
│       │   ├── uuids.js          # GATT UUIDs
│       │   └── packet.js         # Frame assembly
│       ├── data/                 # IndexedDB layer
│       │   ├── schema.js         # Store definitions & migrations
│       │   ├── db.js             # Database open/upgrade
│       │   ├── queries.js        # Typed read/write helpers
│       │   ├── api-shim.js       # /api/* fetch interceptor → IndexedDB
│       │   └── export.js         # JSON/CSV export & import
│       ├── metrics/              # Compute engine
│       │   ├── rollup.js         # Daily rollup (all metrics in one pass)
│       │   ├── hrv.js            # RMSSD, SDNN, pNN50
│       │   ├── strain.js         # Strain score (Borg-like)
│       │   ├── zones.js          # HR zones, caloric burn
│       │   ├── sleep.js          # Sleep detection, stage classification
│       │   ├── steps.js          # Accel-based step estimation
│       │   ├── recovery.js       # Recovery score, breakdown
│       │   ├── workouts.js       # Workout detection
│       │   ├── insights.js       # 12 health insight generators
│       │   ├── plan.js           # Daily training plan
│       │   ├── weekly.js         # Weekly summary
│       │   ├── correlate.js      # Tag correlation (Cohen's d)
│       │   ├── vo2max.js         # VO₂max, fitness age
│       │   ├── whoopage.js       # Physiological age
│       │   ├── hrr.js            # Heart rate recovery
│       │   └── healthmonitor.js  # Today's vitals vs baseline
│       ├── sync/                 # Cloud sync
│       │   ├── client.js         # Pull-merge-push sync client
│       │   └── crypto.js         # PBKDF2 + AES-GCM-256
│       ├── health/               # Apple Health bridge
│       │   ├── apple.js          # Apple Health Export parser
│       │   └── sync.js           # LAN health poll
│       └── util/                 # Utilities
│           ├── events.js         # Event emitter
│           ├── time.js           # Time helpers
│           ├── multitab.js       # Single-tab BLE guard
│           └── notify.js         # Browser notifications
├── functions/api/                # Cloudflare Pages Functions
│   ├── sync.js                   # R2 GET/PUT/DELETE with ETag
│   └── coach.js                  # AI Coach via Workers AI
├── whoof/                        # Python package (legacy server)
├── tests/                        # Test suite (Vitest + Python)
│   ├── js/                       # 560+ Vitest unit tests
│   └── *.py                      # Python reference tests
├── wrangler.toml                  # Cloudflare Pages + R2 config
├── vitest.config.js              # Vitest config
├── run.sh                        # Dev server launcher
└── README.md                     # This file
```

---

## 📋 Implementation status

### ✅ Done

**Core functionality**
- [x] BLE connect/disconnect for WHOOP 4.0 and 5.0
- [x] Live HR, RR, SpO₂, skin temp streaming
- [x] Historical data backfill from strap flash
- [x] Accelerometer X/Y/Z + motion extraction from raw packets
- [x] Auto-start raw data mode on connect for 4.0 straps
- [x] BLE alarm (set/disable/test haptics)
- [x] BLE clock sync (auto RTC drift correction)
- [x] Generic HR profile toggle
- [x] Bluetooth weight scale pairing (0x181D)
- [x] Auto-reconnect with exponential backoff

**Metrics engine**
- [x] HRV (RMSSD, SDNN, pNN50) with baseline
- [x] Recovery score (z-score → 0–100)
- [x] Strain score (Borg-like load model)
- [x] Resting HR (5th percentile)
- [x] Sleep detection + stage classification (Deep/REM/Light/Wake)
- [x] Step estimation from strap accelerometer
- [x] Apple Health step/kcal import
- [x] Sleep source/confidence tracking (motion+hr vs hr-only fallback)
- [x] Sleep quality composite score
- [x] VO₂max, fitness age, physiological age
- [x] Heart rate recovery per workout
- [x] ACWR (acute:chronic workload ratio)
- [x] Stress estimate, caloric burn
- [x] Zone minutes (Z1–Z5)
- [x] Stale rollup detection + recompute

**Dashboard UI**
- [x] Overview: score ribbon, hero metrics, vitals, battery ring, steps, timeline, insights
- [x] Recovery: ring, components, 7-day trend, Poincaré, health monitor
- [x] Sleep: hypnogram, stats, quality ring, stages, 30-day trends, wake alarm
- [x] Strain: curve, ACWR, zone bars, workouts
- [x] Activity: steps, kcal, strain, HR zones, workouts list, 7-day charts
- [x] Trends: chart + rolling avg, weekday rollup, table, records, summary, calendar
- [x] Live: real-time cards, HR chart, events, stats, motion source/age
- [x] Body/Nutrition: weight, BMR, TDEE, food diary, macros, AI estimate
- [x] Coach: AI chat via Workers AI

**Sync & export**
- [x] E2E-encrypted R2 cloud sync (PBKDF2 + AES-GCM-256)
- [x] Auto-sync timer (5 min when unlocked)
- [x] Sync indicator with lock/unlock/syncing/ok/err states
- [x] CSV export (samples, metrics, journal, workouts)
- [x] JSON backup/restore
- [x] PWA: installable, cache-first, offline-capable
- [x] Browser notifications (backfill, recovery, battery, HR anomaly)

**Design & UX**
- [x] Bevel-inspired glass design system
- [x] Bebas Neue for display numbers, Plus Jakarta Sans for headers, Inter for body
- [x] Mobile-first responsive layout
- [x] Battery ring SVG with last-sync time
- [x] Sync section behind gear icon in settings drawer
- [x] Cloud sync indicator in top bar with tooltip
- [x] Date navigation for historical browsing
- [x] App footer

### 🔄 In Progress / Needs Polish

| Item | Priority | Notes |
|------|----------|-------|
| Live dashboard auto-refresh | 🟢 Done | 15s interval for live tab |
| Cloud sync last-sync in status line | 🟢 Done | Shows both sample recency and cloud sync time |
| Wake alarm in Sleep tab | 🟢 Done | BLE + browser notification fallback |
| Activity tab | 🟢 Done | Steps, kcal, zones, workouts, 7-day trends |
| Steps in Trends | 🟢 Done | Table columns + trend metric picker |
| Battery "last synced" tracking | 🟡 Medium | Strap event shows battery time, cloud sync falls back to web sync timestamp |
| CI workflow re-enable | 🟡 Low | `.github/workflows/ci.yml` removed for token scope; add back when needed |

### 📌 Planned / Future

| Feature | Priority | Notes |
|---------|----------|-------|
| Dedicated Workouts tab | 🟡 Medium | Merge workout data into its own view |
| Advanced sleep metrics | 🟡 Medium | Sleep regularity index, circadian phase |
| Historical step backfill | 🟡 Medium | Steps only from live accel; need Apple Health for past days |
| Export to Apple Health / Health Connect | 🟠 Low | Write-back to system health databases |
| Multi-user / family | 🔴 Low | Separate profiles per strap |
| Oura / Fitbit compatibility | 🔴 Low | Additional hardware beyond WHOOP |

---

## 💻 Tech stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JS (no framework) |
| **Charts** | Chart.js 4.4 |
| **Storage** | IndexedDB via idb 8.0 |
| **BLE** | Web Bluetooth API |
| **Backend (optional)** | Python stdlib http.server |
| **Edge** | Cloudflare Pages + Workers AI |
| **Sync storage** | Cloudflare R2 |
| **Testing** | Vitest (560+ tests) |
| **PWA** | Service Worker + Web Manifest |

---

## 🔗 Links

- **Source**: [github.com/shamscasm/openWhoop](https://github.com/shamscasm/openWhoop)
- **Author**: [Shams Khan](https://linkedin.com/in/shamscasm)
- **Based on**: [madhursatija/whoof](https://github.com/madhursatija/whoof)

---

## ⚠️ Disclaimer

This is an **unofficial, third-party project** provided for **educational, research,
and personal interoperability purposes only**. It is **not affiliated with,
endorsed by, or sponsored by WHOOP, Inc.** "WHOOP" and "WHOOP 4.0" are
trademarks of WHOOP, Inc.

The metrics surfaced by this software are **not clinically validated and
are not medical advice**. Do not use for medical, clinical, diagnostic,
or therapeutic purposes.

See [DISCLAIMER.md](DISCLAIMER.md) for full terms.

---

## 📄 License

MIT. See [LICENSE](LICENSE).

---

*Made by [Shams Khan](https://linkedin.com/in/shamscasm) · Vibeset Technology Inc.*
