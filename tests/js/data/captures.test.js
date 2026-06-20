import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import {
  saveCapture, listCaptures, getCapture, deleteCapture,
} from '../../../web/js/data/queries.js';

const TEST_DB = 'whoof-captures-test';

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

describe('captures store', () => {
  it('round-trips save → list → get → delete', async () => {
    await saveCapture(db, {
      label: 'walking',
      created_at: '2026-05-20T12:00:00Z',
      duration_ms: 60_000,
      row_count: 1200,
      capped: false,
      ndjson_text: '{"_meta":{"label":"walking"}}\n{"kind":"realtime","hex":"abcd"}',
    });
    await saveCapture(db, {
      label: 'still',
      created_at: '2026-05-20T13:00:00Z',
      duration_ms: 30_000,
      row_count: 600,
      capped: false,
      ndjson_text: '...',
    });

    const list = await listCaptures(db);
    expect(list).toHaveLength(2);
    // Newest first
    expect(list[0].label).toBe('still');
    expect(list[1].label).toBe('walking');
    // ndjson_text stripped from list
    expect(list[0].ndjson_text).toBeUndefined();
    expect(list[0].row_count).toBe(600);

    const full = await getCapture(db, list[1].id);
    expect(full.label).toBe('walking');
    expect(full.ndjson_text).toContain('realtime');

    await deleteCapture(db, list[1].id);
    expect(await listCaptures(db)).toHaveLength(1);
  });

  it('empty list when none saved', async () => {
    expect(await listCaptures(db)).toEqual([]);
  });
});
