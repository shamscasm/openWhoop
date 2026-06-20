// Apple Health bridge for the phone-only deployment (no Mac in the loop).
//
// Two privacy-preserving import paths, both 100% client-side — no server ever
// sees the data, and every imported value rides the existing E2E sync
// (sync/client.js) to the user's other devices:
//
//   1. Shortcut → URL fragment.  An Apple Shortcut reads HealthKit samples and
//      opens  https://<host>/#health=<base64url(JSON)> .  The fragment after
//      '#' is never transmitted over the network, so the browser reads
//      location.hash, decodes it here, and merges into profile / daily series.
//      This generalises the single-weight readShortcutResult() in health/sync.js
//      to a rich, multi-metric payload.
//
//   2. "Export All Health Data" → export.xml.  The user picks the file; we
//      stream-parse its <Record> elements with a regex.  The export can be
//      hundreds of MB, so DOMParser is not viable — a forward scan over the
//      text keeps memory flat.  Used for one-shot historical backfill.
//
// Pure functions (parse / normalise) take strings in and return plain data so
// they're trivially testable.  The only DB-touching helper, applyHealthToProfile,
// is a thin additive merge over the existing `profile` store.

import { openDb } from '../data/db.js';
import { getDailyMetric, getProfile, putProfile, upsertDailyMetric } from '../data/queries.js';

// HealthKit quantity-type identifiers → our canonical keys.
// Reference: https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
export const HK_TYPE_MAP = Object.freeze({
  HKQuantityTypeIdentifierBodyMass:                  'weight_kg',
  HKQuantityTypeIdentifierHeight:                    'height_cm',
  HKQuantityTypeIdentifierRestingHeartRate:          'resting_hr',
  HKQuantityTypeIdentifierVO2Max:                    'vo2_max',
  HKQuantityTypeIdentifierRespiratoryRate:           'respiratory_rate',
  HKQuantityTypeIdentifierOxygenSaturation:          'blood_oxygen',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN:  'hrv_sdnn_ms',
  HKQuantityTypeIdentifierStepCount:                 'steps',
  HKQuantityTypeIdentifierActiveEnergyBurned:        'active_energy_kcal',
  HKQuantityTypeIdentifierBodyMassIndex:             'bmi',
  HKQuantityTypeIdentifierBodyFatPercentage:         'body_fat_pct',
});

// Friendly names emitted by Apple Shortcuts / Health Auto Export → canonical key.
// Lower-cased on lookup so "Body Mass", "body mass", "BODY MASS" all hit.
export const FRIENDLY_NAME_MAP = Object.freeze({
  'body mass': 'weight_kg',
  'weight': 'weight_kg',
  'body weight': 'weight_kg',
  'height': 'height_cm',
  'resting heart rate': 'resting_hr',
  'vo2 max': 'vo2_max',
  'vo2max': 'vo2_max',
  'cardio fitness': 'vo2_max',
  'respiratory rate': 'respiratory_rate',
  'breathing rate': 'respiratory_rate',
  'oxygen saturation': 'blood_oxygen',
  'blood oxygen': 'blood_oxygen',
  'spo2': 'blood_oxygen',
  'heart rate variability': 'hrv_sdnn_ms',
  'hrv': 'hrv_sdnn_ms',
  'step count': 'steps',
  'steps': 'steps',
  'active energy': 'active_energy_kcal',
  'active energy burned': 'active_energy_kcal',
  'body mass index': 'bmi',
  'bmi': 'bmi',
  'body fat percentage': 'body_fat_pct',
});

// Plausibility bounds per canonical key. Out-of-range values are dropped so a
// mis-typed Shortcut or a stray export row can't corrupt the profile.
const BOUNDS = Object.freeze({
  weight_kg:          [20, 400],
  height_cm:          [50, 260],
  resting_hr:         [25, 120],
  vo2_max:            [10, 90],
  respiratory_rate:   [4, 40],
  blood_oxygen:       [50, 100],
  hrv_sdnn_ms:        [2, 400],
  steps:              [0, 200000],
  active_energy_kcal: [0, 20000],
  bmi:                [8, 80],
  body_fat_pct:       [1, 70],
});

// Profile fields we let Apple Health populate (the rest are daily/series data).
export const PROFILE_KEYS = Object.freeze(['weight_kg', 'height_cm', 'resting_hr', 'vo2_max']);

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const KJ_TO_KCAL = 0.239006;

/**
 * Convert a raw (value, unit) for a canonical key into our canonical unit.
 * Tolerant of the various unit spellings Apple / HAE emit.
 *
 * @param {string} key   canonical key (e.g. 'weight_kg')
 * @param {number} value
 * @param {string} [unit] free-form unit string
 * @returns {number} value in canonical units
 */
export function normalizeUnit(key, value, unit = '') {
  const u = String(unit).toLowerCase().trim();
  let v = value;
  switch (key) {
    case 'weight_kg':
      if (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds') v *= LB_TO_KG;
      else if (u === 'g') v *= 0.001;
      else if (u === 'st' || u === 'stone') v *= 6.35029;
      break;
    case 'height_cm':
      if (u === 'm' || u === 'meter' || u === 'meters') v *= 100;
      else if (u === 'mm') v *= 0.1;
      else if (u === 'in' || u === 'inch' || u === 'inches') v *= IN_TO_CM;
      else if (u === 'ft' || u === 'foot' || u === 'feet') v *= 30.48;
      break;
    case 'blood_oxygen':
    case 'body_fat_pct':
      // HealthKit stores percentages as a 0..1 fraction; scale up when needed.
      if (v <= 1) v *= 100;
      break;
    case 'active_energy_kcal':
      if (u === 'kj') v *= KJ_TO_KCAL;
      else if (u === 'cal') v *= 0.001; // small-calorie → kcal (rare)
      break;
    default:
      break;
  }
  return v;
}

/** Clamp a canonical value to its plausibility band; null if out of range. */
function withinBounds(key, value) {
  if (value == null || !Number.isFinite(value)) return null;
  const b = BOUNDS[key];
  if (!b) return value;
  if (value < b[0] || value > b[1]) return null;
  return value;
}

function roundFor(key, value) {
  if (key === 'steps') return Math.round(value);
  if (key === 'active_energy_kcal') return Math.round(value);
  if (key === 'weight_kg' || key === 'vo2_max' || key === 'respiratory_rate' || key === 'hrv_sdnn_ms') {
    return Math.round(value * 10) / 10;
  }
  if (key === 'height_cm' || key === 'resting_hr' || key === 'blood_oxygen' || key === 'bmi' || key === 'body_fat_pct') {
    return Math.round(value * 10) / 10;
  }
  return value;
}

/**
 * Decode a Shortcut / HAE payload from a URL fragment or raw string.
 * Accepts: '#health=<b64url>', 'health=<b64url>', a bare base64url string,
 * or a raw / URL-encoded JSON string. Returns the parsed object or null.
 *
 * @param {string} input
 * @returns {object|null}
 */
export function decodeShortcutPayload(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('#')) s = s.slice(1);
  // Pull the value out of a key=value fragment if present.
  const m = s.match(/(?:^|&)health=([^&]*)/);
  if (m) s = m[1];
  if (!s) return null;

  // Try direct / URL-decoded JSON first.
  for (const candidate of [s, safeDecodeURIComponent(s)]) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryJson(trimmed);
      if (parsed) return parsed;
    }
  }
  // Otherwise treat it as base64url(JSON).
  const decoded = base64UrlDecode(s);
  if (decoded) {
    const parsed = tryJson(decoded);
    if (parsed) return parsed;
  }
  return null;
}

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}
function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** base64url → UTF-8 string (browser/jsdom atob; null on failure). */
export function base64UrlDecode(s) {
  try {
    let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    // Decode UTF-8 bytes so non-ASCII survives the round-trip.
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Normalise a friendly-named payload object into canonical, unit-converted,
 * bounds-checked values. Accepts either:
 *   { "Body Mass": 72.5, "Resting Heart Rate": 52, ... }
 *   { weight_kg: 72.5, resting_hr: 52, ... }            (already canonical)
 *   { "Body Mass": { qty: 72.5, units: "kg" }, ... }     (HAE-ish object form)
 *
 * @param {object} payload
 * @returns {{values: object, accepted: string[]}}
 */
export function normalizeHealthValues(payload) {
  const out = {};
  const accepted = [];
  if (!payload || typeof payload !== 'object') return { values: out, accepted };

  for (const [rawName, rawVal] of Object.entries(payload)) {
    const nameKey = String(rawName).trim();
    const key = HK_TYPE_MAP[nameKey] || FRIENDLY_NAME_MAP[nameKey.toLowerCase()] ||
      (BOUNDS[nameKey] ? nameKey : null); // already-canonical key
    if (!key) continue;

    let value = null;
    let unit = '';
    if (rawVal != null && typeof rawVal === 'object') {
      value = Number(rawVal.qty ?? rawVal.value ?? rawVal.Qty ?? rawVal.Value);
      unit = rawVal.units ?? rawVal.unit ?? '';
    } else {
      value = Number(rawVal);
    }
    if (!Number.isFinite(value)) continue;

    const normalized = withinBounds(key, normalizeUnit(key, value, unit));
    if (normalized == null) continue;
    out[key] = roundFor(key, normalized);
    accepted.push(key);
  }
  return { values: out, accepted };
}

// ---------------------------------------------------------------------------
// export.xml streaming parser
// ---------------------------------------------------------------------------

const RECORD_RE = /<Record\b([^>]*?)\/?>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(attrStr) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * Stream-parse an Apple Health export.xml into per-metric time series.
 * Only types in HK_TYPE_MAP are kept. Each series is sorted ascending by date
 * and de-duplicated to the last value seen for an identical timestamp.
 *
 * @param {string} xmlText
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.keys]  restrict to these canonical keys
 * @returns {Object<string, Array<{date:string, value:number}>>}
 */
export function parseAppleHealthExport(xmlText, { keys = null } = {}) {
  const series = {};
  if (!xmlText || typeof xmlText !== 'string') return series;
  const want = keys ? new Set(keys) : null;

  let m;
  RECORD_RE.lastIndex = 0;
  while ((m = RECORD_RE.exec(xmlText)) !== null) {
    const attrs = parseAttrs(m[1]);
    const key = HK_TYPE_MAP[attrs.type];
    if (!key) continue;
    if (want && !want.has(key)) continue;

    const raw = Number(attrs.value);
    if (!Number.isFinite(raw)) continue;
    const normalized = withinBounds(key, normalizeUnit(key, raw, attrs.unit));
    if (normalized == null) continue;

    // Prefer startDate; fall back to endDate / creationDate.
    const dateStr = attrs.startDate || attrs.endDate || attrs.creationDate || '';
    if (!dateStr) continue;

    (series[key] ||= []).push({ date: dateStr, value: roundFor(key, normalized) });
  }

  for (const key of Object.keys(series)) {
    series[key].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return series;
}

/**
 * Latest value per metric from a parsed export (or from any {key:[{date,value}]}).
 * @returns {{values: object, dates: object}}
 */
export function latestValues(series) {
  const values = {};
  const dates = {};
  for (const [key, arr] of Object.entries(series || {})) {
    if (!arr || !arr.length) continue;
    const last = arr[arr.length - 1];
    values[key] = last.value;
    dates[key] = last.date;
  }
  return { values, dates };
}

/**
 * Collapse step/energy series into per-local-day sums, and instantaneous
 * metrics (resting_hr, vo2_max, respiratory_rate, blood_oxygen) into per-day
 * last value. Returns { 'YYYY-MM-DD': { steps, active_energy_kcal, ... } }.
 *
 * Date keys use the parser-provided local offset in the Apple timestamp
 * ("2026-06-01 07:14:33 -0700"), so days line up with the user's local days.
 *
 * @param {Object<string,Array<{date:string,value:number}>>} series
 * @returns {Object<string, object>}
 */
export function dailySeriesFromExport(series) {
  const SUMMED = new Set(['steps', 'active_energy_kcal']);
  const LATEST = new Set(['resting_hr', 'vo2_max', 'respiratory_rate', 'blood_oxygen', 'hrv_sdnn_ms', 'weight_kg', 'bmi', 'body_fat_pct']);
  const out = {};
  for (const [key, arr] of Object.entries(series || {})) {
    for (const { date, value } of arr || []) {
      const day = appleDateToLocalDay(date);
      if (!day) continue;
      const bucket = (out[day] ||= {});
      if (SUMMED.has(key)) bucket[key] = (bucket[key] || 0) + value;
      else if (LATEST.has(key)) bucket[key] = value; // arr is ascending → last write wins
    }
  }
  // Round summed fields.
  for (const day of Object.keys(out)) {
    if (out[day].steps != null) out[day].steps = Math.round(out[day].steps);
    if (out[day].active_energy_kcal != null) out[day].active_energy_kcal = Math.round(out[day].active_energy_kcal);
  }
  return out;
}

/** "2026-06-01 07:14:33 -0700" | ISO → "YYYY-MM-DD" (date part as written). */
export function appleDateToLocalDay(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------------------------------------------------------------------------
// Persistence (additive, profile store only — daily series wired separately)
// ---------------------------------------------------------------------------

/**
 * Merge canonical health values into the singleton profile. Only PROFILE_KEYS
 * are written, and only when they differ from the stored value. Never clears
 * an existing field. Returns the merged profile, or null if nothing changed.
 *
 * @param {object} values   canonical values (from normalizeHealthValues)
 * @param {IDBDatabase} [db]
 * @returns {Promise<object|null>}
 */
export async function applyHealthToProfile(values, db = null) {
  if (!values || typeof values !== 'object') return null;
  const d = db ?? (await openDb());
  const existing = (await getProfile(d)) ?? {};
  const merged = { ...existing };
  let changed = false;
  for (const key of PROFILE_KEYS) {
    const v = values[key];
    if (v == null) continue;
    if (existing[key] == null || Math.abs(existing[key] - v) > 1e-6) {
      merged[key] = v;
      changed = true;
    }
  }
  if (!changed) return null;
  await putProfile(d, merged);
  return merged;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function applyHealthDailyMetrics(daily, db = null) {
  if (!daily || typeof daily !== 'object') return { changed: 0, dates: [] };
  const d = db ?? (await openDb());
  const dates = [];
  for (const [date, values] of Object.entries(daily)) {
    if (!values || typeof values !== 'object') continue;
    const patch = {};
    if (values.steps != null) {
      patch.steps = Math.round(values.steps);
      patch.steps_source = 'apple_health';
      patch.steps_confidence_pct = 100;
    }
    if (values.active_energy_kcal != null) patch.active_energy_kcal = Math.round(values.active_energy_kcal);
    if (values.respiratory_rate != null) patch.respiratory_rate = values.respiratory_rate;
    if (values.blood_oxygen != null) patch.avg_spo2 = values.blood_oxygen;
    if (!Object.keys(patch).length) continue;
    const existing = (await getDailyMetric(d, date)) ?? { date };
    await upsertDailyMetric(d, { ...existing, ...patch, date });
    dates.push(date);
  }
  return { changed: dates.length, dates };
}

/**
 * Read a health payload out of the current URL fragment and apply it to the
 * profile. Safe to call on every boot — returns null when no fragment present.
 * Clears the fragment afterwards so a refresh doesn't re-apply.
 *
 * @param {object} [opts]
 * @param {Location} [opts.location]  injectable for tests
 * @param {History}  [opts.history]
 * @param {IDBDatabase} [opts.db]
 * @returns {Promise<{values:object, accepted:string[]}|null>}
 */
export async function readHealthFromHash({ location: loc = (typeof location !== 'undefined' ? location : null),
                                           history: hist = (typeof history !== 'undefined' ? history : null),
                                           db = null } = {}) {
  if (!loc || !loc.hash || !loc.hash.includes('health=')) return null;
  const payload = decodeShortcutPayload(loc.hash);
  if (!payload) return null;
  const { values, accepted } = normalizeHealthValues(payload);
  if (!accepted.length) return null;
  await applyHealthToProfile(values, db);
  await applyHealthDailyMetrics({ [todayIso()]: values }, db);
  // Strip the fragment so a reload doesn't re-import.
  try {
    if (hist && hist.replaceState) {
      const url = loc.pathname + loc.search;
      hist.replaceState({}, '', url || '/');
    }
  } catch { /* non-fatal */ }
  return { values, accepted };
}
