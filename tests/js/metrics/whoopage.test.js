// Physiological Age tests.
// Covers: happy path (fit/unfit 30yo), null/missing signal handling,
// known-value checks on normative helpers, confidence levels, clamping.
import { describe, it, expect } from 'vitest';
import {
  physiologicalAge,
  expectedVo2maxForAge,
  expectedRestingHrForAge,
  expectedRmssdForAge,
} from '../../../web/js/metrics/whoopage.js';

// ---------------------------------------------------------------------------
// Normative helper functions
// ---------------------------------------------------------------------------

describe('expectedVo2maxForAge', () => {
  it('returns a reasonable value at 30M (anchored at 47)', () => {
    const v = expectedVo2maxForAge(30, 'M');
    expect(v).toBeCloseTo(47, 0);
  });

  it('returns a lower value for females at the same age', () => {
    expect(expectedVo2maxForAge(40, 'F')).toBeLessThan(expectedVo2maxForAge(40, 'M'));
  });

  it('declines with age (50 < 30)', () => {
    expect(expectedVo2maxForAge(50, 'M')).toBeLessThan(expectedVo2maxForAge(30, 'M'));
  });

  it('interpolates between anchor decades', () => {
    const v35 = expectedVo2maxForAge(35, 'M');
    const v30 = expectedVo2maxForAge(30, 'M');
    const v40 = expectedVo2maxForAge(40, 'M');
    expect(v35).toBeGreaterThan(v40);
    expect(v35).toBeLessThan(v30);
  });

  it('falls back to M table for unknown sex', () => {
    expect(expectedVo2maxForAge(30, 'X')).toBe(expectedVo2maxForAge(30, 'M'));
  });
});

describe('expectedRestingHrForAge', () => {
  it('returns a reasonable value at 30M (anchored at 64)', () => {
    const v = expectedRestingHrForAge(30, 'M');
    expect(v).toBeCloseTo(64, 0);
  });

  it('increases slightly with age (60 > 30)', () => {
    expect(expectedRestingHrForAge(60, 'M')).toBeGreaterThan(expectedRestingHrForAge(30, 'M'));
  });

  it('returns slightly higher values for females', () => {
    expect(expectedRestingHrForAge(40, 'F')).toBeGreaterThan(expectedRestingHrForAge(40, 'M'));
  });
});

describe('expectedRmssdForAge', () => {
  it('returns ~57 at age 30 (anchored)', () => {
    const v = expectedRmssdForAge(30);
    expect(v).toBeCloseTo(57, 0);
  });

  it('declines with age (60 < 30)', () => {
    expect(expectedRmssdForAge(60)).toBeLessThan(expectedRmssdForAge(30));
  });

  it('interpolates between decades', () => {
    const v35 = expectedRmssdForAge(35);
    const v30 = expectedRmssdForAge(30);
    const v40 = expectedRmssdForAge(40);
    expect(v35).toBeLessThan(v30);
    expect(v35).toBeGreaterThan(v40);
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — null / insufficient input
// ---------------------------------------------------------------------------

describe('physiologicalAge — null handling', () => {
  it('returns null when chronoAge is missing', () => {
    expect(physiologicalAge({ vo2max: 50, restingHr: 60 })).toBeNull();
    expect(physiologicalAge({ chronoAge: null, vo2max: 50, restingHr: 60 })).toBeNull();
    expect(physiologicalAge({ chronoAge: NaN, vo2max: 50, restingHr: 60 })).toBeNull();
  });

  it('returns null when fewer than 2 signals are present', () => {
    // Zero signals
    expect(physiologicalAge({ chronoAge: 30 })).toBeNull();
    // Exactly one signal
    expect(physiologicalAge({ chronoAge: 30, vo2max: 47 })).toBeNull();
    expect(physiologicalAge({ chronoAge: 30, restingHr: 64 })).toBeNull();
    expect(physiologicalAge({ chronoAge: 30, rmssd: 57 })).toBeNull();
    expect(physiologicalAge({ chronoAge: 30, avgSleepMinutes: 480 })).toBeNull();
    expect(physiologicalAge({ chronoAge: 30, avgRecovery: 70 })).toBeNull();
  });

  it('ignores null/NaN individual signals but still works with remaining present ones', () => {
    // Only vo2max + restingHr are valid — should succeed.
    const r = physiologicalAge({
      chronoAge: 30,
      vo2max: 47,
      restingHr: 64,
      rmssd: null,
      avgSleepMinutes: null,
      avgRecovery: null,
    });
    expect(r).not.toBeNull();
    expect(r.drivers.map((d) => d.name)).toEqual(['vo2max', 'restingHr']);
  });

  it('ignores non-positive signals (<=0) as invalid', () => {
    // vo2max=0 and restingHr=0 should not count as valid signals.
    expect(physiologicalAge({ chronoAge: 30, vo2max: 0, restingHr: 0 })).toBeNull();
  });

  it('handles no arguments (no crash)', () => {
    expect(physiologicalAge()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — happy path: fit 30yo
// ---------------------------------------------------------------------------

describe('physiologicalAge — fit 30yo (physioAge < 30)', () => {
  // A well-trained 30yo: VO2max 58 (vs norm ~47), RHR 48 (vs norm ~64),
  // RMSSD 90 (vs norm ~57) — all signals strongly favourable.
  const fit = physiologicalAge({
    chronoAge: 30,
    sex: 'M',
    vo2max: 58,
    restingHr: 48,
    rmssd: 90,
  });

  it('returns a non-null result', () => {
    expect(fit).not.toBeNull();
  });

  it('produces physioAge strictly less than chronoAge (30)', () => {
    expect(fit.physioAge).toBeLessThan(30);
  });

  it('has a negative deltaYears', () => {
    expect(fit.deltaYears).toBeLessThan(0);
  });

  it('includes all three supplied drivers', () => {
    const names = fit.drivers.map((d) => d.name);
    expect(names).toContain('vo2max');
    expect(names).toContain('restingHr');
    expect(names).toContain('rmssd');
  });

  it('each driver has a negative yearsDelta (all signals favour youth)', () => {
    for (const d of fit.drivers) {
      expect(d.yearsDelta).toBeLessThan(0);
    }
  });

  it('confidence is low for 3 signals (medium threshold is >3)', () => {
    // 3 signals = medium per spec (>=3 is medium, >=4 is high).
    expect(fit.confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — happy path: unfit 30yo
// ---------------------------------------------------------------------------

describe('physiologicalAge — unfit 30yo (physioAge > 30)', () => {
  // Sedentary 30yo: VO2max 30 (well below norm ~47), RHR 75 (above norm ~64),
  // RMSSD 25 (below norm ~57) — all signals strongly unfavourable.
  const unfit = physiologicalAge({
    chronoAge: 30,
    sex: 'M',
    vo2max: 30,
    restingHr: 75,
    rmssd: 25,
  });

  it('returns a non-null result', () => {
    expect(unfit).not.toBeNull();
  });

  it('produces physioAge strictly greater than chronoAge (30)', () => {
    expect(unfit.physioAge).toBeGreaterThan(30);
  });

  it('has a positive deltaYears', () => {
    expect(unfit.deltaYears).toBeGreaterThan(0);
  });

  it('each driver has a positive yearsDelta (all signals unfavourable)', () => {
    for (const d of unfit.drivers) {
      expect(d.yearsDelta).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — known-value arithmetic checks
// ---------------------------------------------------------------------------

describe('physiologicalAge — known-value checks', () => {
  it('physioAge = chronoAge when all signals exactly match norms', () => {
    // At exact norms, every delta is ~0, so physioAge ≈ chronoAge.
    const age = 40;
    const r = physiologicalAge({
      chronoAge: age,
      sex: 'M',
      vo2max: expectedVo2maxForAge(age, 'M'),   // delta = 0
      restingHr: expectedRestingHrForAge(age, 'M'), // delta = 0
      rmssd: expectedRmssdForAge(age),              // delta ≈ 0 (log(1)=0)
    });
    expect(r).not.toBeNull();
    // With all deltas ~0, physioAge should be very close to chronoAge.
    expect(r.physioAge).toBeCloseTo(age, 0);
    expect(Math.abs(r.deltaYears)).toBeLessThan(1);
  });

  it('delta direction: fit 30yo is younger than unfit 30yo', () => {
    const fit = physiologicalAge({
      chronoAge: 30, sex: 'M', vo2max: 58, restingHr: 48, rmssd: 90,
    });
    const unfit = physiologicalAge({
      chronoAge: 30, sex: 'M', vo2max: 30, restingHr: 75, rmssd: 25,
    });
    expect(fit.physioAge).toBeLessThan(unfit.physioAge);
  });

  it('sleep penalty: <7h adds positive delta', () => {
    // Only sleep + restingHr (at norm) present — sleep penalty should dominate.
    const poor = physiologicalAge({
      chronoAge: 35,
      restingHr: expectedRestingHrForAge(35, 'M'), // delta ~0
      avgSleepMinutes: 240, // 4h — well below 7h threshold
    });
    expect(poor).not.toBeNull();
    const sleepDriver = poor.drivers.find((d) => d.name === 'avgSleepMinutes');
    expect(sleepDriver.yearsDelta).toBeGreaterThan(0);
  });

  it('sleep bonus: 8h gives a negative delta', () => {
    const good = physiologicalAge({
      chronoAge: 35,
      restingHr: expectedRestingHrForAge(35, 'M'), // delta ~0
      avgSleepMinutes: 480, // 8h — in bonus zone
    });
    expect(good).not.toBeNull();
    const sleepDriver = good.drivers.find((d) => d.name === 'avgSleepMinutes');
    expect(sleepDriver.yearsDelta).toBeLessThan(0);
  });

  it('recovery >66 gives negative delta; <33 gives positive delta', () => {
    const mkRecovery = (avgRecovery) =>
      physiologicalAge({ chronoAge: 35, restingHr: 65, avgRecovery });

    const green = mkRecovery(90);
    const greenDrv = green.drivers.find((d) => d.name === 'avgRecovery');
    expect(greenDrv.yearsDelta).toBeLessThan(0);

    const red = mkRecovery(20);
    const redDrv = red.drivers.find((d) => d.name === 'avgRecovery');
    expect(redDrv.yearsDelta).toBeGreaterThan(0);
  });

  it('physioAge is clamped to [18, 90]', () => {
    // An extremely unhealthy 85yo — physioAge should cap at 90.
    const old = physiologicalAge({
      chronoAge: 85,
      sex: 'M',
      vo2max: 10,  // catastrophically low
      restingHr: 100, // very high
      rmssd: 5,    // very low
    });
    expect(old).not.toBeNull();
    expect(old.physioAge).toBeLessThanOrEqual(90);

    // An extremely fit 18yo — physioAge should not go below 18.
    const young = physiologicalAge({
      chronoAge: 18,
      sex: 'M',
      vo2max: 90,
      restingHr: 30,
      rmssd: 200,
    });
    expect(young).not.toBeNull();
    expect(young.physioAge).toBeGreaterThanOrEqual(18);
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — confidence levels
// ---------------------------------------------------------------------------

describe('physiologicalAge — confidence', () => {
  const base = { chronoAge: 40 };

  it('low with exactly 2 signals', () => {
    const r = physiologicalAge({ ...base, vo2max: 43, restingHr: 64 });
    expect(r.confidence).toBe('low');
  });

  it('medium with exactly 3 signals', () => {
    const r = physiologicalAge({ ...base, vo2max: 43, restingHr: 64, rmssd: 49 });
    expect(r.confidence).toBe('medium');
  });

  it('high with 4 or more signals', () => {
    const r = physiologicalAge({ ...base, vo2max: 43, restingHr: 64, rmssd: 49, avgSleepMinutes: 480 });
    expect(r.confidence).toBe('high');

    const r5 = physiologicalAge({ ...base, vo2max: 43, restingHr: 64, rmssd: 49, avgSleepMinutes: 480, avgRecovery: 70 });
    expect(r5.confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — output shape
// ---------------------------------------------------------------------------

describe('physiologicalAge — output shape', () => {
  it('result contains all required fields', () => {
    const r = physiologicalAge({ chronoAge: 30, sex: 'F', vo2max: 40, restingHr: 67 });
    expect(r).toMatchObject({
      physioAge: expect.any(Number),
      chronoAge: 30,
      deltaYears: expect.any(Number),
      drivers: expect.any(Array),
      confidence: expect.stringMatching(/^(low|medium|high)$/),
    });
  });

  it('each driver has name, label, yearsDelta (number), and weight (number)', () => {
    const r = physiologicalAge({
      chronoAge: 30, vo2max: 47, restingHr: 64, rmssd: 57,
    });
    for (const d of r.drivers) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.label).toBe('string');
      expect(typeof d.yearsDelta).toBe('number');
      expect(typeof d.weight).toBe('number');
    }
  });

  it('deltaYears = physioAge - chronoAge (round-trip)', () => {
    const r = physiologicalAge({
      chronoAge: 35, sex: 'M', vo2max: 50, restingHr: 60, rmssd: 65,
    });
    expect(r.deltaYears).toBeCloseTo(r.physioAge - r.chronoAge, 5);
  });
});

// ---------------------------------------------------------------------------
// physiologicalAge — sex stratification
// ---------------------------------------------------------------------------

describe('physiologicalAge — sex stratification', () => {
  it('same raw VO2max produces different delta for M vs F (different norms)', () => {
    const m = physiologicalAge({ chronoAge: 30, sex: 'M', vo2max: 47, restingHr: 65 });
    const f = physiologicalAge({ chronoAge: 30, sex: 'F', vo2max: 47, restingHr: 67 });
    // M norm at 30 is 47 (delta ~0). F norm at 30 is 40 (delta negative = younger for F).
    const mVo2 = m.drivers.find((d) => d.name === 'vo2max');
    const fVo2 = f.drivers.find((d) => d.name === 'vo2max');
    // For F, 47 > norm 40 -> fitter -> younger delta.
    expect(fVo2.yearsDelta).toBeLessThan(mVo2.yearsDelta);
  });
});
