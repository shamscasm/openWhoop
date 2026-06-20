// Heart-Rate Recovery (HRR) — autonomic fitness marker.
//
// HRR measures how fast heart rate drops in the minute(s) after peak exertion.
// A faster drop indicates better parasympathetic reactivation (autonomic fitness).
//
// Reference: Cole et al. (1999) NEJM — HRR1 ≥12 bpm is normal; ≥25 = excellent.
// Reference: Mora et al. (2003) Circulation — HRR2 adds independent prognostic value.
//
// Pure functions only. Callers provide samples pre-fetched from IndexedDB.
// No wall-clock reads — workoutEndUtc is passed in as an argument.

// Tolerance window (ms) for matching a sample to a target offset.
// We accept the closest sample within ±15 s of the desired timestamp.
const MATCH_TOLERANCE_MS = 15_000;

// Minimum post-workout coverage (ms) required before returning a result.
// Avoids misleading output from a single rogue sample.
const MIN_POST_COVERAGE_MS = 30_000;

// HRR1 category thresholds (bpm drop in 60 s).
// Cole et al. 1999: <12 bpm = poor; Kligfield 2003: ≥25 = excellent.
const CATEGORY_THRESHOLDS = Object.freeze({
  excellent: 25,
  good: 18,
  fair: 12,
});

function isNum(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v);
}

/**
 * Find the sample whose ts_utc (parsed to epoch ms) is closest to targetMs,
 * but only if it falls within MATCH_TOLERANCE_MS.
 *
 * @param {Array<{ts_utc: string, heart_rate_bpm: number|null}>} samples
 * @param {number} targetMs
 * @returns {number|null} heart_rate_bpm of the closest matching sample, or null
 */
function hrAtTarget(samples, targetMs) {
  let bestDelta = Infinity;
  let bestHr = null;
  for (const s of samples) {
    if (!isNum(s.heart_rate_bpm)) continue;
    const t = new Date(s.ts_utc).getTime();
    const delta = Math.abs(t - targetMs);
    if (delta <= MATCH_TOLERANCE_MS && delta < bestDelta) {
      bestDelta = delta;
      bestHr = s.heart_rate_bpm;
    }
  }
  return bestHr;
}

/**
 * Categorise a 60-second HRR value.
 *
 * Thresholds: ≥25 excellent, 18–24 good, 12–17 fair, <12 poor.
 * Returns null when hrr60 is null or not a finite number.
 *
 * @param {number|null} hrr60
 * @returns {'excellent'|'good'|'fair'|'poor'|null}
 */
function categorise(hrr60) {
  if (!isNum(hrr60)) return null;
  if (hrr60 >= CATEGORY_THRESHOLDS.excellent) return 'excellent';
  if (hrr60 >= CATEGORY_THRESHOLDS.good) return 'good';
  if (hrr60 >= CATEGORY_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

/**
 * Compute heart-rate recovery metrics from a sample array spanning a workout
 * cool-down period.
 *
 * endHr is the HR at (or closest sample to) workoutEndUtc. If the caller
 * already knows the peak HR (e.g. from a workout record), pass it as
 * `options.peakHr` to override the look-up — useful when the end-of-workout
 * sample is ambiguous due to GPS/BLE reconnection gaps.
 *
 * hrr60 = endHr − HR at end + 60 s (closest sample within ±15 s).
 * hrr120 = endHr − HR at end + 120 s (same tolerance).
 *
 * Returns null when:
 *   - samples is empty / missing
 *   - workoutEndUtc cannot be parsed
 *   - endHr cannot be determined (no sample and no peakHr)
 *   - fewer than 30 s of post-workout samples exist
 *
 * @param {Array<{ts_utc: string, heart_rate_bpm: number|null}>} samples
 * @param {string} workoutEndUtc - ISO-8601 string marking end of exertion
 * @param {object} [options]
 * @param {number|null} [options.peakHr=null] - override end-of-workout HR
 * @returns {{hrr60: number|null, hrr120: number|null, endHr: number, category: string|null}|null}
 */
export function heartRateRecovery(samples, workoutEndUtc, { peakHr = null } = {}) {
  if (!samples || samples.length === 0) return null;

  const endMs = new Date(workoutEndUtc).getTime();
  if (!Number.isFinite(endMs)) return null;

  // Determine endHr: prefer caller-supplied peakHr, then look it up from samples.
  const endHr = isNum(peakHr) ? peakHr : hrAtTarget(samples, endMs);
  if (!isNum(endHr)) return null;

  // Require at least MIN_POST_COVERAGE_MS of post-workout samples.
  let maxPostMs = -Infinity;
  for (const s of samples) {
    const t = new Date(s.ts_utc).getTime();
    if (t > endMs && isNum(s.heart_rate_bpm) && t > maxPostMs) maxPostMs = t;
  }
  if (maxPostMs - endMs < MIN_POST_COVERAGE_MS) return null;

  // HRR at 60 s and 120 s: endHr minus the HR at that offset.
  // A positive value means HR fell — higher is better.
  const hr60 = hrAtTarget(samples, endMs + 60_000);
  const hr120 = hrAtTarget(samples, endMs + 120_000);

  const hrr60 = isNum(hr60) ? endHr - hr60 : null;
  const hrr120 = isNum(hr120) ? endHr - hr120 : null;

  return {
    hrr60,
    hrr120,
    endHr,
    category: categorise(hrr60),
  };
}
