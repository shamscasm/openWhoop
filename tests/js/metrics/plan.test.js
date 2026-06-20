// Tests for the daily training plan engine.

import { describe, it, expect } from 'vitest';
import { dailyPlan, ZONES } from '../../../web/js/metrics/plan.js';

describe('dailyPlan', () => {
  it('returns active recovery when no recovery data', () => {
    const p = dailyPlan({ recoveryScore: null });
    expect(p.zone).toBe('active');
  });

  it('returns rest when recovery < 33%', () => {
    const p = dailyPlan({ recoveryScore: 20 });
    expect(p.zone).toBe('rest');
    expect(p.strainRange[1]).toBeLessThanOrEqual(6);
  });

  it('returns rest when low streak active regardless of score', () => {
    const p = dailyPlan({ recoveryScore: 65, lowStreakDays: true });
    expect(p.zone).toBe('rest');
  });

  it('returns active when yellow zone (33–49%)', () => {
    const p = dailyPlan({ recoveryScore: 45 });
    expect(p.zone).toBe('active');
  });

  it('returns train when recovery 50–66%', () => {
    const p = dailyPlan({ recoveryScore: 60 });
    expect(p.zone).toBe('train');
  });

  it('returns push when recovery ≥ 67% and good sleep', () => {
    const p = dailyPlan({
      recoveryScore: 80,
      sleepPerformancePct: 90,
      sleepDebtMinutes: 0,
      avgStrain7d: 10,
    });
    expect(p.zone).toBe('push');
    expect(p.strainRange[0]).toBeGreaterThanOrEqual(16);
  });

  it('caps at train when green recovery but high weekly load', () => {
    const p = dailyPlan({ recoveryScore: 75, avgStrain7d: 18 });
    expect(p.zone).toBe('train');
  });

  it('caps at train when green recovery but poor sleep', () => {
    const p = dailyPlan({ recoveryScore: 75, sleepPerformancePct: 50, avgStrain7d: 10 });
    expect(p.zone).toBe('train');
  });

  it('caps at active when yellow + high sleep debt', () => {
    const p = dailyPlan({ recoveryScore: 55, sleepDebtMinutes: 240 }); // 4h debt
    expect(p.zone).toBe('active');
  });

  it('returns push for ideal conditions', () => {
    const p = dailyPlan({
      recoveryScore: 90,
      sleepPerformancePct: 95,
      sleepDebtMinutes: 0,
      avgStrain7d: 12,
      lowStreakDays: false,
    });
    expect(p.zone).toBe('push');
    expect(p.hrZoneCap).toBe(5);
  });

  it('result always includes required fields', () => {
    for (const score of [10, 40, 55, 80]) {
      const p = dailyPlan({ recoveryScore: score });
      expect(typeof p.zone).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.emoji).toBe('string');
      expect(Array.isArray(p.strainRange)).toBe(true);
      expect(typeof p.hrZoneCap).toBe('number');
      expect(typeof p.color).toBe('string');
      expect(typeof p.message).toBe('string');
      expect(typeof p.rationale).toBe('string');
      expect(typeof p.targetStrain).toBe('number');
    }
  });

  it('ZONES export covers all 4 zones', () => {
    expect(Object.keys(ZONES)).toEqual(['rest', 'active', 'train', 'push']);
  });
});
