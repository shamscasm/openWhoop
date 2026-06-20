// Recovery score tests, ported from tests/test_metrics.py and extended
// with synthetic coverage for the 4-component breakdown that the original
// Python tests exercised only via the DB-touching integration path.
import { describe, it, expect } from 'vitest';
import {
  recoveryScore,
  recoveryBreakdown,
  RECOVERY_WEIGHTS,
  RECOVERY_BASELINE_DAYS,
} from '../../../web/js/metrics/recovery.js';

describe('recoveryScore (single-component, legacy)', () => {
  it('returns ~50 when today is at the baseline mean', () => {
    const history = [50.0, 52.0, 48.0, 51.0, 49.0];
    const score = recoveryScore(50.0, history);
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(60);
  });

  it('returns > 80 when today is far above baseline', () => {
    const history = [50.0, 52.0, 48.0, 51.0, 49.0];
    const score = recoveryScore(100.0, history);
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(80);
  });

  it('returns < 20 when today is far below baseline', () => {
    const history = [50.0, 52.0, 48.0, 51.0, 49.0];
    const score = recoveryScore(20.0, history);
    expect(score).not.toBeNull();
    expect(score).toBeLessThan(20);
  });

  it('is null without enough history', () => {
    expect(recoveryScore(50.0, [])).toBeNull();
    expect(recoveryScore(50.0, [50.0])).toBeNull(); // need >= 3
  });

  it('is null when today is null', () => {
    expect(recoveryScore(null, [50.0, 52.0, 48.0])).toBeNull();
  });

  it('clamps the z-score at +/- 3 sigma so values stay in [0, 100]', () => {
    const history = [50.0, 50.0, 50.0, 50.0, 50.0]; // sigma -> 0 -> 1.0 fallback
    const high = recoveryScore(10000.0, history);
    const low = recoveryScore(-10000.0, history);
    expect(high).toBe(100.0);
    expect(low).toBe(0.0);
  });
});

describe('RECOVERY_WEIGHTS', () => {
  it('exposes the five sub-component weights (renormalised per present component)', () => {
    expect(Object.keys(RECOVERY_WEIGHTS).sort()).toEqual([
      'hrv',
      'resp',
      'rhr',
      'sleep',
      'strain',
    ]);
    // All five weights sum to 1.0
    const totalSum = RECOVERY_WEIGHTS.hrv + RECOVERY_WEIGHTS.rhr +
      RECOVERY_WEIGHTS.sleep + RECOVERY_WEIGHTS.resp + RECOVERY_WEIGHTS.strain;
    expect(totalSum).toBeCloseTo(1.0, 9);
  });

  it('resp is null when no respiratory data provided', () => {
    const result = recoveryBreakdown({
      todayRmssd: 55, rmssdHistory: [50, 51, 49, 50, 52, 48],
      todayRhr: 52, rhrHistory: [55, 54, 56, 55, 53, 55],
      sleepPerformancePct: 80, yesterdayStrain: 10,
    });
    expect(result.resp).toBeNull();
  });

  it('folds resp in when respiratory data is present', () => {
    const base = {
      todayRmssd: 55, rmssdHistory: [50, 51, 49, 50, 52, 48],
      todayRhr: 52, rhrHistory: [55, 54, 56, 55, 53, 55],
      sleepPerformancePct: 80, yesterdayStrain: 10,
    };
    const withResp = recoveryBreakdown({
      ...base, todayRespRate: 13, respHistory: [15, 15, 16, 15, 14, 15],
    });
    expect(withResp.resp).not.toBeNull();        // low resp vs baseline → good
    expect(withResp.resp).toBeGreaterThan(50);
  });

  it('exposes the rolling baseline length (14 days)', () => {
    expect(RECOVERY_BASELINE_DAYS).toBe(14);
  });
});

describe('recoveryBreakdown', () => {
  // A stable 14-day baseline for HRV (mean=50, stdev ~1.5) and RHR
  // (mean=55, stdev ~1.5). Using stable history makes the z-score
  // arithmetic easy to follow.
  const rmssdHist = [50, 52, 48, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51];
  const rhrHist = [55, 57, 53, 56, 54, 55, 57, 53, 56, 54, 55, 57, 53, 56];

  it('produces a 4-component dict with a weighted total when all inputs present', () => {
    const result = recoveryBreakdown({
      todayRmssd: 50.0,
      rmssdHistory: rmssdHist,
      todayRhr: 55.0,
      rhrHistory: rhrHist,
      sleepPerformancePct: 90.0,
      yesterdayStrain: 10.0,
    });
    expect(result).toMatchObject({
      hrv: expect.any(Number),
      rhr: expect.any(Number),
      sleep: expect.any(Number),
      strain: expect.any(Number),
      total: expect.any(Number),
    });
    // HRV exactly at baseline -> ~50
    expect(result.hrv).toBeGreaterThanOrEqual(45);
    expect(result.hrv).toBeLessThanOrEqual(55);
    // Sleep performance passed straight through (rounded)
    expect(result.sleep).toBe(90.0);
    // Strain = 100 - (10/21*100) = 100 - 47.619... = 52.4
    expect(result.strain).toBeCloseTo(52.4, 1);
  });

  it('returns the weighted average as the total', () => {
    // Build known component scores by manually crafting balanced inputs.
    const result = recoveryBreakdown({
      todayRmssd: 50.0, // hrv ~ 50
      rmssdHistory: rmssdHist,
      todayRhr: 55.0, // rhr ~ 50
      rhrHistory: rhrHist,
      sleepPerformancePct: 80.0, // sleep = 80
      yesterdayStrain: 0.0, // strain = 100
    });
    // Weighted sum with renormalisation (weights sum to 1.0 with all 5, but resp is null)
    const usedWeightSum = RECOVERY_WEIGHTS.hrv + RECOVERY_WEIGHTS.rhr +
      RECOVERY_WEIGHTS.sleep + RECOVERY_WEIGHTS.strain;
    const manual =
      (result.hrv * RECOVERY_WEIGHTS.hrv +
       result.rhr * RECOVERY_WEIGHTS.rhr +
       result.sleep * RECOVERY_WEIGHTS.sleep +
       result.strain * RECOVERY_WEIGHTS.strain) / usedWeightSum;
    expect(result.total).toBeCloseTo(Math.round(manual * 10) / 10, 1);
  });

  it('renormalises remaining weights when some components are missing', () => {
    // No HRV history, no RHR history, no strain -> only sleep is used.
    const result = recoveryBreakdown({
      todayRmssd: 50.0,
      rmssdHistory: [], // < 3 -> hrv null
      todayRhr: 55.0,
      rhrHistory: [], // < 3 -> rhr null
      sleepPerformancePct: 73.4,
      yesterdayStrain: null,
    });
    expect(result.hrv).toBeNull();
    expect(result.rhr).toBeNull();
    expect(result.strain).toBeNull();
    expect(result.sleep).toBe(73.4);
    expect(result.total).toBe(73.4);
  });

  it('returns total=null when every component is missing', () => {
    const result = recoveryBreakdown({
      todayRmssd: null,
      rmssdHistory: [],
      todayRhr: null,
      rhrHistory: [],
      sleepPerformancePct: null,
      yesterdayStrain: null,
    });
    expect(result.hrv).toBeNull();
    expect(result.rhr).toBeNull();
    expect(result.sleep).toBeNull();
    expect(result.strain).toBeNull();
    expect(result.total).toBeNull();
  });

  it('treats RHR as inverted (lower vs baseline => higher score)', () => {
    // Today's RHR well below baseline -> rhr component should be > 50.
    const low = recoveryBreakdown({
      todayRmssd: null,
      rmssdHistory: [],
      todayRhr: 45.0,
      rhrHistory: rhrHist,
      sleepPerformancePct: null,
      yesterdayStrain: null,
    });
    expect(low.rhr).toBeGreaterThan(50);

    // Today's RHR well above baseline -> rhr component should be < 50.
    const high = recoveryBreakdown({
      todayRmssd: null,
      rmssdHistory: [],
      todayRhr: 70.0,
      rhrHistory: rhrHist,
      sleepPerformancePct: null,
      yesterdayStrain: null,
    });
    expect(high.rhr).toBeLessThan(50);
  });

  it('clamps the strain component to [0, 100]', () => {
    // yesterday_strain > 21 would push the formula negative; we clamp at 0.
    const huge = recoveryBreakdown({
      todayRmssd: null,
      rmssdHistory: [],
      todayRhr: null,
      rhrHistory: [],
      sleepPerformancePct: null,
      yesterdayStrain: 50.0,
    });
    expect(huge.strain).toBe(0.0);

    // negative strain -> capped at 100
    const tiny = recoveryBreakdown({
      todayRmssd: null,
      rmssdHistory: [],
      todayRhr: null,
      rhrHistory: [],
      sleepPerformancePct: null,
      yesterdayStrain: -5.0,
    });
    expect(tiny.strain).toBe(100.0);
  });
});
