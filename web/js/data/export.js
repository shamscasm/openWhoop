// Export / import all IndexedDB stores as a single JSON blob.
// Versioned so future schema changes can migrate on import.

import { openDb } from './db.js';
import { STORES } from './schema.js';

const EXPORT_VERSION = 1;

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function clearStore(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

export async function buildExportPayload(db = null) {
  const d = db ?? (await openDb());
  const payload = {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
  };
  for (const store of Object.keys(STORES)) {
    payload[store] = await getAll(d, store);
  }
  return payload;
}

export async function exportAllToJson(db = null) {
  const payload = await buildExportPayload(db);
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

// ---- CSV exports -----------------------------------------------------------

function csvRow(values) {
  return values.map((v) => {
    if (v == null) return '';
    const s = String(v);
    // Quote if value contains comma, quote, or newline.
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

/**
 * Export the samples store as CSV.
 * Columns: ts_utc, heart_rate_bpm, rr_interval_ms, spo2_pct, skin_temp_c,
 *          accel_x, accel_y, accel_z, session_id
 */
export async function exportSamplesCsv(db = null) {
  const d = db ?? (await openDb());
  const rows = await getAll(d, 'samples');
  const header = 'ts_utc,heart_rate_bpm,rr_interval_ms,spo2_pct,skin_temp_c,accel_x,accel_y,accel_z,session_id';
  const lines = [header];
  for (const r of rows) {
    lines.push(csvRow([
      r.ts_utc, r.heart_rate_bpm, r.rr_interval_ms,
      r.spo2_pct, r.skin_temp_c,
      r.accel_x, r.accel_y, r.accel_z,
      r.session_id ?? '',
    ]));
  }
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

/**
 * Export daily_metrics as CSV.
 * All numeric columns included; zone_minutes is expanded into zone_min_1…5.
 */
export async function exportDailyMetricsCsv(db = null) {
  const d = db ?? (await openDb());
  const rows = await getAll(d, 'daily_metrics');
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const header = [
    'date', 'avg_hr', 'min_hr', 'max_hr', 'resting_hr',
    'rmssd_ms', 'sdnn_ms', 'pnn50_pct', 'hrv_baseline_ms',
    'avg_spo2', 'avg_skin_temp_c', 'skin_temp_deviation_c',
    'strain_score', 'recovery_score',
    'recovery_hrv_component', 'recovery_rhr_component',
    'recovery_sleep_component', 'recovery_strain_component',
    'sleep_minutes', 'deep_sleep_minutes', 'rem_sleep_minutes',
    'light_sleep_minutes', 'wake_minutes',
    'sleep_need_minutes', 'sleep_performance_pct',
    'sleep_debt_minutes', 'sleep_consistency_pct',
    'respiratory_rate', 'stress_avg', 'calories',
    'zone_min_1', 'zone_min_2', 'zone_min_3', 'zone_min_4', 'zone_min_5',
    'bedtime_local', 'wake_local',
  ].join(',');
  const lines = [header];
  for (const r of rows) {
    const z = Array.isArray(r.zone_minutes) ? r.zone_minutes : [null, null, null, null, null];
    lines.push(csvRow([
      r.date, r.avg_hr, r.min_hr, r.max_hr, r.resting_hr,
      r.rmssd_ms, r.sdnn_ms, r.pnn50_pct, r.hrv_baseline_ms,
      r.avg_spo2, r.avg_skin_temp_c, r.skin_temp_deviation_c,
      r.strain_score, r.recovery_score,
      r.recovery_hrv_component, r.recovery_rhr_component,
      r.recovery_sleep_component, r.recovery_strain_component,
      r.sleep_minutes, r.deep_sleep_minutes, r.rem_sleep_minutes,
      r.light_sleep_minutes, r.wake_minutes,
      r.sleep_need_minutes, r.sleep_performance_pct,
      r.sleep_debt_minutes, r.sleep_consistency_pct,
      r.respiratory_rate, r.stress_avg, r.calories,
      z[0], z[1], z[2], z[3], z[4],
      r.bedtime_local, r.wake_local,
    ]));
  }
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

/**
 * Export journal entries as CSV.
 * Columns: date, tags, text
 */
export async function exportJournalCsv(db = null) {
  const d = db ?? (await openDb());
  const rows = await getAll(d, 'journal');
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const lines = ['date,tags,text'];
  for (const r of rows) {
    lines.push(csvRow([
      r.date,
      (r.tags ?? []).join(' '),
      r.text ?? '',
    ]));
  }
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

export async function exportWorkoutsCsv(db = null) {
  const d = db ?? (await openDb());
  const rows = await getAll(d, 'workouts');
  rows.sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1));
  const lines = ['date,start_utc,duration_min,avg_hr,max_hr,strain,calories,zone1_min,zone2_min,zone3_min,zone4_min,zone5_min,label'];
  for (const r of rows) {
    const durMin = r.duration_seconds != null ? Math.round(r.duration_seconds / 60 * 10) / 10 : '';
    let zones = [0, 0, 0, 0, 0];
    if (r.zone_seconds) {
      try {
        const zs = typeof r.zone_seconds === 'string' ? JSON.parse(r.zone_seconds) : r.zone_seconds;
        zones = zs.map((s) => Math.round(s / 60 * 10) / 10);
      } catch { /* ignore malformed */ }
    }
    lines.push(csvRow([
      r.date ?? '',
      r.start_utc ?? '',
      durMin,
      r.avg_hr != null ? Math.round(r.avg_hr) : '',
      r.max_hr != null ? Math.round(r.max_hr) : '',
      r.strain != null ? r.strain.toFixed(1) : '',
      r.calories != null ? Math.round(r.calories) : '',
      ...zones,
      r.label ?? '',
    ]));
  }
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

export async function importAllFromJson(payload, db = null) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Import payload is not an object');
  }
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${payload.version} (expected ${EXPORT_VERSION})`);
  }
  const d = db ?? (await openDb());
  // Overwrite all syncable stores inside ONE readwrite transaction so an
  // interrupted import rolls back completely instead of leaving some stores
  // cleared-but-not-refilled. 'captures' (raw BLE frames) is excluded so a
  // restore never destroys local capture history absent from the export.
  const stores = Object.keys(STORES).filter((s) => s !== 'captures');
  let totalRows = 0;
  await new Promise((resolve, reject) => {
    const tx = d.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('import transaction aborted'));
    for (const store of stores) {
      const os = tx.objectStore(store);
      os.clear();
      const rows = Array.isArray(payload[store]) ? payload[store] : [];
      for (const row of rows) os.put(row);
      totalRows += rows.length;
    }
  });
  return { totalRows };
}
