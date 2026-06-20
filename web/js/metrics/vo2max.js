// VO2max estimation and fitness-age computation from resting heart rate.
//
// All functions are pure: no DOM, no IndexedDB, no Date.now() calls.
// Inputs come from the daily_metrics row (resting_hr, age, sex) which the
// caller reads from IndexedDB and passes in. When a required field is
// missing or physiologically implausible, the function returns null so the
// UI can degrade gracefully — matching real-strap behaviour where only
// heart_rate_bpm and rr_interval_ms are reliably populated.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNum(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** Linear interpolation between two points. */
function lerp(x0, y0, x1, y1, x) {
  if (x1 === x0) return y0;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

// ---------------------------------------------------------------------------
// ACSM / Cooper normative VO2max bands
// Reference: ACSM's Guidelines for Exercise Testing and Prescription, 11th ed.
// Bands are inclusive lower bounds for each category:
//   { ageMin, ageMax, male: [Poor, Fair, Good, Excellent, Superior cutoffs],
//     female: [...] }
// A value >= Superior cutoff is 'Superior', >= Excellent is 'Excellent', etc.
// Values below the Poor cutoff (first entry) remain 'Poor'.
// ---------------------------------------------------------------------------
const NORM_CUTOFFS = [
  // age 20–29
  { ageMin: 20, ageMax: 29, M: [32.0, 38.0, 43.0, 48.0, 53.0], F: [24.0, 29.0, 32.0, 36.0, 41.0] },
  // age 30–39
  { ageMin: 30, ageMax: 39, M: [31.0, 36.0, 41.0, 45.0, 50.0], F: [22.0, 27.0, 30.0, 33.0, 37.0] },
  // age 40–49
  { ageMin: 40, ageMax: 49, M: [29.0, 34.0, 38.0, 43.0, 47.0], F: [20.0, 24.0, 27.0, 31.0, 35.0] },
  // age 50–59
  { ageMin: 50, ageMax: 59, M: [26.0, 31.0, 35.0, 40.0, 44.0], F: [18.0, 22.0, 25.0, 28.0, 31.0] },
  // age 60–69
  { ageMin: 60, ageMax: 69, M: [22.0, 27.0, 31.0, 36.0, 40.0], F: [16.0, 20.0, 23.0, 26.0, 29.0] },
  // age 70+
  { ageMin: 70, ageMax: 120, M: [20.0, 24.0, 28.0, 33.0, 37.0], F: [14.0, 18.0, 20.0, 24.0, 27.0] },
];

const CATEGORY_LABELS = ['Poor', 'Fair', 'Good', 'Excellent', 'Superior'];

// ---------------------------------------------------------------------------
// Population VO2max medians by decade for fitness-age inversion.
// Source: derived from Shvartz & Reibold (1990) / ACSM norms; median is
// interpolated between the Good/Excellent band boundary (50th–60th pct).
// Decade anchors at ages [20, 30, 40, 50, 60, 70].
// ---------------------------------------------------------------------------
const MEDIAN_VO2_BY_AGE = {
  // [age, medianVo2] pairs; linear interpolation is used between points.
  M: [
    [18, 43.0],
    [20, 43.0],
    [30, 41.0],
    [40, 38.0],
    [50, 35.0],
    [60, 31.0],
    [70, 28.0],
    [85, 24.0],
  ],
  F: [
    [18, 32.0],
    [20, 32.0],
    [30, 30.0],
    [40, 27.0],
    [50, 25.0],
    [60, 23.0],
    [70, 20.0],
    [85, 17.0],
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate VO2max from resting heart rate using the Uth–Sorensen (2004)
 * rest-based formula:
 *
 *   VO2max ≈ 15.3 × (HRmax / HRrest)
 *
 * where HRmax = maxHrOverride || (220 − age).
 *
 * Result is clamped to a plausible physiological range [20, 80] mL/kg/min
 * and rounded to one decimal place. Returns null when restingHr is absent
 * or physiologically impossible (≤ 0).
 *
 * @param {object} args
 * @param {number|null|undefined} args.restingHr - resting heart rate (bpm)
 * @param {number|null|undefined} args.age - years
 * @param {string} [args.sex='M'] - 'M' or 'F'
 * @param {number|null} [args.maxHrOverride=null] - measured HRmax if available
 * @returns {number|null}
 */
export function estimateVo2max({ restingHr, age, sex = 'M', maxHrOverride = null }) {
  if (!isNum(restingHr) || restingHr <= 0) return null;
  if (!isNum(age) || age <= 0) return null;

  const hrMax = isNum(maxHrOverride) && maxHrOverride > 0
    ? maxHrOverride
    : 220 - age; // Fox & Haskell (1971) age-predicted HRmax

  // Uth–Sorensen (2004): VO2max ~= 15.3 * (HRmax / HRrest)
  const raw = 15.3 * (hrMax / restingHr);
  const clamped = Math.max(20.0, Math.min(80.0, raw));
  return round1(clamped);
}

/**
 * Classify a VO2max value using ACSM/Cooper age-and-sex normative bands.
 *
 * Categories (ACSM Guidelines for Exercise Testing and Prescription, 11th ed.):
 *   'Poor' | 'Fair' | 'Good' | 'Excellent' | 'Superior'
 *
 * Returns 'Poor' when vo2max is below every cutoff or when inputs are
 * missing/implausible.
 *
 * @param {number|null|undefined} vo2max - mL/kg/min
 * @param {number|null|undefined} age - years
 * @param {string} [sex='M'] - 'M' or 'F'
 * @returns {string}
 */
export function vo2maxCategory(vo2max, age, sex = 'M') {
  if (!isNum(vo2max) || !isNum(age)) return 'Poor';

  const key = sex === 'F' ? 'F' : 'M';
  const band = NORM_CUTOFFS.find((b) => age >= b.ageMin && age <= b.ageMax)
    ?? NORM_CUTOFFS[NORM_CUTOFFS.length - 1];
  const cutoffs = band[key];

  // Walk from highest category down; return the first one the user clears.
  for (let i = cutoffs.length - 1; i >= 0; i--) {
    if (vo2max >= cutoffs[i]) return CATEGORY_LABELS[i];
  }
  return 'Poor';
}

/**
 * Infer "fitness age" by inverting the sex-specific population VO2max-by-age
 * curve via linear interpolation between decade anchors.
 *
 * A fitness age < chronological age means the user's aerobic capacity
 * matches a younger demographic.
 *
 * Result is clamped to [18, 85]. Returns null when inputs are missing.
 *
 * @param {object} args
 * @param {number|null|undefined} args.vo2max - mL/kg/min
 * @param {string} [args.sex='M'] - 'M' or 'F'
 * @returns {number|null}
 */
export function fitnessAge({ vo2max, sex = 'M' }) {
  if (!isNum(vo2max) || vo2max <= 0) return null;

  const key = sex === 'F' ? 'F' : 'M';
  const curve = MEDIAN_VO2_BY_AGE[key];

  // VO2max decreases with age, so a higher vo2max → younger fitness age.
  // We walk the curve and find the bracket where vo2max sits.
  for (let i = 0; i < curve.length - 1; i++) {
    const [age0, v0] = curve[i];
    const [age1, v1] = curve[i + 1];
    // v0 >= v1 (curve is decreasing). The user's vo2max falls in this bracket
    // when it is between v1 and v0 (inclusive at both ends).
    if (vo2max <= v0 && vo2max >= v1) {
      // Invert: given vo2max, interpolate age from the VO2 axis to the age axis.
      const age = lerp(v0, age0, v1, age1, vo2max);
      return Math.round(Math.max(18, Math.min(85, age)));
    }
  }

  // Beyond the curve extremes: clamp.
  if (vo2max > curve[0][1]) return 18;
  return 85;
}

/**
 * Convenience wrapper that runs all three computations in one call.
 *
 * Returns:
 *   vo2max        — estimated VO2max (mL/kg/min), or null
 *   category      — ACSM category string
 *   fitnessAge    — inferred fitness age (years), or null
 *   fitnessAgeDelta — fitnessAge − age (negative = younger/fitter), or null
 *
 * @param {object} args
 * @param {number|null|undefined} args.restingHr
 * @param {number|null|undefined} args.age
 * @param {string} [args.sex='M']
 * @param {number|null} [args.maxHrOverride=null]
 * @returns {{ vo2max: number|null, category: string, fitnessAge: number|null, fitnessAgeDelta: number|null }}
 */
export function vo2maxReport({ restingHr, age, sex = 'M', maxHrOverride = null }) {
  const vo2max = estimateVo2max({ restingHr, age, sex, maxHrOverride });
  const category = vo2maxCategory(vo2max, age, sex);
  const fa = fitnessAge({ vo2max, sex });
  const fitnessAgeDelta = isNum(fa) && isNum(age) ? fa - age : null;
  return { vo2max, category, fitnessAge: fa, fitnessAgeDelta };
}
