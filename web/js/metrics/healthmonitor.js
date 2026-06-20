// WHOOP "Health Monitor" — today's core vitals each compared to the user's
// own rolling baseline, with in-range / out-of-range classification.
//
// Each vital produces: { key, label, value, unit, baseline, delta, z, status, direction }
// status is one of: 'normal' | 'elevated' | 'low' | 'unavailable'
//
// Degraded gracefully on real strap data where only heart_rate_bpm and
// rr_interval_ms are populated — spo2, skin_temp, etc. will all come back
// 'unavailable' rather than crashing.
//
// Requires at least MIN_BASELINE_SAMPLES valid points per vital before any
// status other than 'unavailable' is assigned.

// Minimum baseline rows with a valid reading before we classify a vital.
const MIN_BASELINE_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNum(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v);
}

function mean(values) {
  // Arithmetic mean of a non-empty array.
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

function pstdev(values) {
  // Population standard deviation.
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Extract a numeric field from a daily_metrics row. Returns null when the
 * field is absent, null, or non-numeric.
 *
 * @param {object|null|undefined} row
 * @param {string} field
 * @returns {number|null}
 */
function field(row, f) {
  if (!row) return null;
  const v = row[f];
  return isNum(v) ? v : null;
}

/**
 * Build baseline stats for one vital extracted from an array of prior rows.
 * Returns { values, mu, sigma } or null when fewer than MIN_BASELINE_SAMPLES
 * valid readings exist.
 *
 * @param {Array<object>} rows
 * @param {string} fieldName
 * @returns {{values: number[], mu: number, sigma: number}|null}
 */
function baselineStats(rows, fieldName) {
  const values = [];
  for (const row of rows) {
    const v = field(row, fieldName);
    if (isNum(v)) values.push(v);
  }
  if (values.length < MIN_BASELINE_SAMPLES) return null;
  const mu = mean(values);
  // Use population stdev over the baseline window; fall back to 1.0 to avoid
  // division by zero on a perfectly flat baseline.
  const sigma = pstdev(values) || 1.0;
  return { values, mu, sigma };
}

/**
 * Compute a z-score: (value - baseline_mean) / baseline_sigma.
 *
 * @param {number} value
 * @param {number} mu
 * @param {number} sigma
 * @returns {number}
 */
function zScore(value, mu, sigma) {
  // z = (x - μ) / σ, where σ is floored at 1.0 by callers.
  return (value - mu) / sigma;
}

// ---------------------------------------------------------------------------
// Vital classifiers
// ---------------------------------------------------------------------------

/**
 * Classify resting heart rate. Elevated when z > +1.5 (higher than usual).
 * Lower is better, so direction is 'lower_better'.
 *
 * @param {number} value  bpm
 * @param {number} mu     baseline mean bpm
 * @param {number} sigma  baseline sigma bpm
 * @returns {'normal'|'elevated'|'low'}
 */
function classifyRhr(value, mu, sigma) {
  const z = zScore(value, mu, sigma);
  // Elevated: z > +1.5 (heart beating faster than usual)
  if (z > 1.5) return 'elevated';
  return 'normal';
}

/**
 * Classify RMSSD (HRV). Low when z < -1.5 (lower than usual).
 * Higher is better, so direction is 'higher_better'.
 *
 * @param {number} value  ms
 * @param {number} mu     baseline mean ms
 * @param {number} sigma  baseline sigma ms
 * @returns {'normal'|'low'}
 */
function classifyRmssd(value, mu, sigma) {
  const z = zScore(value, mu, sigma);
  // Low: z < -1.5 (HRV well below personal baseline)
  if (z < -1.5) return 'low';
  return 'normal';
}

/**
 * Classify respiratory rate. Normal band 12-20 br/min; elevated if z > +1.5
 * OR absolute value > 20.
 *
 * @param {number} value  breaths/min
 * @param {number} mu     baseline mean
 * @param {number} sigma  baseline sigma
 * @returns {'normal'|'elevated'|'low'}
 */
function classifyRespRate(value, mu, sigma) {
  const z = zScore(value, mu, sigma);
  // Elevated by absolute threshold or statistical deviation
  if (value > 20 || z > 1.5) return 'elevated';
  // Below in-range floor 12 br/min counts as low
  if (value < 12) return 'low';
  return 'normal';
}

/**
 * Classify SpO2. Low if absolute value < 95% OR z < -1.5.
 *
 * @param {number} value  percent
 * @param {number} mu     baseline mean
 * @param {number} sigma  baseline sigma
 * @returns {'normal'|'low'}
 */
function classifySpO2(value, mu, sigma) {
  const z = zScore(value, mu, sigma);
  // Low: below 95% absolute threshold (clinical concern) or far below baseline
  if (value < 95 || z < -1.5) return 'low';
  return 'normal';
}

/**
 * Classify skin temperature via its deviation from baseline temp.
 * Uses skin_temp_deviation_c (pre-computed nightly offset). Flagged when
 * |z| > 2 OR |skin_temp_deviation_c| > 0.6 °C (possible fever/hypothermia).
 *
 * @param {number} deviation  skin_temp_deviation_c (°C)
 * @param {number} mu         baseline mean deviation
 * @param {number} sigma      baseline sigma
 * @returns {'normal'|'elevated'|'low'}
 */
function classifySkinTemp(deviation, mu, sigma) {
  const z = zScore(deviation, mu, sigma);
  const absZ = Math.abs(z);
  const absDeviation = Math.abs(deviation);
  // Flag if statistical outlier OR absolute deviation exceeds 0.6°C
  if (absZ > 2 || absDeviation > 0.6) {
    return deviation > 0 ? 'elevated' : 'low';
  }
  return 'normal';
}

// ---------------------------------------------------------------------------
// Vital builder
// ---------------------------------------------------------------------------

/**
 * Build a single vital entry with baseline stats, delta, z, and status.
 *
 * @param {object} opts
 * @param {string}              opts.key        - field name used in daily_metrics
 * @param {string}              opts.label      - human-readable label
 * @param {string}              opts.unit       - display unit string
 * @param {string}              opts.direction  - 'higher_better'|'lower_better'|'neutral'
 * @param {number|null}         opts.value      - today's reading
 * @param {Array<object>}       opts.rows       - baseline daily_metrics rows
 * @param {string}              opts.baselineKey - field to read from baseline rows
 *                                               (may differ from key for skin_temp)
 * @param {function}            opts.classify   - (value, mu, sigma) -> status string
 * @returns {object}  vital entry
 */
function buildVital({ key, label, unit, direction, value, rows, baselineKey, classify }) {
  const stats = baselineStats(rows, baselineKey);

  const entry = {
    key,
    label,
    value: isNum(value) ? round1(value) : null,
    unit,
    baseline: null,
    delta: null,
    z: null,
    status: 'unavailable',
    direction,
  };

  if (!isNum(value) || stats === null) {
    return entry;
  }

  const { mu, sigma } = stats;
  const z = zScore(value, mu, sigma);
  entry.baseline = round1(mu);
  entry.delta = round2(value - mu);
  entry.z = round2(z);
  entry.status = classify(value, mu, sigma);
  return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute WHOOP-style Health Monitor for a single day.
 *
 * Compares today's core vitals against the user's personal rolling baseline
 * derived from baselineRows. Vitals with insufficient baseline data (< 3
 * valid points) return status 'unavailable' rather than erroring.
 *
 * On real strap hardware only resting_hr and rmssd_ms are reliably populated.
 * avg_spo2, avg_skin_temp_c, and respiratory_rate will typically come back
 * 'unavailable' — that is expected and correct behaviour.
 *
 * @param {object|null|undefined} today
 *   A daily_metrics row for the day being evaluated.
 * @param {Array<object>} baselineRows
 *   Prior daily_metrics rows (newest-first ok; order doesn't affect stats).
 * @param {object} [opts]
 * @param {string} [opts.sex='M']   Biological sex (reserved for future norms).
 * @param {number} [opts.age=30]    Age in years (reserved for future norms).
 * @returns {{ vitals: object[], overall: 'green'|'yellow'|'red', flaggedCount: number }|null}
 */
export function healthMonitor(today, baselineRows, { sex = 'M', age = 30 } = {}) {
  // Can't assess anything without a today row.
  if (!today) return null;

  const rows = Array.isArray(baselineRows) ? baselineRows : [];

  // Skin temperature uses skin_temp_deviation_c for the baseline comparison
  // because avg_skin_temp_c drifts with ambient temperature. The deviation
  // is already normalised to a nightly baseline by the device firmware.
  const vitals = [
    buildVital({
      key: 'resting_hr',
      label: 'Resting HR',
      unit: 'bpm',
      direction: 'lower_better',
      value: field(today, 'resting_hr'),
      rows,
      baselineKey: 'resting_hr',
      classify: classifyRhr,
    }),

    buildVital({
      key: 'rmssd_ms',
      label: 'HRV (RMSSD)',
      unit: 'ms',
      direction: 'higher_better',
      value: field(today, 'rmssd_ms'),
      rows,
      baselineKey: 'rmssd_ms',
      classify: classifyRmssd,
    }),

    buildVital({
      key: 'respiratory_rate',
      label: 'Respiratory Rate',
      unit: 'br/min',
      direction: 'lower_better',
      value: field(today, 'respiratory_rate'),
      rows,
      baselineKey: 'respiratory_rate',
      classify: classifyRespRate,
    }),

    buildVital({
      key: 'avg_spo2',
      label: 'Blood Oxygen',
      unit: '%',
      direction: 'higher_better',
      value: field(today, 'avg_spo2'),
      rows,
      baselineKey: 'avg_spo2',
      classify: classifySpO2,
    }),

    buildVital({
      key: 'avg_skin_temp_c',
      label: 'Skin Temp Deviation',
      unit: '°C',
      direction: 'neutral',
      // Today's value is the deviation, not the raw temperature.
      value: field(today, 'skin_temp_deviation_c'),
      rows,
      baselineKey: 'skin_temp_deviation_c',
      classify: classifySkinTemp,
    }),
  ];

  // Count flagged vitals (any available vital not 'normal').
  let flaggedCount = 0;
  for (const v of vitals) {
    if (v.status !== 'normal' && v.status !== 'unavailable') flaggedCount += 1;
  }

  // Overall signal: green = no flags, yellow = 1 flag, red = 2+.
  let overall;
  if (flaggedCount === 0) {
    overall = 'green';
  } else if (flaggedCount === 1) {
    overall = 'yellow';
  } else {
    overall = 'red';
  }

  return { vitals, overall, flaggedCount };
}
