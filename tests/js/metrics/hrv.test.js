// HRV math sanity tests, ported from tests/test_metrics.py.
import { describe, it, expect } from 'vitest';
import { filterRr, rmssd, sdnn, pnn50 } from '../../../web/js/metrics/hrv.js';

// Population stdev (Python's statistics.pstdev), used to mirror the source test.
function pstdev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// Deterministic Box-Muller Gaussian sampler — mirrors the spirit of the
// Python `random.seed(7) + random.gauss(0, 25)` test; we don't need identical
// values, just a reproducible distribution to land inside the same range.
function seededGaussian(seed) {
  let state = seed >>> 0;
  const rand = () => {
    // Mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (mean, std) => {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * std;
  };
}

describe('filterRr', () => {
  it('drops ectopic beats', () => {
    const rr = [800, 810, 805, 1300, 800, 795]; // 1300 is an ectopic spike
    const out = filterRr(rr);
    expect(out.includes(1300)).toBe(false);
    expect(out.length).toBe(5);
  });

  it('recovers from an implausible first-beat anchor (BLE reconnect artifact)', () => {
    // A 2000 ms first interval used to anchor the Malik check and reject every
    // subsequent normal beat, collapsing HRV to null. Median anchoring fixes it.
    const rr = [2000, 1000, 1010, 990, 1005, 995, 1002];
    const out = filterRr(rr);
    expect(out.includes(2000)).toBe(false);
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(rmssd(rr)).not.toBeNull();
  });

  it('discards out-of-band intervals entirely', () => {
    const out = filterRr([100, 1000, 1005, 995, 1002, 9000]);
    expect(out.includes(100)).toBe(false);
    expect(out.includes(9000)).toBe(false);
  });
});

describe('rmssd', () => {
  it('is zero for constant intervals', () => {
    const value = rmssd(Array(30).fill(800));
    expect(value === 0.0 || value < 0.001).toBe(true);
  });

  it('matches known value for alternating pattern', () => {
    // Alternating: successive diffs are +10/-10, squared diffs = 100,
    // mean = 100, sqrt = 10.
    const rr = [800, 810, 800, 810, 800, 810, 800, 810, 800, 810];
    const value = rmssd(rr);
    expect(value).not.toBeNull();
    expect(value).toBeCloseTo(10.0, 9);
  });

  it('lands in the typical resting range with Gaussian jitter', () => {
    const gauss = seededGaussian(7);
    const rr = [];
    for (let i = 0; i < 300; i++) {
      rr.push(Math.trunc(900 + gauss(0, 25)));
    }
    const value = rmssd(rr);
    expect(value).not.toBeNull();
    expect(value).toBeGreaterThan(10);
    expect(value).toBeLessThan(200);
  });
});

describe('sdnn', () => {
  it('matches population standard deviation', () => {
    const rr = [800, 820, 790, 810, 800, 815, 795];
    const sd = sdnn(rr);
    expect(sd).not.toBeNull();
    expect(sd).toBeCloseTo(pstdev(rr), 9);
  });
});

describe('pnn50', () => {
  it('is 100% when every successive diff exceeds 50 ms', () => {
    const rr = [800, 900, 800, 900, 800, 900];
    const val = pnn50(rr);
    expect(val).not.toBeNull();
    expect(val).toBe(100.0);
  });

  it('is 0% when no successive diff exceeds 50 ms', () => {
    const rr = [800, 810, 820, 830, 840];
    const val = pnn50(rr);
    expect(val).toBe(0.0);
  });
});
