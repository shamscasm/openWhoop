import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { upsertDailyMetric } from '../../../web/js/data/queries.js';
import { exportAllToJson, importAllFromJson, buildExportPayload, exportJournalCsv, exportWorkoutsCsv } from '../../../web/js/data/export.js';
import { upsertJournalEntry, replaceWorkoutsForDate } from '../../../web/js/data/queries.js';

const TEST_DB = 'whoof-export-test';

function freshDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function getAll(d, store) {
  return new Promise((resolve, reject) => {
    const req = d.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let db;
beforeEach(async () => {
  if (db) { try { db.close(); } catch {} db = null; }
  await freshDb();
  db = await openDb(TEST_DB);
});

describe('buildExportPayload', () => {
  it('returns an object with version + every store', async () => {
    await upsertDailyMetric(db, { date: '2026-05-19', avg_hr: 70 });
    const data = await buildExportPayload(db);
    expect(data.version).toBe(1);
    expect(data.daily_metrics).toHaveLength(1);
    expect(data.daily_metrics[0].date).toBe('2026-05-19');
    expect(data).toHaveProperty('samples');
    expect(data).toHaveProperty('sessions');
    expect(data).toHaveProperty('profile');
  });
});

describe('exportAllToJson', () => {
  it('returns a non-empty Blob', async () => {
    await upsertDailyMetric(db, { date: '2026-05-19', avg_hr: 70 });
    const blob = await exportAllToJson(db);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(50); // at minimum the JSON shell
    expect(blob.type).toBe('application/json');
  });
});

describe('importAllFromJson', () => {
  it('imports rows and they round-trip via the same db', async () => {
    const payload = {
      version: 1,
      samples: [
        { id: 1, ts_utc: '2026-05-19T10:00:00Z', session_id: 1, sequence: 0,
          heart_rate_bpm: 70, rr_interval_ms: 800, spo2_pct: 98, skin_temp_c: 33,
          accel_x: 0, accel_y: 0, accel_z: 0, motion: 0,
          ppg_amp: 0, ambient_light: 0, ppg_quality: 0, crc_ok: 1 },
      ],
      sessions: [{ id: 1, started_at: '2026-05-19T10:00:00Z', ended_at: null, label: 't', notes: null, sample_count: 1 }],
      device_events: [],
      daily_metrics: [{ date: '2026-05-19', avg_hr: 70, recovery_score: 80 }],
      profile: [{ id: 1, age: 30 }],
      sleep_stages: [],
      workouts: [],
    };
    const result = await importAllFromJson(payload, db);
    expect(result.totalRows).toBe(4);

    const samples = await getAll(db, 'samples');
    const dm = await getAll(db, 'daily_metrics');
    const profile = await getAll(db, 'profile');
    expect(samples).toHaveLength(1);
    expect(samples[0].heart_rate_bpm).toBe(70);
    expect(dm[0].date).toBe('2026-05-19');
    expect(profile[0].age).toBe(30);
  });

  it('clears existing data before importing', async () => {
    await upsertDailyMetric(db, { date: '2026-01-01', avg_hr: 99 });
    await importAllFromJson({
      version: 1, samples: [], sessions: [], device_events: [],
      daily_metrics: [{ date: '2026-05-19', avg_hr: 70 }],
      profile: [], sleep_stages: [], workouts: [],
    }, db);
    const all = await getAll(db, 'daily_metrics');
    expect(all).toHaveLength(1);
    expect(all[0].date).toBe('2026-05-19');
  });

  it('rejects payloads with the wrong version', async () => {
    await expect(importAllFromJson({ version: 999 }, db)).rejects.toThrow(/version/);
  });

  it('rejects non-object payloads', async () => {
    await expect(importAllFromJson(null, db)).rejects.toThrow();
    await expect(importAllFromJson('hello', db)).rejects.toThrow();
  });
});

// happy-dom's Blob may not expose .text() — read via FileReader.
function blobToText(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

describe('exportWorkoutsCsv', () => {
  it('returns a Blob with header row when no workouts', async () => {
    const blob = await exportWorkoutsCsv(db);
    expect(blob).toBeInstanceOf(Blob);
    const text = await blobToText(blob);
    expect(text.startsWith('date,start_utc,duration_min')).toBe(true);
  });

  it('includes workouts sorted oldest-first with correct fields', async () => {
    await replaceWorkoutsForDate(db, '2026-05-19', [
      {
        date: '2026-05-19',
        start_utc: '2026-05-19T17:00:00Z',
        end_utc: '2026-05-19T18:00:00Z',
        duration_seconds: 3600,
        avg_hr: 145,
        max_hr: 180,
        strain: 14.5,
        calories: 620,
        zone_seconds: JSON.stringify([300, 600, 900, 1200, 600]),
        label: null,
        auto_detected: true,
      },
    ]);
    const blob = await exportWorkoutsCsv(db);
    const text = await blobToText(blob);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2); // header + 1 workout
    expect(lines[1]).toContain('2026-05-19');
    expect(lines[1]).toContain('60');   // duration_min = 3600 / 60
    expect(lines[1]).toContain('145');  // avg_hr
    expect(lines[1]).toContain('14.5'); // strain
  });
});

describe('exportJournalCsv', () => {
  it('returns a Blob with header row when no entries', async () => {
    const blob = await exportJournalCsv(db);
    expect(blob).toBeInstanceOf(Blob);
    const text = await blobToText(blob);
    expect(text.startsWith('date,tags,text')).toBe(true);
  });

  it('includes journal entries sorted oldest-first', async () => {
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'Long run', tags: ['hardworkout'] });
    await upsertJournalEntry(db, { date: '2026-05-18', text: 'Friday night', tags: ['alcohol', 'stress'] });
    const blob = await exportJournalCsv(db);
    const text = await blobToText(blob);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[1]).toContain('2026-05-18');
    expect(lines[1]).toContain('alcohol stress');
    expect(lines[2]).toContain('2026-05-20');
    expect(lines[2]).toContain('hardworkout');
  });

  it('escapes commas inside text field', async () => {
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'First, then second', tags: [] });
    const blob = await exportJournalCsv(db);
    const text = await blobToText(blob);
    expect(text).toContain('"First, then second"');
  });
});
