// Detailed sleep architecture metrics derived from stage segments.
//
// These functions operate on the output of classifyStages() from sleep.js —
// an array of {start_utc, end_utc, stage} objects — so they run entirely
// on HR+RR-only real strap data without requiring SPO2, skin temp, or
// accelerometer fields.
//
// Intentionally zero dependencies: no imports, no DOM, no wall-clock reads.
// Every value is passed in; callers (rollup.js, api-shim.js) supply the data.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isArr(v) {
  return Array.isArray(v) && v.length > 0;
}

function round0(v) {
  return Math.round(v);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function segDurMin(seg) {
  // Duration of a stage segment in (possibly fractional) minutes.
  // Parses ISO UTC strings; does not touch the wall clock.
  const startMs = new Date(seg.start_utc).getTime();
  const endMs = new Date(seg.end_utc).getTime();
  return (endMs - startMs) / 60_000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute detailed sleep architecture metrics from a hypnogram.
 *
 * @param {Array<{start_utc:string, end_utc:string, stage:string}>} stages
 *   Stage segments in time order; stage values: 'wake' | 'light' | 'deep' | 'rem'.
 * @param {[Date, Date]|null} [sleepWindow=null]
 *   Explicit time-in-bed window as [windowStart, windowEnd] Date objects.
 *   When null, time-in-bed is derived from the first segment's start to the
 *   last segment's end (parsed from ISO strings).
 * @returns {{
 *   timeInBedMin: number,
 *   asleepMin: number,
 *   sleepEfficiencyPct: number,
 *   sleepLatencyMin: number,
 *   wasoMin: number,
 *   disturbances: number,
 *   awakenings: number,
 *   cycleCount: number,
 *   longestStretchMin: number,
 *   restorativePct: number,
 * }|null}
 */
export function sleepArchitecture(stages, sleepWindow = null) {
  if (!isArr(stages)) return null;

  // Determine time-in-bed window (milliseconds).
  let windowStartMs;
  let windowEndMs;
  if (sleepWindow != null) {
    windowStartMs = sleepWindow[0].getTime();
    windowEndMs = sleepWindow[1].getTime();
  } else {
    windowStartMs = new Date(stages[0].start_utc).getTime();
    windowEndMs = new Date(stages[stages.length - 1].end_utc).getTime();
  }

  // Guard against a degenerate or backwards window.
  if (windowEndMs <= windowStartMs) return null;

  // timeInBedMin: total window width in minutes.
  const timeInBedMin = round0((windowEndMs - windowStartMs) / 60_000);

  // asleepMin: sum of non-wake segment duration in minutes.
  let asleepMs = 0;
  let deepMs = 0;
  let remMs = 0;
  for (const seg of stages) {
    if (seg.stage === 'wake') continue;
    const startMs = new Date(seg.start_utc).getTime();
    const endMs = new Date(seg.end_utc).getTime();
    const dur = endMs - startMs;
    asleepMs += dur;
    if (seg.stage === 'deep') deepMs += dur;
    if (seg.stage === 'rem') remMs += dur;
  }
  const asleepMin = round0(asleepMs / 60_000);

  // sleepEfficiencyPct = 100 * asleepMin / timeInBedMin, clamped 0-100, 1dp.
  // Formula: same as Whoop's definition (time asleep / time in bed).
  const sleepEfficiencyPct = timeInBedMin > 0
    ? round1(clamp(100.0 * asleepMs / (windowEndMs - windowStartMs), 0, 100))
    : 0;

  // sleepLatencyMin: minutes from window start (or first segment start, if no
  // explicit window) to the first non-wake segment. 0 if first segment is asleep.
  // Uses the raw ms window start so an explicit sleepWindow is respected.
  let sleepOnsetMs = null;
  for (const seg of stages) {
    if (seg.stage !== 'wake') {
      sleepOnsetMs = new Date(seg.start_utc).getTime();
      break;
    }
  }
  const sleepLatencyMin = sleepOnsetMs != null
    ? round0(Math.max(0, (sleepOnsetMs - windowStartMs) / 60_000))
    : round0(timeInBedMin); // never fell asleep

  // Find final awakening: last non-wake segment end before any trailing wake.
  let finalAsleepMs = null;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].stage !== 'wake') {
      finalAsleepMs = new Date(stages[i].end_utc).getTime();
      break;
    }
  }

  // wasoMin / disturbances / awakenings: wake segments AFTER sleep onset and
  // BEFORE the final awakening.
  //
  // Wake segments that are entirely at or before sleepOnsetMs constitute
  // sleep latency; wake segments that start at or after finalAsleepMs are
  // trailing wake (not WASO). We count only what falls in between.
  let wasoMs = 0;
  let awakenings = 0;
  if (sleepOnsetMs != null && finalAsleepMs != null) {
    for (const seg of stages) {
      if (seg.stage !== 'wake') continue;
      const segStartMs = new Date(seg.start_utc).getTime();
      const segEndMs = new Date(seg.end_utc).getTime();
      // A wake segment counts as WASO when it begins after sleep onset and
      // ends before (or at) the final non-wake segment's end.
      if (segStartMs >= sleepOnsetMs && segEndMs <= finalAsleepMs) {
        wasoMs += segEndMs - segStartMs;
        awakenings += 1;
      }
    }
  }
  const wasoMin = round0(wasoMs / 60_000);
  const disturbances = awakenings; // same count, different label per spec

  // cycleCount: number of REM-onset transitions (entering rem from a non-rem
  // stage). If there is no REM at all, approximate as floor(asleepMin / 90),
  // since each complete NREM-REM cycle averages ~90 minutes.
  let cycleCount = 0;
  let hasRem = false;
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].stage === 'rem') {
      hasRem = true;
      // Transition into rem: either the first segment, or the prior stage was not rem.
      if (i === 0 || stages[i - 1].stage !== 'rem') {
        cycleCount += 1;
      }
    }
  }
  if (!hasRem) {
    cycleCount = Math.max(0, Math.floor(asleepMin / 90));
  }

  // longestStretchMin: longest contiguous run of non-wake segments (in minutes).
  let longestStretchMs = 0;
  let curStretchMs = 0;
  for (const seg of stages) {
    if (seg.stage !== 'wake') {
      const startMs = new Date(seg.start_utc).getTime();
      const endMs = new Date(seg.end_utc).getTime();
      curStretchMs += endMs - startMs;
    } else {
      if (curStretchMs > longestStretchMs) longestStretchMs = curStretchMs;
      curStretchMs = 0;
    }
  }
  if (curStretchMs > longestStretchMs) longestStretchMs = curStretchMs;
  const longestStretchMin = round0(longestStretchMs / 60_000);

  // restorativePct = 100 * (deep + rem) / asleep.
  // High values indicate adequate slow-wave and REM sleep.
  const restorativePct = asleepMs > 0
    ? round1(clamp(100.0 * (deepMs + remMs) / asleepMs, 0, 100))
    : 0;

  return {
    timeInBedMin,
    asleepMin,
    sleepEfficiencyPct,
    sleepLatencyMin,
    wasoMin,
    disturbances,
    awakenings,
    cycleCount,
    longestStretchMin,
    restorativePct,
  };
}
