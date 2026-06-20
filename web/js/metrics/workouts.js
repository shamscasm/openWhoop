// Auto-detect workouts from sustained elevated HR.
//
// Ported from whoof/workouts.py.
//
// A workout is a contiguous period where the rolling-10-minute median HR sits
// above 60% of max-HR AND we are not in the user's sleep window. Workouts
// shorter than 10 minutes or completely inside the sleep window are dropped.
//
// The Python module exported `persist_workouts_for_day(con, day_iso,
// detected)` which deletes prior auto-workouts in SQLite and re-inserts the
// new set. That helper is NOT ported here -- the browser layer owns its own
// IndexedDB persistence and calls `detectWorkouts` with sample arrays it has
// already fetched. The `samples` parameter that was a `Sequence[sqlite3.Row]`
// is now a plain array of `{ ts_utc, heart_rate_bpm }` objects, and the
// remaining arguments (age, max-HR override, sleep window, weight, sex) are
// grouped into an options object so the call site reads as keyword args
// rather than five positional values.

import {
  maxHr,
  zoneSecondsFromHrSeries,
  caloriesFromHrSeries,
} from './zones.js';

// Tunables -- match whoof/workouts.py.
export const MIN_WORKOUT_MINUTES = 10;
export const MERGE_GAP_MINUTES = 5;
export const HR_FRACTION_THRESHOLD = 0.60; // of max HR
export const ROLLING_WINDOW_SECONDS = 600; // 10 min

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function mean(values) {
  if (values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

/**
 * O(n*window) rolling median -- fine for ~86k samples/day.
 *
 * @param {Array<number|null>} values
 * @param {number} window
 * @returns {Array<number>}
 */
function rollingMedian(values, window) {
  const out = new Array(values.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    const seg = [];
    for (let j = lo; j < hi; j++) {
      const v = values[j];
      if (v !== null && v !== undefined) seg.push(v);
    }
    out[i] = seg.length > 0 ? median(seg) : 0.0;
  }
  return out;
}

/** Round to N decimals like Python's `round(x, n)`. */
function round1(x) {
  return Math.round(x * 10) / 10;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Format a Date as YYYY-MM-DD in the local timezone -- matches Python's
 * `dt.astimezone(local).date().isoformat()`.
 */
function localDateIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format a Date as ISO 8601 with seconds precision in UTC -- matches Python's
 * `dt.astimezone(timezone.utc).isoformat(timespec='seconds')`.
 *
 * Python emits `+00:00`; we emit the same to keep parity with the recorder's
 * SQLite columns.
 */
function utcIsoSeconds(d) {
  const s = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return s.slice(0, 19) + '+00:00';
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Localised strain for a single workout (same shape as daily strain, smaller scale).
 *
 * @param {Array<number>} hrWindow
 * @param {number} age
 * @param {number|null} maxHrOverride
 * @returns {number}
 */
export function workoutStrain(hrWindow, age, maxHrOverride) {
  if (!hrWindow || hrWindow.length === 0) return 0.0;
  const maxBpm = maxHr(age, maxHrOverride);
  let rest = hrWindow[0];
  for (let i = 1; i < hrWindow.length; i++) {
    if (hrWindow[i] < rest) rest = hrWindow[i];
  }
  if (maxBpm <= rest) return 0.0;
  const minutes = hrWindow.length / 60.0;
  let load = 0.0;
  for (const h of hrWindow) {
    const intensity = Math.max(0.0, (h - rest) / (maxBpm - rest));
    load += intensity * intensity;
  }
  return round2(21.0 * (1.0 - Math.exp((-load * minutes) / 1000.0)));
}

/**
 * Detect workouts from a series of HR samples.
 *
 * @param {Array<object>} samples
 *   Rows with at least `ts_utc` (ISO 8601 string) and `heart_rate_bpm` (number
 *   or null/undefined to skip the sample).
 * @param {object} opts
 * @param {number} opts.age
 * @param {number|null} [opts.maxHrOverride]
 * @param {[Date, Date]|null} [opts.sleepWindow]  Optional [start, end] in UTC.
 * @param {number|null} [opts.weightKg]
 * @param {string|null} [opts.sex]
 * @returns {Array<object>}  Workout records suitable for IndexedDB insertion.
 */
export function detectWorkouts(samples, opts = {}) {
  const {
    age,
    maxHrOverride = null,
    sleepWindow = null,
    weightKg = null,
    sex = null,
  } = opts;

  if (!samples || samples.length === 0) return [];
  const maxBpm = maxHr(age, maxHrOverride);
  const threshold = maxBpm * HR_FRACTION_THRESHOLD;

  // Build per-sample HR view, skipping rows where HR is missing.
  const times = [];
  const hrs = [];
  for (const r of samples) {
    if (r.heart_rate_bpm === null || r.heart_rate_bpm === undefined) continue;
    times.push(new Date(r.ts_utc));
    hrs.push(Number(r.heart_rate_bpm));
  }
  if (hrs.length === 0) return [];

  // Median sample interval (seconds) -- used to size the rolling window.
  const intervals = [];
  const lim = Math.min(times.length, 200);
  for (let i = 1; i < lim; i++) {
    intervals.push((times[i].getTime() - times[i - 1].getTime()) / 1000);
  }
  let medianDt = intervals.length > 0 ? median(intervals) : 1.0;
  medianDt = Math.max(0.5, Math.min(10.0, medianDt));
  const windowSamples = Math.max(
    10,
    Math.trunc(ROLLING_WINDOW_SECONDS / medianDt),
  );

  const rolling = rollingMedian(hrs, windowSamples);

  // Walk through, find continuous runs above threshold (outside sleep).
  const rawSegments = [];
  let segStart = null;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const rh = rolling[i];
    const inSleep =
      sleepWindow !== null &&
      sleepWindow !== undefined &&
      t >= sleepWindow[0] &&
      t < sleepWindow[1];
    const above = rh >= threshold && !inSleep;
    if (above && segStart === null) {
      segStart = t;
    } else if (!above && segStart !== null) {
      rawSegments.push([segStart, t]);
      segStart = null;
    }
  }
  if (segStart !== null) {
    rawSegments.push([segStart, times[times.length - 1]]);
  }

  if (rawSegments.length === 0) return [];

  // Merge segments separated by < MERGE_GAP_MINUTES.
  const merged = [rawSegments[0]];
  for (let i = 1; i < rawSegments.length; i++) {
    const [s, e] = rawSegments[i];
    const [ls, le] = merged[merged.length - 1];
    if ((s.getTime() - le.getTime()) / 1000 <= MERGE_GAP_MINUTES * 60) {
      merged[merged.length - 1] = [ls, e];
    } else {
      merged.push([s, e]);
    }
  }

  // Filter by minimum duration, then build per-workout stats.
  const out = [];
  for (const [s, e] of merged) {
    const durMin = (e.getTime() - s.getTime()) / 60000;
    if (durMin < MIN_WORKOUT_MINUTES) continue;

    const hrWindow = [];
    for (let i = 0; i < times.length; i++) {
      const tt = times[i];
      if (tt >= s && tt <= e) hrWindow.push(hrs[i]);
    }
    if (hrWindow.length === 0) continue;

    let zs = zoneSecondsFromHrSeries(hrWindow, maxBpm);
    // Scale zone counts by sample interval to get true seconds.
    zs = zs.map((c) => Math.round(c * medianDt));

    let cals = caloriesFromHrSeries(hrWindow, age, weightKg, sex);
    // Scale calories: our per-second formula multiplied by actual seconds.
    cals = round1(cals * medianDt);

    const avgHr = round1(mean(hrWindow));
    let mx = hrWindow[0];
    for (let i = 1; i < hrWindow.length; i++) {
      if (hrWindow[i] > mx) mx = hrWindow[i];
    }
    mx = round1(mx);
    const strain = workoutStrain(hrWindow, age, maxHrOverride);

    out.push({
      date: localDateIso(s),
      start_utc: utcIsoSeconds(s),
      end_utc: utcIsoSeconds(e),
      duration_seconds: Math.trunc((e.getTime() - s.getTime()) / 1000),
      avg_hr: avgHr,
      max_hr: mx,
      strain,
      calories: cals,
      zone_seconds: JSON.stringify(zs),
      label: null,
      auto_detected: true,
    });
  }
  return out;
}
