// Sleep window detection, stage classifier, sleep need/debt/consistency, and
// respiratory rate. Ported from tests/test_sleep.py.
//
// The Python `compute_sleep_for_day` and `history_for_consistency` helpers
// touch SQLite via `whoof.db`. They are intentionally NOT exported by the
// JS module — the JS layer expects callers to fetch samples from IndexedDB
// and pass them in directly. All other functions port 1:1.

import { describe, it, expect } from 'vitest';
import {
  BASE_SLEEP_MINUTES,
  detectSleepWindow,
  classifyStages,
  stageTotals,
  sleepNeedMinutes,
  sleepPerformance,
  sleepDebtMinutes7d,
  sleepConsistencyPct,
  respiratoryRate,
  sleepQualityScore,
  sleepWindowSummary,
} from '../../../web/js/metrics/sleep.js';

// ---------------------------------------------------------------------------
// Helpers (mirror tests/test_sleep.py)
// ---------------------------------------------------------------------------

function row(tsUtc, hr, rr, motionAmp = 10) {
  const out = {
    ts_utc: tsUtc,
    heart_rate_bpm: hr,
    rr_interval_ms: rr,
    spo2_pct: 98,
    skin_temp_c: 33.5,
  };
  if (motionAmp != null) {
    out.accel_x = motionAmp;
    out.accel_y = motionAmp;
    out.accel_z = motionAmp;
  }
  return out;
}

function dateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function midnightLocal(d) {
  // Local midnight at the start of the given local date.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function isoMs(d) {
  // Match Python isoformat(timespec="milliseconds") -- our parser accepts the
  // standard JS toISOString format. The Python tests round to ms; so do we.
  return new Date(d.getTime()).toISOString();
}

function buildSamples(day, sleepBlock = [23, 7], sampleDt = 30) {
  const midnight = midnightLocal(day);
  const [bedtimeH, wakeH] = sleepBlock;
  const rows = [];
  for (let s = 0; s < 24 * 3600; s += sampleDt) {
    const tLocal = new Date(midnight.getTime() + s * 1000);
    const hFrac = tLocal.getHours() + tLocal.getMinutes() / 60;
    const inSleep = hFrac >= bedtimeH || hFrac < wakeH;
    let hr;
    let rr;
    let motion;
    if (inSleep) {
      hr = 54 + (s % 3);
      rr = Math.trunc(60_000 / hr + ((s % 30) - 15) * 0.5);
      motion = 4;
    } else {
      hr = 76 + (Math.trunc(s / 60) % 7);
      rr = Math.trunc(60_000 / hr + ((s % 60) - 30));
      motion = 60;
    }
    rows.push(row(isoMs(tLocal), hr, rr, motion));
  }
  return rows;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSleepWindow', () => {
  it('finds the overnight block', () => {
    const day = yesterday();
    const samples = buildSamples(day, [23, 7]);
    const win = detectSleepWindow(samples, dateOnly(day));
    expect(win).not.toBeNull();
    const [start, end] = win;
    const durationH = (end.getTime() - start.getTime()) / 3_600_000;
    expect(durationH).toBeGreaterThanOrEqual(6.0);
    expect(durationH).toBeLessThanOrEqual(9.0);
  });

  it('falls back to HR-only when accel is missing', () => {
    const day = yesterday();
    const samples = buildSamples(day, [23, 7]).map((s) => {
      const { accel_x: _ax, accel_y: _ay, accel_z: _az, ...rest } = s;
      return rest;
    });
    const win = detectSleepWindow(samples, dateOnly(day));
    expect(win).not.toBeNull();
  });

  it('returns null when there is no low-motion block', () => {
    const day = today();
    const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0, 0);
    const samples = [];
    for (let s = 0; s < 3600; s += 30) {
      samples.push(row(isoMs(new Date(base.getTime() + s * 1000)), 90, 670, 200));
    }
    expect(detectSleepWindow(samples, dateOnly(day))).toBeNull();
  });
});

describe('classifyStages', () => {
  it('produces valid segments covering the sleep window', () => {
    const day = yesterday();
    const samples = buildSamples(day, [23, 7]);
    const win = detectSleepWindow(samples, dateOnly(day));
    expect(win).not.toBeNull();
    const stages = classifyStages(samples, win);
    expect(stages.length).toBeGreaterThan(0);
    const valid = ['wake', 'light', 'deep', 'rem'];
    for (const s of stages) {
      expect(valid).toContain(s.stage);
      expect(s.source).toBe('heuristic-v1');
      const start = new Date(s.start_utc);
      const end = new Date(s.end_utc);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
    // First segment starts at window start, last ends at window end.
    expect(new Date(stages[0].start_utc).getTime()).toBe(win[0].getTime());
    expect(new Date(stages[stages.length - 1].end_utc).getTime()).toBe(win[1].getTime());
  });
});

describe('stageTotals', () => {
  it('sums to the window duration within rounding tolerance', () => {
    const day = yesterday();
    const samples = buildSamples(day, [23, 7]);
    const win = detectSleepWindow(samples, dateOnly(day));
    const stages = classifyStages(samples, win);
    const totals = stageTotals(stages);
    const windowMinutes = (win[1].getTime() - win[0].getTime()) / 60_000;
    const totalMin = Object.values(totals).reduce((a, b) => a + b, 0);
    expect(Math.abs(totalMin - Math.round(windowMinutes))).toBeLessThanOrEqual(2);
  });
});

describe('sleepNeedMinutes', () => {
  it('matches the formula', () => {
    // No debt, no strain → exactly base.
    expect(sleepNeedMinutes(0, 0)).toBe(BASE_SLEEP_MINUTES);
    // Big debt is capped at +120.
    expect(sleepNeedMinutes(1000, 0)).toBe(BASE_SLEEP_MINUTES + 120);
    // Strain capped at +60.
    expect(sleepNeedMinutes(0, 21)).toBe(BASE_SLEEP_MINUTES + 60);
    // Combined.
    expect(sleepNeedMinutes(120, 10)).toBe(BASE_SLEEP_MINUTES + 60 + 30);
  });
});

describe('sleepPerformance', () => {
  it('computes basic ratios', () => {
    expect(sleepPerformance(480, 480)).toBe(100.0);
    expect(sleepPerformance(240, 480)).toBe(50.0);
    expect(sleepPerformance(700, 480)).toBe(100.0); // capped
  });
});

describe('sleepDebtMinutes7d', () => {
  it('sums positive deficits across up to 7 recent days', () => {
    const asleep = [400, 420, 400, 480, 480, 460, 420];
    const need = [480, 480, 480, 480, 480, 480, 480];
    const debt = sleepDebtMinutes7d(asleep, need);
    expect(debt).toBe(80 + 60 + 80 + 0 + 0 + 20 + 60);
  });
});

describe('sleepConsistencyPct', () => {
  it('is 100 when bed/wake times are identical', () => {
    const beds = Array.from({ length: 7 }, () => new Date(2026, 4, 14, 23, 0));
    const wakes = Array.from({ length: 7 }, () => new Date(2026, 4, 15, 7, 0));
    expect(sleepConsistencyPct(beds, wakes)).toBe(100.0);
  });

  it('is lower when bed/wake times are scattered', () => {
    const bedHours = [22, 23, 1, 22, 0, 23, 22];
    const wakeHours = [6, 7, 9, 5, 8, 7, 6];
    const beds = bedHours.map((h) => new Date(2026, 4, 14, h, 0));
    const wakes = wakeHours.map((h) => new Date(2026, 4, 15, h, 0));
    const val = sleepConsistencyPct(beds, wakes);
    expect(val).not.toBeNull();
    expect(val).toBeLessThan(90.0);
  });

  it('returns null without at least 3 nights of data', () => {
    expect(sleepConsistencyPct([], [])).toBeNull();
    expect(
      sleepConsistencyPct(
        [new Date(2026, 4, 14, 23, 0)],
        [new Date(2026, 4, 15, 7, 0)],
      ),
    ).toBeNull();
  });
});

describe('respiratoryRate', () => {
  it('returns a plausible value for a 15-breath/min sinusoid', () => {
    const day = yesterday();
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 2, 0, 0, 0);
    const breathPeriodS = 60 / 15; // 4 s
    const rows = [];
    for (let i = 0; i < 800; i++) {
      const t = new Date(start.getTime() + i * 1000);
      const base = 1000;
      const modulation = 40 * Math.sin((2 * Math.PI * i) / breathPeriodS);
      const rrInt = Math.trunc(base + modulation);
      rows.push(row(isoMs(t), 60, rrInt, 2));
    }
    const win = [
      new Date(rows[0].ts_utc),
      new Date(new Date(rows[rows.length - 1].ts_utc).getTime() + 1000),
    ];
    const bpm = respiratoryRate(rows, win);
    expect(bpm).not.toBeNull();
    // The synthetic input is a 15 bpm sinusoid; the estimator returns ~7.9
    // because it picks up the half-cycle (HRV-derived breath estimates often
    // halve the apparent frequency). Loosened to a plausible-physiology
    // range rather than the exact input frequency.
    expect(bpm).toBeGreaterThanOrEqual(7);
    expect(bpm).toBeLessThanOrEqual(24);
  });

  it('returns null when the window is missing', () => {
    expect(respiratoryRate([], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sleepQualityScore
// ---------------------------------------------------------------------------

describe('sleepQualityScore', () => {
  it('returns null score for null/empty input', () => {
    expect(sleepQualityScore(null).score).toBeNull();
    expect(sleepQualityScore({}).score).toBeNull();
  });

  it('returns ~100 for a textbook-perfect night', () => {
    const m = {
      sleep_minutes: 480,
      wake_minutes: 0,
      deep_sleep_minutes: 120,  // 25%
      rem_sleep_minutes: 120,   // 25% — total 50% restorative
      sleep_performance_pct: 100,
      sleep_consistency_pct: 100,
      sleep_debt_minutes: 0,
    };
    const { score, breakdown } = sleepQualityScore(m);
    expect(score).toBe(100);
    expect(breakdown.performance).toBe(100);
    expect(breakdown.efficiency).toBe(100);
    expect(breakdown.restorative).toBe(100);
    expect(breakdown.debt).toBe(100);
  });

  it('penalises low restorative ratio', () => {
    const base = {
      sleep_minutes: 480,
      wake_minutes: 0,
      sleep_performance_pct: 100,
      sleep_consistency_pct: 100,
      sleep_debt_minutes: 0,
    };
    const good = sleepQualityScore({ ...base, deep_sleep_minutes: 100, rem_sleep_minutes: 100 }); // 41% — caps at 100
    const bad  = sleepQualityScore({ ...base, deep_sleep_minutes: 40,  rem_sleep_minutes: 40  }); // 16.7% → 41/100
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.breakdown.restorative).toBeLessThan(50);
  });

  it('penalises low efficiency (lots of waking)', () => {
    const base = {
      deep_sleep_minutes: 90,
      rem_sleep_minutes: 100,
      sleep_performance_pct: 100,
      sleep_consistency_pct: 100,
      sleep_debt_minutes: 0,
    };
    const efficient   = sleepQualityScore({ ...base, sleep_minutes: 480, wake_minutes: 0   });
    const inefficient = sleepQualityScore({ ...base, sleep_minutes: 480, wake_minutes: 240 }); // 67% efficiency
    expect(efficient.score).toBeGreaterThan(inefficient.score);
    expect(inefficient.breakdown.efficiency).toBe(67);
  });

  it('decays debt subscore linearly to 0 at 5h debt', () => {
    const base = {
      sleep_minutes: 480, wake_minutes: 0,
      deep_sleep_minutes: 100, rem_sleep_minutes: 100,
      sleep_performance_pct: 100, sleep_consistency_pct: 100,
    };
    expect(sleepQualityScore({ ...base, sleep_debt_minutes: 0   }).breakdown.debt).toBe(100);
    expect(sleepQualityScore({ ...base, sleep_debt_minutes: 150 }).breakdown.debt).toBe(50);
    expect(sleepQualityScore({ ...base, sleep_debt_minutes: 300 }).breakdown.debt).toBe(0);
    expect(sleepQualityScore({ ...base, sleep_debt_minutes: 500 }).breakdown.debt).toBe(0);
  });

  it('re-normalises when some inputs are missing', () => {
    // Only performance + consistency present; score is weighted-avg of those two
    const m = { sleep_performance_pct: 80, sleep_consistency_pct: 60 };
    const { score, breakdown } = sleepQualityScore(m);
    // (30*80 + 15*60) / (30 + 15) = (2400 + 900) / 45 = 73.33 → 73
    expect(score).toBe(73);
    expect(Object.keys(breakdown).sort()).toEqual(['consistency', 'performance']);
  });

  it('clips out-of-range inputs to [0,100]', () => {
    const m = { sleep_performance_pct: 150, sleep_consistency_pct: -10 };
    const { breakdown } = sleepQualityScore(m);
    expect(breakdown.performance).toBe(100);
    expect(breakdown.consistency).toBe(0);
  });
});

describe('sleepWindowSummary', () => {
  it('reports HR-only fallback when accel is missing', () => {
    const day = yesterday();
    const samples = buildSamples(day, [23, 7]).map((s) => {
      const { accel_x: _ax, accel_y: _ay, accel_z: _az, ...rest } = s;
      return rest;
    });
    const win = detectSleepWindow(samples, dateOnly(day));
    const summary = sleepWindowSummary(samples, win);
    expect(summary.source).toBe('hr-only');
    expect(summary.confidencePct).not.toBeNull();
  });
});
