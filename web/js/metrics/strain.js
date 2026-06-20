/**
 * Strain (cardiac load) calculations.
 *
 * Ported from whoof/metrics.py. Reproduces the spirit of Whoop's
 * 0-21 strain scale from cardiovascular load without using the
 * proprietary algorithm.
 */

// Knee of the exponential strain curve, in intensity-minutes. See strainScore.
const STRAIN_DIVISOR = 32.0;

/**
 * Whoop-like 0-21 daily strain score.
 *
 * Methodology:
 *   load   = sum( max(0, (hr - rest) / (max - rest)) ^ 2 ) * dt_seconds / 60
 *   strain = 21 * (1 - exp(-load / 32))
 *
 * The squared term emphasises higher intensities, matching the
 * qualitative behaviour of Whoop's published scale.
 *
 * STRAIN_DIVISOR sets the curve's knee. With load in intensity-minutes, 32
 * spreads a real day across the 0-21 range instead of saturating at 21 for
 * any sustained effort.
 *
 * @param {ReadonlyArray<number|null|undefined>} hrBpm  Heart-rate samples (bpm).
 * @param {number} [age=30]                              Age in years (for max HR estimate).
 * @param {number|null} [restingHr=null]                 Optional resting HR; defaults to min of samples.
 * @param {number} [sampleIntervalSec=1.0]               Seconds between samples; scales load so the
 *                                                        score is invariant to the stream's sample rate.
 * @returns {number}                                     Strain score in [0, 21].
 */
export function strainScore(hrBpm, age = 30, restingHr = null, sampleIntervalSec = 1.0) {
  if (!hrBpm || hrBpm.length === 0) {
    return 0.0;
  }
  const samples = [];
  for (const h of hrBpm) {
    if (h !== null && h !== undefined && h >= 30 && h <= 230) {
      samples.push(h);
    }
  }
  if (samples.length === 0) {
    return 0.0;
  }
  const maxHr = 220 - age;
  const rest = restingHr ? restingHr : Math.min(...samples);
  if (maxHr <= rest) {
    return 0.0;
  }
  let sumSq = 0.0;
  for (const h of samples) {
    const intensity = Math.max(0.0, (h - rest) / (maxHr - rest));
    sumSq += intensity * intensity;
  }
  // Intensity-minutes: the per-sample intensity² sum scaled by the real
  // sample interval, so a coarse historical dump and a 1 Hz live stream of
  // the same effort yield the same load. divisor STRAIN_DIVISOR is tuned so a
  // sedentary day lands ~6-9 and an all-out day approaches 21.
  const dt = Number.isFinite(sampleIntervalSec) && sampleIntervalSec > 0 ? sampleIntervalSec : 1.0;
  const load = (sumSq * dt) / 60.0;
  return Math.round(21.0 * (1.0 - Math.exp(-load / STRAIN_DIVISOR)) * 100) / 100;
}

/**
 * Zone-weighted strain — a more interpretable companion to strainScore().
 *
 * Ported from goose's zone_score model. Time-in-zone is weighted 1..5 (a minute
 * in Z5 counts 5× a minute in Z1), normalised into the 0-21 range, then blended
 * 70/30 with an HR-reserve term so the score reflects both *how long* and *how
 * hard*. Unlike the exponential strainScore it degrades gracefully to 0 with no
 * load and is trivial to explain ("you banked N zone-minutes").
 *
 * @param {Object} o
 * @param {ReadonlyArray<number>} o.zoneMinutes  [z1..z5] minutes in each zone.
 * @param {number} o.avgHr        Mean HR over the active window (bpm).
 * @param {number} o.restingHr    Resting HR (bpm).
 * @param {number} o.maxHrBpm     Max HR (bpm).
 * @returns {number}              Strain in [0, 21].
 */
export function zoneWeightedStrain({ zoneMinutes, avgHr, restingHr, maxHrBpm } = {}) {
  if (!Array.isArray(zoneMinutes) || zoneMinutes.length < 5) return 0;
  const weights = [1, 2, 3, 4, 5];
  let zoneLoad = 0;
  for (let i = 0; i < 5; i++) zoneLoad += (zoneMinutes[i] || 0) * weights[i];
  const zoneScore = Math.max(0, Math.min(21, zoneLoad / 20));

  let reserveScore = 0;
  if (Number.isFinite(avgHr) && Number.isFinite(restingHr) && Number.isFinite(maxHrBpm) && maxHrBpm > restingHr) {
    const reserve = Math.max(0, Math.min(1, (avgHr - restingHr) / (maxHrBpm - restingHr)));
    reserveScore = reserve * 21;
  }
  const final = 0.7 * zoneScore + 0.3 * reserveScore;
  return Math.round(final * 100) / 100;
}

/**
 * Acute:Chronic Workload Ratio. Compares short-term (acute) strain
 * exposure to a longer-term (chronic) baseline. A ratio of 0.8–1.3 is
 * the canonical "sweet spot"; outside that range is associated with
 * either elevated injury risk (>1.3) or detraining (<0.6).
 *
 * @param {ReadonlyArray<number|null|undefined>} strainSeries
 *        Strain scores in newest-first order (latest at index 0).
 * @param {Object} [opts]
 * @param {number} [opts.acuteDays=7]    Window for acute mean
 * @param {number} [opts.chronicDays=21] Max window for chronic mean
 *        (taken from indices acuteDays … acuteDays+chronicDays-1)
 * @param {number} [opts.minSamples=5]   Minimum non-null values per window
 * @returns {{ratio:number, acute:number, chronic:number}|null}
 */
export function acwr(strainSeries, { acuteDays = 7, chronicDays = 21, minSamples = 5 } = {}) {
  if (!Array.isArray(strainSeries)) return null;
  const acute = strainSeries.slice(0, acuteDays).filter((v) => v != null);
  const chronic = strainSeries.slice(acuteDays, acuteDays + chronicDays).filter((v) => v != null);
  if (acute.length < minSamples || chronic.length < minSamples) return null;
  const acuteMean = acute.reduce((a, b) => a + b, 0) / acute.length;
  const chronicMean = chronic.reduce((a, b) => a + b, 0) / chronic.length;
  if (!chronicMean) return null;
  return { ratio: acuteMean / chronicMean, acute: acuteMean, chronic: chronicMean };
}
