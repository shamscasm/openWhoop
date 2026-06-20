// Tests for journal IndexedDB queries (DB version 3).

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { upsertJournalEntry, journalForDate, recentJournalEntries } from '../../../web/js/data/queries.js';

const TEST_DB = 'whoof-journal-test';

function freshDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

let db;
beforeEach(async () => {
  if (db) { try { db.close(); } catch {} db = null; }
  await freshDb();
  db = await openDb(TEST_DB);
});

describe('upsertJournalEntry', () => {
  it('saves and retrieves a journal entry', async () => {
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'Long run today', tags: ['hardworkout'] });
    const e = await journalForDate(db, '2026-05-20');
    expect(e).not.toBeNull();
    expect(e.text).toBe('Long run today');
    expect(e.tags).toEqual(['hardworkout']);
  });

  it('replaces existing entry for same date (one-per-day semantics)', async () => {
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'First note', tags: ['stress'] });
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'Updated note', tags: ['alcohol', 'stress'] });
    const e = await journalForDate(db, '2026-05-20');
    expect(e.text).toBe('Updated note');
    expect(e.tags).toContain('alcohol');
  });

  it('returns null for a date with no entry', async () => {
    const e = await journalForDate(db, '2026-01-01');
    expect(e).toBeNull();
  });

  it('stores empty tags array', async () => {
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'No tags', tags: [] });
    const e = await journalForDate(db, '2026-05-20');
    expect(e.tags).toEqual([]);
  });
});

describe('recentJournalEntries', () => {
  it('returns entries sorted newest first', async () => {
    await upsertJournalEntry(db, { date: '2026-05-18', text: 'three days ago', tags: [] });
    await upsertJournalEntry(db, { date: '2026-05-20', text: 'today', tags: [] });
    await upsertJournalEntry(db, { date: '2026-05-19', text: 'yesterday', tags: [] });
    const entries = await recentJournalEntries(db, 10);
    expect(entries[0].date).toBe('2026-05-20');
    expect(entries[1].date).toBe('2026-05-19');
    expect(entries[2].date).toBe('2026-05-18');
  });

  it('respects the limit parameter', async () => {
    for (let i = 1; i <= 10; i++) {
      await upsertJournalEntry(db, { date: `2026-05-${String(i).padStart(2, '0')}`, text: `Day ${i}`, tags: [] });
    }
    const entries = await recentJournalEntries(db, 3);
    expect(entries).toHaveLength(3);
  });

  it('returns empty array when no entries', async () => {
    const entries = await recentJournalEntries(db, 7);
    expect(entries).toEqual([]);
  });
});
