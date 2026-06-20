// End-to-end test: historical samples written to IndexedDB (as if they
// arrived via SEND_HISTORICAL_DATA) → recomputeRecent() rolls them up into
// daily_metrics → API reads them back. Exercises the full offline-sync
// chain without needing a real BLE strap.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import {
  insertSamplesBatch, putProfile, getDailyMetric, recentDailyMetrics,
} from '../../../web/js/data/queries.js';
import { recomputeRecent } from '../../../web/js/metrics/rollup.js';

const TEST_DB = 'whoof-backfill-test';

function freshDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

let db;
beforeEach(async () => {
  if (db) { try { db.close(); } catch {} db = null; }
  await freshDb();
  db = await openDb(TEST_DB);
});

/**
 * Synthesize 1 hour of HR samples (every 30 s = 120 samples) for a date,
 * with realistic HR + RR intervals. Models what would arrive from the strap
 * after a successful historical dump.
 */
function syntheticBackfillSamples(dateIso, hr = 60, rrMs = 1000) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const samples = [];
  for (let sec = 0; sec < 3600; sec += 30) {
    const ts = new Date(y, m - 1, d, 3, 0, sec).toISOString();  // 3 AM local — solidly in sleep window
    samples.push({
      ts_utc: ts, session_id: null, sequence: null,
      heart_rate_bpm: hr + (Math.random() - 0.5) * 2,
      rr_interval_ms: rrMs + Math.round((Math.random() - 0.5) * 40),
      spo2_pct: null, skin_temp_c: null,
      accel_x: null, accel_y: null, accel_z: null,
      motion: 0, ppg_amp: null, ambient_light: null, ppg_quality: null,
      crc_ok: 1,
    });
  }
  return samples;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('backfill → rollup chain', () => {
  it('rolls up samples written via the backfill path', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 72 });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateIso = isoDate(yesterday);

    await insertSamplesBatch(db, syntheticBackfillSamples(dateIso, 60, 1000));

    await recomputeRecent(db, 7, { ageOverride: 30 });

    const m = await getDailyMetric(db, dateIso);
    expect(m).toBeTruthy();
    // We put samples at 3 AM local, well inside the sleep window (02–06).
    expect(m.rmssd_ms).toBeGreaterThan(0);
    expect(m.resting_hr).toBeGreaterThan(40);
    expect(m.resting_hr).toBeLessThan(80);
  });

  it('multiple days of backfilled samples each get their own daily_metric row', async () => {
    await putProfile(db, { age: 30 });

    const days = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = isoDate(d);
      days.push(iso);
      await insertSamplesBatch(db, syntheticBackfillSamples(iso, 60 + i, 1000));
    }

    await recomputeRecent(db, 7);

    const recent = await recentDailyMetrics(db, 14);
    const datesInRollup = new Set(recent.map(r => r.date));
    for (const day of days) expect(datesInRollup.has(day)).toBe(true);
  });

  it('idempotent — running recomputeRecent twice yields the same row', async () => {
    await putProfile(db, { age: 30 });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateIso = isoDate(yesterday);
    await insertSamplesBatch(db, syntheticBackfillSamples(dateIso));

    await recomputeRecent(db, 7);
    const first = await getDailyMetric(db, dateIso);
    await recomputeRecent(db, 7);
    const second = await getDailyMetric(db, dateIso);

    expect(second.rmssd_ms).toBeCloseTo(first.rmssd_ms, 1);
    expect(second.resting_hr).toBe(first.resting_hr);
  });
});
