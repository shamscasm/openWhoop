// Tests for journal tag correlation analysis.

import { describe, it, expect } from 'vitest';
import { analyseTagCorrelations, tagInsights } from '../../../web/js/metrics/correlate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function journal(date, tags) {
  return { date, tags, text: '' };
}

function metric(date, recovery, rmssd = 55, rhr = 50, sleepPerf = 80) {
  return { date, recovery_score: recovery, rmssd_ms: rmssd, resting_hr: rhr, sleep_performance_pct: sleepPerf };
}

// Build a dataset: n alcohol days with poor next-day recovery,
// m non-alcohol days with good next-day recovery.
function buildAlcohol(nAlcohol = 5, nNone = 5) {
  const entries = [];
  const metrics = [];
  // alcohol days
  for (let i = 0; i < nAlcohol; i++) {
    const date = `2026-04-${String(i + 1).padStart(2, '0')}`;
    const nextDate = `2026-04-${String(i + 2).padStart(2, '0')}`;
    entries.push(journal(date, ['alcohol']));
    metrics.push(metric(nextDate, 25, 35, 62, 55)); // poor next-day
  }
  // non-alcohol days
  for (let i = nAlcohol; i < nAlcohol + nNone; i++) {
    const date = `2026-04-${String(i + 1).padStart(2, '0')}`;
    const nextDate = `2026-04-${String(i + 2).padStart(2, '0')}`;
    entries.push(journal(date, []));
    metrics.push(metric(nextDate, 75, 65, 48, 85)); // good next-day
  }
  return { entries, metrics };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analyseTagCorrelations', () => {
  it('returns empty array when insufficient data', () => {
    expect(analyseTagCorrelations([], [])).toEqual([]);
    expect(analyseTagCorrelations([journal('2026-05-01', ['alcohol'])], [])).toEqual([]);
  });

  it('detects negative correlation for alcohol tag', () => {
    const { entries, metrics } = buildAlcohol(5, 5);
    const corr = analyseTagCorrelations(entries, metrics);
    const recoveryCorr = corr.find((c) => c.tag === 'alcohol' && c.metric === 'recovery_score');
    expect(recoveryCorr).toBeDefined();
    expect(recoveryCorr.direction).toBe('negative');
    expect(recoveryCorr.deltaAbs).toBeLessThan(0); // next-day recovery lower after alcohol
    expect(recoveryCorr.nWith).toBeGreaterThanOrEqual(2);
  });

  it('each result has required fields', () => {
    const { entries, metrics } = buildAlcohol(4, 4);
    const corr = analyseTagCorrelations(entries, metrics);
    for (const c of corr) {
      expect(typeof c.tag).toBe('string');
      expect(typeof c.metric).toBe('string');
      expect(typeof c.d).toBe('number');
      expect(typeof c.nWith).toBe('number');
      expect(typeof c.nWithout).toBe('number');
      expect(['positive', 'negative', 'neutral']).toContain(c.direction);
      expect(typeof c.description).toBe('string');
    }
  });

  it('neutral direction for same next-day values regardless of tag', () => {
    const entries = [];
    const metrics = [];
    // All days: same next-day recovery = no correlation
    for (let i = 1; i <= 10; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      const next = `2026-05-${String(i + 1).padStart(2, '0')}`;
      entries.push(journal(date, i <= 5 ? ['stress'] : []));
      metrics.push(metric(next, 60));
    }
    const corr = analyseTagCorrelations(entries, metrics);
    const stressRec = corr.find((c) => c.tag === 'stress' && c.metric === 'recovery_score');
    // Cohen's d should be close to 0 → neutral
    if (stressRec) expect(stressRec.direction).toBe('neutral');
  });

  it('requires at least 2 "with" samples to include a correlation', () => {
    const entries = [
      journal('2026-05-01', ['alcohol']),
      journal('2026-05-02', []),
      journal('2026-05-03', []),
      journal('2026-05-04', []),
    ];
    const metrics = [
      metric('2026-05-02', 30),
      metric('2026-05-03', 70),
      metric('2026-05-04', 75),
      metric('2026-05-05', 72),
    ];
    const corr = analyseTagCorrelations(entries, metrics);
    // Only 1 "with" sample — should be excluded.
    const alcoholCorr = corr.filter((c) => c.tag === 'alcohol');
    expect(alcoholCorr).toHaveLength(0);
  });
});

describe('tagInsights', () => {
  it('returns [] for empty correlations', () => {
    expect(tagInsights([])).toEqual([]);
  });

  it('returns one insight per tag (strongest effect)', () => {
    const { entries, metrics } = buildAlcohol(5, 5);
    const corr = analyseTagCorrelations(entries, metrics);
    const ins = tagInsights(corr);
    // Only 'alcohol' tag — expect exactly one insight.
    expect(ins.length).toBe(1);
    expect(ins[0].tag).toBe('alcohol');
    expect(typeof ins[0].summary).toBe('string');
  });

  it('sorts negative effects before positive', () => {
    const positive = { tag: 'goodsleep', direction: 'positive', d: 0.8, metric: 'recovery_score', metricLabel: 'Recovery', nWith: 5, nWithout: 5, deltaAbs: 10, deltaPct: 15, description: '' };
    const negative = { tag: 'alcohol', direction: 'negative', d: -0.6, metric: 'recovery_score', metricLabel: 'Recovery', nWith: 5, nWithout: 5, deltaAbs: -8, deltaPct: -12, description: '' };
    const ins = tagInsights([positive, negative]);
    expect(ins[0].direction).toBe('negative');
  });
});
