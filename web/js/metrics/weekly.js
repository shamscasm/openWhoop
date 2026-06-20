// Weekly summary generator. Produces a structured and human-readable summary
// of the past 7 days from daily_metrics rows.
//
// Pure function — no DB access. Caller fetches and passes metrics.

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtH(minutes) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Build a weekly summary from up to 7 recent daily_metrics rows.
 *
 * @param {Array} metrics - newest-first daily_metrics rows
 * @returns {{
 *   days: number,
 *   avgRecovery: number|null,
 *   avgStrain: number|null,
 *   avgSleepH: number|null,
 *   avgRmssd: number|null,
 *   avgRhr: number|null,
 *   totalCalories: number|null,
 *   workoutCount: number,
 *   bestRecovery: { date:string, score:number }|null,
 *   worstRecovery: { date:string, score:number }|null,
 *   highestStrain: { date:string, score:number }|null,
 *   greenDays: number,
 *   redDays: number,
 *   summary: string,
 * }}
 */
export function weeklySummary(metrics) {
  const slice = metrics.slice(0, 7);
  const days = slice.length;
  if (days === 0) {
    return {
      days: 0, avgRecovery: null, avgStrain: null, avgSleepH: null,
      avgRmssd: null, avgRhr: null, totalCalories: null, workoutCount: 0,
      bestRecovery: null, worstRecovery: null, highestStrain: null,
      greenDays: 0, redDays: 0, summary: 'No data yet.',
    };
  }

  const recoveries = slice.map((m) => m.recovery_score).filter((v) => v != null);
  const strains    = slice.map((m) => m.strain_score).filter((v) => v != null);
  const sleeps     = slice.map((m) => m.sleep_minutes).filter((v) => v != null);
  const rmssds     = slice.map((m) => m.rmssd_ms).filter((v) => v != null);
  const rhrs       = slice.map((m) => m.resting_hr).filter((v) => v != null);
  const cals       = slice.map((m) => m.calories).filter((v) => v != null);

  const avgRecovery = mean(recoveries);
  const avgStrain   = mean(strains);
  const avgSleepH   = sleeps.length ? mean(sleeps) / 60 : null;
  const avgRmssd    = mean(rmssds);
  const avgRhr      = mean(rhrs);
  const totalCalories = cals.length ? cals.reduce((a, b) => a + b, 0) : null;

  // Cumulative HR zone minutes across the week.
  const zoneSum = [0, 0, 0, 0, 0];
  let hasZoneData = false;
  for (const m of slice) {
    if (Array.isArray(m.zone_minutes)) {
      for (let i = 0; i < 5; i++) zoneSum[i] += m.zone_minutes[i] || 0;
      hasZoneData = true;
    }
  }

  // Workout count: days where strain > 10.
  const workoutCount = strains.filter((s) => s > 10).length;

  const greenDays = recoveries.filter((r) => r >= 67).length;
  const redDays   = recoveries.filter((r) => r < 33).length;

  let bestRecovery = null;
  let worstRecovery = null;
  let highestStrain = null;

  for (const m of slice) {
    if (m.recovery_score != null) {
      if (!bestRecovery || m.recovery_score > bestRecovery.score) {
        bestRecovery = { date: m.date, score: m.recovery_score };
      }
      if (!worstRecovery || m.recovery_score < worstRecovery.score) {
        worstRecovery = { date: m.date, score: m.recovery_score };
      }
    }
    if (m.strain_score != null && (!highestStrain || m.strain_score > highestStrain.score)) {
      highestStrain = { date: m.date, score: m.strain_score };
    }
  }

  // Build human-readable summary.
  const lines = [];
  lines.push(`📅 Last ${days} days`);
  if (avgRecovery != null) {
    const emoji = avgRecovery >= 67 ? '🟢' : avgRecovery >= 33 ? '🟡' : '🔴';
    lines.push(`${emoji} Avg recovery: ${Math.round(avgRecovery)}%  (${greenDays} green, ${redDays} red)`);
  }
  if (avgSleepH != null) lines.push(`💤 Avg sleep: ${avgSleepH.toFixed(1)}h`);
  if (avgRmssd   != null) lines.push(`💓 Avg HRV (RMSSD): ${Math.round(avgRmssd)} ms`);
  if (avgRhr     != null) lines.push(`❤️ Avg resting HR: ${Math.round(avgRhr)} bpm`);
  if (avgStrain  != null) lines.push(`⚡ Avg daily strain: ${avgStrain.toFixed(1)}  (${workoutCount} workout days)`);
  if (totalCalories != null) lines.push(`🔥 Total calories: ${Math.round(totalCalories).toLocaleString()} kcal`);

  if (hasZoneData && zoneSum.some((v) => v > 0)) {
    const zoneLine = zoneSum
      .map((mins, i) => mins > 0 ? `Z${i + 1} ${fmtH(mins)}` : null)
      .filter(Boolean)
      .join(' · ');
    if (zoneLine) lines.push(`🏃 Week zones: ${zoneLine}`);
  }

  return {
    days, avgRecovery, avgStrain, avgSleepH, avgRmssd, avgRhr, totalCalories,
    workoutCount, bestRecovery, worstRecovery, highestStrain,
    greenDays, redDays, zoneSum, hasZoneData, summary: lines.join('\n'),
  };
}
