// Standards-compliant Bluetooth scale support.
//
// Web Bluetooth can talk directly to any scale that implements the
// Bluetooth SIG Weight Scale Service (0x181D). Most "smart scales" use
// proprietary services instead — but the spec-compliant ones (Beurer
// BF600, A&D UC-352BLE, some Nokia / Withings) just work without an app.
//
// Spec: https://www.bluetooth.com/specifications/specs/weight-scale-service-1-0/
// Characteristic 0x2A9D Weight Measurement format:
//   flags (uint8)
//     bit 0: 0=SI(kg), 1=Imperial(lbs)
//     bit 1: timestamp present
//     bit 2: user id present
//     bit 3: BMI + height present
//   weight (uint16 LE, resolution 0.005 kg or 0.01 lb)
//   [timestamp 7 bytes if flag bit 1]
//   [user_id uint8 if flag bit 2]
//   [bmi uint16 LE (0.1 res) + height uint16 LE (0.001m or 0.1in res) if flag bit 3]

import { openDb } from '../data/db.js';
import { getProfile, putProfile } from '../data/queries.js';

const WEIGHT_SCALE_SERVICE = 'weight_scale';
const WEIGHT_MEASUREMENT_CHAR = 'weight_measurement';

// Resolution constants from the spec.
const WEIGHT_RES_KG = 0.005;
const WEIGHT_RES_LB = 0.01;
const LB_TO_KG = 0.45359237;
const IN_TO_M = 0.0254;

/**
 * Parse a Weight Measurement notification.
 *
 *   data: DataView | Uint8Array
 *   → { weightKg, heightM, bmi, userId, timestamp, isImperial }
 *
 * Returns null if the buffer is too short.
 */
export function parseWeightMeasurement(data) {
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 3) return null;

  const flags = bytes[0];
  const isImperial = (flags & 0x01) !== 0;
  const hasTimestamp = (flags & 0x02) !== 0;
  const hasUserId = (flags & 0x04) !== 0;
  const hasBmiHeight = (flags & 0x08) !== 0;

  let offset = 1;
  const weightRaw = bytes[offset] | (bytes[offset + 1] << 8);
  offset += 2;
  const weightUnits = isImperial ? weightRaw * WEIGHT_RES_LB : weightRaw * WEIGHT_RES_KG;
  const weightKg = isImperial ? weightUnits * LB_TO_KG : weightUnits;

  let timestamp = null;
  if (hasTimestamp && offset + 7 <= bytes.length) {
    const year = bytes[offset] | (bytes[offset + 1] << 8);
    const month = bytes[offset + 2];
    const day = bytes[offset + 3];
    const hour = bytes[offset + 4];
    const minute = bytes[offset + 5];
    const second = bytes[offset + 6];
    if (year > 0) {
      timestamp = new Date(year, month - 1, day, hour, minute, second).toISOString();
    }
    offset += 7;
  }

  let userId = null;
  if (hasUserId && offset < bytes.length) {
    userId = bytes[offset];
    offset += 1;
  }

  let bmi = null;
  let heightM = null;
  if (hasBmiHeight && offset + 4 <= bytes.length) {
    const bmiRaw = bytes[offset] | (bytes[offset + 1] << 8);
    bmi = bmiRaw * 0.1;
    offset += 2;
    const heightRaw = bytes[offset] | (bytes[offset + 1] << 8);
    if (isImperial) {
      heightM = heightRaw * 0.1 * IN_TO_M;  // 0.1 inch resolution
    } else {
      heightM = heightRaw * 0.001;  // 1 mm resolution
    }
    offset += 2;
  }

  return {
    weightKg: Math.round(weightKg * 100) / 100,
    isImperial,
    timestamp,
    userId,
    bmi,
    heightM,
    heightCm: heightM ? Math.round(heightM * 1000) / 10 : null,
  };
}

/**
 * Show a device picker, connect to a standards-compliant scale, and
 * resolve with the first weight measurement. Throws if Web Bluetooth
 * isn't available or the user cancels.
 */
export async function readOneWeightFromScale() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not available');
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [WEIGHT_SCALE_SERVICE] }],
  });
  const server = await device.gatt.connect();
  try {
    const service = await server.getPrimaryService(WEIGHT_SCALE_SERVICE);
    const char = await service.getCharacteristic(WEIGHT_MEASUREMENT_CHAR);
    const measurement = await new Promise((resolve, reject) => {
      const onValue = (e) => {
        const m = parseWeightMeasurement(e.target.value);
        if (m && m.weightKg > 0) {
          char.removeEventListener('characteristicvaluechanged', onValue);
          resolve(m);
        }
      };
      char.addEventListener('characteristicvaluechanged', onValue);
      char.startNotifications().catch(reject);
      // Some scales send via the read attribute too; try once.
      char.readValue().then(dv => {
        const m = parseWeightMeasurement(dv);
        if (m && m.weightKg > 0) {
          char.removeEventListener('characteristicvaluechanged', onValue);
          resolve(m);
        }
      }).catch(() => {});
      // Hard timeout — user needs to step on the scale within a minute.
      setTimeout(() => reject(new Error('No measurement in 60 s — step on the scale')), 60_000);
    });
    return measurement;
  } finally {
    try { server.disconnect(); } catch {}
  }
}

/** Connect to a scale, take one reading, and persist into profile. */
export async function readScaleIntoProfile(db = null) {
  const m = await readOneWeightFromScale();
  const d = db ?? (await openDb());
  const existing = (await getProfile(d)) ?? {};
  const merged = { ...existing, weight_kg: m.weightKg };
  if (m.heightCm) merged.height_cm = m.heightCm;
  await putProfile(d, merged);
  return m;
}

/** Manual entry path — used by the UI when no scale or HAE is set up. */
export async function setWeightManually(weightKg, db = null) {
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500) {
    throw new Error('Weight must be between 0 and 500 kg');
  }
  const d = db ?? (await openDb());
  const existing = (await getProfile(d)) ?? {};
  await putProfile(d, { ...existing, weight_kg: Math.round(weightKg * 100) / 100 });
  return weightKg;
}
