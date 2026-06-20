// Journal tag correlation analysis.
//
// Given journal entries and daily_metrics, computes how each tag correlates
// with next-day biometric outcomes (recovery, HRV, resting HR, sleep quality).
//
// Algorithm: for each tag, compare "days after the tag appears" vs "days where
// the tag did not appear" using a simple Cohen's d effect size so small-n
// samples don't produce fake confidence.
//
// Pure function — no DB access.

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Cohen's d — standardised mean difference between two groups.
// Positive d = group A > group B.
// Cap at ±10 when pooled SD is near zero (perfect separation).
function cohensD(groupA, groupB) {
  if (!groupA.length || !groupB.length) return null;
  const mA = mean(groupA);
  const mB = mean(groupB);
  const sA = std(groupA) ?? 0;
  const sB = std(groupB) ?? 0;
  const n = groupA.length + groupB.length;
  // Pooled SD (Hedges' correction isn't needed at this granularity).
  const pooledSd = Math.sqrt(
    ((groupA.length - 1) * sA * sA + (groupB.length - 1) * sB * sB) / Math.max(n - 2, 1),
  );
  if (pooledSd < 1e-10) {
    // Zero variance in both groups — perfect (or absent) separation.
    if (Math.abs(mA - mB) < 1e-10) return 0;
    return mA > mB ? 10 : -10; // Cap at ±10 (practically infinite effect)
  }
  return (mA - mB) / pooledSd;
}

/**
 * Analyse impact of journal tags on next-day outcomes.
 *
 * @param {Array<{date:string, tags:string[]}>} journalEntries - newest→oldest
 * @param {Array<{date:string, recovery_score, rmssd_ms, resting_hr, sleep_performance_pct}>} metrics
 *        - newest→oldest daily_metrics rows
 * @returns {Array<{
 *     tag: string,
 *     metric: string,
 *     metricLabel: string,
 *     nWith: number,
 *     nWithout: number,
 *     deltaAbs: number,        // mean difference (tagged next-day minus untagged)
 *     deltaPct: number|null,   // % difference relative to untagged mean
 *     d: number,               // Cohen's d effect size
 *     direction: 'positive'|'negative'|'neutral',
 *     description: string,
 *   }>}
 */
export function analyseTagCorrelations(journalEntries, metrics) {
  if (!journalEntries.length || metrics.length < 4) return [];

  // Build a map of date → next-day metrics. "Next day" = the metrics row for
  // the calendar day AFTER the journal entry.
  const metricsByDate = new Map();
  for (const m of metrics) {
    metricsByDate.set(m.date, m);
  }

  function nextDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Collect all tags seen in journal.
  const allTags = new Set();
  for (const e of journalEntries) {
    for (const t of (e.tags ?? [])) allTags.add(t);
  }

  // Outcomes to analyse.
  const OUTCOMES = [
    { key: 'recovery_score',        label: 'Recovery',           higherIsBetter: true  },
    { key: 'rmssd_ms',              label: 'HRV (RMSSD)',        higherIsBetter: true  },
    { key: 'resting_hr',            label: 'Resting HR',         higherIsBetter: false },
    { key: 'sleep_performance_pct', label: 'Sleep performance',  higherIsBetter: true  },
  ];

  const results = [];

  for (const tag of allTags) {
    // Dates where this tag appeared.
    const taggedDates = new Set(
      journalEntries.filter((e) => (e.tags ?? []).includes(tag)).map((e) => e.date),
    );

    for (const outcome of OUTCOMES) {
      // Next-day values split by whether the tag appeared.
      const withTag    = [];
      const withoutTag = [];

      for (const e of journalEntries) {
        const nd = nextDate(e.date);
        const m = metricsByDate.get(nd);
        if (!m || m[outcome.key] == null) continue;
        if (taggedDates.has(e.date)) {
          withTag.push(m[outcome.key]);
        } else {
          withoutTag.push(m[outcome.key]);
        }
      }

      if (withTag.length < 2 || withoutTag.length < 2) continue;

      const mWith    = mean(withTag);
      const mWithout = mean(withoutTag);
      const deltaAbs = mWith - mWithout;
      const deltaPct = mWithout !== 0 ? (deltaAbs / Math.abs(mWithout)) * 100 : null;
      const d = cohensD(withTag, withoutTag);
      if (d == null) continue;

      // "positive" means better outcome is associated with the tag.
      // For metrics where higher is better: positive d = tag days lead to higher next-day metric = good.
      // For HR (lower is better): positive d = higher HR after tag = negative effect.
      const rawPositive = d > 0;
      const direction = Math.abs(d) < 0.2
        ? 'neutral'
        : ((outcome.higherIsBetter ? rawPositive : !rawPositive) ? 'positive' : 'negative');

      const sign = deltaAbs >= 0 ? '+' : '−';
      const pctStr = deltaPct != null ? ` (${deltaAbs >= 0 ? '+' : '−'}${Math.abs(deltaPct).toFixed(0)}%)` : '';
      const description = direction === 'neutral'
        ? `No meaningful effect on ${outcome.label} (d=${d.toFixed(2)})`
        : `Next-day ${outcome.label}: ${sign}${Math.abs(deltaAbs).toFixed(1)}${pctStr} vs non-${tag} days (n=${withTag.length} vs ${withoutTag.length})`;

      results.push({
        tag,
        metric: outcome.key,
        metricLabel: outcome.label,
        nWith: withTag.length,
        nWithout: withoutTag.length,
        deltaAbs,
        deltaPct: deltaPct != null ? Math.round(deltaPct * 10) / 10 : null,
        d,
        direction,
        description,
      });
    }
  }

  // Sort by effect size magnitude, largest first. Within same tag, group together.
  results.sort((a, b) => {
    if (a.tag !== b.tag) return a.tag.localeCompare(b.tag);
    return Math.abs(b.d) - Math.abs(a.d);
  });

  return results;
}

/**
 * Summarise tag correlations into a short human-readable insight per tag.
 * Returns at most one insight per tag (the strongest effect).
 *
 * @param {Array} correlations - output of analyseTagCorrelations
 * @returns {Array<{tag, direction, summary}>}
 */
export function tagInsights(correlations) {
  // Group by tag, pick the strongest non-neutral correlation.
  const byTag = new Map();
  for (const c of correlations) {
    if (c.direction === 'neutral') continue;
    const existing = byTag.get(c.tag);
    if (!existing || Math.abs(c.d) > Math.abs(existing.d)) {
      byTag.set(c.tag, c);
    }
  }

  const TAG_LABELS = {
    alcohol: 'Alcohol', illness: 'Illness', stress: 'Stress',
    travel: 'Travel', race: 'Race', goodsleep: 'Good sleep', hardworkout: 'Hard workout',
    caffeine: 'Late caffeine', meditation: 'Meditation', cold: 'Cold exposure', nap: 'Nap',
  };

  const insights = [];
  for (const [tag, c] of byTag) {
    const label = TAG_LABELS[tag] ?? tag;
    const effectWord = Math.abs(c.d) > 0.8 ? 'strongly' : Math.abs(c.d) > 0.5 ? 'notably' : 'slightly';
    const dirWord = c.direction === 'negative' ? 'lowers' : 'improves';
    // Append quantitative delta (e.g. "−12 pts (−18%)") for the leading metric.
    const sign = c.deltaAbs > 0 ? '+' : '−';
    const absVal = Math.abs(c.deltaAbs).toFixed(1).replace(/\.0$/, '');
    const pctPart = c.deltaPct != null ? ` (${c.deltaAbs > 0 ? '+' : '−'}${Math.abs(c.deltaPct).toFixed(0)}%)` : '';
    const delta = ` ${sign}${absVal}${pctPart}`;
    insights.push({
      tag,
      direction: c.direction,
      summary: `${label} ${effectWord} ${dirWord} next-day ${c.metricLabel.toLowerCase()}${delta} (n=${c.nWith})`,
    });
  }

  // negative effects first (more actionable)
  insights.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'negative' ? -1 : 1;
    return 0;
  });
  return insights;
}
