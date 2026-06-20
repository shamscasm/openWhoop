// In-browser shim that mimics the Python /api/* endpoints from
// whoof/dashboard.py, but reads from IndexedDB instead of SQLite.
//
// Registers `window.whoofApi.handle(url, opts?)` → Promise<JSON>.
// The legacy `fetchJSON` in app.js delegates to this when present so every
// existing render function works unchanged.

import { openDb } from './db.js';
import {
  samplesInRange, latestSample, recentEvents,
  getProfile, putProfile,
  getDailyMetric, recentDailyMetrics,
  workoutsForDate, sleepStagesForDate, patchWorkoutLabel,
  addWorkout, deleteWorkout,
  addFoodEntry, foodEntriesForDate, recentFoodEntries, deleteFoodEntry,
  addBodyWeightEntry, recentBodyWeightEntries, deleteBodyWeightEntry,
  personalRecords,
} from './queries.js';
import { rollupDay, recomputeRecent, rollupMissing } from '../metrics/rollup.js';
import { maxHr } from '../metrics/zones.js';
import { sleepQualityScore } from '../metrics/sleep.js';
import { estimateStepsFromAccel } from '../metrics/steps.js';
import { acwr as computeAcwr } from '../metrics/strain.js';
import { healthMonitor } from '../metrics/healthmonitor.js';

const VALID_TREND_METRICS = new Set([
  'rmssd_ms', 'resting_hr', 'recovery_score', 'strain_score',
  'sleep_minutes', 'sleep_performance_pct', 'sleep_debt_minutes',
  'avg_hr', 'avg_spo2', 'skin_temp_deviation_c', 'respiratory_rate',
  'calories', 'stress_avg',
  'steps', 'active_energy_kcal',
  // WHOOP-parity metrics
  'vo2max', 'fitness_age', 'whoop_age', 'hrr60',
  'sleep_efficiency_pct', 'sleep_latency_min', 'waso_min', 'restorative_pct',
]);

let _db = null;
async function db() {
  if (!_db) _db = await openDb();
  return _db;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Returns the UTC instants bounding a *local* calendar day. The name says UTC
// because the return values are UTC ISO strings, but the day is the user's
// local day on purpose — rollup.js uses the identical local-midnight bounds,
// so the samples this serves line up exactly with the daily_metrics it
// computed. Do NOT switch to Date.UTC(): that would shift the window by the
// timezone offset and desync the API from the rollup.
function dayBoundsUtc(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function toLocalIso(utcIso) {
  const d = new Date(utcIso);
  // ISO with local offset, second precision
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const oh = pad(Math.floor(absOff / 60));
  const om = pad(absOff % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function countSamples(d) {
  return new Promise((resolve, reject) => {
    const req = d.transaction('samples').objectStore('samples').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function latestNonNullVitals(d, seconds = 86400) {
  const end = new Date();
  const start = new Date(end.getTime() - seconds * 1000);
  const rows = await samplesInRange(d, start.toISOString(), end.toISOString());
  const vitals = { spo2_pct: null, skin_temp_c: null, respiratory_rate: null, skin_temp_raw: null };
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (vitals.spo2_pct == null && r.spo2_pct != null && r.spo2_pct >= 70 && r.spo2_pct <= 100) {
      vitals.spo2_pct = r.spo2_pct;
    }
    const tempC = r.skin_temp_c ?? r.skin_temp_est_c;
    if (vitals.skin_temp_c == null && tempC != null && tempC >= 20 && tempC <= 45) {
      vitals.skin_temp_c = tempC;
    }
    if (vitals.respiratory_rate == null && r.respiratory_rate != null && r.respiratory_rate >= 4 && r.respiratory_rate <= 40) {
      vitals.respiratory_rate = r.respiratory_rate;
    }
    if (vitals.skin_temp_raw == null && r.skin_temp_raw != null) {
      vitals.skin_temp_raw = r.skin_temp_raw;
    }
    if (vitals.spo2_pct != null && vitals.skin_temp_c != null && vitals.respiratory_rate != null && vitals.skin_temp_raw != null) break;
  }
  return vitals;
}

function sampleMotion(row) {
  if (!row) return null;
  if (row.motion != null && Number.isFinite(row.motion)) return Math.abs(row.motion);
  if (row.accel_x == null && row.accel_y == null && row.accel_z == null) return null;
  return Math.abs(row.accel_x ?? 0) + Math.abs(row.accel_y ?? 0) + Math.abs(row.accel_z ?? 0);
}

async function latestNonNullMotion(d, seconds = 3600) {
  const end = new Date();
  const start = new Date(end.getTime() - seconds * 1000);
  const rows = await samplesInRange(d, start.toISOString(), end.toISOString());
  for (let i = rows.length - 1; i >= 0; i--) {
    const motion = sampleMotion(rows[i]);
    if (motion != null) return { ts_utc: rows[i].ts_utc, motion, source: rows[i].motion != null ? 'strap_motion' : 'strap_accel' };
  }
  return null;
}

function withLatestVitals(sample, vitals) {
  if (!sample) return sample;
  return {
    ...sample,
    spo2_pct: sample.spo2_pct ?? vitals.spo2_pct,
    skin_temp_c: sample.skin_temp_c ?? sample.skin_temp_est_c ?? vitals.skin_temp_c,
    respiratory_rate: sample.respiratory_rate ?? vitals.respiratory_rate,
    skin_temp_raw: sample.skin_temp_raw ?? vitals.skin_temp_raw,
  };
}

async function latestBattery(d) {
  // device_events with kind='battery', newest first
  const events = await recentEvents(d, 100);
  const bat = events.find((e) => e.kind === 'battery');
  if (bat) {
    return { ts_utc: bat.ts_utc, kind: bat.kind, detail: bat.detail };
  }
  return null;
}

function sanitizeNumber(value, min = -Infinity, max = Infinity) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function foodTotals(rows) {
  const sum = (key) => rows.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
  return {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g') * 10) / 10,
    carbs_g: Math.round(sum('carbs_g') * 10) / 10,
    fat_g: Math.round(sum('fat_g') * 10) / 10,
  };
}

function bmrMifflin(profile = {}) {
  const weight = Number(profile.weight_kg);
  const height = Number(profile.height_cm);
  const age = Number(profile.age);
  if (!Number.isFinite(weight) || !Number.isFinite(height) || !Number.isFinite(age)) return null;
  const sexAdjust = profile.sex === 'F' ? -161 : 5;
  return Math.round(10 * weight + 6.25 * height - 5 * age + sexAdjust);
}

function latestWeightPerDay(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (!existing || (row.created_at ?? '') > (existing.created_at ?? '')) byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => (a.date > b.date ? 1 : -1));
}

// ----- handlers -------------------------------------------------------------

async function apiStatus() {
  const d = await db();
  const [latest, battery, events, sampleCount, history, vitals] = await Promise.all([
    latestSample(d),
    latestBattery(d),
    recentEvents(d, 1),
    countSamples(d),
    recentDailyMetrics(d, 365),
    latestNonNullVitals(d),
  ]);
  return {
    latest_sample: withLatestVitals(latest, vitals),
    latest_battery: battery,
    latest_event: events[0] ?? null,
    sample_count: sampleCount,
    days_recorded: history.length,
    now_utc: new Date().toISOString(),
  };
}

async function apiToday(downsample = 30) {
  const d = await db();
  const { startUtc, endUtc } = dayBoundsUtc(todayIso());
  const rows = await samplesInRange(d, startUtc, endUtc);
  const step = Math.max(1, downsample);
  const points = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % step !== 0) continue;
    const r = rows[i];
    points.push({
      t: toLocalIso(r.ts_utc),
      hr: r.heart_rate_bpm, rr: r.rr_interval_ms,
      spo2: r.spo2_pct, temp: r.skin_temp_c,
    });
  }
  const metrics = await getDailyMetric(d, todayIso());
  return { points, sample_count: rows.length, metrics: metrics ?? null };
}

async function apiHistory(days = 30) {
  const d = await db();
  const out = await recentDailyMetrics(d, days);
  return { days: out };
}

async function apiRecompute(age = null) {
  const d = await db();
  const opts = age != null ? { ageOverride: age } : {};
  const computed = await recomputeRecent(d, 7, opts);
  return { computed: computed.map((m) => m.date) };
}

async function apiOverview() {
  const d = await db();
  const day = todayIso();
  // Catch up any missing rollups (cheap if nothing's missing)
  await rollupMissing(d, 14);
  const [m, latest, battery] = await Promise.all([
    getDailyMetric(d, day),
    latestSample(d),
    latestBattery(d),
  ]);
  // Recent workouts across last 3 days
  const recentDates = [0, 1, 2].map((off) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - off);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  });
  const workoutBatches = await Promise.all(recentDates.map((iso) => workoutsForDate(d, iso)));
  const recentWorkouts = workoutBatches.flat()
    .sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1))
    .slice(0, 5);
  // Last 14 days for trend context (oldest → newest).
  const recentMetrics = await recentDailyMetrics(d, 14);
  const trend7 = recentMetrics.slice(0, 7).reverse().map((r) => ({
    date: r.date,
    recovery_score:        r.recovery_score        ?? null,
      rmssd_ms:              r.rmssd_ms              ?? null,
      strain_score:          r.strain_score          ?? null,
      sleep_performance_pct: r.sleep_performance_pct ?? null,
      sleep_minutes:         r.sleep_minutes         ?? null,
      deep_sleep_minutes:    r.deep_sleep_minutes    ?? null,
    }));

  return {
    date: day,
    metrics: m ?? null,
    latest_sample: latest,
    battery,
    recent_workouts: recentWorkouts,
    trend7,
  };
}

async function apiSleep(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const [m, stages, all] = await Promise.all([
    getDailyMetric(d, day),
    sleepStagesForDate(d, day),
    recentDailyMetrics(d, 30),
  ]);
  const trend = all
    .filter((row) => row.date <= day)
    .reverse()
    .map((r) => ({
      date: r.date,
      sleep_minutes:         r.sleep_minutes         ?? null,
      deep_sleep_minutes:    r.deep_sleep_minutes    ?? null,
      rem_sleep_minutes:     r.rem_sleep_minutes     ?? null,
      light_sleep_minutes:   r.light_sleep_minutes   ?? null,
      wake_minutes:          r.wake_minutes          ?? null,
      respiratory_rate:      r.respiratory_rate      ?? null,
      sleep_performance_pct: r.sleep_performance_pct ?? null,
      sleep_consistency_pct: r.sleep_consistency_pct ?? null,
      sleep_debt_minutes:    r.sleep_debt_minutes    ?? null,
      quality_score:         sleepQualityScore(r).score,
    }));
  const quality = sleepQualityScore(m);
  return {
    date: day,
    summary: m ?? null,
    quality,
    stages: stages.map((s) => ({
      start: toLocalIso(s.start_utc),
      end: toLocalIso(s.end_utc),
      stage: s.stage,
    })),
    trend,
  };
}

async function apiRecovery(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const m = await getDailyMetric(d, day);
  if (!m) return { date: day, summary: null, trend: [], health_monitor: null };
  const [all, profile] = await Promise.all([
    recentDailyMetrics(d, 30),
    getProfile(d),
  ]);
  const trend = all
    .filter((row) => row.date <= day)
    .reverse()
    .map((r) => ({
      date: r.date,
      rmssd_ms: r.rmssd_ms ?? null,
      resting_hr: r.resting_hr ?? null,
      recovery_score: r.recovery_score ?? null,
      recovery_hrv_component: r.recovery_hrv_component ?? null,
      recovery_rhr_component: r.recovery_rhr_component ?? null,
      recovery_sleep_component: r.recovery_sleep_component ?? null,
      recovery_resp_component: r.recovery_resp_component ?? null,
      recovery_strain_component: r.recovery_strain_component ?? null,
      skin_temp_deviation_c: r.skin_temp_deviation_c ?? null,
    }));
  // WHOOP-style Health Monitor: today's vitals vs the user's rolling baseline.
  const baseline = all.filter((row) => row.date < day);
  const monitor = healthMonitor(m, baseline, {
    sex: profile?.sex ?? 'M',
    age: profile?.age ?? 30,
  });
  return { date: day, summary: m, trend, health_monitor: monitor };
}

async function apiStrain(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const { startUtc, endUtc } = dayBoundsUtc(day);
  const rows = await samplesInRange(d, startUtc, endUtc);
  const profile = (await getProfile(d)) || {};
  const age = profile.age ?? 30;
  const maxBpm = maxHr(age, profile.max_hr_override);

  // Coarse strain curve: cumulative load per 10-min bucket
  const BUCKET_MIN = 10;
  const BUCKET_SEC = BUCKET_MIN * 60;
  const series = [];
  if (rows.length) {
    const [y, mo, da] = day.split('-').map(Number);
    let bucketStart = new Date(y, mo - 1, da, 0, 0, 0, 0);
    let bucketEnd = new Date(bucketStart.getTime() + BUCKET_SEC * 1000);
    let cumLoad = 0;
    let bucketHrs = [];

    const flush = () => {
      if (bucketHrs.length) {
        const intensities = bucketHrs.map((h) => Math.max(0, (h - 50) / (maxBpm - 50)));
        cumLoad += intensities.reduce((s, i) => s + i * i, 0) * (1 / 60);
      }
      const pad = (n) => String(n).padStart(2, '0');
      series.push({
        t: `${bucketStart.getFullYear()}-${pad(bucketStart.getMonth() + 1)}-${pad(bucketStart.getDate())}T${pad(bucketStart.getHours())}:${pad(bucketStart.getMinutes())}`,
        strain: Math.round(21 * (1 - Math.exp(-cumLoad / 100)) * 100) / 100,
      });
    };

    for (const r of rows) {
      const t = new Date(r.ts_utc);
      while (t >= bucketEnd) {
        flush();
        bucketStart = bucketEnd;
        bucketEnd = new Date(bucketStart.getTime() + BUCKET_SEC * 1000);
        bucketHrs = [];
      }
      if (r.heart_rate_bpm != null) bucketHrs.push(r.heart_rate_bpm);
    }
    if (bucketHrs.length) flush();
  }

  const [m, workouts, history] = await Promise.all([
    getDailyMetric(d, day),
    workoutsForDate(d, day),
    recentDailyMetrics(d, 30),
  ]);

  // 30-day strain trend (oldest → newest)
  const trend = history
    .filter((row) => row.date <= day)
    .reverse()
    .map((r) => ({
      date: r.date,
      strain_score: r.strain_score ?? null,
      calories:     r.calories     ?? null,
    }));

  // Acute:Chronic Workload Ratio — 7d acute / prior 21d chronic
  const strainVals = history
    .filter((row) => row.date <= day)
    .map((r) => r.strain_score);
  let acwrInfo = null;
  const info = computeAcwr(strainVals, { acuteDays: 7, chronicDays: 21 });
  if (info) {
    let band = 'sweet-spot';
    if      (info.ratio > 1.5) band = 'high-risk';
    else if (info.ratio > 1.3) band = 'elevated';
    else if (info.ratio < 0.6) band = 'detraining';
    acwrInfo = {
      ratio: Math.round(info.ratio * 100) / 100,
      acute: info.acute,
      chronic: info.chronic,
      band,
    };
  }

  return { date: day, summary: m ?? null, curve: series, workouts, trend, acwr: acwrInfo };
}

async function apiTrends(metric = 'recovery_score', days = 30) {
  const d = await db();
  if (!VALID_TREND_METRICS.has(metric)) {
    return { error: `unknown metric: ${metric}`, valid: [...VALID_TREND_METRICS].sort() };
  }
  const all = await recentDailyMetrics(d, days);
  const series = all
    .map((r) => ({ date: r.date, value: r[metric] ?? null }))
    .reverse();
  // Weekday averages
  const buckets = [[], [], [], [], [], [], []];
  for (const r of all) {
    if (r[metric] != null) {
      const [y, m, dd] = r.date.split('-').map(Number);
      const wd = new Date(y, m - 1, dd).getDay(); // 0 = Sunday
      // Python's weekday(): Monday = 0; JS getDay(): Sunday = 0. Convert:
      const pyWd = (wd + 6) % 7;
      buckets[pyWd].push(Number(r[metric]));
    }
  }
  const weekdayAverages = Object.fromEntries(
    buckets.map((arr, i) => [i, arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null])
  );
  return { metric, series, weekday_averages: weekdayAverages };
}

async function apiWorkouts(days = 30) {
  const d = await db();
  const today = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const ws = await workoutsForDate(d, iso);
    out.push(...ws);
  }
  return { workouts: out.sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1)) };
}

async function apiWorkoutPost(payload) {
  const d = await db();
  const date = payload.date || todayIso();
  const startLocal = payload.start_local || `${date}T${payload.start_time || '12:00'}`;
  const durationMin = Math.max(1, Math.min(1440, parseInt(payload.duration_min ?? '30', 10) || 30));
  const start = new Date(startLocal);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const calories = sanitizeNumber(payload.calories, 0, 10000);
  const avgHr = sanitizeNumber(payload.avg_hr, 30, 230);
  const maxHrVal = sanitizeNumber(payload.max_hr, 30, 230);
  const strain = sanitizeNumber(payload.strain, 0, 21);
  const id = await addWorkout(d, {
    date,
    start_utc: start.toISOString(),
    end_utc: end.toISOString(),
    duration_seconds: durationMin * 60,
    avg_hr: avgHr,
    max_hr: maxHrVal,
    strain,
    calories,
    zone_seconds: JSON.stringify([0, 0, 0, 0, 0]),
    label: String(payload.label || payload.type || 'Workout').trim() || 'Workout',
    notes: String(payload.notes || ''),
    rpe: sanitizeNumber(payload.rpe, 1, 10),
    auto_detected: false,
  });
  return { ok: true, id };
}

async function apiBody(dayIso = todayIso(), days = 30) {
  const d = await db();
  const [profile, daily, foodToday, foodRecent, weightRows, recentMetrics] = await Promise.all([
    getProfile(d),
    getDailyMetric(d, dayIso),
    foodEntriesForDate(d, dayIso),
    recentFoodEntries(d, days),
    recentBodyWeightEntries(d, Math.max(days, 90)),
    recentDailyMetrics(d, days),
  ]);
  const bmr = bmrMifflin(profile || {});
  const activity = daily?.active_energy_kcal ?? daily?.energy_kcal_active ?? null;
  const burned = Math.round((bmr ?? 0) + (activity ?? 0)) || daily?.calories || null;
  const totals = foodTotals(foodToday);
  const deficit = burned != null ? Math.round(burned - totals.calories) : null;
  const recentByDate = new Map();
  for (const row of foodRecent) {
    if (!recentByDate.has(row.date)) recentByDate.set(row.date, []);
    recentByDate.get(row.date).push(row);
  }
  // Build a map of date → daily_metric for per-day burned lookup
  const metricByDate = new Map();
  for (const m of recentMetrics) {
    if (m.date) metricByDate.set(m.date, m);
  }
  const nutritionTrend = [...recentByDate.entries()]
    .map(([date, rows]) => {
      const totals = foodTotals(rows);
      const dm = metricByDate.get(date);
      const dayBurned = dm?.calories ? Math.round(dm.calories)
        : dm?.active_energy_kcal || dm?.energy_kcal_active
          ? Math.round((bmr ?? 0) + (dm.active_energy_kcal ?? dm.energy_kcal_active ?? 0))
          : null;
      return { date, ...totals, burned: dayBurned };
    })
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const weights = latestWeightPerDay(weightRows).map((row) => ({
    id: row.id,
    date: row.date,
    weight_kg: row.weight_kg,
    source: row.source,
  }));
  const avgDeficit = nutritionTrend.length
    ? Math.round(nutritionTrend.slice(-7).reduce((sum, row) => sum + ((row.burned ?? 0) - row.calories), 0) / Math.min(7, nutritionTrend.length))
    : null;
  return {
    date: dayIso,
    profile: profile ?? {},
    bmr,
    burned,
    active_burn: activity,
    eaten: totals,
    deficit,
    projected_kg_4w: avgDeficit == null ? null : Math.round((avgDeficit * 28 / 7700) * 100) / 100,
    food_entries: foodToday,
    nutrition_trend: nutritionTrend,
    weights,
    latest_weight: weights[weights.length - 1] ?? null,
  };
}

async function apiFoodPost(payload) {
  const d = await db();
  const id = await addFoodEntry(d, {
    date: payload.date || todayIso(),
    meal: String(payload.meal || 'snack').toLowerCase(),
    name: String(payload.name || 'Food').trim() || 'Food',
    calories: sanitizeNumber(payload.calories, 0, 10000),
    protein_g: sanitizeNumber(payload.protein_g, 0, 500),
    carbs_g: sanitizeNumber(payload.carbs_g, 0, 1000),
    fat_g: sanitizeNumber(payload.fat_g, 0, 500),
    source: payload.source === 'ai' ? 'ai' : 'manual',
    notes: String(payload.notes || ''),
  });
  return { ok: true, id };
}

async function apiWeightPost(payload) {
  const d = await db();
  const weight = sanitizeNumber(payload.weight_kg, 20, 400);
  if (weight == null) return { ok: false, message: 'invalid weight' };
  const date = payload.date || todayIso();
  const id = await addBodyWeightEntry(d, { date, weight_kg: Math.round(weight * 10) / 10, source: payload.source || 'manual', notes: payload.notes || '' });
  const existing = (await getProfile(d)) ?? {};
  await putProfile(d, { ...existing, weight_kg: Math.round(weight * 10) / 10 });
  return { ok: true, id };
}

async function apiProfileGet() {
  const d = await db();
  return (await getProfile(d)) ?? {};
}

async function apiProfilePost(payload) {
  const d = await db();
  const clean = {};
  if (payload.age != null) {
    const n = parseInt(payload.age, 10);
    if (Number.isFinite(n)) clean.age = Math.max(1, Math.min(120, n));
  }
  if ('sex' in payload) {
    clean.sex = (payload.sex === 'M' || payload.sex === 'F') ? payload.sex : null;
  }
  if (payload.weight_kg != null) {
    const n = parseFloat(payload.weight_kg);
    if (Number.isFinite(n)) clean.weight_kg = Math.max(20, Math.min(300, n));
  }
  if (payload.height_cm != null) {
    const n = parseFloat(payload.height_cm);
    if (Number.isFinite(n)) clean.height_cm = Math.max(50, Math.min(250, n));
  }
  if ('max_hr_override' in payload) {
    if (payload.max_hr_override == null || payload.max_hr_override === '') {
      clean.max_hr_override = null;
    } else {
      const n = parseInt(payload.max_hr_override, 10);
      if (Number.isFinite(n)) clean.max_hr_override = Math.max(120, Math.min(230, n));
    }
  }
  const existing = (await getProfile(d)) ?? {};
  const merged = { ...existing, ...clean };
  await putProfile(d, merged);
  return await getProfile(d);
}

async function apiLive(seconds = 300) {
  const d = await db();
  const end = new Date();
  const sec = Math.max(30, Math.min(3600, seconds));
  const start = new Date(end.getTime() - sec * 1000);
  const rows = await samplesInRange(d, start.toISOString(), end.toISOString());
  const points = rows.map((r) => ({
    t: toLocalIso(r.ts_utc),
    hr: r.heart_rate_bpm, rr: r.rr_interval_ms,
    spo2: r.spo2_pct, temp: r.skin_temp_c,
    motion: sampleMotion(r),
  }));
  const [last, battery, events, latestMotion] = await Promise.all([
    latestSample(d),
    latestBattery(d),
    recentEvents(d, 20),
    latestNonNullMotion(d),
  ]);
  const vitals = await latestNonNullVitals(d);
  const steps = estimateStepsFromAccel(rows);
  const latest = withLatestVitals(last, vitals);
  let motionSource = null;
  if (latest && sampleMotion(latest) != null) {
    const hasMotionField = latest.motion != null;
    latest.motion = sampleMotion(latest);
    motionSource = { ts_utc: latest.ts_utc, motion: latest.motion, source: hasMotionField ? 'strap_motion' : 'strap_accel' };
  } else if (latest && latestMotion) {
    latest.motion = latestMotion.motion;
    motionSource = latestMotion;
  }
  return {
    points,
    latest_sample: latest,
    latest_motion: motionSource,
    live_steps: steps,
    battery,
    events,
    now_utc: end.toISOString(),
  };
}

// ----- dispatcher -----------------------------------------------------------

async function handle(url, opts = {}) {
  const parsed = new URL(url, location.origin);
  const path = parsed.pathname;
  const qs = parsed.searchParams;
  const method = (opts.method ?? 'GET').toUpperCase();

  // POST endpoints
  if (method === 'POST' && path === '/api/profile') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    return apiProfilePost(body);
  }
  if (method === 'POST' && path === '/api/recompute') {
    const age = qs.get('age');
    return apiRecompute(age ? parseInt(age, 10) : null);
  }
  if (method === 'POST' && path === '/api/workout-label') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const d = await openDb();
    await patchWorkoutLabel(d, body.id, body.label ?? '');
    return { ok: true };
  }
  if (method === 'POST' && path === '/api/workout') return apiWorkoutPost(opts.body ? JSON.parse(opts.body) : {});
  if (method === 'POST' && path === '/api/food') return apiFoodPost(opts.body ? JSON.parse(opts.body) : {});
  if (method === 'POST' && path === '/api/weight') return apiWeightPost(opts.body ? JSON.parse(opts.body) : {});
  if (method === 'DELETE' && path === '/api/workout') { await deleteWorkout(await db(), parseInt(qs.get('id'), 10)); return { ok: true }; }
  if (method === 'DELETE' && path === '/api/food') { await deleteFoodEntry(await db(), parseInt(qs.get('id'), 10)); return { ok: true }; }
  if (method === 'DELETE' && path === '/api/weight') { await deleteBodyWeightEntry(await db(), parseInt(qs.get('id'), 10)); return { ok: true }; }

  // GET endpoints
  if (path === '/api/status')   return apiStatus();
  if (path === '/api/today')    return apiToday(parseInt(qs.get('downsample') ?? '30', 10));
  if (path === '/api/history')  return apiHistory(parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/recompute') return apiRecompute(qs.get('age') ? parseInt(qs.get('age'), 10) : null);
  if (path === '/api/overview') return apiOverview();
  if (path === '/api/sleep')    return apiSleep(qs.get('date'));
  if (path === '/api/recovery') return apiRecovery(qs.get('date'));
  if (path === '/api/strain')   return apiStrain(qs.get('date'));
  if (path === '/api/trends')   return apiTrends(qs.get('metric') ?? 'recovery_score', parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/workouts') return apiWorkouts(parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/body') return apiBody(qs.get('date') || todayIso(), parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/profile')          return apiProfileGet();
  if (path === '/api/personal-records') return personalRecords(await db());
  if (path === '/api/live')     return apiLive(parseInt(qs.get('seconds') ?? '300', 10));

  return null; // signal "not handled" — caller falls through to fetch()
}

window.whoofApi = { handle };
