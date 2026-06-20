import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { insertSamplesBatch } from '../../../web/js/data/queries.js';
import { verifyData, summarizeIntegrity } from '../../../web/js/data/integrity.js';

const TEST_DB = 'whoof-integrity-test';

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

function sample(ts, hr, sessionId = 1, rr = null) {
  return {
    ts_utc: ts, session_id: sessionId, sequence: null,
    heart_rate_bpm: hr, rr_interval_ms: rr,
    spo2_pct: null, skin_temp_c: null,
    accel_x: null, accel_y: null, accel_z: null,
    motion: null, ppg_amp: null, ambient_light: null, ppg_quality: null,
    crc_ok: 1,
  };
}

describe('verifyData', () => {
  it('returns empty report for empty store', async () => {
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.totalSamples).toBe(0);
    expect(r.timeGaps).toEqual([]);
    expect(r.hrAnomalies).toEqual([]);
  });

  it('detects a >5min gap inside a single session', async () => {
    await insertSamplesBatch(db, [
      sample('2026-05-20T03:00:00Z', 60),
      sample('2026-05-20T03:00:30Z', 61),
      sample('2026-05-20T03:08:00Z', 62),   // 7.5 min gap
      sample('2026-05-20T03:08:30Z', 63),
    ]);
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.timeGaps).toHaveLength(1);
    expect(r.timeGaps[0].durationMs).toBe(450_000); // 7.5 min
  });

  it('does NOT flag gaps across different sessions', async () => {
    await insertSamplesBatch(db, [
      sample('2026-05-20T03:00:00Z', 60, 1),
      sample('2026-05-20T05:00:00Z', 61, 2),  // different session
    ]);
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.timeGaps).toEqual([]);
  });

  it('flags HR jumps > 50 bpm in <60s', async () => {
    await insertSamplesBatch(db, [
      sample('2026-05-20T03:00:00Z', 60),
      sample('2026-05-20T03:00:30Z', 130),  // +70 jump
    ]);
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.hrAnomalies).toHaveLength(1);
    expect(r.hrAnomalies[0].delta).toBe(70);
  });

  it('detects duplicate timestamps', async () => {
    await insertSamplesBatch(db, [
      sample('2026-05-20T03:00:00Z', 60, 1, 1000),
      sample('2026-05-20T03:00:00Z', 60, 1, 1000),  // exact duplicate
    ]);
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0].count).toBe(2);
  });

  it('different RR intervals at same timestamp are NOT duplicates', async () => {
    // This is the normal multi-RR-per-packet case.
    await insertSamplesBatch(db, [
      sample('2026-05-20T03:00:00Z', 60, 1, 1000),
      sample('2026-05-20T03:00:00Z', 60, 1, 990),
    ]);
    const r = await verifyData(db, '2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    expect(r.duplicates).toEqual([]);
  });

  it('reports staleSinceMs based on last sample', async () => {
    await insertSamplesBatch(db, [sample('2026-01-01T00:00:00Z', 60)]);
    const r = await verifyData(db, '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(r.staleSinceMs).toBeGreaterThan(0);
  });
});

describe('summarizeIntegrity', () => {
  it('ok when nothing is wrong', () => {
    const out = summarizeIntegrity({
      totalSamples: 1000, timeGaps: [], hrAnomalies: [], duplicates: [], staleSinceMs: 60_000,
    });
    expect(out.status).toBe('ok');
    expect(out.message).toMatch(/clean/);
  });

  it('warn for stale data', () => {
    const out = summarizeIntegrity({
      totalSamples: 1000, timeGaps: [], hrAnomalies: [], duplicates: [],
      staleSinceMs: 72 * 3600 * 1000,
    });
    expect(out.status).toBe('warn');
    expect(out.message).toMatch(/stale/);
  });

  it('bad for many issues', () => {
    const out = summarizeIntegrity({
      totalSamples: 1000,
      timeGaps: Array.from({ length: 20 }),
      hrAnomalies: Array.from({ length: 20 }),
      duplicates: [{ count: 2 }],
      staleSinceMs: 72 * 3600 * 1000,
    });
    expect(out.status).toBe('bad');
  });
});
