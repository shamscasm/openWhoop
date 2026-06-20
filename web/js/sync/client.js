// Cross-device sync client: pull → merge → push, all E2E-encrypted.
//
// The snapshot (everything except local-only `captures`) is encrypted in the
// browser (crypto.js) before it touches the network, and decrypted only here.
// The server (functions/api/sync.js) sees opaque ciphertext.
//
// Merge is APPEND-ONLY by NATURAL KEY, never by the stores' autoIncrement
// `id` — those ids are device-local, so merging by id would collide unrelated
// records across devices. Natural keys (timestamps, dates) are stable, and a
// Whoop strap only talks to one host at a time, so raw samples recorded on
// different devices are disjoint in time and union cleanly. Append-only means
// a sync can add records but never delete or overwrite local data → no loss.
//
// v1 limitation: edits to an ALREADY-synced record (e.g. renaming a workout,
// editing a journal note on a second device) do not propagate — only new
// records do. Propagating edits needs per-record updated_at; deferred.

import { openDb } from '../data/db.js';
import { STORES } from '../data/schema.js';
import { buildExportPayload } from '../data/export.js';
import { deriveKey, encryptJSON, decryptJSON } from './crypto.js';

const ENDPOINT = '/api/sync';
const CONFIG_KEY = 'whoof-sync';

// `captures` is local-only diagnostic data (raw packet dumps) — never synced.
export const SYNCABLE = Object.keys(STORES).filter((s) => s !== 'captures');

// Per-store merge strategy.
//   append: insert incoming rows whose natural key is new (id stripped so the
//           local store assigns a fresh one); existing rows untouched.
//   upsert: put by the store's stable keyPath (here: daily_metrics by `date`).
//   fill:   put incoming only if the local store is empty (singleton profile).
const MERGE = {
  samples:       { mode: 'append', key: (r) => `${r.ts_utc}#${r.sequence ?? 0}` },
  sessions:      { mode: 'append', key: (r) => `${r.started_at}` },
  device_events: { mode: 'append', key: (r) => `${r.ts_utc}#${r.kind ?? ''}` },
  sleep_stages:  { mode: 'append', key: (r) => `${r.date}#${r.start_utc}` },
  workouts:      { mode: 'append', key: (r) => `${r.start_utc ?? `${r.date}#${r.label ?? ''}`}` },
  daily_metrics: { mode: 'upsert' },
  journal:       { mode: 'append', key: (r) => `${r.date}` },
  profile:       { mode: 'fill' },
};

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putAll(db, store, rows) {
  return new Promise((resolve, reject) => {
    if (!rows.length) return resolve();
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    for (const row of rows) s.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Merge a decrypted remote snapshot into the local DB. Returns per-store counts
// of rows actually added. Never deletes or overwrites local records.
export async function mergeSnapshot(db, snapshot) {
  const stats = {};
  for (const store of SYNCABLE) {
    const incoming = Array.isArray(snapshot?.[store]) ? snapshot[store] : [];
    const cfg = MERGE[store];
    if (!cfg || !incoming.length) { stats[store] = 0; continue; }

    if (cfg.mode === 'upsert') {
      await putAll(db, store, incoming);
      stats[store] = incoming.length;
      continue;
    }
    if (cfg.mode === 'fill') {
      const existing = await getAll(db, store);
      if (!existing.length) { await putAll(db, store, incoming); stats[store] = incoming.length; }
      else stats[store] = 0;
      continue;
    }
    // append
    const existing = await getAll(db, store);
    const seen = new Set(existing.map(cfg.key));
    const fresh = [];
    for (const row of incoming) {
      const k = cfg.key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      const copy = { ...row };
      delete copy.id; // local store assigns a fresh autoIncrement id
      fresh.push(copy);
    }
    await putAll(db, store, fresh);
    stats[store] = fresh.length;
  }
  return stats;
}

// Local snapshot to upload (everything syncable; captures excluded).
async function buildSyncSnapshot(db) {
  const payload = await buildExportPayload(db);
  delete payload.captures;
  return payload;
}

// ---- network ------------------------------------------------------------

export async function pull(syncId, { fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  const res = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${syncId}` } });
  if (res.status === 404) return { exists: false, etag: null, blob: null };
  if (!res.ok) throw new Error(`sync pull failed: ${res.status}`);
  return { exists: true, etag: res.headers.get('ETag'), blob: new Uint8Array(await res.arrayBuffer()) };
}

export async function push(syncId, key, snapshot, etag, { fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  const blob = await encryptJSON(key, snapshot);
  const headers = { Authorization: `Bearer ${syncId}`, 'Content-Type': 'application/octet-stream' };
  if (etag) headers['If-Match'] = etag;
  else headers['If-None-Match'] = '*';
  const res = await fetchImpl(endpoint, { method: 'PUT', headers, body: blob });
  if (res.status === 412) return { ok: false, conflict: true };
  if (!res.ok) throw new Error(`sync push failed: ${res.status}`);
  return { ok: true, etag: res.headers.get('ETag') };
}

async function syncOnce({ db, key, syncId, fetchImpl }) {
  const pulled = await pull(syncId, { fetchImpl });
  let added = null;
  if (pulled.exists) {
    const remote = await decryptJSON(key, pulled.blob);
    added = await mergeSnapshot(db, remote);
  }
  const merged = await buildSyncSnapshot(db);
  const res = await push(syncId, key, merged, pulled.etag, { fetchImpl });
  return { res, added };
}

// Full bidirectional sync. On a concurrent-write conflict (412) re-pull, re-merge
// and retry once — the second pass incorporates whatever the other device wrote.
export async function sync({ db, key, syncId, fetchImpl = fetch }) {
  let { res, added } = await syncOnce({ db, key, syncId, fetchImpl });
  if (res.conflict) {
    ({ res, added } = await syncOnce({ db, key, syncId, fetchImpl }));
  }
  if (res.conflict) return { status: 'conflict', added };
  return { status: 'ok', etag: res.etag, added };
}

// ---- config + in-memory session key ------------------------------------
// syncId is persisted (it's an address, not the secret). The passphrase and
// derived key are NEVER persisted — the user unlocks per session.

export function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; } catch { return null; }
}
export function saveConfig(cfg) { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
export function clearConfig() { localStorage.removeItem(CONFIG_KEY); }

let _key = null;
let _syncId = null;

export async function unlock(passphrase, syncId) {
  _key = await deriveKey(passphrase, syncId);
  _syncId = syncId;
}
export function locked() { return !_key; }
export function lock() { _key = null; _syncId = null; }

export async function syncNow({ db = null, fetchImpl = fetch } = {}) {
  if (!_key || !_syncId) throw new Error('sync locked — unlock with passphrase first');
  return sync({ db: db ?? (await openDb()), key: _key, syncId: _syncId, fetchImpl });
}
