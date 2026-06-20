# openWhoop

An **independent, unofficial, educational** BLE client for WHOOP 4.0 and 5.0
straps. Reads heart rate, RR intervals, SpO₂, skin temperature, and
accelerometer data off the band over Bluetooth Low Energy, stores everything
locally in your browser's IndexedDB, and computes **HRV, recovery, strain,
sleep, and step** estimates entirely on-device — no cloud, no subscription.

Built from the excellent reverse-engineering work of
[`jogolden/whoomp`][whoomp] and [`bWanShiTong/reverse-engineering-whoop`][bwan],
forked from the archived [`madhursatija/whoof`][whoof].

> [!IMPORTANT]
> **Disclaimer.** This is an unofficial, third-party project provided for
> **educational, research, and personal interoperability purposes only**.
> It is **not affiliated with, endorsed by, or sponsored by WHOOP, Inc.**
> "WHOOP" and "WHOOP 4.0" are trademarks of WHOOP, Inc.; references here
> are nominative and describe hardware compatibility only.
>
> The metrics surfaced by this software are **not clinically validated and
> are not medical advice**. Do not use for medical, clinical, diagnostic,
> or therapeutic purposes. The software is provided "as is" without
> warranty of any kind (MIT). **See [DISCLAIMER.md](DISCLAIMER.md) before
> using.**

> The WHOOP strap broadcasts raw sensor telemetry over standard BLE without
> a subscription gate at the wire layer. This project lets you read that
> telemetry from a strap you own — nothing more.

---

## Features

### Dashboard (tabs)

- **Overview** — score ribbon, hero metrics (HRV/RHR/resp/temp), vitals strip, timeline/insights, battery ring with last-sync time, steps card (strap accel or Apple Health), cloud sync indicator
- **Recovery** — recovery ring, components breakdown (HRV/RHR/baselines), 7-day trends, Poincaré plot, health monitor, ACWR
- **Sleep** — hypnogram, sleep totals/performance/quality, stages breakdown, bedtime/wake time, 30-day trends, **wake alarm** with BLE strap alarm + browser notification fallback
- **Strain** — strain curve, ACWR, zone minutes, workout cards
- **Activity** — daily steps, active kcal, strain, HR zone minutes, recent workouts list, 7-day trend charts
- **Trends** — raw + 7-day rolling average chart, weekday averages, full daily metrics table (including steps/active kcal), personal records, weekly summary, tag correlations, heatmap calendar
- **Live** — real-time HR/resp/temp/motion/steps/battery, HR chart, device events, session stats
- **Body / Nutrition** — body composition tracking, weight scale (BLE), food logging with AI estimate
- **Coach** — AI-powered coach grounded in today's data (Cloudflare Workers AI)

### Analysis
- HRV (RMSSD, SDNN, pNN50), recovery score (z-score → 0–100), strain (Borg-like load)
- Sleep detection + stage classification (Deep/REM/Light/Wake)
- **Step estimation** from strap accelerometer (high-pass filter + peak detection)
- **Apple Health integration** — daily steps/active energy import
- **Health insights engine** — 12 generators across HRV, RHR, sleep, strain, ACWR
- **Tag correlation analysis** — Cohen's d for lifestyle tags vs recovery
- **Weekly summary** with week-over-week deltas, ACWR, training plan

### Data & connectivity
- **End-to-end encrypted cloud sync** via Cloudflare R2 (PBKDF2 + AES-GCM-256)
- **IndexedDB persistence** — all data local, no server required
- **BLE alarm** — set/disable/test haptic vibration on the strap
- **BLE clock sync** — automatic RTC drift correction
- **Generic HR Profile** — expose strap as standard BLE HR monitor for Strava/Zwift
- **Bluetooth scale** — pair with any Weight Scale Service (0x181D) scale
- **Raw packet capture** — NDJSON dump for protocol research
- **CSV/JSON export** — full backup and restore
- **Progressive Web App** — installable, offline-capable, push notifications
- **Multi-tab guard** — prevents multiple GATT connections

---

## Quick start

```bash
python3 -m http.server 8765 --directory web
```

Or use the included script:

```bash
./run.sh dash --host 0.0.0.0 --port 8765
```

Open **Chrome** (Web Bluetooth) at `http://localhost:8765/`.

1. Tap your Whoop band to wake it.
2. Click **Connect Whoop** — Chrome shows a device picker.
3. Select your band.

The dashboard populates automatically as data streams in.

---

## Project layout

```
openWhoop/
├── web/
│   ├── index.html          Dashboard (overview, sleep, activity, live, …)
│   ├── app.js              Tab routing, overview/sleep/activity/live rendering
│   ├── styles.css          All component styles
│   ├── sw.js               Service worker (cache-first)
│   ├── vendor/             Vendored dependencies (Chart.js, idb)
│   └── js/
│       ├── app-mvp.js      BLE lifecycle, sync UI, health import, sensor handlers
│       ├── ble/            BLE client, protocol, parsers, CRC
│       ├── data/           IndexedDB schema, queries, API shim, export
│       ├── metrics/        HRV, strain, sleep, recovery, steps, rollup, insights
│       ├── sync/           E2E-encrypted R2 sync client, crypto
│       ├── health/         Apple Health import
│       └── util/           Events, time, multitab guard, notifications
├── whoof/                  Python package (legacy HTTP server)
├── functions/api/          Cloudflare Pages Functions (R2 sync)
├── tests/                  Vitest unit tests + Python reference tests
├── wrangler.toml           Cloudflare Pages + R2 binding config
└── run.sh                  Dev server launcher
```

---

## Credits

- [jogolden/whoomp][whoomp] — original Whoop 4.0 reverse engineering
- [bWanShiTong/reverse-engineering-whoop][bwan] — protocol writeup, CRC parameters
- [madhursatija/whoof][whoof] — the archived fork this project was built from
- [christianmeurer/whoop-reader][whoop-reader] — Python BLE driver reference
- [jacc/whoop-re][jacc] — REST API research

[whoof]:         https://github.com/madhursatija/whoof
[whoop-reader]:  https://github.com/christianmeurer/whoop-reader
[whoomp]:        https://github.com/jogolden/whoomp
[bwan]:          https://github.com/bWanShiTong/reverse-engineering-whoop
[jacc]:          https://github.com/jacc/whoop-re

---

## License

MIT. See [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

Made by [Shams Khan](https://linkedin.com/in/shamscasm) · Vibeset Technology Inc.
