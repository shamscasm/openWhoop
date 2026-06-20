// IndexedDB connection helper. Single function: openDb().
// Creates / upgrades the schema declared in schema.js.

import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export function openDb(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      // The versionchange transaction lets us reach stores that already exist
      // so a version bump can add new indexes to them, not only create new
      // stores. The previous version skipped existing stores entirely, so any
      // index added in a later schema version was silently never created.
      const tx = req.transaction;
      for (const [storeName, def] of Object.entries(STORES)) {
        const store = db.objectStoreNames.contains(storeName)
          ? tx.objectStore(storeName)
          : db.createObjectStore(storeName, {
            keyPath: def.keyPath,
            autoIncrement: !!def.autoIncrement,
          });
        for (const idx of def.indexes) {
          const [idxName, keyPath] = idx;
          if (!store.indexNames.contains(idxName)) {
            store.createIndex(idxName, keyPath ?? idxName);
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
