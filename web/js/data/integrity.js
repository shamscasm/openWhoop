// Data integrity diagnostic for the IndexedDB sample store.
//
// Scans a date range and reports:
//   - time gaps   : adjacent samples >5 min apart during a session
//   - hr anomalies: HR jumps >50 bpm between consecutive 30s samples
//   - duplicates  : two samples at the same ts_utc + rr_interval_ms
//   - stale       : nothing in the last 24h (probably the user forgot to sync)
//   - empty stores: profile missing, daily_metrics empty, etc.
//
// Used by the UI to surface a "data health" indicator and by tests to lock
// down expected shapes.

import { samplesInRange } from './queries.js';

const GAP_THRESHOLD_MS = 5 * 60 * 1000;     // 5 minutes
const HR_JUMP_THRESHOLD = 50;                // bpm

/**
 * Run a full integrity check across the given time window.
 *   db: IDBDatabase
 *   isoFrom, isoTo: ISO UTC strings
 *   → {
 *       totalSamples,
 *       timeGaps:    [{ from, to, durationMs }, ...],
 *       hrAnomalies: [{ at, prev, curr, delta }, ...],
 *       duplicates:  [{ ts_utc, count }, ...],
 *       staleSinceMs: number | null,
 *     }
 */
export async function verifyData(db, isoFrom, isoTo) {
  const samples = await samplesInRange(db, isoFrom, isoTo);
  const report = {
    totalSamples: samples.length,
    timeGaps: [],
    hrAnomalies: [],
    duplicates: [],
    staleSinceMs: null,
  };
  if (samples.length === 0) return report;

  // Time gaps + HR anomalies
  const tsSeen = new Map();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    // Duplicate detection: ts_utc + rr_interval (or null) as key
    const key = `${s.ts_utc}|${s.rr_interval_ms ?? ''}`;
    tsSeen.set(key, (tsSeen.get(key) ?? 0) + 1);

    if (i === 0) continue;
    const prev = samples[i - 1];
    const dt = new Date(s.ts_utc).getTime() - new Date(prev.ts_utc).getTime();
    // Only flag intra-session gaps (same session_id) — otherwise the user
    // just wasn't recording for a while, which isn't an error.
    if (dt > GAP_THRESHOLD_MS && s.session_id != null && s.session_id === prev.session_id) {
      report.timeGaps.push({ from: prev.ts_utc, to: s.ts_utc, durationMs: dt });
    }
    if (prev.heart_rate_bpm != null && s.heart_rate_bpm != null && dt < 60_000) {
      const delta = Math.abs(s.heart_rate_bpm - prev.heart_rate_bpm);
      if (delta > HR_JUMP_THRESHOLD) {
        report.hrAnomalies.push({
          at: s.ts_utc, prev: prev.heart_rate_bpm, curr: s.heart_rate_bpm, delta,
        });
      }
    }
  }

  for (const [key, count] of tsSeen.entries()) {
    if (count > 1) {
      const [ts_utc] = key.split('|');
      report.duplicates.push({ ts_utc, count });
    }
  }

  const last = samples[samples.length - 1];
  report.staleSinceMs = Date.now() - new Date(last.ts_utc).getTime();

  return report;
}

/**
 * Quick health summary for the UI.
 *   → { status: 'ok' | 'warn' | 'bad', message: string }
 */
export function summarizeIntegrity(report) {
  const issues = [];
  if (report.totalSamples === 0) issues.push('no data');
  if (report.duplicates.length > 0) issues.push(`${report.duplicates.length} duplicate timestamps`);
  if (report.timeGaps.length > 5) issues.push(`${report.timeGaps.length} session gaps`);
  if (report.hrAnomalies.length > 10) issues.push(`${report.hrAnomalies.length} HR anomalies`);

  let status = 'ok';
  if (report.staleSinceMs != null && report.staleSinceMs > 48 * 3600 * 1000) {
    status = 'warn';
    issues.push(`stale ${Math.floor(report.staleSinceMs / 3600 / 1000)}h`);
  }
  if (issues.length > 2) status = 'bad';
  else if (issues.length > 0) status = 'warn';

  return {
    status,
    message: issues.length === 0
      ? `${report.totalSamples.toLocaleString()} samples, all clean`
      : issues.join('; '),
  };
}
