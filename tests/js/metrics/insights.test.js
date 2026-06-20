// Tests for the trend-insights engine.

import { describe, it, expect } from 'vitest';
import { generateInsights } from '../../../web/js/metrics/insights.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an array of daily_metrics rows (newest → oldest). */
function makeMetrics(overrides = []) {
  const base = {
    rmssd_ms: 55,
    resting_hr: 50,
    recovery_score: 65,
    strain_score: 10,
    sleep_minutes: 450,
    deep_sleep_minutes: 95,   // ~21% — healthy
    rem_sleep_minutes: 108,   // ~24% — healthy
    light_sleep_minutes: 247, // ~55%
    sleep_debt_minutes: 0,
    sleep_consistency_pct: 85,
    respiratory_rate: 14,
    avg_skin_temp_c: 33.5,
    skin_temp_deviation_c: 0.0,
    avg_spo2: 97,
    sleep_performance_pct: 80,
  };
  return overrides.map((o) => ({ ...base, ...o }));
}

/** Build N identical rows, optionally tweaked. */
function repeat(n, fields = {}) {
  return Array.from({ length: n }, (_, i) => fields[i] ?? { ...fields });
}

// ---------------------------------------------------------------------------
// Basic behaviour
// ---------------------------------------------------------------------------

describe('generateInsights', () => {
  it('returns [] when fewer than 3 days of data', () => {
    expect(generateInsights([])).toEqual([]);
    expect(generateInsights(makeMetrics([{}, {}]))).toEqual([]);
  });

  it('returns [] when data is perfectly healthy', () => {
    // 14 days of ideal metrics
    const metrics = makeMetrics(Array(14).fill({}));
    const ins = generateInsights(metrics);
    // Should not flag any warnings for ideal data
    const warns = ins.filter((i) => i.severity === 'warn' || i.severity === 'critical');
    expect(warns).toHaveLength(0);
  });

  it('each insight has required fields', () => {
    // Force several conditions by using bad data
    const metrics = makeMetrics(Array(7).fill({ recovery_score: 20, strain_score: 18 }));
    const ins = generateInsights(metrics);
    for (const i of ins) {
      expect(typeof i.id).toBe('string');
      expect(['info', 'warn', 'critical']).toContain(i.severity);
      expect(typeof i.title).toBe('string');
      expect(typeof i.body).toBe('string');
    }
  });

  it('sorts critical > warn > info', () => {
    const metrics = makeMetrics(Array(7).fill({
      rmssd_ms: 30,       // hrv declining if slope down
      recovery_score: 20, // low-streak trigger
      strain_score: 18,   // overreaching trigger
      sleep_debt_minutes: 300, // warn
    }));
    // Build a declining HRV series
    const declining = Array.from({ length: 7 }, (_, i) => ({
      rmssd_ms: 60 - i * 5, // 60, 55, 50, 45, 40, 35, 30 newest→oldest
      recovery_score: 20,
      strain_score: 18,
      sleep_debt_minutes: 300,
      sleep_minutes: 450,
      resting_hr: 50,
      sleep_consistency_pct: 85,
      respiratory_rate: 14,
      avg_skin_temp_c: 33.5,
      skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(declining);
    const sevs = ins.map((i) => i.severity);
    const RANK = { critical: 0, warn: 1, info: 2 };
    for (let i = 1; i < sevs.length; i++) {
      expect(RANK[sevs[i]]).toBeGreaterThanOrEqual(RANK[sevs[i - 1]]);
    }
  });
});

// ---------------------------------------------------------------------------
// HRV trend
// ---------------------------------------------------------------------------

describe('HRV insights', () => {
  it('flags declining HRV', () => {
    // newest→oldest: 30, 35, 40, 45, 50, 55, 60 (declining over time = rising newest→oldest is wrong)
    // For declining, chrono (oldest→newest) should go 60→30.
    // metrics is newest→oldest: [30,35,40,45,50,55,60]
    const metrics = [30, 35, 40, 45, 50, 55, 60].map((rmssd_ms) => ({
      rmssd_ms, resting_hr: 50, recovery_score: 60, strain_score: 8,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    const hrv = ins.find((i) => i.id === 'hrv-declining');
    expect(hrv).toBeDefined();
    expect(hrv.trend).toBe('down');
  });

  it('flags rising HRV', () => {
    // newest→oldest: 80,75,70,65,60,55,50 — rising over time
    const metrics = [80, 75, 70, 65, 60, 55, 50].map((rmssd_ms) => ({
      rmssd_ms, resting_hr: 50, recovery_score: 60, strain_score: 8,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    const hrv = ins.find((i) => i.id === 'hrv-rising');
    expect(hrv).toBeDefined();
    expect(hrv.trend).toBe('up');
  });

  it('does not flag stable HRV', () => {
    const metrics = Array(7).fill(null).map(() => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score: 60, strain_score: 8,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'hrv-declining')).toBeUndefined();
    expect(ins.find((i) => i.id === 'hrv-rising')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resting HR
// ---------------------------------------------------------------------------

describe('Resting HR insights', () => {
  it('flags elevated RHR', () => {
    // First half (oldest) ≈ 48, second half (newest) ≈ 58
    const metrics = [60, 58, 57, 56, 48, 47, 48].map((resting_hr) => ({
      rmssd_ms: 55, resting_hr, recovery_score: 60, strain_score: 8,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'rhr-elevated')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sleep debt
// ---------------------------------------------------------------------------

describe('Sleep debt insights', () => {
  it('flags high sleep debt', () => {
    const metrics = makeMetrics([{ sleep_debt_minutes: 300 }, ...Array(6).fill({})]);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'sleep-debt-high')).toBeDefined();
  });

  it('flags moderate sleep debt', () => {
    const metrics = makeMetrics([{ sleep_debt_minutes: 150 }, ...Array(6).fill({})]);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'sleep-debt-moderate')).toBeDefined();
  });

  it('does not flag zero debt', () => {
    const metrics = makeMetrics(Array(7).fill({ sleep_debt_minutes: 0 }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id.startsWith('sleep-debt'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Recovery streak
// ---------------------------------------------------------------------------

describe('Recovery streak insights', () => {
  it('flags 3-day low recovery streak', () => {
    const metrics = [25, 28, 30, 65, 70, 68, 72].map((recovery_score) => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score, strain_score: 10,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'recovery-low-streak')).toBeDefined();
  });

  it('flags 3-day high recovery streak', () => {
    const metrics = [80, 75, 78, 30, 35, 40, 50].map((recovery_score) => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score, strain_score: 5,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'recovery-high-streak')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overreaching
// ---------------------------------------------------------------------------

describe('Strain / recovery balance insights', () => {
  it('flags overreaching (high strain + low recovery)', () => {
    const metrics = Array(7).fill(null).map(() => ({
      rmssd_ms: 45, resting_hr: 58, recovery_score: 35,
      strain_score: 16, sleep_minutes: 400, sleep_debt_minutes: 0,
      sleep_consistency_pct: 75, respiratory_rate: 14,
      avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'overreaching')).toBeDefined();
  });

  it('flags undertrained (green recovery + low strain)', () => {
    const metrics = Array(7).fill(null).map(() => ({
      rmssd_ms: 65, resting_hr: 46, recovery_score: 80,
      strain_score: 4, sleep_minutes: 490, sleep_debt_minutes: 0,
      sleep_consistency_pct: 90, respiratory_rate: 13,
      avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'undertrained')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skin temperature
// ---------------------------------------------------------------------------

describe('Skin temperature insights', () => {
  it('flags elevated skin temperature deviation', () => {
    const metrics = Array(5).fill(null).map(() => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score: 60, strain_score: 8,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 34.2, skin_temp_deviation_c: 0.8,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'skin-temp-elevated')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Short sleep duration
// ---------------------------------------------------------------------------

describe('Sleep duration insights', () => {
  it('flags consistently short sleep', () => {
    const metrics = Array(7).fill(null).map(() => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score: 55, strain_score: 8,
      sleep_minutes: 300, // 5h
      sleep_debt_minutes: 180, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
    }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'sleep-short')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SpO₂
// ---------------------------------------------------------------------------

describe('SpO₂ insights', () => {
  it('flags low SpO₂ (<93%) as warn', () => {
    const metrics = makeMetrics(Array(5).fill({ avg_spo2: 91 }));
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'spo2-low');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
    expect(alert.trend).toBe('down');
  });

  it('flags borderline SpO₂ (93–94%) as info', () => {
    const metrics = makeMetrics(Array(5).fill({ avg_spo2: 94 }));
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'spo2-borderline');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('does not flag normal SpO₂ (>=95%)', () => {
    const metrics = makeMetrics(Array(5).fill({ avg_spo2: 97 }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('spo2'))).toBeUndefined();
  });

  it('returns null when fewer than 2 SpO₂ values available', () => {
    // Only one row has avg_spo2 — not enough to act
    const metrics = makeMetrics([
      { avg_spo2: 90 },
      ...Array(4).fill({ avg_spo2: null }),
    ]);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('spo2'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sleep efficiency
// ---------------------------------------------------------------------------

describe('Sleep efficiency insights', () => {
  it('flags poor sleep performance (<55%) as warn', () => {
    const metrics = makeMetrics(Array(5).fill({ sleep_performance_pct: 48 }));
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'sleep-perf-poor');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
  });

  it('flags low sleep performance (55–69%) as info', () => {
    const metrics = makeMetrics(Array(5).fill({ sleep_performance_pct: 62 }));
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'sleep-perf-low');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('does not flag normal sleep performance (>=70%)', () => {
    const metrics = makeMetrics(Array(5).fill({ sleep_performance_pct: 80 }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('sleep-perf'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ACWR (Acute:Chronic Workload Ratio)
// ---------------------------------------------------------------------------

describe('ACWR insights', () => {
  /** Build 14 metrics: acute 7 days at acuteStrain, chronic 7 days at chronicStrain. */
  function makeAcwr(acuteStrain, chronicStrain) {
    const row = (s) => ({
      rmssd_ms: 55, resting_hr: 50, recovery_score: 60, strain_score: s,
      sleep_minutes: 450, sleep_debt_minutes: 0, sleep_consistency_pct: 85,
      respiratory_rate: 14, avg_skin_temp_c: 33.5, skin_temp_deviation_c: 0.0,
      avg_spo2: 97, sleep_performance_pct: 80,
    });
    return [
      ...Array(7).fill(null).map(() => row(acuteStrain)),   // newest 7
      ...Array(7).fill(null).map(() => row(chronicStrain)),  // older 7
    ];
  }

  it('flags ACWR > 1.5 as warn', () => {
    // Acute 16, chronic 10 → ratio 1.6
    const metrics = makeAcwr(16, 10);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'acwr-high');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
  });

  it('flags ACWR 1.3–1.5 as info', () => {
    // Acute 14, chronic 10 → ratio 1.4
    const metrics = makeAcwr(14, 10);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'acwr-elevated');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('flags ACWR < 0.6 as info', () => {
    // Acute 5, chronic 10 → ratio 0.5
    const metrics = makeAcwr(5, 10);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'acwr-low');
    expect(alert).toBeDefined();
  });

  it('does not fire for ratio in sweet spot (0.8–1.3)', () => {
    // Acute 10, chronic 10 → ratio 1.0
    const metrics = makeAcwr(10, 10);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('acwr'))).toBeUndefined();
  });

  it('does not fire when fewer than 5 chronic days', () => {
    // Only 7 total rows — not enough chronic period
    const metrics = makeMetrics(Array(7).fill({ strain_score: 18 }));
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('acwr'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Training monotony
// ---------------------------------------------------------------------------

describe('Training monotony insights', () => {
  /** Build 7 newest→oldest rows with strain values (oldest to newest in the array for chrono order). */
  function makeMonotonyMetrics(strains) {
    // strains is oldest→newest; metrics are newest→oldest, so reverse
    return [...strains].reverse().map((s) => ({
      ...makeMetrics([{}])[0],
      strain_score: s,
    }));
  }

  it('flags monotony > 2.5 as info', () => {
    // All 12.0 — no variation → very high monotony
    const metrics = makeMonotonyMetrics([12, 12, 12, 12, 12, 12, 12]);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'training-monotony-high');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('does not flag varied training (hard/easy pattern)', () => {
    // Alternating hard/easy — high variability → low monotony
    const metrics = makeMonotonyMetrics([4, 16, 4, 16, 4, 16, 4]);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'training-monotony-high')).toBeUndefined();
  });

  it('does not flag low-strain windows (avg < 4)', () => {
    const metrics = makeMonotonyMetrics([2, 2, 2, 2, 2, 2, 2]);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'training-monotony-high')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deep sleep alert
// ---------------------------------------------------------------------------

describe('Deep sleep alert', () => {
  /** Build metrics with given deep proportion (0–1) of 450 min total sleep. */
  function makeDeepMetrics(deepFraction, n = 7) {
    return makeMetrics(
      Array(n).fill({
        sleep_minutes: 450,
        deep_sleep_minutes: Math.round(450 * deepFraction),
      }),
    );
  }

  it('fires warn when avg deep < 13%', () => {
    const metrics = makeDeepMetrics(0.10);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'deep-sleep-low');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
  });

  it('fires info when avg deep is 13–20%', () => {
    const metrics = makeDeepMetrics(0.16);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'deep-sleep-below-target');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('does not fire when deep sleep >= 20%', () => {
    const metrics = makeDeepMetrics(0.22);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('deep-sleep'))).toBeUndefined();
  });

  it('skips rows where sleep_minutes is null', () => {
    // Only 2 rows have data — below MIN_DAYS
    const metrics = makeMetrics([
      { sleep_minutes: null, deep_sleep_minutes: null },
      { sleep_minutes: null, deep_sleep_minutes: null },
      { sleep_minutes: 450, deep_sleep_minutes: 45 },
      { sleep_minutes: 450, deep_sleep_minutes: 45 },
    ]);
    const ins = generateInsights(metrics);
    // Only 2 valid rows — should not fire (need MIN_DAYS = 3)
    expect(ins.find((i) => i.id?.startsWith('deep-sleep'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REM sleep alert
// ---------------------------------------------------------------------------

describe('REM sleep alert', () => {
  function makeRemMetrics(remFraction, n = 7) {
    return makeMetrics(
      Array(n).fill({
        sleep_minutes: 450,
        rem_sleep_minutes: Math.round(450 * remFraction),
      }),
    );
  }

  it('fires warn when avg REM < 15%', () => {
    const metrics = makeRemMetrics(0.10);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'rem-sleep-low');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
  });

  it('fires info when avg REM is 15–20%', () => {
    const metrics = makeRemMetrics(0.17);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'rem-sleep-below-target');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('info');
  });

  it('does not fire when REM >= 20%', () => {
    const metrics = makeRemMetrics(0.23);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id?.startsWith('rem-sleep'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HRV vs personal baseline
// ---------------------------------------------------------------------------

describe('HRV baseline alert', () => {
  /**
   * Build newest→oldest metric array.
   * baselineHrv: value for days [3, n)
   * recentHrv:   value for most recent 3 days
   */
  function makeHrvBaseline(baselineHrv, recentHrv, totalDays = 20) {
    return makeMetrics(
      Array(totalDays)
        .fill(null)
        .map((_, i) => ({ rmssd_ms: i < 3 ? recentHrv : baselineHrv })),
    );
  }

  it('fires warn when HRV is 2+ SD below baseline', () => {
    // Baseline: 60ms ± ~5ms (varied to create meaningful SD)
    const metrics = makeMetrics([
      { rmssd_ms: 30 }, { rmssd_ms: 30 }, { rmssd_ms: 30 }, // recent (very low)
      ...Array(17)
        .fill(null)
        .map((_, i) => ({ rmssd_ms: 55 + (i % 5) })), // baseline ~57ms
    ]);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'hrv-below-baseline');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
  });

  it('fires info when HRV is ~1 SD below baseline', () => {
    // Baseline ~55ms, recent ~48ms — ~1.2 SD below
    const metrics = makeMetrics([
      { rmssd_ms: 48 }, { rmssd_ms: 48 }, { rmssd_ms: 48 },
      ...Array(17)
        .fill(null)
        .map((_, i) => ({ rmssd_ms: 54 + (i % 5) })),
    ]);
    const ins = generateInsights(metrics);
    const alert = ins.find((i) => i.id === 'hrv-below-baseline');
    expect(alert).toBeDefined();
  });

  it('does not fire when HRV is at baseline', () => {
    const metrics = makeHrvBaseline(55, 55, 20);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'hrv-below-baseline')).toBeUndefined();
  });

  it('does not fire with fewer than 10 days of data', () => {
    const metrics = makeHrvBaseline(55, 30, 8);
    const ins = generateInsights(metrics);
    expect(ins.find((i) => i.id === 'hrv-below-baseline')).toBeUndefined();
  });

  it('does not fire when baseline is flat (sd < 1)', () => {
    // All baseline identical → sd = 0 → skip
    const metrics = makeHrvBaseline(55, 30, 20);
    const ins = generateInsights(metrics);
    // Flat baseline → guard kicks in, no alert
    expect(ins.find((i) => i.id === 'hrv-below-baseline')).toBeUndefined();
  });
});
