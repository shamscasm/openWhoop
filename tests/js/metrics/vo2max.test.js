import { describe, it, expect } from 'vitest';
import {
  estimateVo2max,
  vo2maxCategory,
  fitnessAge,
  vo2maxReport,
} from '../../../web/js/metrics/vo2max.js';

// ---------------------------------------------------------------------------
// estimateVo2max
// ---------------------------------------------------------------------------
describe('estimateVo2max', () => {
  it('matches the known Uth-Sorensen value: RHR 50, age 30 -> ~58.1', () => {
    // HRmax = 220 - 30 = 190; VO2max = 15.3 * (190 / 50) = 15.3 * 3.8 = 58.14
    const result = estimateVo2max({ restingHr: 50, age: 30 });
    expect(result).toBeCloseTo(58.1, 1);
  });

  it('accepts an explicit maxHrOverride', () => {
    // 15.3 * (200 / 50) = 15.3 * 4.0 = 61.2
    const result = estimateVo2max({ restingHr: 50, age: 30, maxHrOverride: 200 });
    expect(result).toBeCloseTo(61.2, 1);
  });

  it('clamps unrealistically high values to 80', () => {
    // Very low RHR produces raw > 80; must clamp.
    const result = estimateVo2max({ restingHr: 20, age: 20 });
    expect(result).toBe(80.0);
  });

  it('clamps unrealistically low values to 20', () => {
    // Very high RHR at old age produces raw < 20; must clamp.
    const result = estimateVo2max({ restingHr: 140, age: 90 });
    expect(result).toBe(20.0);
  });

  it('returns null when restingHr is null', () => {
    expect(estimateVo2max({ restingHr: null, age: 30 })).toBeNull();
  });

  it('returns null when restingHr is undefined', () => {
    expect(estimateVo2max({ restingHr: undefined, age: 30 })).toBeNull();
  });

  it('returns null when restingHr is 0', () => {
    expect(estimateVo2max({ restingHr: 0, age: 30 })).toBeNull();
  });

  it('returns null when restingHr is negative', () => {
    expect(estimateVo2max({ restingHr: -5, age: 30 })).toBeNull();
  });

  it('returns null when age is null', () => {
    expect(estimateVo2max({ restingHr: 60, age: null })).toBeNull();
  });

  it('returns null when age is 0', () => {
    expect(estimateVo2max({ restingHr: 60, age: 0 })).toBeNull();
  });

  it('uses sex parameter without error (sex does not affect formula)', () => {
    const m = estimateVo2max({ restingHr: 60, age: 30, sex: 'M' });
    const f = estimateVo2max({ restingHr: 60, age: 30, sex: 'F' });
    // Uth-Sorensen formula is sex-neutral; both must be equal
    expect(m).toBe(f);
  });

  it('rounds to one decimal place', () => {
    const result = estimateVo2max({ restingHr: 55, age: 35 });
    expect(result).not.toBeNull();
    // Result should be finite and have at most 1 decimal
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(Math.round(result * 10) / 10);
  });
});

// ---------------------------------------------------------------------------
// vo2maxCategory
// ---------------------------------------------------------------------------
describe('vo2maxCategory', () => {
  it('labels a well-trained 30-year-old male as Excellent or Superior', () => {
    // VO2max 50 for age 30 M -> cutoffs: Poor<31, Fair<36, Good<41, Excellent<45, Superior>=50
    const cat = vo2maxCategory(50, 30, 'M');
    expect(['Excellent', 'Superior']).toContain(cat);
  });

  it('labels 58 for a 30-year-old male as Superior', () => {
    expect(vo2maxCategory(58, 30, 'M')).toBe('Superior');
  });

  it('labels a low value as Poor (30 M)', () => {
    expect(vo2maxCategory(28, 30, 'M')).toBe('Poor');
  });

  it('applies female norms correctly (lower cutoffs)', () => {
    // 35 mL/kg/min for a 30-year-old female = Good (cutoff 30) or above
    const cat = vo2maxCategory(35, 30, 'F');
    expect(['Good', 'Excellent', 'Superior']).toContain(cat);
  });

  it('labels a very high female VO2max as Superior', () => {
    // 40 for age 30 F -> cutoffs top is 37 for Superior
    expect(vo2maxCategory(40, 30, 'F')).toBe('Superior');
  });

  it('handles the 60s age band for male', () => {
    // age 65, VO2max 36 -> cutoff for Superior is 40; Excellent starts at 36
    const cat = vo2maxCategory(36, 65, 'M');
    expect(cat).toBe('Excellent');
  });

  it('uses the 70+ band for age > 70', () => {
    const cat = vo2maxCategory(29, 75, 'M');
    expect(['Good', 'Excellent', 'Superior']).toContain(cat);
  });

  it('returns Poor when vo2max is null', () => {
    expect(vo2maxCategory(null, 30, 'M')).toBe('Poor');
  });

  it('returns Poor when age is null', () => {
    expect(vo2maxCategory(45, null, 'M')).toBe('Poor');
  });

  it('defaults sex to M when omitted', () => {
    const withM = vo2maxCategory(45, 30, 'M');
    const defaulted = vo2maxCategory(45, 30);
    expect(defaulted).toBe(withM);
  });
});

// ---------------------------------------------------------------------------
// fitnessAge
// ---------------------------------------------------------------------------
describe('fitnessAge', () => {
  it('returns 18 for an extremely high VO2max (beyond top of curve)', () => {
    expect(fitnessAge({ vo2max: 80, sex: 'M' })).toBe(18);
  });

  it('returns 85 for a very low VO2max (below bottom of curve)', () => {
    expect(fitnessAge({ vo2max: 5, sex: 'M' })).toBe(85);
  });

  it('a VO2max matching the 30-year male median returns ~30', () => {
    // Male median at 30 is 41 mL/kg/min per the curve
    const fa = fitnessAge({ vo2max: 41, sex: 'M' });
    expect(fa).toBeGreaterThanOrEqual(25);
    expect(fa).toBeLessThanOrEqual(35);
  });

  it('a VO2max matching the 50-year female median returns ~50', () => {
    // Female median at 50 is 25 mL/kg/min per the curve
    const fa = fitnessAge({ vo2max: 25, sex: 'F' });
    expect(fa).toBeGreaterThanOrEqual(45);
    expect(fa).toBeLessThanOrEqual(55);
  });

  it('clamps the result to at least 18', () => {
    const fa = fitnessAge({ vo2max: 79, sex: 'M' });
    expect(fa).toBeGreaterThanOrEqual(18);
  });

  it('clamps the result to at most 85', () => {
    const fa = fitnessAge({ vo2max: 10, sex: 'F' });
    expect(fa).toBeLessThanOrEqual(85);
  });

  it('returns null when vo2max is null', () => {
    expect(fitnessAge({ vo2max: null, sex: 'M' })).toBeNull();
  });

  it('returns null when vo2max is 0', () => {
    expect(fitnessAge({ vo2max: 0, sex: 'M' })).toBeNull();
  });

  it('returns null when vo2max is undefined', () => {
    expect(fitnessAge({ vo2max: undefined, sex: 'M' })).toBeNull();
  });

  it('returns a whole number (rounded)', () => {
    const fa = fitnessAge({ vo2max: 38, sex: 'M' });
    expect(Number.isInteger(fa)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vo2maxReport (convenience wrapper)
// ---------------------------------------------------------------------------
describe('vo2maxReport', () => {
  it('returns all four fields for a healthy 30-year-old male', () => {
    // RHR 50, age 30, HRmax 190 -> VO2max ~= 58.1
    const report = vo2maxReport({ restingHr: 50, age: 30 });
    expect(report.vo2max).toBeCloseTo(58.1, 1);
    expect(typeof report.category).toBe('string');
    expect(report.fitnessAge).not.toBeNull();
    expect(typeof report.fitnessAgeDelta).toBe('number');
  });

  it('fitnessAgeDelta is negative (fitter than chronological age) for an athlete', () => {
    // RHR 50, age 40 -> HRmax 180 -> VO2max ~= 15.3 * 3.6 = 55.08
    // Fitness age for M at 55 VO2max is well below 40
    const report = vo2maxReport({ restingHr: 50, age: 40 });
    expect(report.fitnessAgeDelta).toBeLessThan(0);
  });

  it('fitnessAgeDelta is positive (older) for a sedentary user', () => {
    // RHR 90, age 30 -> HRmax 190 -> VO2max = 15.3 * (190/90) ~= 32.3
    const report = vo2maxReport({ restingHr: 90, age: 30 });
    expect(report.fitnessAgeDelta).toBeGreaterThan(0);
  });

  it('returns null vo2max and null fitnessAge when restingHr is missing', () => {
    const report = vo2maxReport({ restingHr: null, age: 30 });
    expect(report.vo2max).toBeNull();
    expect(report.fitnessAge).toBeNull();
    expect(report.fitnessAgeDelta).toBeNull();
    expect(report.category).toBe('Poor');
  });

  it('accepts a maxHrOverride', () => {
    // 15.3 * (180 / 50) = 15.3 * 3.6 = 55.08
    const report = vo2maxReport({ restingHr: 50, age: 30, maxHrOverride: 180 });
    expect(report.vo2max).toBeCloseTo(55.1, 1);
  });

  it('works for female sex', () => {
    const report = vo2maxReport({ restingHr: 65, age: 35, sex: 'F' });
    expect(report.vo2max).not.toBeNull();
    expect(['Poor', 'Fair', 'Good', 'Excellent', 'Superior']).toContain(report.category);
  });

  it('fitnessAgeDelta equals fitnessAge minus age', () => {
    const report = vo2maxReport({ restingHr: 60, age: 40, sex: 'M' });
    if (report.fitnessAge !== null) {
      expect(report.fitnessAgeDelta).toBe(report.fitnessAge - 40);
    }
  });
});
