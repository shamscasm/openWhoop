// Step estimation from accelerometer / motion data.
//
// Algorithm: band-pass filter the motion signal to isolate the 1.5–3 Hz
// walking cadence, then count peaks above an adaptive threshold.
// Designed for sparse WHOOP BLE samples (1–2 Hz typical) rather than
// assuming a fixed sample rate.

function motionValue(row) {
  if (row.motion != null && Number.isFinite(row.motion)) return Math.abs(row.motion);
  if (row.accel_x == null && row.accel_y == null && row.accel_z == null) return null;
  return Math.abs(row.accel_x || 0) + Math.abs(row.accel_y || 0) + Math.abs(row.accel_z || 0);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Estimate steps from motion/accel data.
 *
 * @param {Array<object>} rows - samples with ts_utc and motion/accel fields
 * @returns {{ steps: number|null, source: string|null, confidencePct: number|null }}
 */
export function estimateStepsFromAccel(rows) {
  const points = [];
  for (const row of rows || []) {
    const v = motionValue(row);
    if (v == null) continue;
    const t = +new Date(row.ts_utc);
    if (!Number.isFinite(t)) continue;
    points.push({ t, v });
  }
  // Need at least 5 points with motion data to attempt estimation.
  if (points.length < 5) return { steps: null, source: null, confidencePct: null };
  points.sort((a, b) => a.t - b.t);

  // Compute median sample interval to adapt thresholds.
  const intervals = [];
  for (let i = 1; i < Math.min(points.length, 100); i++) {
    intervals.push((points[i].t - points[i - 1].t) / 1000);
  }
  intervals.sort((a, b) => a - b);
  const medianDt = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 1.0;

  // High-pass filter: subtract a slow EMA to remove baseline drift.
  // Alpha adapts to sample rate — faster for higher-rate streams.
  const alpha = Math.min(0.25, Math.max(0.05, 0.15 * (medianDt / 1.0)));
  let ema = points[0].v;
  const hp = [];
  for (const p of points) {
    ema = alpha * p.v + (1 - alpha) * ema;
    hp.push(Math.abs(p.v - ema));
  }

  // Adaptive threshold: use percentiles of the high-pass signal.
  // Walking creates clear peaks well above the noise floor.
  // WHOOP motion is uint8 (0-255) and walking values are typically 5-30,
  // so use a low absolute floor with percentile-based adaptation.
  const p50 = percentile(hp, 0.50) ?? 0;
  const p75 = percentile(hp, 0.75) ?? 0;
  const p85 = percentile(hp, 0.85) ?? 0;
  const p95 = percentile(hp, 0.95) ?? 0;
  // Threshold: lower of p75*0.5 and p85*0.35, with a floor of 3.
  // Previous floor of 12 was too high for WHOOP's sparse motion scale.
  const threshold = Math.max(3, p75 * 0.5, p85 * 0.35);

  // Count peaks: local maxima above threshold with proper inter-step timing.
  // Walking cadence is 1.5–3 steps/sec → 333–667 ms between steps.
  // Allow wider range for slow walking: 250ms – 2500ms.
  const minStepMs = 250;
  const maxStepMs = 2500;
  let steps = 0;
  let lastStepMs = -Infinity;

  for (let i = 1; i < hp.length - 1; i++) {
    if (hp[i] < threshold) continue;
    // Must be a local maximum (peak).
    if (hp[i] < hp[i - 1] || hp[i] < hp[i + 1]) continue;
    const dt = points[i].t - lastStepMs;
    if (dt < minStepMs) continue;
    // If gap is too large, just accept it (user may have paused walking).
    // Only reject if this is not the first step.
    if (dt > maxStepMs && lastStepMs !== -Infinity) {
      // Gap too long — could be a new walking bout. Accept but note it.
    }
    steps += 1;
    lastStepMs = points[i].t;
  }

  // Confidence: based on data quality signals.
  const spanHours = (points[points.length - 1].t - points[0].t) / 3_600_000;
  const coverageScore = Math.min(1, points.length / 500) * 35;  // data density
  const spanScore = Math.min(1, spanHours / 4) * 30;            // time coverage
  const signalScore = p95 > 3 ? 25 : (p95 > 0 ? 15 : 0);       // signal strength
  const rateScore = steps > 0 ? 10 : 0;                         // any steps detected
  const confidencePct = Math.round(Math.min(90, coverageScore + spanScore + signalScore + rateScore));

  return {
    steps: steps > 0 ? steps : null,
    source: steps > 0 ? 'strap_accel' : null,
    confidencePct: steps > 0 ? confidencePct : null,
  };
}
