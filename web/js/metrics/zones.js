// HR zones, calorie estimation (Keytel), and continuous stress level.
// Ported from whoof/zones.py.

// Zone boundaries as fractions of max HR (industry standard 5-zone model).
export const ZONE_BOUNDS = [
  ['z1', 0.50, 0.60],
  ['z2', 0.60, 0.70],
  ['z3', 0.70, 0.80],
  ['z4', 0.80, 0.90],
  ['z5', 0.90, 1.20], // z5 = anything >= 90% (open-ended upper bound)
];

export function maxHr(age, override = null) {
  if (override) {
    return Math.trunc(override);
  }
  return Math.max(120, 220 - Math.max(1, Math.trunc(age)));
}

/** Return zone index 1-5 for an HR value, or null if below Z1. */
export function zoneForHr(hr, maxBpm) {
  if (hr === null || hr === undefined || maxBpm <= 0) {
    return null;
  }
  const frac = hr / maxBpm;
  for (let idx = 0; idx < ZONE_BOUNDS.length; idx++) {
    const [, lo, hi] = ZONE_BOUNDS[idx];
    if (frac >= lo && frac < hi) {
      return idx + 1;
    }
  }
  return null;
}

/**
 * Given a per-second HR series, return [z1, z2, z3, z4, z5] seconds spent in each.
 *
 * Samples below Z1 are not counted in any zone. HR is assumed sampled once per
 * second; if your sampling is different, scale the result accordingly.
 */
export function zoneSecondsFromHrSeries(hrPerSecond, maxBpm) {
  const counts = [0, 0, 0, 0, 0];
  for (const hr of hrPerSecond) {
    const z = zoneForHr(hr || 0.0, maxBpm);
    if (z !== null) {
      counts[z - 1] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Calories — Keytel (2005) HR-based estimate
// ---------------------------------------------------------------------------

/**
 * Kcal burned in one minute given mean HR.
 *
 * From Keytel et al. (2005). When sex is unknown we average the two formulas.
 * When weight is unknown we assume 70 kg.
 */
export function caloriesPerMinute(hr, age, weightKg, sex) {
  if (hr === null || hr === undefined || hr < 30 || hr > 230) {
    return 0.0;
  }
  const w = weightKg && weightKg > 0 ? weightKg : 70.0;
  const a = age && age > 0 ? age : 30;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.0740 * a) / 4.184;
  let kpm;
  if (sex === 'M') {
    kpm = male;
  } else if (sex === 'F') {
    kpm = female;
  } else {
    kpm = (male + female) / 2;
  }
  return Math.max(0.0, kpm);
}

/** Total kcal over a per-second HR series. */
export function caloriesFromHrSeries(hrPerSecond, age, weightKg, sex) {
  if (!hrPerSecond || hrPerSecond.length === 0) {
    return 0.0;
  }
  const w = weightKg && weightKg > 0 ? weightKg : 70.0;
  let total = 0.0;
  for (const hr of hrPerSecond) {
    if (hr === null || hr === undefined || hr < 30) {
      // below ~30 bpm: count basal-only, ~1.0 kcal/min for 70 kg → /60
      total += 1.0 / 60.0;
      continue;
    }
    total += caloriesPerMinute(hr, age, w, sex) / 60.0;
  }
  return Math.round(total * 10) / 10;
}

// ---------------------------------------------------------------------------
// Energy Bank — MET-model calorie split (resting vs active)
// ---------------------------------------------------------------------------
//
// Ported from goose's energy_rollup. Unlike Keytel (which is one opaque
// kcal/min number) this splits burn into a resting baseline and an active
// component, which is what a "bank" UI needs. Resting follows the 22 kcal/kg/day
// RMR rule; active is a per-sample MET, taken as the greater of the zone MET and
// an HR-reserve MET, converted via kcal/min = MET·3.5·kg/200.
//
// Requires body weight. With no weight the model can't run — callers should
// fall back to caloriesFromHrSeries (Keytel, 70 kg default).

const ZONE_ACTIVE_MET = [0, 1, 2.5, 5, 8]; // indexed by zone-1 (z1..z5)

/**
 * @param {Object} o
 * @param {ReadonlyArray<number|null>} o.hrSeries  Per-sample HR (bpm).
 * @param {number} o.weightKg
 * @param {number} [o.restingHr=60]
 * @param {number} o.maxHrBpm
 * @param {number} [o.sampleIntervalSec=1]
 * @returns {{restingKcal:number, activeKcal:number, totalKcal:number}|null}
 */
export function energyBankCalories({ hrSeries, weightKg, restingHr = 60, maxHrBpm, sampleIntervalSec = 1 } = {}) {
  if (!hrSeries || hrSeries.length === 0 || !weightKg || weightKg <= 0) return null;
  const dtMin = (Number.isFinite(sampleIntervalSec) && sampleIntervalSec > 0 ? sampleIntervalSec : 1) / 60;
  const rest = Number.isFinite(restingHr) && restingHr > 0 ? restingHr : 60;
  const max = Number.isFinite(maxHrBpm) && maxHrBpm > rest ? maxHrBpm : rest + 130;

  const restingKcal = (weightKg * 22 * (hrSeries.length * dtMin)) / 1440;

  let activeKcal = 0;
  for (const hr of hrSeries) {
    if (hr === null || hr === undefined || hr < 30) continue;
    const z = zoneForHr(hr, max);
    const zoneMet = z ? ZONE_ACTIVE_MET[z - 1] : 0;
    const reserve = Math.max(0, Math.min(1, (hr - rest) / (max - rest)));
    const reserveMet = 7 * Math.pow(reserve, 1.35);
    const met = Math.max(zoneMet, reserveMet);
    activeKcal += (met * 3.5 * weightKg / 200) * dtMin;
  }

  const r = (x) => Math.round(x * 10) / 10;
  const rp = r(restingKcal);
  const ap = r(activeKcal);
  return { restingKcal: rp, activeKcal: ap, totalKcal: r(rp + ap) };
}

/**
 * Strain budget remaining for the day: recovery sets a 0-21 ceiling, today's
 * strain spends against it. Drives the Energy Bank gauge.
 * @returns {number|null} remaining strain budget in [0, 21], or null.
 */
export function energyBankRemaining(recoveryScore, currentStrain) {
  if (!Number.isFinite(recoveryScore)) return null;
  const budget = (recoveryScore / 100) * 21;
  return Math.round(Math.max(0, budget - (currentStrain || 0)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Stress level (continuous 5-min RMSSD windows during wake hours)
// ---------------------------------------------------------------------------

function _rmssd(rr) {
  if (rr.length < 3) {
    return null;
  }
  const filtered = rr.filter((v) => v !== null && v !== undefined && v > 250 && v < 2000);
  if (filtered.length < 3) {
    return null;
  }
  const diffs = [];
  for (let i = 0; i < filtered.length - 1; i++) {
    diffs.push(filtered[i + 1] - filtered[i]);
  }
  const sumSq = diffs.reduce((acc, d) => acc + d * d, 0);
  return Math.sqrt(sumSq / diffs.length);
}

/**
 * Compute 5-minute stress samples across `rows`.
 *
 * Stress = 100 - clamp(50 + (rmssd - baseline)/baseline * 50, 0, 100).
 * Excludes samples inside the sleep window if provided.
 *
 * `rows` is an array of { ts_utc, rr_interval_ms }.
 * `sleepWindow` is an optional [Date, Date] tuple.
 */
export function stressSamples(rows, baselineRmssd, sleepWindow = null) {
  if (!rows || rows.length === 0 || baselineRmssd === null || baselineRmssd === undefined || baselineRmssd <= 0) {
    return [];
  }

  const bucketMs = 5 * 60 * 1000;
  const out = [];
  let curStart = null;
  let curRrs = [];

  const isoSeconds = (d) => {
    // ISO string trimmed to seconds, matching Python isoformat(timespec='seconds').
    const s = d.toISOString();
    return s.slice(0, 19) + s.slice(-1); // 'YYYY-MM-DDTHH:MM:SSZ'
  };

  const flush = (end) => {
    if (curStart === null || curRrs.length < 8) {
      curStart = null;
      curRrs = [];
      return;
    }
    const rms = _rmssd(curRrs);
    if (rms !== null) {
      let recoveryLike = 50 + ((rms - baselineRmssd) / baselineRmssd) * 50;
      recoveryLike = Math.max(0.0, Math.min(100.0, recoveryLike));
      const stress = Math.round((100 - recoveryLike) * 10) / 10;
      out.push({
        start_utc: isoSeconds(curStart),
        end_utc: isoSeconds(end),
        stress,
      });
    }
    curStart = null;
    curRrs = [];
  };

  for (const r of rows) {
    if (r.rr_interval_ms === null || r.rr_interval_ms === undefined) {
      continue;
    }
    const t = new Date(r.ts_utc);
    if (sleepWindow && t >= sleepWindow[0] && t < sleepWindow[1]) {
      continue;
    }
    if (curStart === null) {
      curStart = t;
    }
    if (t.getTime() - curStart.getTime() >= bucketMs) {
      flush(t);
      curStart = t;
    }
    curRrs.push(r.rr_interval_ms);
  }
  if (curStart !== null) {
    flush(new Date(curStart.getTime() + bucketMs));
  }

  return out;
}
