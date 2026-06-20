import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { getProfile, putProfile } from '../../../web/js/data/queries.js';
import {
  parseWeightMeasurement, setWeightManually,
} from '../../../web/js/health/scale.js';

const TEST_DB = 'whoof-scale-test';

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

describe('parseWeightMeasurement', () => {
  it('decodes a 75.5 kg SI reading', () => {
    // flags=0 (SI, no extras), weight = 75500/200 res? No — spec: SI res = 0.005
    // So raw = 75.5 / 0.005 = 15100 = 0x3AFC
    const data = new Uint8Array([0x00, 0xFC, 0x3A]);
    const out = parseWeightMeasurement(data);
    expect(out.weightKg).toBeCloseTo(75.5, 2);
    expect(out.isImperial).toBe(false);
  });

  it('converts imperial lbs to kg', () => {
    // flags=1 (imperial), weight = 165 lb / 0.01 = 16500 = 0x4074
    const data = new Uint8Array([0x01, 0x74, 0x40]);
    const out = parseWeightMeasurement(data);
    expect(out.weightKg).toBeCloseTo(74.84, 1);
    expect(out.isImperial).toBe(true);
  });

  it('extracts timestamp when flag bit 1 is set', () => {
    // flags=2 (timestamp), weight, then 7-byte timestamp
    const data = new Uint8Array([
      0x02,                              // flags
      0xFC, 0x3A,                        // weight = 75.5 kg
      0xEA, 0x07,                        // year = 2026
      0x05, 0x14,                        // month=5, day=20
      0x08, 0x00, 0x00,                  // hh:mm:ss
    ]);
    const out = parseWeightMeasurement(data);
    expect(out.weightKg).toBeCloseTo(75.5, 2);
    expect(out.timestamp).toMatch(/2026-05-20/);
  });

  it('extracts BMI + height when flag bit 3 is set', () => {
    // flags=0x08, weight, bmi (24.5 → 245 = 0xF5 0x00), height (175 cm = 1750 mm = 0x06D6)
    const data = new Uint8Array([
      0x08,
      0xFC, 0x3A,                        // 75.5 kg
      0xF5, 0x00,                        // bmi = 24.5
      0xD6, 0x06,                        // height = 1750 mm
    ]);
    const out = parseWeightMeasurement(data);
    expect(out.bmi).toBeCloseTo(24.5, 1);
    expect(out.heightCm).toBeCloseTo(175, 0);
  });

  it('returns null for too-short buffers', () => {
    expect(parseWeightMeasurement(new Uint8Array([0]))).toBeNull();
    expect(parseWeightMeasurement(new Uint8Array([]))).toBeNull();
  });
});

describe('setWeightManually', () => {
  it('persists weight to profile', async () => {
    await setWeightManually(73.2, db);
    const p = await getProfile(db);
    expect(p.weight_kg).toBeCloseTo(73.2, 2);
  });

  it('preserves existing profile fields', async () => {
    await putProfile(db, { age: 30, sex: 'M' });
    await setWeightManually(73.2, db);
    const p = await getProfile(db);
    expect(p.age).toBe(30);
    expect(p.sex).toBe('M');
    expect(p.weight_kg).toBeCloseTo(73.2, 2);
  });

  it('rejects nonsense values', async () => {
    await expect(setWeightManually(0, db)).rejects.toThrow();
    await expect(setWeightManually(-5, db)).rejects.toThrow();
    await expect(setWeightManually(NaN, db)).rejects.toThrow();
    await expect(setWeightManually(600, db)).rejects.toThrow();
  });
});
