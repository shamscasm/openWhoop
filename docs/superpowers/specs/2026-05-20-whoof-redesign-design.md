# whoof v0.2 — Whoop-style redesign

Date: 2026-05-20
Status: implementing

## Goal
Replace the single-page 4-card dashboard with a Whoop-style multi-tab dashboard, and add ~10 new metrics derived from data already captured (HR, RR, SpO2, skin temp, 3-axis accel, motion, PPG amplitude, ambient light, PPG quality). Stay on stdlib + vanilla JS + Chart.js — no new runtime deps.

## Information architecture
Single-page app, tab nav, polls every 10s.

- **Overview** — recovery ring, strain bar, last-night sleep snapshot, current HR, recent workouts.
- **Recovery** — score + 4-component breakdown (HRV / RHR / Sleep / Prior strain), 30-day HRV & RHR, skin-temp deviation.
- **Sleep** — hypnogram (stage timeline), stage totals, sleep performance vs need, debt, consistency, respiratory rate, SpO2 avg/min.
- **Strain** — strain curve, HR-zones donut, workouts list, calories.
- **Trends** — switchable line chart, weekday averages.
- **Live** — last 5 min HR/SpO2/temp, device status, battery, packet rate.
- Slide-out **Settings** — profile (age, sex, weight, height, max-HR override).

## New metrics

| Metric | Formula |
|---|---|
| Sleep stages | 30s epochs; wake (motion>200 OR HR>baseline+15), deep (motion<30 AND HR≈min AND low RMSSD), rem (motion<50 AND HR elevated AND high RMSSD), light = rest |
| Sleep need (min) | `480 + min(120, debt7d/2) + min(60, strain_yesterday*3)` |
| Sleep performance | `100 * asleep / need`, capped 100 |
| Sleep debt | sum of max(0, need_i − asleep_i) over 7d |
| Sleep consistency | `100 − clamp(stddev(bed,wake), 0, 120) / 1.2` |
| HR zones | %max-HR: Z1 50-60, Z2 60-70, Z3 70-80, Z4 80-90, Z5 90-100 |
| Calories | Keytel: `((-55.0969+0.6309*HR+0.1988*kg+0.2017*age)/4.184) * min` (men) / equivalent (women); MET fallback when profile missing |
| Respiratory rate | Peak-count detrended RR-interval series in deep sleep, convert to bpm, clamp 8-24 |
| Skin temp deviation | today_mean − 14d_baseline |
| Stress level | 5-min rolling RMSSD, z-score vs baseline, inverted, clamped 0-100 |
| Workout detect | sliding 10-min window, median HR > 60% max → workout; end after 5 min low; merge gaps < 5 min |
| Recovery breakdown | HRV(40%) + RHR(20%) + Sleep(30%) + PriorStrain(10%) |

## Schema changes (all idempotent in `db.connect`)

New tables: `profile` (singleton), `sleep_stages`, `workouts`.

New columns on `daily_metrics`: `deep_sleep_minutes`, `rem_sleep_minutes`, `light_sleep_minutes`, `wake_minutes`, `sleep_need_minutes`, `sleep_performance_pct`, `sleep_debt_minutes`, `sleep_consistency_pct`, `respiratory_rate`, `skin_temp_deviation_c`, `calories`, `zone_minutes` (JSON), `recovery_hrv_component`, `recovery_rhr_component`, `recovery_sleep_component`, `recovery_strain_component`, `stress_avg`.

## File layout

```
whoof/
  db.py        # extended: migration, profile/sleep_stages/workouts helpers
  metrics.py   # extended: recovery breakdown, skin temp deviation
  sleep.py     # NEW: stage classifier, need/debt/consistency, respiratory rate
  zones.py     # NEW: HR zones, calories (Keytel), stress
  workouts.py  # NEW: auto-detection
  dashboard.py # extended: new endpoints
  cli.py       # extended: profile command, richer seed-demo
web/
  index.html   # rewritten: tab shell
  app.js       # NEW: tab routing, fetch logic, all renders
  styles.css   # NEW: design tokens, components
```

## API endpoints

Keep `/api/status`, `/api/today`, `/api/history`, `/api/recompute`. Add:

- `GET /api/overview` — today summary for overview tab
- `GET /api/sleep?date=YYYY-MM-DD` — stages, totals, performance, debt, consistency, respiratory rate
- `GET /api/recovery?date=YYYY-MM-DD` — score + 4 components
- `GET /api/strain?date=YYYY-MM-DD` — strain curve, zones, workouts list, calories
- `GET /api/trends?metric=X&days=N` — series for any metric
- `GET /api/workouts?days=N` — workouts list
- `GET /api/profile` / `POST /api/profile` — profile read/update
- `GET /api/live?seconds=300` — recent stream (polling, not SSE)

## Visual style

- Near-black background (#070809), high-contrast text.
- Recovery color: green / amber / red (≥67 / 34-66 / <34).
- Strain color: blue → cyan.
- Sleep color: purple.
- Custom SVG components: recovery ring (270° arc), strain bar (vertical), sleep hypnogram (banded timeline), zones donut.
- Chart.js for line/bar trends.

## Out of scope (deferred)

- Decoding undecoded BLE bytes 20-91 (would need fresh capture + reverse engineering)
- Journaling / sleep behavior logging
- Goal setting / strain coach
- Mobile PWA / offline
- Multi-device support

## Testing

New: `tests/test_sleep.py`, `tests/test_zones.py`, `tests/test_workouts.py`. Each module gets synthetic-data unit tests so behaviour is verifiable without a real strap. Existing 18 tests must keep passing.
