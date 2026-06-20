import { describe, it, expect } from 'vitest';
import { healthMonitor } from '../../../web/js/metrics/healthmonitor.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a baseline-row with only the HR-only fields a real strap populates.
 * All other fields default to null.
 */
function makeBaselineRow({ resting_hr = null, rmssd_ms = null, respiratory_rate = null, avg_spo2 = null, skin_temp_deviation_c = null } = {}) {
  return {
    date: '2026-01-01',
    avg_hr: null,
    min_hr: null,
    max_hr: null,
    resting_hr,
    rmssd_ms,
    hrv_baseline_ms: null,
    sdnn_ms: null,
    pnn50_pct: null,
    avg_spo2,
    avg_skin_temp_c: null,
    skin_temp_deviation_c,
    strain_score: null,
    recovery_score: null,
    sleep_minutes: null,
    deep_sleep_minutes: null,
    rem_sleep_minutes: null,
    light_sleep_minutes: null,
    wake_minutes: null,
    sleep_need_minutes: null,
    sleep_performance_pct: null,
    sleep_debt_minutes: null,
    sleep_consistency_pct: null,
    respiratory_rate,
    stress_avg: null,
    calories: null,
    zone_minutes: [0, 0, 0, 0, 0],
    bedtime_local: null,
    wake_local: null,
  };
}

/** 10 baseline rows with stable RHR ~55 bpm and RMSSD ~40 ms. */
const stableBaseline = [
  makeBaselineRow({ resting_hr: 55, rmssd_ms: 40 }),
  makeBaselineRow({ resting_hr: 56, rmssd_ms: 41 }),
  makeBaselineRow({ resting_hr: 54, rmssd_ms: 39 }),
  makeBaselineRow({ resting_hr: 55, rmssd_ms: 40 }),
  makeBaselineRow({ resting_hr: 57, rmssd_ms: 42 }),
  makeBaselineRow({ resting_hr: 55, rmssd_ms: 40 }),
  makeBaselineRow({ resting_hr: 56, rmssd_ms: 38 }),
  makeBaselineRow({ resting_hr: 54, rmssd_ms: 41 }),
  makeBaselineRow({ resting_hr: 55, rmssd_ms: 40 }),
  makeBaselineRow({ resting_hr: 56, rmssd_ms: 39 }),
];

// ---------------------------------------------------------------------------
// Null / guard cases
// ---------------------------------------------------------------------------

describe('healthMonitor — guard cases', () => {
  it('returns null when today is null', () => {
    expect(healthMonitor(null, stableBaseline)).toBeNull();
  });

  it('returns null when today is undefined', () => {
    expect(healthMonitor(undefined, stableBaseline)).toBeNull();
  });

  it('tolerates an empty baselineRows array (all vitals unavailable)', () => {
    const today = makeBaselineRow({ resting_hr: 60 });
    const result = healthMonitor(today, []);
    expect(result).not.toBeNull();
    for (const v of result.vitals) {
      expect(v.status).toBe('unavailable');
    }
    expect(result.overall).toBe('green');
    expect(result.flaggedCount).toBe(0);
  });

  it('tolerates missing (null) baselineRows argument gracefully', () => {
    const today = makeBaselineRow({ resting_hr: 60 });
    const result = healthMonitor(today, null);
    expect(result).not.toBeNull();
    for (const v of result.vitals) {
      expect(v.status).toBe('unavailable');
    }
  });
});

// ---------------------------------------------------------------------------
// Sparse baseline -> unavailable
// ---------------------------------------------------------------------------

describe('healthMonitor — sparse baseline (< 3 points)', () => {
  it('marks vitals unavailable when baseline has only 2 valid rows', () => {
    const sparse = [
      makeBaselineRow({ resting_hr: 55 }),
      makeBaselineRow({ resting_hr: 56 }),
    ];
    const today = makeBaselineRow({ resting_hr: 80 }); // spike, but not enough history
    const result = healthMonitor(today, sparse);
    expect(result).not.toBeNull();
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.status).toBe('unavailable');
    expect(rhrVital.baseline).toBeNull();
    expect(rhrVital.z).toBeNull();
  });

  it('overall is green (no flagged vitals) when all are unavailable', () => {
    const sparse = [makeBaselineRow({ resting_hr: 55 }), makeBaselineRow({ resting_hr: 56 })];
    const today = makeBaselineRow({ resting_hr: 90 });
    const result = healthMonitor(today, sparse);
    expect(result.overall).toBe('green');
    expect(result.flaggedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path — all-normal vitals -> green
// ---------------------------------------------------------------------------

describe('healthMonitor — all-normal vitals', () => {
  it('returns overall green when RHR is at baseline', () => {
    const today = makeBaselineRow({ resting_hr: 55, rmssd_ms: 40 });
    const result = healthMonitor(today, stableBaseline);
    expect(result).not.toBeNull();
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.status).toBe('normal');
    expect(result.overall).toBe('green');
    expect(result.flaggedCount).toBe(0);
  });

  it('populates baseline, delta, and z for available vitals', () => {
    const today = makeBaselineRow({ resting_hr: 55 });
    const result = healthMonitor(today, stableBaseline);
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.baseline).toBeCloseTo(55.3, 0);
    expect(rhrVital.delta).not.toBeNull();
    expect(rhrVital.z).not.toBeNull();
  });

  it('vitals for missing fields on HR-only data come back unavailable', () => {
    const today = makeBaselineRow({ resting_hr: 55 }); // no spo2, no skin_temp
    const result = healthMonitor(today, stableBaseline);
    const spo2 = result.vitals.find((v) => v.key === 'avg_spo2');
    const temp = result.vitals.find((v) => v.key === 'avg_skin_temp_c');
    expect(spo2.status).toBe('unavailable');
    expect(temp.status).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// RHR spike -> elevated -> yellow
// ---------------------------------------------------------------------------

describe('healthMonitor — RHR spike yields elevated + yellow overall', () => {
  // Baseline: RHR mean ~55, sigma ~1. Today: 65 -> z = (65-55)/1 = ~9 >> 1.5
  it('flags RHR as elevated when it spikes well above baseline', () => {
    const today = makeBaselineRow({ resting_hr: 65, rmssd_ms: 40 });
    const result = healthMonitor(today, stableBaseline);
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.status).toBe('elevated');
    expect(rhrVital.z).toBeGreaterThan(1.5);
  });

  it('returns overall yellow when exactly one vital is flagged', () => {
    const today = makeBaselineRow({ resting_hr: 65, rmssd_ms: 40 });
    const result = healthMonitor(today, stableBaseline);
    expect(result.overall).toBe('yellow');
    expect(result.flaggedCount).toBe(1);
  });

  it('direction on resting_hr is lower_better', () => {
    const today = makeBaselineRow({ resting_hr: 55 });
    const result = healthMonitor(today, stableBaseline);
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.direction).toBe('lower_better');
  });
});

// ---------------------------------------------------------------------------
// RMSSD drop -> low HRV -> yellow
// ---------------------------------------------------------------------------

describe('healthMonitor — RMSSD drop yields low HRV', () => {
  // Baseline RMSSD: mean ~40, sigma ~1. Today: 20 -> z = (20-40)/1 << -1.5
  it('flags rmssd_ms as low when HRV drops well below baseline', () => {
    const today = makeBaselineRow({ resting_hr: 55, rmssd_ms: 20 });
    const result = healthMonitor(today, stableBaseline);
    const hrvVital = result.vitals.find((v) => v.key === 'rmssd_ms');
    expect(hrvVital.status).toBe('low');
    expect(hrvVital.z).toBeLessThan(-1.5);
  });

  it('direction on rmssd_ms is higher_better', () => {
    const today = makeBaselineRow({ rmssd_ms: 40 });
    const result = healthMonitor(today, stableBaseline);
    const v = result.vitals.find((v) => v.key === 'rmssd_ms');
    expect(v.direction).toBe('higher_better');
  });
});

// ---------------------------------------------------------------------------
// Two vitals flagged -> red
// ---------------------------------------------------------------------------

describe('healthMonitor — two flagged vitals -> red', () => {
  it('returns overall red when RHR elevated and RMSSD low simultaneously', () => {
    const today = makeBaselineRow({ resting_hr: 70, rmssd_ms: 15 });
    const result = healthMonitor(today, stableBaseline);
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    const hrvVital = result.vitals.find((v) => v.key === 'rmssd_ms');
    expect(rhrVital.status).toBe('elevated');
    expect(hrvVital.status).toBe('low');
    expect(result.overall).toBe('red');
    expect(result.flaggedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SpO2 — absolute + z-score thresholds
// ---------------------------------------------------------------------------

describe('healthMonitor — SpO2 classification', () => {
  const spo2Baseline = Array.from({ length: 10 }, () =>
    makeBaselineRow({ avg_spo2: 98 })
  );

  it('flags avg_spo2 as low when < 95% absolute threshold', () => {
    const today = makeBaselineRow({ avg_spo2: 93 });
    const result = healthMonitor(today, spo2Baseline);
    const v = result.vitals.find((v) => v.key === 'avg_spo2');
    expect(v.status).toBe('low');
  });

  it('flags avg_spo2 as low when z < -1.5 even above 95%', () => {
    // Baseline mean ~98 with tiny spread; value 95 is z << -1.5
    const today = makeBaselineRow({ avg_spo2: 95 });
    const result = healthMonitor(today, spo2Baseline);
    const v = result.vitals.find((v) => v.key === 'avg_spo2');
    expect(v.status).toBe('low');
  });

  it('marks normal when SpO2 is at baseline', () => {
    const today = makeBaselineRow({ avg_spo2: 98 });
    const result = healthMonitor(today, spo2Baseline);
    const v = result.vitals.find((v) => v.key === 'avg_spo2');
    expect(v.status).toBe('normal');
  });

  it('direction on avg_spo2 is higher_better', () => {
    const today = makeBaselineRow({ avg_spo2: 98 });
    const result = healthMonitor(today, spo2Baseline);
    const v = result.vitals.find((v) => v.key === 'avg_spo2');
    expect(v.direction).toBe('higher_better');
  });
});

// ---------------------------------------------------------------------------
// Respiratory rate — absolute band + z-score
// ---------------------------------------------------------------------------

describe('healthMonitor — respiratory rate classification', () => {
  const rrBaseline = Array.from({ length: 10 }, () =>
    makeBaselineRow({ respiratory_rate: 15 })
  );

  it('flags respiratory_rate as elevated when > 20 br/min', () => {
    const today = makeBaselineRow({ respiratory_rate: 22 });
    const result = healthMonitor(today, rrBaseline);
    const v = result.vitals.find((v) => v.key === 'respiratory_rate');
    expect(v.status).toBe('elevated');
  });

  it('flags respiratory_rate as low when < 12 br/min', () => {
    const today = makeBaselineRow({ respiratory_rate: 10 });
    const result = healthMonitor(today, rrBaseline);
    const v = result.vitals.find((v) => v.key === 'respiratory_rate');
    expect(v.status).toBe('low');
  });

  it('marks normal at 15 br/min with matching baseline', () => {
    const today = makeBaselineRow({ respiratory_rate: 15 });
    const result = healthMonitor(today, rrBaseline);
    const v = result.vitals.find((v) => v.key === 'respiratory_rate');
    expect(v.status).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Skin temperature — absolute + z-score
// ---------------------------------------------------------------------------

describe('healthMonitor — skin temperature deviation classification', () => {
  const tempBaseline = Array.from({ length: 10 }, () =>
    makeBaselineRow({ skin_temp_deviation_c: 0.0 })
  );

  it('flags elevated when skin_temp_deviation_c > 0.6°C', () => {
    const today = makeBaselineRow({ skin_temp_deviation_c: 0.8 });
    const result = healthMonitor(today, tempBaseline);
    const v = result.vitals.find((v) => v.key === 'avg_skin_temp_c');
    expect(v.status).toBe('elevated');
  });

  it('flags low when skin_temp_deviation_c < -0.6°C', () => {
    const today = makeBaselineRow({ skin_temp_deviation_c: -0.8 });
    const result = healthMonitor(today, tempBaseline);
    const v = result.vitals.find((v) => v.key === 'avg_skin_temp_c');
    expect(v.status).toBe('low');
  });

  it('marks normal when deviation is within ±0.3°C', () => {
    const today = makeBaselineRow({ skin_temp_deviation_c: 0.2 });
    const result = healthMonitor(today, tempBaseline);
    const v = result.vitals.find((v) => v.key === 'avg_skin_temp_c');
    expect(v.status).toBe('normal');
  });

  it('direction on skin temp is neutral', () => {
    const today = makeBaselineRow({ skin_temp_deviation_c: 0.0 });
    const result = healthMonitor(today, tempBaseline);
    const v = result.vitals.find((v) => v.key === 'avg_skin_temp_c');
    expect(v.direction).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Known-value check (end-to-end arithmetic)
// ---------------------------------------------------------------------------

describe('healthMonitor — known-value arithmetic check', () => {
  // Construct a baseline where resting_hr = [60,60,60,...] (10 rows)
  // mean = 60, sigma = 0 -> fallback sigma = 1.0
  // Today resting_hr = 62 -> z = (62 - 60) / 1.0 = 2.0 -> > 1.5 -> elevated
  const uniformBaseline = Array.from({ length: 10 }, () =>
    makeBaselineRow({ resting_hr: 60 })
  );

  it('produces z = 2.0 and status elevated for resting_hr at +2σ (with sigma floor)', () => {
    const today = makeBaselineRow({ resting_hr: 62 });
    const result = healthMonitor(today, uniformBaseline);
    const rhrVital = result.vitals.find((v) => v.key === 'resting_hr');
    expect(rhrVital.z).toBeCloseTo(2.0, 5);
    expect(rhrVital.baseline).toBeCloseTo(60.0, 5);
    expect(rhrVital.delta).toBeCloseTo(2.0, 5);
    expect(rhrVital.status).toBe('elevated');
    expect(result.flaggedCount).toBe(1);
    expect(result.overall).toBe('yellow');
  });
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe('healthMonitor — output shape', () => {
  it('returns exactly 5 vitals in the expected key order', () => {
    const today = makeBaselineRow({ resting_hr: 55 });
    const result = healthMonitor(today, stableBaseline);
    const keys = result.vitals.map((v) => v.key);
    expect(keys).toEqual([
      'resting_hr',
      'rmssd_ms',
      'respiratory_rate',
      'avg_spo2',
      'avg_skin_temp_c',
    ]);
  });

  it('each vital entry has all required fields', () => {
    const today = makeBaselineRow({ resting_hr: 55 });
    const result = healthMonitor(today, stableBaseline);
    for (const v of result.vitals) {
      expect(v).toHaveProperty('key');
      expect(v).toHaveProperty('label');
      expect(v).toHaveProperty('value');
      expect(v).toHaveProperty('unit');
      expect(v).toHaveProperty('baseline');
      expect(v).toHaveProperty('delta');
      expect(v).toHaveProperty('z');
      expect(v).toHaveProperty('status');
      expect(v).toHaveProperty('direction');
    }
  });

  it('accepts optional sex and age params without crashing', () => {
    const today = makeBaselineRow({ resting_hr: 55 });
    const result = healthMonitor(today, stableBaseline, { sex: 'F', age: 45 });
    expect(result).not.toBeNull();
  });
});
