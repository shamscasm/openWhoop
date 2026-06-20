import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { STORES } from '../../../web/js/data/schema.js';

function freshDb(name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('openDb', () => {
  beforeEach(() => freshDb('whoof-test-db'));

  it('creates all declared object stores at version 1', async () => {
    const db = await openDb('whoof-test-db');
    const names = Array.from(db.objectStoreNames);
    for (const store of Object.keys(STORES)) {
      expect(names).toContain(store);
    }
    db.close();
  });

  it('creates indexes on the samples store', async () => {
    const db = await openDb('whoof-test-db');
    const tx = db.transaction('samples');
    const idx = Array.from(tx.objectStore('samples').indexNames);
    expect(idx).toContain('ts_utc');
    expect(idx).toContain('session_id');
    expect(idx).toContain('session_sequence');
    db.close();
  });

  it('round-trips one inserted record', async () => {
    const db = await openDb('whoof-test-db');
    const wtx = db.transaction('device_events', 'readwrite');
    wtx.objectStore('device_events').add({
      ts_utc: '2026-05-20T10:00:00Z',
      kind: 'connect',
      detail: 'aa:bb',
    });
    await new Promise((r) => (wtx.oncomplete = r));

    const rtx = db.transaction('device_events');
    const all = await new Promise((r) =>
      (rtx.objectStore('device_events').getAll().onsuccess = (e) => r(e.target.result))
    );
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('connect');
    db.close();
  });
});
