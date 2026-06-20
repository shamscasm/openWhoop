import { describe, it, expect } from 'vitest';
import { strainScore, acwr, zoneWeightedStrain } from '../../../web/js/metrics/strain.js';

describe('strainScore', () => {
  it('is near zero at rest', () => {
    // 1 hour at perfect rest HR
    const hr = new Array(3600).fill(60.0);
    const score = strainScore(hr, 30, 60.0);
    expect(score).toBeLessThan(1.0);
  });

  it('grows with intensity and is bounded by 21', () => {
    // 1 hour at rest vs 1 hour at near-max
    const rest = new Array(3600).fill(60.0);
    const hard = new Array(3600).fill(180.0);
    const sRest = strainScore(rest, 30, 60.0);
    const sHard = strainScore(hard, 30, 60.0);
    expect(sHard).toBeGreaterThan(sRest);
    expect(sHard).toBeLessThanOrEqual(21.0);
  });

  it('is bounded between 0 and 21 even at sustained max HR', () => {
    // 6 hours at max HR shouldn't exceed Whoop's 21.
    const hr = new Array(6 * 3600).fill(200.0);
    const score = strainScore(hr, 30, 50.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(21.0);
  });

  it('differentiates effort duration: 60 min scores higher than 30 min', () => {
    // Same moderate intensity (~120 bpm, rest 60, max 190), different duration.
    const thirty = new Array(30 * 60).fill(120.0);
    const sixty = new Array(60 * 60).fill(120.0);
    const s30 = strainScore(thirty, 30, 60.0);
    const s60 = strainScore(sixty, 30, 60.0);
    expect(s60).toBeGreaterThan(s30);
    // Neither should peg at the ceiling — the old formula collapsed both to 21.
    expect(s30).toBeGreaterThan(0.5);
    expect(s60).toBeLessThan(21.0);
  });

  it('is invariant to sample rate when the interval is supplied', () => {
    // 30 min of identical effort sampled at 1 Hz vs every 5 s must agree.
    const oneHz = new Array(30 * 60).fill(130.0);
    const fiveS = new Array((30 * 60) / 5).fill(130.0);
    const a = strainScore(oneHz, 30, 60.0, 1.0);
    const b = strainScore(fiveS, 30, 60.0, 5.0);
    expect(a).toBeCloseTo(b, 1);
  });
});

describe('zoneWeightedStrain', () => {
  it('is 0 with no zone time', () => {
    expect(zoneWeightedStrain({ zoneMinutes: [0, 0, 0, 0, 0] })).toBe(0);
  });

  it('returns 0 for malformed input', () => {
    expect(zoneWeightedStrain({})).toBe(0);
    expect(zoneWeightedStrain({ zoneMinutes: [1, 2] })).toBe(0);
  });

  it('weights higher zones more: an hour in Z5 beats an hour in Z1', () => {
    const z1 = zoneWeightedStrain({ zoneMinutes: [60, 0, 0, 0, 0], avgHr: 110, restingHr: 60, maxHrBpm: 190 });
    const z5 = zoneWeightedStrain({ zoneMinutes: [0, 0, 0, 0, 60], avgHr: 175, restingHr: 60, maxHrBpm: 190 });
    expect(z5).toBeGreaterThan(z1);
  });

  it('is bounded to [0, 21]', () => {
    const huge = zoneWeightedStrain({ zoneMinutes: [0, 0, 0, 0, 600], avgHr: 188, restingHr: 60, maxHrBpm: 190 });
    expect(huge).toBeGreaterThanOrEqual(0);
    expect(huge).toBeLessThanOrEqual(21);
  });

  it('works without a reserve term (zone-only blend = 70%)', () => {
    // 20 weighted zone-minutes → zoneScore 1.0; no HR reserve → final 0.7.
    const s = zoneWeightedStrain({ zoneMinutes: [20, 0, 0, 0, 0] });
    expect(s).toBeCloseTo(0.7, 2);
  });
});

describe('acwr', () => {
  // helper: build newest→oldest strain array
  const series = (...vals) => vals;

  it('returns null with too few samples', () => {
    expect(acwr([])).toBeNull();
    expect(acwr(series(10, 10, 10, 10, 10))).toBeNull();          // no chronic days
    expect(acwr(series(10, 10, 10, 10, 10, 10, 10, 8, 8))).toBeNull(); // chronic only 2 valid
  });

  it('returns null for non-array input', () => {
    expect(acwr(null)).toBeNull();
    expect(acwr(undefined)).toBeNull();
    expect(acwr('not-array')).toBeNull();
  });

  it('computes ratio 1.0 when acute and chronic means match', () => {
    const r = acwr(series(10, 10, 10, 10, 10, 10, 10,    10, 10, 10, 10, 10, 10, 10));
    expect(r).not.toBeNull();
    expect(r.ratio).toBeCloseTo(1.0, 4);
    expect(r.acute).toBeCloseTo(10, 4);
    expect(r.chronic).toBeCloseTo(10, 4);
  });

  it('detects training spike (acute > chronic)', () => {
    // Acute mean 18, chronic mean 9 → ratio 2.0
    const r = acwr(series(18, 18, 18, 18, 18, 18, 18,    9, 9, 9, 9, 9, 9, 9));
    expect(r.ratio).toBeCloseTo(2.0, 4);
  });

  it('detects detraining (acute < chronic)', () => {
    const r = acwr(series(4, 4, 4, 4, 4, 4, 4,    12, 12, 12, 12, 12, 12, 12));
    expect(r.ratio).toBeCloseTo(4 / 12, 4);
  });

  it('skips nulls in either window', () => {
    const r = acwr(series(10, null, 10, 10, 10, 10, 10,    20, null, 20, 20, 20, 20, 20));
    expect(r).not.toBeNull();
    expect(r.acute).toBeCloseTo(10, 4);
    expect(r.chronic).toBeCloseTo(20, 4);
    expect(r.ratio).toBeCloseTo(0.5, 4);
  });

  it('returns null when chronic mean is zero', () => {
    // All chronic days are 0
    const r = acwr(series(10, 10, 10, 10, 10, 10, 10,    0, 0, 0, 0, 0, 0, 0));
    expect(r).toBeNull();
  });

  it('respects custom acuteDays/chronicDays', () => {
    // 3-day acute (mean 15), 5-day chronic (mean 10) → ratio 1.5
    const r = acwr(series(15, 15, 15,    10, 10, 10, 10, 10), {
      acuteDays: 3,
      chronicDays: 5,
      minSamples: 3,
    });
    expect(r.ratio).toBeCloseTo(1.5, 4);
  });

  it('honours minSamples threshold', () => {
    // Default minSamples is 5; here acute has 4 valid → null
    const r = acwr(series(10, 10, 10, 10, null, null, null,    10, 10, 10, 10, 10, 10, 10));
    expect(r).toBeNull();
  });
});
