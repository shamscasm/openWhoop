// Workout auto-detection. Ported from tests/test_workouts.py.
//
// The Python `persist_workouts_for_day` helper touches SQLite and is NOT
// ported here -- the browser layer fetches samples from IndexedDB and writes
// detected workouts back through its own persistence layer.

import { describe, it, expect } from 'vitest';
import { detectWorkouts } from '../../../web/js/metrics/workouts.js';

// ---------------------------------------------------------------------------
// Helpers (mirror tests/test_workouts.py)
// ---------------------------------------------------------------------------

function row(tsUtc, hr, rr = 700, motionAmp = 10) {
  return {
    ts_utc: tsUtc,
    heart_rate_bpm: hr,
    rr_interval_ms: rr,
    accel_x: motionAmp,
    accel_y: motionAmp,
    accel_z: motionAmp,
  };
}

function dateIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayLocalDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoMs(d) {
  // Match Python isoformat(timespec="milliseconds") on a UTC datetime --
  // standard ISO 8601 with millisecond precision and a Z offset.
  return new Date(d.getTime()).toISOString();
}

function buildSeries(day) {
  // One sample every 5s. Workout from 17:00 to 17:35 local. Sleep-ish from
  // before 07:00 and after 23:00.
  const midnight = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    0, 0, 0, 0,
  );
  const rows = [];
  for (let s = 0; s < 24 * 3600; s += 5) {
    const tLocal = new Date(midnight.getTime() + s * 1000);
    const hFrac = tLocal.getHours() + tLocal.getMinutes() / 60;
    let hr;
    if (hFrac >= 17.0 && hFrac < 17 + 35 / 60) {
      hr = 155;
    } else if (hFrac < 7 || hFrac >= 23) {
      hr = 55;
    } else {
      hr = 75;
    }
    rows.push(row(isoMs(tLocal), hr, 700, hr < 80 ? 5 : 80));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectWorkouts', () => {
  it('finds an obvious workout block', () => {
    const day = yesterdayLocalDate();
    const rows = buildSeries(day);
    const detected = detectWorkouts(rows, {
      age: 30,
      maxHrOverride: null,
      sleepWindow: null,
      weightKg: 70,
      sex: 'M',
    });
    expect(detected.length).toBe(1);
    const w = detected[0];
    expect(w.date).toBe(dateIso(day));
    expect(w.duration_seconds).toBeGreaterThanOrEqual(30 * 60);
    expect(w.avg_hr).toBeGreaterThan(140);
    expect(w.max_hr).toBeGreaterThanOrEqual(150);
    expect(w.strain).toBeGreaterThan(0);
    expect(w.calories).toBeGreaterThan(0);
    const zs = JSON.parse(w.zone_seconds);
    expect(zs.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(w.auto_detected).toBe(true);
  });

  it('returns no workouts for a resting day', () => {
    const day = yesterdayLocalDate();
    const midnight = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      0, 0, 0, 0,
    );
    const rows = [];
    for (let s = 0; s < 24 * 3600; s += 30) {
      const t = new Date(midnight.getTime() + s * 1000);
      rows.push(row(isoMs(t), 65, 700, 10));
    }
    const detected = detectWorkouts(rows, {
      age: 30,
      maxHrOverride: null,
      sleepWindow: null,
      weightKg: 70,
      sex: 'M',
    });
    expect(detected).toEqual([]);
  });

  it('excludes workouts inside the sleep window', () => {
    const day = yesterdayLocalDate();
    const rows = buildSeries(day);
    // Sleep window in *local* time, expressed as Date objects (UTC equivalent
    // is automatic since Date stores absolute time).
    const sleepStart = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(), 16, 30, 0, 0,
    );
    const sleepEnd = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(), 18, 0, 0, 0,
    );
    const detected = detectWorkouts(rows, {
      age: 30,
      maxHrOverride: null,
      sleepWindow: [sleepStart, sleepEnd],
      weightKg: 70,
      sex: 'M',
    });
    expect(detected).toEqual([]);
  });

  it('drops workouts shorter than the minimum duration', () => {
    const day = yesterdayLocalDate();
    const midnight = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      0, 0, 0, 0,
    );
    const rows = [];
    for (let s = 0; s < 24 * 3600; s += 5) {
      const t = new Date(midnight.getTime() + s * 1000);
      const hFrac = t.getHours() + t.getMinutes() / 60;
      const hr = hFrac >= 17.0 && hFrac < 17 + 5 / 60 ? 160 : 65;
      rows.push(row(isoMs(t), hr, 700, 10));
    }
    const detected = detectWorkouts(rows, {
      age: 30,
      maxHrOverride: null,
      sleepWindow: null,
      weightKg: 70,
      sex: 'M',
    });
    expect(detected).toEqual([]);
  });
});
