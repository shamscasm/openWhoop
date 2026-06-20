// Tests for the weekly summary generator.

import { describe, it, expect } from 'vitest';
import { weeklySummary } from '../../../web/js/metrics/weekly.js';

function makeMetrics(overrides = []) {
  const base = {
    date: '2026-05-20',
    recovery_score: 65,
    strain_score: 10,
    sleep_minutes: 450,
    rmssd_ms: 55,
    resting_hr: 50,
    calories: 2200,
  };
  return overrides.map((o, i) => ({
    ...base,
    date: `2026-05-${String(20 - i).padStart(2, '0')}`,
    ...o,
  }));
}

describe('weeklySummary', () => {
  it('returns safe defaults when no data', () => {
    const s = weeklySummary([]);
    expect(s.days).toBe(0);
    expect(s.avgRecovery).toBeNull();
    expect(s.summary).toBe('No data yet.');
  });

  it('uses at most 7 days even if more are passed', () => {
    const metrics = makeMetrics(Array(14).fill({}));
    const s = weeklySummary(metrics);
    expect(s.days).toBe(7);
  });

  it('computes correct averages', () => {
    const metrics = makeMetrics([
      { recovery_score: 80, strain_score: 14, sleep_minutes: 480, rmssd_ms: 60, resting_hr: 48 },
      { recovery_score: 60, strain_score: 10, sleep_minutes: 420, rmssd_ms: 50, resting_hr: 52 },
      { recovery_score: 40, strain_score: 6,  sleep_minutes: 390, rmssd_ms: 40, resting_hr: 55 },
    ]);
    const s = weeklySummary(metrics);
    expect(s.days).toBe(3);
    expect(s.avgRecovery).toBeCloseTo((80 + 60 + 40) / 3, 1);
    expect(s.avgStrain).toBeCloseTo((14 + 10 + 6) / 3, 1);
    expect(s.avgSleepH).toBeCloseTo((480 + 420 + 390) / 3 / 60, 2);
  });

  it('counts green and red days correctly', () => {
    const metrics = makeMetrics([
      { recovery_score: 80 },
      { recovery_score: 70 },
      { recovery_score: 45 },
      { recovery_score: 20 },
      { recovery_score: 30 },
    ]);
    const s = weeklySummary(metrics);
    expect(s.greenDays).toBe(2);
    expect(s.redDays).toBe(2);
  });

  it('identifies best and worst recovery', () => {
    const metrics = makeMetrics([
      { recovery_score: 55 },
      { recovery_score: 90 },
      { recovery_score: 15 },
    ]);
    const s = weeklySummary(metrics);
    expect(s.bestRecovery.score).toBe(90);
    expect(s.worstRecovery.score).toBe(15);
  });

  it('counts workout days (strain > 10)', () => {
    const metrics = makeMetrics([
      { strain_score: 15 },
      { strain_score: 11 },
      { strain_score: 8 },
      { strain_score: 5 },
    ]);
    const s = weeklySummary(metrics);
    expect(s.workoutCount).toBe(2);
  });

  it('handles null fields gracefully', () => {
    // All metrics have null rmssd_ms — avgRmssd should be null.
    const metrics = makeMetrics([
      { recovery_score: 70, rmssd_ms: null },
      { recovery_score: 55, rmssd_ms: null },
    ]);
    const s = weeklySummary(metrics);
    expect(s.avgRecovery).toBeCloseTo(62.5, 1);
    expect(s.avgRmssd).toBeNull();
  });

  it('produces a non-empty summary string', () => {
    const metrics = makeMetrics(Array(7).fill({}));
    const s = weeklySummary(metrics);
    expect(s.summary.length).toBeGreaterThan(10);
    expect(s.summary).toContain('recovery');
  });
});

  it('aggregates zone_minutes across all days', () => {
    const makeRow = (zones) => ({
      recovery_score: 65, rmssd_ms: 55, resting_hr: 50, strain_score: 12,
      sleep_minutes: 450, calories: 600, zone_minutes: zones,
    });
    const metrics = [
      makeRow([30, 45, 20, 10, 5]),
      makeRow([20, 40, 15, 8, 2]),
      makeRow([25, 50, 10, 5, 0]),
      makeRow([10, 30, 12, 6, 0]),
      makeRow([15, 35, 18, 9, 3]),
      makeRow([20, 42, 22, 11, 4]),
      makeRow([18, 38, 16, 7, 1]),
    ];
    const s = weeklySummary(metrics);
    expect(s.hasZoneData).toBe(true);
    expect(s.zoneSum[0]).toBe(30 + 20 + 25 + 10 + 15 + 20 + 18); // Z1 sum = 138
    expect(s.zoneSum[4]).toBe(5 + 2 + 0 + 0 + 3 + 4 + 1);         // Z5 sum = 15
    expect(s.summary).toMatch(/Week zones/);
  });

  it('skips zone line when no zone data', () => {
    const metrics = makeMetrics(Array(7).fill({})); // no zone_minutes field
    const s = weeklySummary(metrics);
    expect(s.hasZoneData).toBe(false);
    expect(s.summary).not.toMatch(/Week zones/);
  });
