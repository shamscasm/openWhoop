import { describe, it, expect } from 'vitest';
import {
  maxHr,
  zoneForHr,
  zoneSecondsFromHrSeries,
  caloriesPerMinute,
  caloriesFromHrSeries,
  energyBankCalories,
  energyBankRemaining,
} from '../../../web/js/metrics/zones.js';

describe('maxHr', () => {
  it('default formula: 220 - age', () => {
    expect(maxHr(30)).toBe(190);
    expect(maxHr(50)).toBe(170);
  });

  it('override wins', () => {
    expect(maxHr(30, 200)).toBe(200);
  });

  it('floor at 120 for very high ages', () => {
    expect(maxHr(120)).toBeGreaterThanOrEqual(120);
  });
});

describe('zoneForHr', () => {
  it('returns the right zone at each boundary', () => {
    const mx = 200; // thresholds 100/120/140/160/180
    expect(zoneForHr(99, mx)).toBeNull();
    expect(zoneForHr(100, mx)).toBe(1);
    expect(zoneForHr(120, mx)).toBe(2);
    expect(zoneForHr(140, mx)).toBe(3);
    expect(zoneForHr(160, mx)).toBe(4);
    expect(zoneForHr(180, mx)).toBe(5);
    expect(zoneForHr(220, mx)).toBe(5); // capped at Z5
  });
});

describe('zoneSecondsFromHrSeries', () => {
  it('distributes per-second samples into zones', () => {
    // 200 bpm max → thresholds 100/120/140/160/180.
    // 50 = below Z1, 110 = Z1, 130 = Z2, 180 = Z5.
    const series = [
      ...Array(10).fill(50),
      ...Array(60).fill(110),
      ...Array(40).fill(130),
      ...Array(30).fill(180),
    ];
    const out = zoneSecondsFromHrSeries(series, 200);
    expect(out[0]).toBe(60); // Z1
    expect(out[1]).toBe(40); // Z2
    expect(out[2]).toBe(0);  // Z3
    expect(out[3]).toBe(0);  // Z4
    expect(out[4]).toBe(30); // Z5
  });
});

describe('caloriesPerMinute', () => {
  it('men burn more than women at the same HR', () => {
    const m = caloriesPerMinute(150, 30, 80, 'M');
    const f = caloriesPerMinute(150, 30, 80, 'F');
    expect(m).toBeGreaterThan(f);
    expect(f).toBeGreaterThan(0);
    // Within an order of magnitude of typical (~10-20 kcal/min).
    expect(m).toBeGreaterThan(5);
    expect(m).toBeLessThan(30);
  });

  it('unknown sex averages the two formulas', () => {
    const m = caloriesPerMinute(150, 30, 80, 'M');
    const f = caloriesPerMinute(150, 30, 80, 'F');
    const u = caloriesPerMinute(150, 30, 80, null);
    expect(u).toBeCloseTo((m + f) / 2, 6);
  });

  it('returns 0 for HR below 30 bpm or null', () => {
    expect(caloriesPerMinute(20, 30, 80, 'M')).toBe(0.0);
    expect(caloriesPerMinute(null, 30, 80, 'M')).toBe(0.0);
  });
});

describe('caloriesFromHrSeries', () => {
  it('60s @ HR 150 ≈ caloriesPerMinute(150)', () => {
    const series = Array(60).fill(150.0);
    const cals = caloriesFromHrSeries(series, 30, 80, 'M');
    const expected = caloriesPerMinute(150, 30, 80, 'M');
    expect(Math.abs(cals - expected)).toBeLessThan(0.5);
  });

  it('falls back to default weight (70 kg) when weight is null', () => {
    const cals = caloriesFromHrSeries(Array(60).fill(100.0), 30, null, 'M');
    expect(cals).toBeGreaterThan(0);
  });
});

describe('energyBankCalories (MET model)', () => {
  it('returns null without body weight (caller falls back to Keytel)', () => {
    expect(energyBankCalories({ hrSeries: Array(60).fill(120), maxHrBpm: 190 })).toBeNull();
    expect(energyBankCalories({ hrSeries: Array(60).fill(120), weightKg: 0, maxHrBpm: 190 })).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(energyBankCalories({ hrSeries: [], weightKg: 75, maxHrBpm: 190 })).toBeNull();
  });

  it('splits burn into resting + active, totalling the two', () => {
    // 10 min steady at 150 bpm, 75 kg, rest 55, max 190.
    const r = energyBankCalories({
      hrSeries: Array(600).fill(150), weightKg: 75, restingHr: 55, maxHrBpm: 190, sampleIntervalSec: 1,
    });
    expect(r).not.toBeNull();
    expect(r.restingKcal).toBeGreaterThan(0);
    expect(r.activeKcal).toBeGreaterThan(r.restingKcal); // hard effort burns more than baseline
    expect(r.totalKcal).toBeCloseTo(Math.round((r.restingKcal + r.activeKcal) * 10) / 10, 5);
  });

  it('a harder day banks more active kcal than an easy one', () => {
    const easy = energyBankCalories({ hrSeries: Array(600).fill(95), weightKg: 75, restingHr: 55, maxHrBpm: 190 });
    const hard = energyBankCalories({ hrSeries: Array(600).fill(170), weightKg: 75, restingHr: 55, maxHrBpm: 190 });
    expect(hard.activeKcal).toBeGreaterThan(easy.activeKcal);
  });

  it('respects the sample interval (coarser series, same wall-clock → similar total)', () => {
    const oneHz = energyBankCalories({ hrSeries: Array(600).fill(150), weightKg: 75, restingHr: 55, maxHrBpm: 190, sampleIntervalSec: 1 });
    const fiveS = energyBankCalories({ hrSeries: Array(120).fill(150), weightKg: 75, restingHr: 55, maxHrBpm: 190, sampleIntervalSec: 5 });
    expect(fiveS.totalKcal).toBeCloseTo(oneHz.totalKcal, 0);
  });
});

describe('energyBankRemaining', () => {
  it('null when recovery is not finite', () => {
    expect(energyBankRemaining(null, 5)).toBeNull();
  });

  it('full recovery gives a 21-point budget', () => {
    expect(energyBankRemaining(100, 0)).toBeCloseTo(21, 5);
  });

  it('strain spends the budget down, floored at 0', () => {
    expect(energyBankRemaining(50, 5)).toBeCloseTo(10.5 - 5, 5); // budget 10.5
    expect(energyBankRemaining(50, 100)).toBe(0);
  });
});
