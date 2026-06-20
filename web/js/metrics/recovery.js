// Recovery score functions ported from whoof/metrics.py.
//
// The Python `recovery_breakdown` takes a sqlite3.Connection and reads
// prior-day rows. In the browser we keep these functions pure: the caller
// (later rollup.js) reads IndexedDB and passes baseline arrays + today's
// values in. The signature changes are:
//
//   Python: recovery_score(today_rmssd, history_rmssd) -> float | None
//   JS:     recoveryScore(todayRmssd, historyRmssd)    -> number | null
//
//   Python: recovery_breakdown(
//             today_rmssd, rmssd_history,
//             today_rhr, rhr_history,
//             sleep_performance_pct, yesterday_strain,
//           ) -> dict
//   JS:     recoveryBreakdown({
//             todayRmssd, rmssdHistory,
//             todayRhr, rhrHistory,
//             sleepPerformancePct, yesterdayStrain,
//           }) -> {hrv, rhr, sleep, strain, total}
//
// We switched the JS variant to a single options object so callers can
// omit fields by passing nulls/undefined without positional bookkeeping.

// Rolling window length (days) for the recovery-score baseline.
export const RECOVERY_BASELINE_DAYS = 14;

// Recovery sub-component weights — always sum to 1.0 so the weighted average is
// correct without renormalisation (though recoveryBreakdown still renormalises
// over whichever components are present, so a day missing one drops it and
// reweights the rest). `resp` was added from goose's recovery model; days
// without resp data score exactly as before.
export const RECOVERY_WEIGHTS = Object.freeze({
  hrv: 0.35,
  rhr: 0.20,
  sleep: 0.25,
  resp: 0.10,
  strain: 0.10,
});

// Minimum baseline samples needed to compute a z-score.
const MIN_BASELINE_SAMPLES = 3;

// Strain max (Whoop's 0-21 scale).
const STRAIN_MAX = 21.0;

function isNum(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v);
}

function mean(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

function pstdev(values) {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const dev = values[i] - m;
    sq += dev * dev;
  }
  return Math.sqrt(sq / values.length);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Map a value vs. baseline onto a 0-100 score.
 *
 * Higher score is "better recovery". When `inverted=true`, a lower value
 * relative to baseline is treated as better (e.g. resting heart rate).
 *
 * Mirrors `_z_to_score` in whoof/metrics.py: clamp z to +/-3 sigma,
 * then linearly map to [0, 100] with 50 as baseline.
 *
 * @param {number|null|undefined} value
 * @param {ReadonlyArray<number|null|undefined>} history
 * @param {boolean} [inverted=false]
 * @returns {number|null}
 */
function zToScore(value, history, inverted = false) {
  const cleaned = [];
  for (const v of history ?? []) {
    if (isNum(v) && v > 0) cleaned.push(v);
  }
  if (!isNum(value) || cleaned.length < MIN_BASELINE_SAMPLES) return null;
  const mu = mean(cleaned);
  const sigma = pstdev(cleaned) || 1.0;
  let z = (value - mu) / sigma;
  if (inverted) z = -z;
  if (z > 3.0) z = 3.0;
  if (z < -3.0) z = -3.0;
  return round1(50.0 + (z / 3.0) * 50.0);
}

/**
 * Whoop-like 0-100 recovery score (single-component, legacy).
 *
 * Maps today's RMSSD onto a normal distribution built from the rolling
 * baseline. 50 = right at baseline; 100 = very high HRV relative to recent
 * days; 0 = very low. Z-score is clamped to +/- 3 sigma.
 *
 * `recoveryBreakdown` is the preferred multi-component computation.
 *
 * @param {number|null|undefined} todayRmssd
 * @param {ReadonlyArray<number|null|undefined>} historyRmssd
 * @returns {number|null}
 */
export function recoveryScore(todayRmssd, historyRmssd) {
  return zToScore(todayRmssd, historyRmssd, false);
}

/**
 * Whoop-style 4-component recovery score.
 *
 * Components that can't be computed (insufficient history, null inputs)
 * are returned as `null` and dropped from the weighted average; the
 * remaining weights are renormalised. If every component is null, total
 * is null too.
 *
 * @param {object} args
 * @param {number|null|undefined} args.todayRmssd
 * @param {ReadonlyArray<number|null|undefined>} args.rmssdHistory
 * @param {number|null|undefined} args.todayRhr
 * @param {ReadonlyArray<number|null|undefined>} args.rhrHistory
 * @param {number|null|undefined} args.sleepPerformancePct
 * @param {number|null|undefined} args.yesterdayStrain
 * @param {number|null|undefined} args.todayRespRate
 * @param {ReadonlyArray<number|null|undefined>} args.respHistory
 * @returns {{hrv: number|null, rhr: number|null, sleep: number|null, resp: number|null, strain: number|null, total: number|null}}
 */
export function recoveryBreakdown({
  todayRmssd,
  rmssdHistory,
  todayRhr,
  rhrHistory,
  sleepPerformancePct,
  yesterdayStrain,
  todayRespRate,
  respHistory,
}) {
  const hrv = zToScore(todayRmssd, rmssdHistory, false);
  const rhr = zToScore(todayRhr, rhrHistory, true);
  // Respiratory rate: like RHR, lower-than-baseline is better recovery.
  const resp = zToScore(todayRespRate, respHistory, true);
  const sleep = isNum(sleepPerformancePct) ? round1(sleepPerformancePct) : null;
  let strain = null;
  if (isNum(yesterdayStrain)) {
    const raw = 100.0 - (yesterdayStrain * 100.0) / STRAIN_MAX;
    const clamped = Math.max(0.0, Math.min(100.0, raw));
    strain = round1(clamped);
  }

  const components = { hrv, rhr, sleep, resp, strain };
  const used = Object.entries(components).filter(([, v]) => v !== null);
  if (used.length === 0) {
    return { ...components, total: null };
  }
  let weightSum = 0;
  let weighted = 0;
  for (const [k, v] of used) {
    const w = RECOVERY_WEIGHTS[k];
    weightSum += w;
    weighted += v * w;
  }
  return { ...components, total: round1(weighted / weightSum) };
}
