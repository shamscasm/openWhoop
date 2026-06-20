// Physiological Age estimation from multiple longevity-correlated signals.
//
// IMPORTANT DISCLAIMER: This is an interpretable, educational estimate derived
// from wearable-device signals. It is NOT a clinical measure, NOT a medical
// diagnosis, and has NOT been validated against gold-standard biological-age
// assays. Do not use for medical decision-making. The formulas are adapted
// from published epidemiological associations; individual predictions carry
// wide uncertainty intervals (+/- several years at minimum).
//
// Approach: each available signal contributes an additive age-delta (years)
// vs. the age-and-sex-expected population norm. The weighted mean of present
// deltas is added to chronological age, then clamped to [18, 90].
//
// References for normative anchors:
//   VO2max  — ACSM's Guidelines for Exercise Testing and Prescription, 11th ed.;
//             Kaminsky & Imboden (2016) Fitness Quantification.
//   RHR     — Cooney et al. (2010) EJPC; Aune et al. (2023) meta-analysis.
//   RMSSD   — Shaffer & Ginsberg (2017) Front Neurosci; Koenig et al. (2016).
//   Sleep   — Watson et al. (2015) Sleep; Léger et al. NSRR normative data.
//   Recovery — WHOOP (2021) Recovery white-paper; Haddad et al. (2017) Int J Sports Physiol Perf.

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isNum(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------------------
// Normative lookup tables (compact anchors, linearly interpolated).
//
// Each entry is [age, value]. Values between anchors are linearly
// interpolated; values outside the range are linearly extrapolated from
// the nearest two anchors (capped at the table extremes where appropriate).
// ---------------------------------------------------------------------------

function lerp(anchors, age) {
  if (anchors.length === 0) return null;
  if (age <= anchors[0][0]) {
    // Extrapolate from the first two anchors if possible, else return first value.
    if (anchors.length < 2) return anchors[0][1];
    const [a0, v0] = anchors[0];
    const [a1, v1] = anchors[1];
    return v0 + ((age - a0) / (a1 - a0)) * (v1 - v0);
  }
  for (let i = 1; i < anchors.length; i++) {
    const [a0, v0] = anchors[i - 1];
    const [a1, v1] = anchors[i];
    if (age <= a1) {
      return v0 + ((age - a0) / (a1 - a0)) * (v1 - v0);
    }
  }
  // Extrapolate from the last two anchors.
  const n = anchors.length;
  const [a0, v0] = anchors[n - 2];
  const [a1, v1] = anchors[n - 1];
  return v0 + ((age - a0) / (a1 - a0)) * (v1 - v0);
}

// ---------------------------------------------------------------------------
// Exported normative helpers (used by physiologicalAge; also individually
// useful for display on the UI age breakdown card).
// ---------------------------------------------------------------------------

// VO2max norms (mL/kg/min) by age and sex.
// Source: ACSM 11th ed. Table 4.9; Kaminsky (2016) adjusted means.
// 'M' = male, 'F' = female.
const VO2MAX_NORMS = {
  M: [[20, 50], [30, 47], [40, 43], [50, 39], [60, 35], [70, 31], [80, 27]],
  F: [[20, 43], [30, 40], [40, 36], [50, 32], [60, 28], [70, 24], [80, 21]],
};

/**
 * Expected VO2max (mL/kg/min) for a given age and sex.
 *
 * Uses ACSM normative anchors (moderate-fitness population mean) with
 * linear interpolation between decades.
 *
 * @param {number} age
 * @param {'M'|'F'} sex
 * @returns {number}
 */
export function expectedVo2maxForAge(age, sex) {
  const table = VO2MAX_NORMS[sex] ?? VO2MAX_NORMS['M'];
  return lerp(table, age);
}

// Resting heart rate norms (bpm) by age and sex.
// Source: Cooney (2010); Aune (2023) meta-analysis approximate means.
const RHR_NORMS = {
  M: [[20, 65], [30, 64], [40, 64], [50, 65], [60, 66], [70, 67], [80, 68]],
  F: [[20, 67], [30, 67], [40, 67], [50, 68], [60, 69], [70, 70], [80, 71]],
};

/**
 * Expected resting heart rate (bpm) for a given age and sex.
 *
 * Source: population means from Cooney (2010) + Aune (2023) meta-analysis.
 *
 * @param {number} age
 * @param {'M'|'F'} sex
 * @returns {number}
 */
export function expectedRestingHrForAge(age, sex) {
  const table = RHR_NORMS[sex] ?? RHR_NORMS['M'];
  return lerp(table, age);
}

// RMSSD norms (ms) by age — sex difference is small enough to be pooled.
// HRV declines ~logarithmically with age.
// Source: Shaffer & Ginsberg (2017) Front Neurosci; Koenig (2016) pooled norms.
const RMSSD_NORMS = [
  [20, 65],
  [30, 57],
  [40, 49],
  [50, 40],
  [60, 32],
  [70, 26],
  [80, 21],
];

/**
 * Expected RMSSD (ms) for a given age (sex-pooled).
 *
 * Source: Shaffer & Ginsberg (2017) + Koenig (2016) pooled normative means.
 * RMSSD declines roughly log-linearly with age.
 *
 * @param {number} age
 * @returns {number}
 */
export function expectedRmssdForAge(age) {
  return lerp(RMSSD_NORMS, age);
}

// ---------------------------------------------------------------------------
// Signal weights (must sum to 1.0 across all defined signals).
// ---------------------------------------------------------------------------
const SIGNAL_WEIGHTS = Object.freeze({
  vo2max:          0.35,
  restingHr:       0.20,
  rmssd:           0.25,
  avgSleepMinutes: 0.10,
  avgRecovery:     0.10,
});

// ---------------------------------------------------------------------------
// Per-signal age-delta calculators (each returns years, negative = younger).
// ---------------------------------------------------------------------------

/**
 * VO2max age delta.
 *
 * Formula: delta = -0.4 * (actual - expected), clamped to [-15, +15].
 * Sensitivity of -0.4 yr per +1 mL/kg/min from Bouchard (2015) twin-study
 * and ACSM fitness-as-age-substitute regression coefficients.
 *
 * @param {number} vo2max
 * @param {number} age
 * @param {'M'|'F'} sex
 * @returns {number}
 */
function vo2maxDelta(vo2max, age, sex) {
  const expected = expectedVo2maxForAge(age, sex);
  const diff = vo2max - expected; // positive = fitter than norm
  // -0.4 yr per +1 mL/kg/min above expected; higher VO2max = younger delta.
  return clamp(-0.4 * diff, -15, 15);
}

/**
 * Resting HR age delta.
 *
 * Formula: delta = +0.25 * (actual - expected), clamped to [-12, +12].
 * Higher-than-expected RHR -> positive delta (older). Sensitivity ~0.25 yr/bpm
 * from Cooney (2010) hazard ratios back-converted to age equivalents.
 *
 * @param {number} rhr
 * @param {number} age
 * @param {'M'|'F'} sex
 * @returns {number}
 */
function restingHrDelta(rhr, age, sex) {
  const expected = expectedRestingHrForAge(age, sex);
  const diff = rhr - expected; // positive = higher than norm (worse)
  // +0.25 yr per +1 bpm above expected; lower RHR = younger delta.
  return clamp(0.25 * diff, -12, 12);
}

/**
 * RMSSD age delta.
 *
 * Because RMSSD declines log-linearly, we use a log-ratio mapping:
 *   delta = -k * log(actual / expected)
 * where k ≈ 15 makes log(2) ~ 10 years — empirically consistent with the
 * HRV-age elasticity reported in Umetani (1998) and Shaffer (2017).
 * Clamped to [-12, +12].
 *
 * @param {number} rmssd
 * @param {number} age
 * @returns {number}
 */
function rmssdDelta(rmssd, age) {
  const expected = expectedRmssdForAge(age);
  if (expected <= 0 || rmssd <= 0) return 0;
  // log ratio: positive ratio (rmssd > expected) -> negative delta (younger).
  // k=15: log(2) ≈ 0.693 -> delta ≈ -10.4 yr, log(0.5) -> +10.4 yr.
  const k = 15;
  return clamp(-k * Math.log(rmssd / expected), -12, 12);
}

/**
 * Sleep duration age delta.
 *
 * Based on Watson et al. (2015) recommendation: 7-9h optimal.
 *   < 7h (420 min):  penalty up to +5 yr at 0 min sleep.
 *   7-9h (420-540):  small bonus of 0 to -5 yr peaking at 480 min (8h).
 *   > 9h (540 min):  no additional bonus (diminishing returns; excess sleep
 *                    may reflect illness rather than virtue).
 * Clamped to [-5, +5].
 *
 * @param {number} avgSleepMinutes
 * @returns {number}
 */
function sleepDelta(avgSleepMinutes) {
  if (avgSleepMinutes < 420) {
    // Linear penalty: 0 at 420 min, +5 at 0 min.
    return clamp(5 * (1 - avgSleepMinutes / 420), 0, 5);
  }
  if (avgSleepMinutes <= 540) {
    // Bonus zone: peaks at -2.5 at 480 min (8h), fades to 0 at 420 and 540.
    // Quadratic: bonus = -2.5 * 4 * (t-420)(540-t)/(540-420)^2
    const t = avgSleepMinutes;
    const bonus = 2.5 * 4 * ((t - 420) * (540 - t)) / (120 * 120);
    return clamp(-bonus, -5, 0);
  }
  // > 9h: no benefit modelled.
  return 0;
}

/**
 * Recovery score age delta.
 *
 * Maps WHOOP-style 0-100 recovery score to an age delta.
 *   >66 (green): bonus, linearly up to -5 yr at 100.
 *   33-66 (yellow): near-neutral, 0 at 66 blending to 0 at 33.
 *   <33 (red): penalty, up to +5 yr at 0.
 * Clamped to [-5, +5].
 *
 * @param {number} avgRecovery
 * @returns {number}
 */
function recoveryDelta(avgRecovery) {
  if (avgRecovery > 66) {
    // Linear bonus: 0 at 66, -5 at 100.
    return clamp(-5 * (avgRecovery - 66) / 34, -5, 0);
  }
  if (avgRecovery < 33) {
    // Linear penalty: 0 at 33, +5 at 0.
    return clamp(5 * (33 - avgRecovery) / 33, 0, 5);
  }
  // Yellow zone: 33-66 -> small linear taper.
  // 0 at 50, slightly negative toward 66, slightly positive toward 33.
  return clamp(-(avgRecovery - 50) * (2.5 / 17), -5, 5);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Estimate a "Physiological Age" from multiple longevity-correlated signals.
 *
 * Each present signal contributes an additive age-delta vs. population norms;
 * the weighted mean of those deltas is added to chronological age and clamped
 * to [18, 90]. Weights are re-normalised over the signals that are actually
 * present, so a partial reading is still meaningful.
 *
 * DISCLAIMER: Interpretable estimate only. NOT a clinical measure.
 *
 * @param {object} args
 * @param {number|null|undefined} args.chronoAge  - Chronological age (years). Required.
 * @param {'M'|'F'} [args.sex='M']               - Biological sex for sex-stratified norms.
 * @param {number|null} [args.vo2max=null]        - VO2max (mL/kg/min).
 * @param {number|null} [args.restingHr=null]     - Resting heart rate (bpm).
 * @param {number|null} [args.rmssd=null]         - RMSSD from overnight HRV (ms).
 * @param {number|null} [args.avgSleepMinutes=null] - Average sleep per night (minutes).
 * @param {number|null} [args.avgRecovery=null]   - Average WHOOP recovery score (0-100).
 * @returns {{
 *   physioAge: number,
 *   chronoAge: number,
 *   deltaYears: number,
 *   drivers: Array<{name:string, label:string, yearsDelta:number, weight:number}>,
 *   confidence: 'low'|'medium'|'high'
 * }|null}
 */
export function physiologicalAge({
  chronoAge,
  sex = 'M',
  vo2max = null,
  restingHr = null,
  rmssd = null,
  avgSleepMinutes = null,
  avgRecovery = null,
} = {}) {
  if (!isNum(chronoAge)) return null;

  // Normalise sex to 'M' or 'F'; default to 'M' for unknown values.
  const normSex = (sex === 'F' || sex === 'f') ? 'F' : 'M';

  // Build driver list — only for signals that are present and valid.
  const candidates = [];

  if (isNum(vo2max) && vo2max > 0) {
    candidates.push({
      name: 'vo2max',
      label: 'VO₂ max',
      yearsDelta: round1(vo2maxDelta(vo2max, chronoAge, normSex)),
      weight: SIGNAL_WEIGHTS.vo2max,
    });
  }

  if (isNum(restingHr) && restingHr > 0) {
    candidates.push({
      name: 'restingHr',
      label: 'Resting HR',
      yearsDelta: round1(restingHrDelta(restingHr, chronoAge, normSex)),
      weight: SIGNAL_WEIGHTS.restingHr,
    });
  }

  if (isNum(rmssd) && rmssd > 0) {
    candidates.push({
      name: 'rmssd',
      label: 'HRV (RMSSD)',
      yearsDelta: round1(rmssdDelta(rmssd, chronoAge)),
      weight: SIGNAL_WEIGHTS.rmssd,
    });
  }

  if (isNum(avgSleepMinutes) && avgSleepMinutes >= 0) {
    candidates.push({
      name: 'avgSleepMinutes',
      label: 'Avg Sleep',
      yearsDelta: round1(sleepDelta(avgSleepMinutes)),
      weight: SIGNAL_WEIGHTS.avgSleepMinutes,
    });
  }

  if (isNum(avgRecovery) && avgRecovery >= 0 && avgRecovery <= 100) {
    candidates.push({
      name: 'avgRecovery',
      label: 'Recovery Score',
      yearsDelta: round1(recoveryDelta(avgRecovery)),
      weight: SIGNAL_WEIGHTS.avgRecovery,
    });
  }

  // Need at least 2 signals for a meaningful estimate.
  if (candidates.length < 2) return null;

  // Re-normalise weights over the present signals.
  const totalWeight = candidates.reduce((s, d) => s + d.weight, 0);
  const weightedDeltaSum = candidates.reduce((s, d) => s + d.yearsDelta * d.weight, 0);
  const meanDelta = weightedDeltaSum / totalWeight;

  const physioAge = round1(clamp(chronoAge + meanDelta, 18, 90));
  const deltaYears = round1(physioAge - chronoAge);

  // Confidence based on number of signals present.
  let confidence;
  if (candidates.length >= 4) {
    confidence = 'high';
  } else if (candidates.length === 3) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    physioAge,
    chronoAge,
    deltaYears,
    drivers: candidates,
    confidence,
  };
}
