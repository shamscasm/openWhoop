import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { insertSamplesBatch, getDailyMetric, putProfile, upsertDailyMetric } from '../../../web/js/data/queries.js';
import { rollupDay, rollupMissing } from '../../../web/js/metrics/rollup.js';

const TEST_DB = 'whoof-rollup-test';

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

// Build one synthetic day at 1-minute resolution (1,440 samples).
// medianDt picks 60s and scales zones/calories accordingly. The rollup
// orchestration is the unit under test; per-sample fidelity isn't needed.
function syntheticDay(dateIso, { restingHr = 60, peakHr = 140, peakHourLocal = 18, restRr = 1000 } = {}) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
  const SAMPLE_INTERVAL_S = 60;
  const out = [];
  const N = 24 * 60; // 1 sample per minute
  for (let i = 0; i < N; i++) {
    const t = new Date(startLocal.getTime() + i * SAMPLE_INTERVAL_S * 1000);
    const hour = t.getHours();
    let hr;
    if (hour < 7) hr = restingHr + 5;
    else if (hour === peakHourLocal) hr = peakHr;
    else hr = restingHr + 20;
    out.push({
      ts_utc: t.toISOString(),
      session_id: 1,
      sequence: i,
      heart_rate_bpm: hr,
      rr_interval_ms: hour < 7 ? restRr + (i % 2 ? 10 : -10) : null,
      spo2_pct: 98,
      skin_temp_c: 33.2,
      respiratory_rate: hour < 7 ? 14.1 : null,
      accel_x: 0, accel_y: 0, accel_z: 0,
      motion: hour < 7 ? 10 : 80,
      ppg_amp: 0, ambient_light: 0, ppg_quality: 0,
      crc_ok: 1,
    });
  }
  return out;
}

describe('rollupDay', () => {
  it('returns null for a date with no samples', async () => {
    const result = await rollupDay(db, '2026-05-20');
    expect(result).toBeNull();
  });

  it('produces a populated daily_metrics row from a synthetic day', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 75 });
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));

    const dm = await rollupDay(db, '2026-05-20');
    expect(dm).not.toBeNull();
    expect(dm.date).toBe('2026-05-20');
    expect(dm.sample_count).toBe(24 * 60);
    expect(dm.avg_hr).toBeGreaterThan(60);
    expect(dm.avg_hr).toBeLessThan(140);
    expect(dm.max_hr).toBeGreaterThanOrEqual(140);
    expect(dm.resting_hr).toBeGreaterThan(0);
    expect(dm.avg_spo2).toBeCloseTo(98, 0);
    expect(dm.avg_skin_temp_c).toBeCloseTo(33.2, 1);
    expect(dm.respiratory_rate).toBeCloseTo(14.1, 1);
    expect(dm.strain_score).toBeGreaterThanOrEqual(0);
    expect(dm.strain_score).toBeLessThanOrEqual(21);

    // Ported goose metrics are live in the rollup.
    expect(dm.zone_weighted_strain_score).toBeGreaterThanOrEqual(0);
    expect(dm.zone_weighted_strain_score).toBeLessThanOrEqual(21);
    // Weight (75 kg) is set, so the MET energy model runs.
    expect(dm.energy_kcal_resting).toBeGreaterThan(0);
    expect(dm.energy_kcal_active).toBeGreaterThanOrEqual(0);
    expect(dm.energy_kcal_total).toBeCloseTo(dm.energy_kcal_resting + dm.energy_kcal_active, 1);
    expect(dm.energy_bank_remaining).toBeGreaterThanOrEqual(0);
    // resp component is present (null until 3 days of respiratory baseline exist).
    expect(dm).toHaveProperty('recovery_resp_component');
  });

  it('populates WHOOP-parity metrics (vo2max, fitness age, whoop age, sleep architecture)', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 75 });
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));
    const dm = await rollupDay(db, '2026-05-20');

    // VO2max is derivable from resting HR whenever HR samples exist.
    expect(dm.vo2max).toBeGreaterThan(20);
    expect(dm.vo2max).toBeLessThanOrEqual(80);
    expect(typeof dm.vo2max_category).toBe('string');
    expect(dm.fitness_age).toBeGreaterThan(0);

    // WHOOP age needs >=2 signals; vo2max + resting + rmssd are all present.
    expect(dm.whoop_age).not.toBeNull();
    expect(dm.whoop_age).toBeGreaterThanOrEqual(18);
    expect(['low', 'medium', 'high']).toContain(dm.whoop_age_confidence);

    // New fields are always present (null when sleep/HRR can't be derived).
    expect(dm).toHaveProperty('sleep_efficiency_pct');
    expect(dm).toHaveProperty('waso_min');
    expect(dm).toHaveProperty('hrr60');
  });

  it('persists the metric so getDailyMetric returns it', async () => {
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));
    await rollupDay(db, '2026-05-20');
    const persisted = await getDailyMetric(db, '2026-05-20');
    expect(persisted).toBeTruthy();
    expect(persisted.date).toBe('2026-05-20');
    expect(persisted.computed_at).toBeTruthy();
  });

  it('uses ageOverride when profile lacks age', async () => {
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));
    const dm = await rollupDay(db, '2026-05-20', { ageOverride: 25 });
    expect(dm).not.toBeNull();
    // max_hr depends on age via max_hr_from_age; with younger age max is higher,
    // so strain calibration is different. Just confirm we got a value.
    expect(dm.strain_score).toBeGreaterThanOrEqual(0);
  });

  it('populates hrv_baseline_ms once 3 prior days with HRV data exist', async () => {
    // Seed 4 consecutive days. Each has RR intervals during sleep so rmssd is non-null.
    const days = ['2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20'];
    for (const d of days) await insertSamplesBatch(db, syntheticDay(d));
    // Roll up in order so each day has history from the previous ones.
    for (const d of days) await rollupDay(db, d);

    const dm17 = await getDailyMetric(db, '2026-05-17');
    const dm20 = await getDailyMetric(db, '2026-05-20');
    // Day 17 has no prior days → baseline should be null.
    expect(dm17.hrv_baseline_ms).toBeNull();
    // Day 20 has 3 prior days with HRV → baseline should be a positive number.
    expect(dm20.hrv_baseline_ms).toBeGreaterThan(0);
  });
});

describe('rollupMissing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only computes for dates that have samples and no existing metric', async () => {
    // Pin "today" so the seeded sample date stays inside rollupMissing's
    // `days`-wide lookback window. Without this the test rots — it silently
    // broke once the real clock drifted more than `days` past 2026-05-19.
    // Only Date is faked so fake-indexeddb's real timers/microtasks still run.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 20, 12, 0, 0)); // 2026-05-20, local

    // Seed only one day
    await insertSamplesBatch(db, syntheticDay('2026-05-19'));
    const computed = await rollupMissing(db, 7);
    // Should compute at least 2026-05-19 (other dates have no samples so they're skipped)
    const dates = computed.map((m) => m.date);
    expect(dates).toContain('2026-05-19');
    const firstCount = computed.length;

    // Running again should compute nothing more (already persisted)
    const again = await rollupMissing(db, 7);
    expect(again.length).toBe(0);
    // First-pass count was stable
    expect(firstCount).toBeGreaterThanOrEqual(1);
  });

  it('recomputes stale rows missing the current rollup fields', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 20, 12, 0, 0));

    await insertSamplesBatch(db, syntheticDay('2026-05-19'));
    await upsertDailyMetric(db, { date: '2026-05-19', rollup_version: 1, sleep_minutes: 123 });

    const computed = await rollupMissing(db, 7);
    expect(computed.map((m) => m.date)).toContain('2026-05-19');

    const updated = await getDailyMetric(db, '2026-05-19');
    expect(updated.rollup_version).toBe(2);
    expect(updated).toHaveProperty('steps_source');
    expect(updated).toHaveProperty('sleep_source');
  });
});
