import { describe, it, expect } from 'vitest';
import { estimateStepsFromAccel } from '../../../web/js/metrics/steps.js';

describe('estimateStepsFromAccel', () => {
  it('counts periodic accel peaks as strap steps', () => {
    const start = Date.UTC(2026, 5, 1, 12, 0, 0);
    const rows = [];
    for (let i = 0; i < 240; i++) {
      const phase = i % 8;
      const peak = phase === 0 ? 120 : phase === 1 || phase === 7 ? 50 : 8;
      rows.push({
        ts_utc: new Date(start + i * 125).toISOString(),
        accel_x: peak,
        accel_y: 0,
        accel_z: 0,
      });
    }
    const out = estimateStepsFromAccel(rows);
    expect(out.source).toBe('strap_accel');
    expect(out.steps).toBeGreaterThan(20);
    expect(out.confidencePct).toBeGreaterThan(0);
  });

  it('returns null without enough accel signal', () => {
    expect(estimateStepsFromAccel([{ ts_utc: new Date().toISOString(), heart_rate_bpm: 70 }]).steps).toBeNull();
  });
});
