// Heart-Rate Recovery tests.
//
// Timestamps are built from an explicit base epoch constant (not wall-clock)
// so the tests are deterministic and self-documenting.
import { describe, it, expect } from 'vitest';
import { heartRateRecovery } from '../../../web/js/metrics/hrr.js';

// Fixed base: 2024-01-15T10:00:00Z in ms — arbitrary, pinned for reproducibility.
const BASE_MS = 1705312800_000;

/** Build an ISO string offset seconds from BASE_MS. */
function ts(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
}

const WORKOUT_END = ts(0); // t=0, the workout endpoint

/**
 * Synth a cool-down HR tail starting at `startBpm` and decaying by
 * `dropPerMinute` bpm. One sample every `intervalSec` seconds, for
 * `durationSec` seconds starting at secondOffset from BASE_MS.
 */
function buildSamples(startBpm, dropPerMinute, intervalSec, durationSec, startOffsetSec) {
  const samples = [];
  for (let s = 0; s <= durationSec; s += intervalSec) {
    const bpm = startBpm - (dropPerMinute / 60) * s;
    samples.push({ ts_utc: ts(startOffsetSec + s), heart_rate_bpm: Math.round(bpm) });
  }
  return samples;
}

describe('heartRateRecovery — happy path', () => {
  // Synth: end HR=165 at t=0, drops 25 bpm in 60s -> hrr60=25 -> 'excellent'.
  // buildSamples starts at t=0 (startOffsetSec=0) so the first sample is 165 bpm.
  // To get post-workout coverage beyond 30s we extend to 150s.
  const samples = buildSamples(165, 25, 10, 150, 0);

  it('returns a result object with the expected fields', () => {
    const result = heartRateRecovery(samples, WORKOUT_END);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('hrr60');
    expect(result).toHaveProperty('hrr120');
    expect(result).toHaveProperty('endHr');
    expect(result).toHaveProperty('category');
  });

  it('endHr is the HR at the closest sample to workoutEndUtc', () => {
    const result = heartRateRecovery(samples, WORKOUT_END);
    // t=0 sample: bpm = 165 - 0 = 165
    expect(result.endHr).toBe(165);
  });

  it('hrr60 = endHr - HR at t+60s (known-value: 25)', () => {
    const result = heartRateRecovery(samples, WORKOUT_END);
    // t=60: bpm = 165 - 25 = 140 -> hrr60 = 165 - 140 = 25
    expect(result.hrr60).toBe(25);
  });

  it("category is 'excellent' when hrr60 >= 25", () => {
    const result = heartRateRecovery(samples, WORKOUT_END);
    expect(result.category).toBe('excellent');
  });

  it('hrr120 reflects the HR drop at t+120s', () => {
    const result = heartRateRecovery(samples, WORKOUT_END);
    // t=120: bpm = 165 - 50 = 115 -> hrr120 = 165 - 115 = 50
    expect(result.hrr120).toBe(50);
  });
});

describe('heartRateRecovery — caller-supplied peakHr override', () => {
  // Only post-workout samples; no sample at t=0.
  const postSamples = buildSamples(140, 0, 10, 130, 10);

  it('uses peakHr when no sample covers t=0', () => {
    const result = heartRateRecovery(postSamples, WORKOUT_END, { peakHr: 165 });
    expect(result).not.toBeNull();
    expect(result.endHr).toBe(165);
    // hrr60 = 165 - 140 = 25 (HR flat because drop=0 in postSamples)
    expect(result.hrr60).toBe(25);
    expect(result.category).toBe('excellent');
  });
});

describe('heartRateRecovery — category thresholds', () => {
  function makeSamplesWithHrr60(hrr60Value) {
    // endHr = 160, HR at t+60 = 160 - hrr60Value
    const endHrBpm = 160;
    const hr60Bpm = endHrBpm - hrr60Value;
    return [
      { ts_utc: ts(0), heart_rate_bpm: endHrBpm },
      { ts_utc: ts(30), heart_rate_bpm: Math.round(endHrBpm - hrr60Value / 2) },
      { ts_utc: ts(60), heart_rate_bpm: hr60Bpm },
      { ts_utc: ts(120), heart_rate_bpm: hr60Bpm - 5 },
    ];
  }

  it("'excellent' when hrr60 >= 25", () => {
    const r = heartRateRecovery(makeSamplesWithHrr60(25), WORKOUT_END);
    expect(r.category).toBe('excellent');
  });

  it("'good' when 18 <= hrr60 < 25", () => {
    const r = heartRateRecovery(makeSamplesWithHrr60(20), WORKOUT_END);
    expect(r.category).toBe('good');
  });

  it("'fair' when 12 <= hrr60 < 18", () => {
    const r = heartRateRecovery(makeSamplesWithHrr60(14), WORKOUT_END);
    expect(r.category).toBe('fair');
  });

  it("'poor' when hrr60 < 12", () => {
    const r = heartRateRecovery(makeSamplesWithHrr60(8), WORKOUT_END);
    expect(r.category).toBe('poor');
  });
});

describe('heartRateRecovery — null / edge cases', () => {
  it('returns null for null samples', () => {
    expect(heartRateRecovery(null, WORKOUT_END)).toBeNull();
  });

  it('returns null for empty samples', () => {
    expect(heartRateRecovery([], WORKOUT_END)).toBeNull();
  });

  it('returns null for an invalid workoutEndUtc', () => {
    const samples = buildSamples(165, 25, 10, 180, -30);
    expect(heartRateRecovery(samples, 'not-a-date')).toBeNull();
  });

  it('returns null when post-workout coverage is < 30s (too few samples after end)', () => {
    // Only one sample at t+10s — 10s < 30s threshold
    const sparse = [
      { ts_utc: ts(0), heart_rate_bpm: 165 },
      { ts_utc: ts(10), heart_rate_bpm: 160 },
    ];
    expect(heartRateRecovery(sparse, WORKOUT_END)).toBeNull();
  });

  it('returns null when no valid endHr can be found (all bpms null around t=0)', () => {
    const nullHr = [
      { ts_utc: ts(0), heart_rate_bpm: null },
      { ts_utc: ts(60), heart_rate_bpm: null },
      { ts_utc: ts(90), heart_rate_bpm: 140 },
      { ts_utc: ts(120), heart_rate_bpm: 135 },
    ];
    expect(heartRateRecovery(nullHr, WORKOUT_END)).toBeNull();
  });

  it('hrr60 is null when no sample falls within ±15s of t+60', () => {
    // Gap at t+60: samples jump from t+20 to t+80
    const gapSamples = [
      { ts_utc: ts(0), heart_rate_bpm: 165 },
      { ts_utc: ts(20), heart_rate_bpm: 155 },
      { ts_utc: ts(80), heart_rate_bpm: 145 },  // 80s off target of 60s — beyond ±15
      { ts_utc: ts(120), heart_rate_bpm: 135 },
    ];
    const result = heartRateRecovery(gapSamples, WORKOUT_END);
    expect(result).not.toBeNull();
    expect(result.hrr60).toBeNull();
    expect(result.category).toBeNull();  // category derived from hrr60
  });

  it('hrr120 is null when no sample covers t+120 within tolerance', () => {
    // Good 60s coverage, nothing near 120s
    const samples = [
      { ts_utc: ts(0), heart_rate_bpm: 165 },
      { ts_utc: ts(30), heart_rate_bpm: 152 },
      { ts_utc: ts(60), heart_rate_bpm: 140 },  // hrr60=25
      { ts_utc: ts(45), heart_rate_bpm: 148 },  // extra coverage for MIN check
    ];
    const result = heartRateRecovery(samples, WORKOUT_END);
    expect(result).not.toBeNull();
    expect(result.hrr60).toBe(25);
    expect(result.hrr120).toBeNull();
  });

  it('ignores samples whose heart_rate_bpm is null when matching targets', () => {
    const mixed = [
      { ts_utc: ts(0), heart_rate_bpm: 165 },
      { ts_utc: ts(60), heart_rate_bpm: null },   // null at target — should skip
      { ts_utc: ts(62), heart_rate_bpm: 140 },    // fallback within ±15s
      { ts_utc: ts(120), heart_rate_bpm: 120 },
    ];
    const result = heartRateRecovery(mixed, WORKOUT_END);
    expect(result).not.toBeNull();
    // closest valid sample to t+60 is t+62 (2s off, within 15s) -> hrr60=25
    expect(result.hrr60).toBe(25);
  });
});
