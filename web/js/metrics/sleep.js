// Sleep window detection, stage classification, and derived sleep metrics.
// Ported from whoof/sleep.py.
//
// Heuristics are deterministic and based on motion + HR + RR-interval
// variability. Intentionally simple: no FFT libraries, no ML models. They
// approximate Whoop's published metrics but do not match exactly.
//
// DB-touching helpers from the Python version (compute_sleep_for_day,
// history_for_consistency) are not ported here -- callers in the browser
// fetch samples from IndexedDB and hand them to the pure-math functions
// below. The signatures that used `sqlite3.Connection` are dropped; the
// per-sample-array signatures (detectSleepWindow, classifyStages,
// respiratoryRate) port directly.

// How long we group samples for classification. 30 s = one polysomnography epoch.
export const EPOCH_SECONDS = 30;

// Minimum contiguous low-motion span (minutes) to count as a sleep block.
export const MIN_SLEEP_BLOCK_MINUTES = 30;

// Local hour bounds we consider for the nightly sleep window. We look for the
// longest contiguous low-motion block whose midpoint falls inside this range.
// Spans midnight: 20:00 → 11:00.
export const NIGHT_WINDOW_LOCAL = { startHour: 20, endHour: 11 };

// Stages
export const STAGES = ['wake', 'light', 'deep', 'rem'];

// Default sleep need (8h) before debt/strain bumps.
export const BASE_SLEEP_MINUTES = 480;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function motionMagnitude(row) {
  const hasAccel = row.accel_x != null || row.accel_y != null || row.accel_z != null || row.motion != null;
  if (!hasAccel) return null;
  if (row.motion != null) return Math.abs(row.motion);
  const ax = Math.abs(row.accel_x || 0);
  const ay = Math.abs(row.accel_y || 0);
  const az = Math.abs(row.accel_z || 0);
  return ax + ay + az;
}

function sleepMotionAvailable(row) {
  return row.accel_x != null || row.accel_y != null || row.accel_z != null || row.motion != null;
}

function parseTs(row) {
  return new Date(row.ts_utc);
}

function mean(values) {
  if (values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function pstdev(values) {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

// ---------------------------------------------------------------------------
// Sleep window detection
// ---------------------------------------------------------------------------

/**
 * Find the contiguous low-motion + low-HR block that constitutes "last night".
 *
 * Walks samples in time order, grouping into contiguous runs where motion
 * magnitude is below a threshold AND HR is below 95% of the daily mean.
 * Returns the longest such run whose midpoint lies in NIGHT_WINDOW_LOCAL
 * and is at least MIN_SLEEP_BLOCK_MINUTES long. Returns [startUtc, endUtc]
 * as Date objects, or null.
 *
 * @param {Array<object>} samples - rows with ts_utc, heart_rate_bpm, accel_*
 * @param {string} nightOf - YYYY-MM-DD local date (unused for filtering;
 *   sample selection happens in the caller).
 * @returns {[Date, Date]|null}
 */
export function detectSleepWindow(samples, _nightOf) {
  if (!samples || samples.length === 0) return null;

  const hrs = [];
  for (const r of samples) {
    if (r.heart_rate_bpm != null) hrs.push(r.heart_rate_bpm);
  }
  if (hrs.length === 0) return null;

  // Use a permissive HR threshold: max of (95% of mean) and (min + 25 bpm).
  // The min+25 floor lets REM peaks (which run ~10-15 bpm above deep-sleep
  // baseline) count as sleep rather than wake — otherwise REM-heavy nights
  // get fragmented into multiple sub-blocks.
  const hrMin = Math.min(...hrs);
  const hrThreshold = Math.max(mean(hrs) * 0.95, hrMin + 25);
  const motionThreshold = 180;
  const gapTolerance = 6;
  // Tolerate brief disruptions inside a sleep block (a few seconds of
  // elevated HR or a roll-over). We close a run only after `gapTolerance`
  // consecutive non-sleeping samples — that way a single noisy sample
  // doesn't split an 8-hour night.

  const runs = [];
  let cur = [];
  let gap = 0;
  for (const r of samples) {
    const hr = r.heart_rate_bpm != null ? r.heart_rate_bpm : 999;
    const motion = motionMagnitude(r);
    const isSleeping = hr < hrThreshold && (motion == null || motion < motionThreshold);
    if (isSleeping) {
      cur.push(r);
      gap = 0;
    } else if (cur.length > 0) {
      gap += 1;
      if (gap > gapTolerance) {
        runs.push(cur);
        cur = [];
        gap = 0;
      } else {
        // tentatively include — if sleep resumes, this gets folded in
        cur.push(r);
      }
    }
  }
  if (cur.length > 0) runs.push(cur);

  let best = null;
  const { startHour: nightStartH, endHour: nightEndH } = NIGHT_WINDOW_LOCAL;
  for (const run of runs) {
    const start = parseTs(run[0]);
    const end = parseTs(run[run.length - 1]);
    const durationMin = (end.getTime() - start.getTime()) / 60_000;
    if (durationMin < MIN_SLEEP_BLOCK_MINUTES) continue;
    const mid = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
    const h = mid.getHours(); // local hour
    const inWindow = h >= nightStartH || h < nightEndH;
    if (!inWindow) continue;
    const score = Math.trunc(durationMin);
    if (best === null || score > best[2]) {
      best = [start, end, score];
    }
  }

  if (best === null) return null;
  return [best[0], best[1]];
}

// ---------------------------------------------------------------------------
// Stage classification (30-second epochs)
// ---------------------------------------------------------------------------

function bucketIntoEpochs(samples, start, end) {
  const epochs = [];
  let bucketEndMs = start.getTime() + EPOCH_SECONDS * 1000;
  let cur = [];
  const startMs = start.getTime();
  const endMs = end.getTime();
  for (const r of samples) {
    const t = parseTs(r).getTime();
    if (t < startMs || t >= endMs) continue;
    while (t >= bucketEndMs) {
      epochs.push(cur);
      cur = [];
      bucketEndMs += EPOCH_SECONDS * 1000;
    }
    cur.push(r);
  }
  if (cur.length > 0) epochs.push(cur);
  return epochs;
}

/**
 * Cheap RMSSD without the Malik filter -- used per-epoch for relative
 * comparison only.
 */
function rmssdQuick(rr) {
  const filtered = [];
  for (const v of rr) {
    if (v != null && v > 250 && v < 2000) filtered.push(v);
  }
  if (filtered.length < 3) return null;
  let sumSq = 0;
  const n = filtered.length - 1;
  for (let i = 0; i < n; i++) {
    const d = filtered[i + 1] - filtered[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

/**
 * Return stage segments covering the sleep window. Consecutive epochs of the
 * same stage are merged. Each entry: {start_utc, end_utc, stage, source}.
 *
 * @param {Array<object>} samples
 * @param {[Date, Date]} window
 * @returns {Array<{start_utc:string,end_utc:string,stage:string,source:string}>}
 */
export function classifyStages(samples, window) {
  const [start, end] = window;
  const epochs = bucketIntoEpochs(samples, start, end);
  if (epochs.length === 0) return [];

  const motionCoverage = [];

  // Per-epoch stats
  const epochStats = [];
  for (const ep of epochs) {
    if (ep.length === 0) {
      epochStats.push({ hr: null, motion: null, rmssd: null });
      continue;
    }
    const hrs = [];
    const rrs = [];
    const motions = [];
    let hasMotion = false;
    for (const r of ep) {
      if (r.heart_rate_bpm != null) hrs.push(r.heart_rate_bpm);
      if (r.rr_interval_ms != null) rrs.push(r.rr_interval_ms);
      const motion = motionMagnitude(r);
      if (motion != null) {
        hasMotion = true;
        motions.push(motion);
      }
    }
    motionCoverage.push(hasMotion ? 1 : 0);
    epochStats.push({
      hr: hrs.length > 0 ? mean(hrs) : null,
      motion: motions.length > 0 ? mean(motions) : null,
      rmssd: rmssdQuick(rrs),
    });
  }

  const hrVals = [];
  const rmssdVals = [];
  for (const e of epochStats) {
    if (e.hr != null) hrVals.push(e.hr);
    if (e.rmssd != null) rmssdVals.push(e.rmssd);
  }
  if (hrVals.length === 0) return [];
  const hrMin = Math.min(...hrVals);
  const hrBaseline = median(hrVals);
  const rmssdBaseline = rmssdVals.length > 0 ? median(rmssdVals) : 30.0;
  const hasMotionSignal = motionCoverage.some((v) => v > 0);

  // Classify each epoch
  const rawStages = [];
  for (const e of epochStats) {
    const { hr, motion, rmssd } = e;
    if (hr == null) {
      rawStages.push('wake');
      continue;
    }
    if ((hasMotionSignal && motion != null && motion > 200) || hr > hrBaseline + 12) {
      rawStages.push('wake');
    } else if (
      motion != null &&
      motion < 30 &&
      hr <= hrMin + 5 &&
      (rmssd == null || rmssd <= rmssdBaseline)
    ) {
      rawStages.push('deep');
    } else if (
      (motion == null || motion < 60) &&
      hr >= hrMin + 6 &&
      rmssd != null &&
      rmssd > rmssdBaseline * 1.1
    ) {
      rawStages.push('rem');
    } else {
      rawStages.push('light');
    }
  }

  // Smooth: a single-epoch wake surrounded by sleep stays as light.
  const smoothed = rawStages.slice();
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (
      smoothed[i] === 'wake' &&
      smoothed[i - 1] !== 'wake' &&
      smoothed[i + 1] !== 'wake'
    ) {
      smoothed[i] = 'light';
    }
  }

  // Consolidate runs
  const out = [];
  let curStage = smoothed[0];
  let curStartMs = start.getTime();
  const startMs = start.getTime();
  for (let i = 1; i < smoothed.length; i++) {
    if (smoothed[i] !== curStage) {
      const segEndMs = startMs + EPOCH_SECONDS * 1000 * i;
      out.push({
        start_utc: new Date(curStartMs).toISOString(),
        end_utc: new Date(segEndMs).toISOString(),
        stage: curStage,
        source: 'heuristic-v1',
      });
      curStage = smoothed[i];
      curStartMs = segEndMs;
    }
  }
  out.push({
    start_utc: new Date(curStartMs).toISOString(),
    end_utc: new Date(end.getTime()).toISOString(),
    stage: curStage,
    source: 'heuristic-v1',
  });
  return out;
}

export function sleepWindowSummary(samples, window) {
  if (!window || !samples?.length) return { source: null, confidencePct: null };
  const [start, end] = window;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const windowSamples = samples.filter((r) => {
    const t = new Date(r.ts_utc).getTime();
    return t >= startMs && t < endMs;
  });
  if (!windowSamples.length) return { source: null, confidencePct: null };

  let motionSamples = 0;
  let rrSamples = 0;
  let hrSamples = 0;
  for (const row of windowSamples) {
    if (sleepMotionAvailable(row)) motionSamples += 1;
    if (row.rr_interval_ms != null) rrSamples += 1;
    if (row.heart_rate_bpm != null) hrSamples += 1;
  }
  const motionCoverage = motionSamples / windowSamples.length;
  const rrCoverage = rrSamples / windowSamples.length;
  const hrCoverage = hrSamples / windowSamples.length;
  const source = motionCoverage >= 0.2 ? 'motion+hr' : 'hr-only';
  const confidencePct = Math.round(
    Math.min(100, 35 + motionCoverage * 35 + rrCoverage * 20 + hrCoverage * 10)
  );
  return { source, confidencePct };
}

/**
 * Total minutes per stage, integer-rounded.
 *
 * @param {Iterable<{start_utc:string,end_utc:string,stage:string}>} stages
 * @returns {{wake:number,light:number,deep:number,rem:number}}
 */
export function stageTotals(stages) {
  const totals = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const seg of stages) {
    const start = new Date(seg.start_utc).getTime();
    const end = new Date(seg.end_utc).getTime();
    totals[seg.stage] += (end - start) / 60_000;
  }
  const out = {};
  for (const k of STAGES) out[k] = Math.round(totals[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Sleep need / debt / consistency
// ---------------------------------------------------------------------------

/**
 * Whoop-style sleep-need formula. Base 8h plus up to 2h for accumulated
 * debt (half of debt, capped 120 min) plus up to 1h proportional to
 * yesterday's strain (~3 min per strain point, capped 60 min).
 *
 * @param {number} priorDebtMinutes
 * @param {number} strainYesterday
 * @returns {number}
 */
export function sleepNeedMinutes(priorDebtMinutes, strainYesterday) {
  const debtBump = Math.min(120.0, Math.max(0.0, priorDebtMinutes) / 2.0);
  const strainBump = Math.min(60.0, Math.max(0.0, strainYesterday) * 3.0);
  return Math.round(BASE_SLEEP_MINUTES + debtBump + strainBump);
}

/**
 * Sleep performance as a 0-100 score, rounded to one decimal.
 *
 * @param {number} asleepMinutes
 * @param {number} needMinutes
 * @returns {number}
 */
export function sleepPerformance(asleepMinutes, needMinutes) {
  if (needMinutes <= 0) return 0.0;
  const raw = Math.min(100.0, (100.0 * asleepMinutes) / needMinutes);
  return Math.round(raw * 10) / 10;
}

/**
 * Composite Sleep Quality Score (0–100). Combines five subscores into a
 * single number so the user can compare nights at a glance:
 *
 *   30%  performance   — how much of sleep need was met
 *   20%  efficiency    — asleep / time-in-bed (penalises restless sleep)
 *   20%  restorative   — (deep + rem) / total, normalised to a 40% target
 *   15%  consistency   — sleep schedule regularity
 *   15%  debt penalty  — 0 sleep debt → 100, decays to 0 at 5h of debt
 *
 * Each subscore is clipped to 0–100. Missing inputs are skipped and the
 * remaining weights re-normalised so the output is still on a 0–100 scale.
 *
 * @param {Object} m  - row-like object with the fields below.
 * @param {number} [m.sleep_minutes]
 * @param {number} [m.wake_minutes]
 * @param {number} [m.deep_sleep_minutes]
 * @param {number} [m.rem_sleep_minutes]
 * @param {number} [m.sleep_performance_pct]
 * @param {number} [m.sleep_consistency_pct]
 * @param {number} [m.sleep_debt_minutes]
 * @returns {{score:number|null, breakdown:Object}}
 */
export function sleepQualityScore(m) {
  if (!m) return { score: null, breakdown: {} };

  const subscores = [];
  const clip = (v) => Math.max(0, Math.min(100, v));

  // Performance — need fulfillment
  if (m.sleep_performance_pct != null) {
    subscores.push({ key: 'performance', weight: 30, value: clip(m.sleep_performance_pct) });
  }
  // Efficiency — asleep / time-in-bed
  if (m.sleep_minutes != null && m.wake_minutes != null) {
    const tib = m.sleep_minutes + m.wake_minutes;
    if (tib > 0) {
      subscores.push({ key: 'efficiency', weight: 20, value: clip(100 * m.sleep_minutes / tib) });
    }
  }
  // Restorative — (deep+rem)/total, target 40%
  if (m.sleep_minutes != null && m.sleep_minutes > 0 &&
      m.deep_sleep_minutes != null && m.rem_sleep_minutes != null) {
    const ratio = (m.deep_sleep_minutes + m.rem_sleep_minutes) / m.sleep_minutes;
    subscores.push({ key: 'restorative', weight: 20, value: clip(100 * Math.min(1, ratio / 0.40)) });
  }
  // Consistency
  if (m.sleep_consistency_pct != null) {
    subscores.push({ key: 'consistency', weight: 15, value: clip(m.sleep_consistency_pct) });
  }
  // Debt penalty
  if (m.sleep_debt_minutes != null) {
    const debt = Math.max(0, m.sleep_debt_minutes);
    subscores.push({ key: 'debt', weight: 15, value: clip(100 * Math.max(0, 1 - debt / 300)) });
  }

  if (!subscores.length) return { score: null, breakdown: {} };

  const totalWeight = subscores.reduce((a, s) => a + s.weight, 0);
  const weighted = subscores.reduce((a, s) => a + s.weight * s.value, 0);
  const score = Math.round(weighted / totalWeight);
  const breakdown = {};
  for (const s of subscores) breakdown[s.key] = Math.round(s.value);
  return { score, breakdown };
}

/**
 * Sum of max(0, need - asleep) across up to 7 recent days.
 *
 * @param {Array<number>} asleepHistory
 * @param {Array<number>} needHistory
 * @returns {number}
 */
export function sleepDebtMinutes7d(asleepHistory, needHistory) {
  let debt = 0;
  const n = Math.min(7, asleepHistory.length, needHistory.length);
  for (let i = 0; i < n; i++) {
    debt += Math.max(0, (needHistory[i] || 0) - (asleepHistory[i] || 0));
  }
  return debt;
}

/**
 * Consistency score 0-100 derived from population stddev of bed/wake times.
 * Lower stddev = higher score. Bedtimes before noon are wrapped to the
 * following day so a 1am bedtime averages cleanly with a 23:00 one.
 *
 * @param {Array<Date>} bedtimesLocal
 * @param {Array<Date>} waketimesLocal
 * @returns {number|null}
 */
export function sleepConsistencyPct(bedtimesLocal, waketimesLocal) {
  if (bedtimesLocal.length < 3 || waketimesLocal.length < 3) return null;

  const bedMinutesOfDay = (dt) => {
    let m = dt.getHours() * 60 + dt.getMinutes() + dt.getSeconds() / 60;
    if (m < 720) m += 1440;
    return m;
  };
  const wakeMinutesOfDay = (dt) =>
    dt.getHours() * 60 + dt.getMinutes() + dt.getSeconds() / 60;

  const bedM = bedtimesLocal.map(bedMinutesOfDay);
  const wakeM = waketimesLocal.map(wakeMinutesOfDay);
  const sigma = (pstdev(bedM) + pstdev(wakeM)) / 2;
  const raw = Math.max(0.0, Math.min(100.0, 100.0 - sigma / 1.2));
  return Math.round(raw * 10) / 10;
}

// ---------------------------------------------------------------------------
// Respiratory rate from RR-interval modulation
// ---------------------------------------------------------------------------

/**
 * Estimate breaths/min via respiratory sinus arrhythmia (RSA): the RR
 * series oscillates at the breathing frequency.
 *
 * Algorithm: autocorrelation peak picking. For each candidate breath period
 * (2.5s through 10s in 0.1s steps), compute the autocorrelation of the
 * detrended RR signal at that lag. The peak picks out the true period even
 * when sampling is too sparse for reliable zero-crossing detection (zero
 * crossings get aliased at <4 samples/cycle, autocorrelation does not).
 *
 * Returns breaths-per-minute, or null if there's not enough signal or no
 * clear periodic peak.
 *
 * @param {Array<object>} samples - rows with ts_utc and rr_interval_ms
 * @param {[Date, Date]|null} window
 * @returns {number|null}
 */
export function respiratoryRate(samples, window) {
  if (window == null) return null;
  const [start, end] = window;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const rrs = [];
  for (const r of samples) {
    if (r.rr_interval_ms == null) continue;
    const t = parseTs(r).getTime();
    if (t >= startMs && t < endMs) rrs.push([t, r.rr_interval_ms]);
  }
  if (rrs.length < 60) return null;

  // Detrend with a centred moving average to remove HR baseline drift.
  const win = 30;
  const vals = rrs.map((p) => p[1]);
  const half = Math.trunc(win / 2);
  const detrended = new Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(vals.length, i + half + 1);
    let s = 0;
    for (let j = lo; j < hi; j++) s += vals[j];
    detrended[i] = vals[i] - s / (hi - lo);
  }

  // Median sampling interval in seconds. Used to translate a "lag in samples"
  // into "lag in seconds" for the candidate-period scan.
  const intervals = [];
  for (let i = 1; i < Math.min(rrs.length, 200); i++) {
    intervals.push((rrs[i][0] - rrs[i - 1][0]) / 1000);
  }
  intervals.sort((a, b) => a - b);
  const medianDt = intervals[Math.trunc(intervals.length / 2)] || 1.0;
  if (medianDt <= 0) return null;

  // Iterate over integer LAGS directly — period resolution is limited by the
  // sample interval, so testing fractional periods that round to the same lag
  // would just bias toward whichever fractional value is tested first.
  // Plausible breathing range: 6..30 bpm → period 2..10 s.
  const minLag = Math.max(1, Math.floor(2.0 / medianDt));
  const maxLag = Math.min(detrended.length - 1, Math.ceil(10.0 / medianDt));

  let bestLag = null;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i + lag < detrended.length; i++) {
      sum += detrended[i] * detrended[i + lag];
      n++;
    }
    if (n === 0) continue;
    const corr = sum / n;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag == null || bestCorr <= 0) return null;

  // Quadratic interpolation around the peak to recover sub-lag resolution.
  // For a real autocorrelation peak between bestLag-1 and bestLag+1, the true
  // peak is at bestLag + offset where offset = (y_{-1} - y_{+1}) / (2*(y_{-1} - 2y_0 + y_{+1})).
  const corrAt = (lag) => {
    if (lag < 1 || lag >= detrended.length) return -Infinity;
    let s = 0, n = 0;
    for (let i = 0; i + lag < detrended.length; i++) { s += detrended[i] * detrended[i + lag]; n++; }
    return n > 0 ? s / n : -Infinity;
  };
  const yPrev = corrAt(bestLag - 1);
  const yNext = corrAt(bestLag + 1);
  let refinedLag = bestLag;
  const denom = yPrev - 2 * bestCorr + yNext;
  if (Math.abs(denom) > 1e-12 && Number.isFinite(yPrev) && Number.isFinite(yNext)) {
    const offset = (yPrev - yNext) / (2 * denom);
    if (Math.abs(offset) < 1) refinedLag = bestLag + offset;
  }

  const periodSec = refinedLag * medianDt;
  const bpm = 60.0 / periodSec;
  if (bpm < 6.0 || bpm > 30.0) return null;
  return Math.round(bpm * 10) / 10;
}

/**
 * First non-wake start and last non-wake end, as local-time Date objects.
 *
 * @param {Array<{start_utc:string,end_utc:string,stage:string}>} stages
 * @returns {[Date|null, Date|null]}
 */
export function bedWakeTimesLocal(stages) {
  if (!stages || stages.length === 0) return [null, null];
  const asleep = stages.filter((s) => s.stage !== 'wake');
  if (asleep.length === 0) return [null, null];
  const bed = new Date(asleep[0].start_utc);
  const wake = new Date(asleep[asleep.length - 1].end_utc);
  return [bed, wake];
}
