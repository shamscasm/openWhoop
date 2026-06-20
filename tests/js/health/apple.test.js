import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { getDailyMetric, getProfile, putProfile } from '../../../web/js/data/queries.js';
import {
  HK_TYPE_MAP, FRIENDLY_NAME_MAP, PROFILE_KEYS,
  normalizeUnit, decodeShortcutPayload, base64UrlDecode,
  normalizeHealthValues, parseAppleHealthExport, latestValues,
  dailySeriesFromExport, appleDateToLocalDay,
  applyHealthToProfile, applyHealthDailyMetrics, readHealthFromHash,
} from '../../../web/js/health/apple.js';

const TEST_DB = 'whoof-apple-test';

function freshDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

// One shared connection, always closed between tests, so deleteDatabase never
// blocks on a lingering handle from an earlier describe block.
let db;
beforeEach(async () => {
  if (db) { try { db.close(); } catch {} db = null; }
  await freshDb();
  db = await openDb(TEST_DB);
});
afterEach(() => {
  if (db) { try { db.close(); } catch {} db = null; }
});

// base64url(JSON) the way an Apple Shortcut would build it (UTF-8 safe).
function b64urlJson(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('normalizeUnit', () => {
  it('converts pounds to kg', () => {
    expect(normalizeUnit('weight_kg', 154.32, 'lb')).toBeCloseTo(70, 1);
  });
  it('leaves kg as-is', () => {
    expect(normalizeUnit('weight_kg', 72.5, 'kg')).toBe(72.5);
  });
  it('converts inches and metres to cm', () => {
    expect(normalizeUnit('height_cm', 70, 'in')).toBeCloseTo(177.8, 1);
    expect(normalizeUnit('height_cm', 1.78, 'm')).toBeCloseTo(178, 1);
  });
  it('scales fractional oxygen saturation up to a percentage', () => {
    expect(normalizeUnit('blood_oxygen', 0.97, '%')).toBeCloseTo(97, 1);
    expect(normalizeUnit('blood_oxygen', 97, '%')).toBe(97);
  });
});

describe('base64UrlDecode / decodeShortcutPayload', () => {
  it('decodes a base64url fragment with the #health= prefix', () => {
    const payload = { 'Body Mass': 72.5, 'Resting Heart Rate': 52 };
    const hash = '#health=' + b64urlJson(payload);
    expect(decodeShortcutPayload(hash)).toEqual(payload);
  });
  it('decodes a raw base64url string (no prefix)', () => {
    const payload = { weight_kg: 80 };
    expect(decodeShortcutPayload(b64urlJson(payload))).toEqual(payload);
  });
  it('accepts raw JSON in the fragment', () => {
    const hash = '#health=' + encodeURIComponent('{"weight_kg":81.2}');
    expect(decodeShortcutPayload(hash)).toEqual({ weight_kg: 81.2 });
  });
  it('round-trips non-ASCII through base64url', () => {
    expect(base64UrlDecode(b64urlJson({ note: 'café ✓' }))).toContain('café ✓');
  });
  it('returns null on garbage', () => {
    expect(decodeShortcutPayload('#health=')).toBeNull();
    expect(decodeShortcutPayload('')).toBeNull();
    expect(decodeShortcutPayload('#other=1')).toBeNull();
  });
});

describe('normalizeHealthValues', () => {
  it('maps friendly names and converts units', () => {
    const { values, accepted } = normalizeHealthValues({
      'Body Mass': 154.32,                 // lb? no unit → treated as already kg-ish number; see object form below
      'Resting Heart Rate': 52,
      'VO2 Max': 48.3,
      'Blood Oxygen': 0.97,
    });
    expect(values.resting_hr).toBe(52);
    expect(values.vo2_max).toBe(48.3);
    expect(values.blood_oxygen).toBeCloseTo(97, 1);
    expect(accepted).toContain('vo2_max');
  });
  it('handles the HAE object form { qty, units }', () => {
    const { values } = normalizeHealthValues({
      'Body Mass': { qty: 154.32, units: 'lb' },
      'Height': { qty: 70, units: 'in' },
    });
    expect(values.weight_kg).toBeCloseTo(70, 0);
    expect(values.height_cm).toBeCloseTo(177.8, 0);
  });
  it('accepts already-canonical keys', () => {
    const { values } = normalizeHealthValues({ weight_kg: 72.5, resting_hr: 48 });
    expect(values).toEqual({ weight_kg: 72.5, resting_hr: 48 });
  });
  it('drops out-of-range and unknown values', () => {
    const { values } = normalizeHealthValues({
      weight_kg: 9999,        // out of bounds
      'Unknown Metric': 5,    // not mapped
      resting_hr: 50,
    });
    expect(values.weight_kg).toBeUndefined();
    expect(values.resting_hr).toBe(50);
  });
});

describe('parseAppleHealthExport', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="73.0" startDate="2026-05-30 08:00:00 -0700" endDate="2026-05-30 08:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" value="160.0" startDate="2026-06-01 08:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" unit="count/min" value="51" startDate="2026-06-01 06:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1200" startDate="2026-06-01 09:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="800" startDate="2026-06-01 18:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierVO2Max" unit="mL/min·kg" value="47.5" startDate="2026-05-28 10:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierDietaryWater" unit="mL" value="500" startDate="2026-06-01 12:00:00 -0700"/>
</HealthData>`;

  it('extracts mapped types and converts units', () => {
    const series = parseAppleHealthExport(XML);
    expect(Object.keys(series).sort()).toEqual(
      ['resting_hr', 'steps', 'vo2_max', 'weight_kg'].sort()
    );
    // Second body-mass row is in lb → ~72.6 kg
    expect(series.weight_kg.at(-1).value).toBeCloseTo(72.6, 0);
    // Water is unmapped → ignored
    expect(series.dietary_water).toBeUndefined();
  });

  it('sorts each series ascending by date', () => {
    const series = parseAppleHealthExport(XML);
    expect(series.weight_kg[0].date < series.weight_kg[1].date).toBe(true);
  });

  it('respects the keys filter', () => {
    const series = parseAppleHealthExport(XML, { keys: ['resting_hr'] });
    expect(Object.keys(series)).toEqual(['resting_hr']);
  });

  it('returns {} for empty input', () => {
    expect(parseAppleHealthExport('')).toEqual({});
    expect(parseAppleHealthExport(null)).toEqual({});
  });

  it('latestValues picks the newest per metric', () => {
    const { values } = latestValues(parseAppleHealthExport(XML));
    expect(values.weight_kg).toBeCloseTo(72.6, 0);
    expect(values.resting_hr).toBe(51);
  });

  it('dailySeriesFromExport sums steps and keeps latest RHR per day', () => {
    const daily = dailySeriesFromExport(parseAppleHealthExport(XML));
    expect(daily['2026-06-01'].steps).toBe(2000);     // 1200 + 800
    expect(daily['2026-06-01'].resting_hr).toBe(51);
  });
});

describe('appleDateToLocalDay', () => {
  it('extracts the date part as written (local)', () => {
    expect(appleDateToLocalDay('2026-06-01 07:14:33 -0700')).toBe('2026-06-01');
    expect(appleDateToLocalDay('2026-06-01T07:14:33Z')).toBe('2026-06-01');
    expect(appleDateToLocalDay('')).toBeNull();
  });
});

describe('applyHealthToProfile (IndexedDB)', () => {
  it('writes only PROFILE_KEYS and preserves existing fields', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 70 });
    const merged = await applyHealthToProfile(
      { weight_kg: 72.5, height_cm: 178, resting_hr: 50, vo2_max: 48, steps: 9000 },
      db,
    );
    expect(merged.weight_kg).toBe(72.5);
    expect(merged.height_cm).toBe(178);
    expect(merged.resting_hr).toBe(50);
    expect(merged.age).toBe(30); // preserved
    expect(merged.steps).toBeUndefined(); // not a profile key
  });

  it('returns null when nothing changed', async () => {
    await putProfile(db, { weight_kg: 72.5 });
    const res = await applyHealthToProfile({ weight_kg: 72.5 }, db);
    expect(res).toBeNull();
  });
});

describe('applyHealthDailyMetrics (IndexedDB)', () => {
  it('writes Apple steps and active energy into daily_metrics', async () => {
    const res = await applyHealthDailyMetrics({
      '2026-06-01': { steps: 9000, active_energy_kcal: 450 },
    }, db);
    expect(res.changed).toBe(1);
    const row = await getDailyMetric(db, '2026-06-01');
    expect(row.steps).toBe(9000);
    expect(row.steps_source).toBe('apple_health');
    expect(row.steps_confidence_pct).toBe(100);
    expect(row.active_energy_kcal).toBe(450);
  });
});

describe('readHealthFromHash', () => {
  it('imports from the fragment and clears it', async () => {
    const hash = '#health=' + b64urlJson({ 'Body Mass': { qty: 72.5, units: 'kg' }, 'Resting Heart Rate': 49 });
    let replaced = null;
    const fakeLoc = { hash, pathname: '/', search: '' };
    const fakeHist = { replaceState: (_s, _t, url) => { replaced = url; } };
    const res = await readHealthFromHash({ location: fakeLoc, history: fakeHist, db });
    expect(res.accepted).toContain('weight_kg');
    expect(res.values.resting_hr).toBe(49);
    const p = await getProfile(db);
    expect(p.weight_kg).toBe(72.5);
    expect(replaced).toBe('/');
  });

  it('returns null when no health fragment is present', async () => {
    const res = await readHealthFromHash({ location: { hash: '#overview' }, history: {}, db });
    expect(res).toBeNull();
  });
});
