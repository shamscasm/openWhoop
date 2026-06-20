// Tests for sleepdetail.js sleep architecture metrics.
// All timestamps are built from a fixed base epoch so no wall-clock reads occur.
import { describe, it, expect, beforeAll } from 'vitest';
import { sleepArchitecture } from '../../../web/js/metrics/sleepdetail.js';

// Fixed base epoch: 2024-01-15T22:00:00.000Z (22:00 UTC, a plausible bedtime).
// All segment boundaries are expressed as offsets from this constant.
const BASE_MS = 1705359600000; // 2024-01-15T23:00:00.000Z

function tsAt(offsetMinutes) {
  return new Date(BASE_MS + offsetMinutes * 60_000).toISOString();
}

function seg(startMin, endMin, stage) {
  return { start_utc: tsAt(startMin), end_utc: tsAt(endMin), stage };
}

// Hypnogram: wake 10m, light 40m, deep 30m, rem 20m, wake 5m, light 30m, rem 25m
// Segment boundaries (cumulative minutes from BASE_MS):
//   [0..10]   wake
//   [10..50]  light
//   [50..80]  deep
//   [80..100] rem
//   [100..105] wake   ← WASO
//   [105..135] light
//   [135..160] rem
const HYPNOGRAM = [
  seg(0, 10, 'wake'),
  seg(10, 50, 'light'),
  seg(50, 80, 'deep'),
  seg(80, 100, 'rem'),
  seg(100, 105, 'wake'),
  seg(105, 135, 'light'),
  seg(135, 160, 'rem'),
];

// ── Known-value assertions ────────────────────────────────────────────────────
//
// timeInBedMin   = 160
// asleepMin      = 40+30+20+5(no)+30+25 = 145  (non-wake segments)
//                  → actually: 40+30+20+30+25 = 145
// sleepEffPct    = 100*145/160 = 90.625 → 90.6 (1dp)
// sleepLatency   = 10 (first segment is wake)
// wasoMin        = 5 (the mid-night wake 100..105)
// awakenings     = 1
// disturbances   = 1
// cycleCount     = 2 (rem onset at [80..100] from deep, and [135..160] from light)
// longestStretch = 90 (10..100: light 40 + deep 30 + rem 20)
// restorativePct = 100*(30+20+25)/145 = 100*75/145 ≈ 51.7 (1dp)

describe('sleepArchitecture', () => {
  describe('null / empty guard', () => {
    it('returns null for null stages', () => {
      expect(sleepArchitecture(null)).toBeNull();
    });

    it('returns null for undefined stages', () => {
      expect(sleepArchitecture(undefined)).toBeNull();
    });

    it('returns null for empty stages array', () => {
      expect(sleepArchitecture([])).toBeNull();
    });
  });

  describe('happy path – full hypnogram', () => {
    let result;
    beforeAll(() => {
      result = sleepArchitecture(HYPNOGRAM);
    });

    it('returns a non-null object', () => {
      expect(result).not.toBeNull();
    });

    it('computes timeInBedMin = 160', () => {
      expect(result.timeInBedMin).toBe(160);
    });

    it('computes asleepMin = 145 (sum of non-wake segments)', () => {
      expect(result.asleepMin).toBe(145);
    });

    it('computes sleepEfficiencyPct = 90.6', () => {
      expect(result.sleepEfficiencyPct).toBe(90.6);
    });

    it('computes sleepLatencyMin = 10', () => {
      expect(result.sleepLatencyMin).toBe(10);
    });

    it('computes wasoMin = 5', () => {
      expect(result.wasoMin).toBe(5);
    });

    it('computes disturbances = 1', () => {
      expect(result.disturbances).toBe(1);
    });

    it('computes awakenings = 1 (same as disturbances)', () => {
      expect(result.awakenings).toBe(1);
    });

    it('computes cycleCount = 2 (two rem-onset transitions)', () => {
      expect(result.cycleCount).toBe(2);
    });

    it('computes longestStretchMin = 90 (light+deep+rem before the WASO)', () => {
      expect(result.longestStretchMin).toBe(90);
    });

    it('computes restorativePct ≈ 51.7 (100*(deep+rem)/asleep)', () => {
      // 100 * 75 / 145 = 51.7241... → rounds to 51.7
      expect(result.restorativePct).toBe(51.7);
    });
  });

  describe('sleepWindow override', () => {
    it('uses the explicit window for timeInBedMin when provided', () => {
      // Extend the window 20 minutes before the first segment.
      const windowStart = new Date(BASE_MS - 20 * 60_000);
      const windowEnd = new Date(BASE_MS + 160 * 60_000);
      const result = sleepArchitecture(HYPNOGRAM, [windowStart, windowEnd]);
      expect(result.timeInBedMin).toBe(180); // 160 + 20 pre-sleep padding
    });

    it('still counts asleepMin from stage data regardless of window', () => {
      const windowStart = new Date(BASE_MS - 20 * 60_000);
      const windowEnd = new Date(BASE_MS + 160 * 60_000);
      const result = sleepArchitecture(HYPNOGRAM, [windowStart, windowEnd]);
      expect(result.asleepMin).toBe(145);
    });

    it('adds the window extension to sleepLatencyMin', () => {
      // Window starts 20m before first segment; first segment is 10m of wake.
      // Latency = 20 (window-to-stage gap) + 10 (wake segment) = 30 min.
      const windowStart = new Date(BASE_MS - 20 * 60_000);
      const windowEnd = new Date(BASE_MS + 160 * 60_000);
      const result = sleepArchitecture(HYPNOGRAM, [windowStart, windowEnd]);
      expect(result.sleepLatencyMin).toBe(30);
    });
  });

  describe('edge cases', () => {
    it('returns sleepLatencyMin=0 when first segment is non-wake', () => {
      const stages = [
        seg(0, 40, 'light'),
        seg(40, 70, 'deep'),
        seg(70, 90, 'rem'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.sleepLatencyMin).toBe(0);
    });

    it('returns wasoMin=0 and awakenings=0 when no mid-night wake', () => {
      const stages = [
        seg(0, 10, 'wake'),
        seg(10, 50, 'light'),
        seg(50, 80, 'deep'),
        seg(80, 100, 'rem'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.wasoMin).toBe(0);
      expect(result.awakenings).toBe(0);
    });

    it('does not count trailing wake as WASO', () => {
      // Trailing wake at end should be excluded from WASO.
      const stages = [
        seg(0, 40, 'light'),
        seg(40, 70, 'deep'),
        seg(70, 90, 'rem'),
        seg(90, 100, 'wake'), // trailing wake — not WASO
      ];
      const result = sleepArchitecture(stages);
      expect(result.wasoMin).toBe(0);
      expect(result.awakenings).toBe(0);
    });

    it('falls back to floor(asleepMin/90) for cycleCount when no REM present', () => {
      // 180 minutes of sleep without any REM → floor(180/90) = 2.
      const stages = [
        seg(0, 10, 'wake'),
        seg(10, 100, 'light'),
        seg(100, 190, 'deep'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.cycleCount).toBe(2);
    });

    it('cycleCount is 0 when not enough asleepMin for even one cycle (no REM)', () => {
      const stages = [
        seg(0, 45, 'light'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.cycleCount).toBe(0);
    });

    it('clamps sleepEfficiencyPct to 100 even for degenerate windows', () => {
      // If the window is shorter than asleep time (shouldn't happen in practice,
      // but guard anyway): efficiency must not exceed 100.
      const stages = [
        seg(0, 60, 'light'),
        seg(60, 120, 'deep'),
      ];
      const windowStart = new Date(BASE_MS);
      const windowEnd = new Date(BASE_MS + 60 * 60_000); // only 60 min wide
      const result = sleepArchitecture(stages, [windowStart, windowEnd]);
      expect(result.sleepEfficiencyPct).toBeLessThanOrEqual(100);
    });

    it('handles all-wake hypnogram gracefully', () => {
      const stages = [
        seg(0, 30, 'wake'),
        seg(30, 60, 'wake'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.asleepMin).toBe(0);
      expect(result.sleepEfficiencyPct).toBe(0);
      expect(result.restorativePct).toBe(0);
      expect(result.longestStretchMin).toBe(0);
      expect(result.cycleCount).toBe(0);
    });

    it('counts multiple awakenings correctly', () => {
      // Two mid-sleep wake segments.
      const stages = [
        seg(0, 5, 'wake'),   // latency
        seg(5, 45, 'light'),
        seg(45, 50, 'wake'), // WASO #1
        seg(50, 80, 'deep'),
        seg(80, 85, 'wake'), // WASO #2
        seg(85, 120, 'rem'),
      ];
      const result = sleepArchitecture(stages);
      expect(result.awakenings).toBe(2);
      expect(result.disturbances).toBe(2);
      expect(result.wasoMin).toBe(10);
    });
  });
});
