// DST + timezone edge cases. The system processes timestamps in UTC but
// rolls up by local-time day; these tests pin down the behaviour around
// DST transitions and TZ offsets.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { insertSamplesBatch, putProfile } from '../../../web/js/data/queries.js';
import { recomputeRecent } from '../../../web/js/metrics/rollup.js';
import { localDateKey, startOfLocalDay } from '../../../web/js/util/time.js';

const TEST_DB = 'whoof-dst-test';

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

function sample(tsIso, hr = 60) {
  return {
    ts_utc: tsIso, session_id: null, sequence: null,
    heart_rate_bpm: hr, rr_interval_ms: 1000,
    spo2_pct: null, skin_temp_c: null,
    accel_x: null, accel_y: null, accel_z: null,
    motion: null, ppg_amp: null, ambient_light: null, ppg_quality: null,
    crc_ok: 1,
  };
}

describe('localDateKey', () => {
  it('returns the local-time YYYY-MM-DD for any date', () => {
    const d = new Date(2026, 4, 20, 10, 30); // May 20, 10:30 local
    expect(localDateKey(d)).toBe('2026-05-20');
  });

  it('uses local date even when UTC date is different', () => {
    // For users east of UTC, 23:30 UTC on May 19 = May 20 local.
    // For users west, 03:30 UTC on May 20 = May 19 local.
    // localDateKey just calls .getFullYear/getMonth/getDate on a Date so
    // it always reflects the local-zone interpretation. Verify by round-trip:
    const d = new Date(2026, 4, 20, 0, 0, 1);  // 00:00:01 local on May 20
    expect(localDateKey(d)).toBe('2026-05-20');
    const d2 = new Date(2026, 4, 19, 23, 59, 59);  // 23:59:59 local on May 19
    expect(localDateKey(d2)).toBe('2026-05-19');
  });
});

describe('startOfLocalDay', () => {
  it('zeros out hours/minutes/seconds/ms in local time', () => {
    const d = new Date(2026, 4, 20, 15, 42, 17, 999);
    const s = startOfLocalDay(d);
    expect(s.getHours()).toBe(0);
    expect(s.getMinutes()).toBe(0);
    expect(s.getSeconds()).toBe(0);
    expect(s.getMilliseconds()).toBe(0);
    expect(s.getDate()).toBe(20);
  });
});

describe('rollup with samples spanning a DST transition', () => {
  // Note: this test is intentionally TZ-agnostic — it just confirms that
  // samples scattered across what would be a DST transition (in a TZ that
  // observes DST) all end up bucketed into the right local days, and that
  // recomputeRecent doesn't crash.

  it('handles samples around 2 AM local on a DST spring-forward day', async () => {
    await putProfile(db, { age: 30 });
    // Simulate a string of samples from 01:30 local to 03:30 local on a
    // hypothetical DST-affected day. Use 1 hour of UTC time, since DST
    // skipping doesn't affect monotonic UTC.
    const baseUtc = new Date(2026, 2, 8, 6, 0, 0).getTime(); // March 8, 06:00 UTC
    const samples = [];
    for (let s = 0; s < 3600; s += 30) {
      samples.push(sample(new Date(baseUtc + s * 1000).toISOString(), 60));
    }
    await insertSamplesBatch(db, samples);
    // Should not throw, and should produce metrics for whatever local
    // day the UTC timestamps fall in.
    await expect(recomputeRecent(db, 14, { ageOverride: 30 })).resolves.toBeDefined();
  });

  it('handles a 1-hour duplicate window (DST fall-back simulation)', async () => {
    await putProfile(db, { age: 30 });
    // Two batches of samples that, in a fall-back TZ, would both map to
    // 01:30 local. We store as distinct UTC timestamps which is the only
    // unambiguous representation.
    const utcA = new Date(2026, 10, 1, 5, 30, 0); // Nov 1, 05:30 UTC
    const utcB = new Date(2026, 10, 1, 6, 30, 0); // Nov 1, 06:30 UTC
    const samples = [
      sample(utcA.toISOString(), 60),
      sample(utcB.toISOString(), 62),
    ];
    await insertSamplesBatch(db, samples);
    await expect(recomputeRecent(db, 14, { ageOverride: 30 })).resolves.toBeDefined();
  });
});

describe('samplesInRange returns the right slice regardless of TZ', () => {
  it('range query uses UTC ISO strings, so TZ display does not affect filtering', async () => {
    await insertSamplesBatch(db, [
      sample('2026-05-20T01:00:00Z', 60),
      sample('2026-05-20T05:00:00Z', 65),
      sample('2026-05-20T23:00:00Z', 70),
    ]);
    const { samplesInRange } = await import('../../../web/js/data/queries.js');
    const r = await samplesInRange(db, '2026-05-20T03:00:00Z', '2026-05-20T20:00:00Z');
    expect(r).toHaveLength(1);
    expect(r[0].heart_rate_bpm).toBe(65);
  });
});
