// HRV time-domain metrics ported from whoof/metrics.py.
//
// Standard published methods (Malik 1996, ESC/NASPE Task Force) so the
// numbers are interpretable on their own even though they won't match
// Whoop's proprietary scores exactly.

const MIN_BEATS_FOR_HRV = 5;

/**
 * Drop ectopic / artifact RR intervals.
 *
 * Standard guideline: discard any beat that differs from its predecessor
 * by more than 20%.
 *
 * @param {Iterable<number>} rrMs - RR intervals in milliseconds.
 * @returns {number[]} filtered RR intervals.
 */
export function filterRr(rrMs) {
  const arr = Array.from(rrMs ?? []).filter(
    (r) => typeof r === 'number' && Number.isFinite(r),
  );
  if (arr.length === 0) return [];

  // Physiological plausibility gate (250-2000 ms ≈ 30-240 bpm). Beats outside
  // this band are hardware artifacts, not heartbeats.
  const PLAUSIBLE_MIN = 250;
  const PLAUSIBLE_MAX = 2000;
  const plausible = arr.filter((r) => r >= PLAUSIBLE_MIN && r <= PLAUSIBLE_MAX);
  if (plausible.length === 0) return [];

  // Seed the Malik comparison with the median rather than the first beat. A
  // single implausible-but-in-band first interval (common right after a BLE
  // reconnect) would otherwise become the anchor and reject every subsequent
  // normal beat, collapsing the series to one element and nulling HRV.
  const sorted = [...plausible].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const out = [];
  for (const r of arr) {
    if (r < PLAUSIBLE_MIN || r > PLAUSIBLE_MAX) continue;
    const ref = out.length ? out[out.length - 1] : median;
    if (Math.abs(r - ref) / Math.max(ref, 1) <= 0.2) {
      out.push(r);
    }
  }
  return out;
}

/**
 * Root mean square of successive RR differences (ms).
 * The single most reported time-domain HRV index.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function rmssd(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  let sumSq = 0;
  const n = rr.length - 1;
  for (let i = 0; i < n; i++) {
    const d = rr[i + 1] - rr[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

/**
 * Standard deviation of NN intervals (ms). Population stdev to match
 * Python's `statistics.pstdev`.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function sdnn(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rr[i];
  const mean = sum / n;
  let sqAcc = 0;
  for (let i = 0; i < n; i++) {
    const dev = rr[i] - mean;
    sqAcc += dev * dev;
  }
  return Math.sqrt(sqAcc / n);
}

/**
 * Percentage of successive RR intervals differing by > 50 ms.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function pnn50(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length - 1;
  let over = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rr[i + 1] - rr[i]) > 50) over++;
  }
  return (100.0 * over) / n;
}
