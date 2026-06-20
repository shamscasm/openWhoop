import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { getProfile, putProfile } from '../../../web/js/data/queries.js';
import {
  applySnapshotToProfile, fetchHealthSnapshot,
  readShortcutResult, buildIngestUrl,
} from '../../../web/js/health/sync.js';

const TEST_DB = 'whoof-health-test';

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
  // Reset fetch mocks
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchHealthSnapshot', () => {
  it('returns null when server is unreachable', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('fail')));
    const out = await fetchHealthSnapshot();
    expect(out).toBeNull();
  });

  it('returns null on 404', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
    expect(await fetchHealthSnapshot()).toBeNull();
  });

  it('returns parsed JSON on 200', async () => {
    const payload = { values: { weight_kg: 75.5 }, updated_at: '2026-05-20' };
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }));
    expect(await fetchHealthSnapshot()).toEqual(payload);
  });
});

describe('applySnapshotToProfile', () => {
  it('writes weight_kg into a new profile', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ values: { weight_kg: 72.3 } }),
    }));
    const merged = await applySnapshotToProfile(db);
    expect(merged.weight_kg).toBeCloseTo(72.3, 2);
    const p = await getProfile(db);
    expect(p.weight_kg).toBeCloseTo(72.3, 2);
  });

  it('preserves existing fields when merging', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 70 });
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ values: { weight_kg: 72.5 } }),
    }));
    const merged = await applySnapshotToProfile(db);
    expect(merged.age).toBe(30);
    expect(merged.sex).toBe('M');
    expect(merged.weight_kg).toBeCloseTo(72.5, 2);
  });

  it('returns existing profile unchanged when snapshot has no new values', async () => {
    await putProfile(db, { age: 30, weight_kg: 70 });
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ values: { weight_kg: 70 } }),
    }));
    const out = await applySnapshotToProfile(db);
    expect(out.weight_kg).toBe(70);
    expect(out.age).toBe(30);
  });
});

describe('readShortcutResult', () => {
  const originalLocation = window.location;
  const originalHistory = window.history;

  beforeEach(() => {
    // jsdom allows mutating href via the URL setter on history.replaceState
    history.replaceState({}, '', '/?weight_from_shortcut=78.2');
  });

  it('reads and persists the weight from the URL', async () => {
    const out = await readShortcutResult(db);
    expect(out).toBeCloseTo(78.2, 2);
    const p = await getProfile(db);
    expect(p.weight_kg).toBeCloseTo(78.2, 2);
  });

  it('clears the URL after reading', async () => {
    await readShortcutResult(db);
    expect(new URL(window.location.href).searchParams.get('weight_from_shortcut')).toBeNull();
  });

  it('rejects out-of-range values', async () => {
    history.replaceState({}, '', '/?weight_from_shortcut=600');
    const out = await readShortcutResult(db);
    expect(out).toBeNull();
  });

  it('converts pounds to kg when weight_unit=lb', async () => {
    history.replaceState({}, '', '/?weight_from_shortcut=154.32&weight_unit=lb');
    const out = await readShortcutResult(db);
    expect(out).toBeCloseTo(70, 0);
    const p = await getProfile(db);
    expect(p.weight_kg).toBeCloseTo(70, 0);
    // both params are stripped from the URL afterwards
    expect(new URL(window.location.href).searchParams.get('weight_unit')).toBeNull();
  });

  it('returns null when no shortcut param is present', async () => {
    history.replaceState({}, '', '/');
    const out = await readShortcutResult(db);
    expect(out).toBeNull();
  });
});

describe('buildIngestUrl', () => {
  it('produces a URL ending in /api/health/ingest', () => {
    const url = buildIngestUrl();
    expect(url).toMatch(/\/api\/health\/ingest$/);
    expect(url.startsWith('http://')).toBe(true);
  });
});
