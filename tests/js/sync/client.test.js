// @vitest-environment node
// node env → real WebCrypto (crypto.subtle); fake-indexeddb/auto (setup.js)
// installs indexedDB globally regardless of env.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { deriveKey } from '../../../web/js/sync/crypto.js';
import { mergeSnapshot, sync } from '../../../web/js/sync/client.js';

const SYNC_ID = 'a'.repeat(64);
let key1;
let wrongKey;
beforeAll(async () => {
  key1 = await deriveKey('pass-one', SYNC_ID);
  wrongKey = await deriveKey('WRONG-pass', SYNC_ID);
});

let n = 0;
async function freshDb() {
  const name = `whoof-sync-test-${++n}`;
  await new Promise((r) => { const q = indexedDB.deleteDatabase(name); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  return openDb(name);
}
function put(db, store, row) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
function all(db, store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const sample = (ts, hr) => ({ ts_utc: ts, heart_rate_bpm: hr, sequence: 0 });

// In-memory fake R2 matching functions/api/sync.js semantics.
function makeServer() {
  let obj = null; // { buf, etag }
  let c = 0;
  const fetchImpl = async (_url, opts = {}) => {
    const method = opts.method || 'GET';
    const h = opts.headers || {};
    if (!/^Bearer [a-f0-9]{64}$/.test(h.Authorization || '')) return new Response('u', { status: 401 });
    if (method === 'GET') {
      return obj ? new Response(obj.buf, { status: 200, headers: { ETag: obj.etag } }) : new Response(null, { status: 404 });
    }
    if (method === 'PUT') {
      if (h['If-None-Match'] === '*' && obj) return new Response(null, { status: 412 });
      if (h['If-Match'] && (!obj || obj.etag !== h['If-Match'])) return new Response(null, { status: 412 });
      obj = { buf: new Uint8Array(opts.body), etag: `"e${++c}"` };
      return new Response(null, { status: 204, headers: { ETag: obj.etag } });
    }
    return new Response(null, { status: 405 });
  };
  return { fetchImpl, peek: () => obj };
}

describe('mergeSnapshot (append-only, natural keys)', () => {
  let db;
  beforeEach(async () => { db = await freshDb(); });

  it('inserts into an empty store', async () => {
    await mergeSnapshot(db, { samples: [sample('T1', 60), sample('T2', 61)] });
    expect((await all(db, 'samples')).length).toBe(2);
  });

  it('dedups samples by ts_utc#sequence, adds only new', async () => {
    await put(db, 'samples', sample('T1', 60)); // local id=1
    await mergeSnapshot(db, { samples: [{ id: 1, ...sample('T1', 99) }, sample('T2', 62)] });
    const rows = await all(db, 'samples');
    expect(rows.length).toBe(2); // T1 not duplicated, T2 added
    expect(rows.map((r) => r.ts_utc).sort()).toEqual(['T1', 'T2']);
  });

  it('strips incoming id so device-local ids never collide', async () => {
    await put(db, 'samples', sample('T1', 60)); // gets id=1
    await mergeSnapshot(db, { samples: [{ id: 1, ...sample('T9', 70) }] }); // same id, diff ts
    const rows = await all(db, 'samples');
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2); // distinct ids
  });

  it('upserts daily_metrics by date', async () => {
    await put(db, 'daily_metrics', { date: '2026-06-01', recovery_score: 50 });
    await mergeSnapshot(db, { daily_metrics: [{ date: '2026-06-01', recovery_score: 80 }] });
    const rows = await all(db, 'daily_metrics');
    expect(rows.length).toBe(1);
    expect(rows[0].recovery_score).toBe(80);
  });

  it('fills profile only when local is empty (never clobbers)', async () => {
    await mergeSnapshot(db, { profile: [{ id: 1, age: 30 }] });
    await mergeSnapshot(db, { profile: [{ id: 1, age: 40 }] }); // local non-empty → ignored
    const rows = await all(db, 'profile');
    expect(rows.length).toBe(1);
    expect(rows[0].age).toBe(30);
  });

  it('never deletes local-only records', async () => {
    await put(db, 'samples', sample('LOCAL', 50));
    await mergeSnapshot(db, { samples: [sample('REMOTE', 51)] });
    expect((await all(db, 'samples')).map((r) => r.ts_utc).sort()).toEqual(['LOCAL', 'REMOTE']);
  });
});

describe('sync (E2E pull → merge → push)', () => {
  it('first device pushes when remote is empty', async () => {
    const srv = makeServer();
    const db = await freshDb();
    await put(db, 'samples', sample('T1', 60));
    const r = await sync({ db, key: key1, syncId: SYNC_ID, fetchImpl: srv.fetchImpl });
    expect(r.status).toBe('ok');
    expect(srv.peek()).not.toBeNull(); // ciphertext stored
  });

  it('second device converges (gains the first device\'s data)', async () => {
    const srv = makeServer();
    const d1 = await freshDb();
    await put(d1, 'samples', sample('T1', 60));
    await sync({ db: d1, key: key1, syncId: SYNC_ID, fetchImpl: srv.fetchImpl });

    const d2 = await freshDb();
    await put(d2, 'samples', sample('T2', 62));
    await sync({ db: d2, key: key1, syncId: SYNC_ID, fetchImpl: srv.fetchImpl });
    expect((await all(d2, 'samples')).map((r) => r.ts_utc).sort()).toEqual(['T1', 'T2']);

    // d1 syncs again → gains T2.
    await sync({ db: d1, key: key1, syncId: SYNC_ID, fetchImpl: srv.fetchImpl });
    expect((await all(d1, 'samples')).map((r) => r.ts_utc).sort()).toEqual(['T1', 'T2']);
  });

  it('retries once on a concurrent-write 412 and still converges', async () => {
    const srv = makeServer();
    let injected = false;
    const flaky = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'PUT' && !injected) {
        injected = true;
        return new Response(null, { status: 412 }); // simulate another writer
      }
      return srv.fetchImpl(url, opts);
    };
    const db = await freshDb();
    await put(db, 'samples', sample('T1', 60));
    const r = await sync({ db, key: key1, syncId: SYNC_ID, fetchImpl: flaky });
    expect(r.status).toBe('ok');
    expect(srv.peek()).not.toBeNull();
  });

  it('wrong passphrase cannot decrypt the remote → sync rejects (load-bearing)', async () => {
    const srv = makeServer();
    const d1 = await freshDb();
    await put(d1, 'samples', sample('T1', 60));
    await sync({ db: d1, key: key1, syncId: SYNC_ID, fetchImpl: srv.fetchImpl });

    const d2 = await freshDb();
    await expect(sync({ db: d2, key: wrongKey, syncId: SYNC_ID, fetchImpl: srv.fetchImpl })).rejects.toThrow();
  });
});
