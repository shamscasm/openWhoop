// Daily training plan / recommendation engine.
//
// Combines recovery score, recent strain load, and sleep performance to
// recommend a training intensity category for today. Completely pure —
// no DB access; caller reads the DB and passes values in.
//
// Output zones mirror Whoop's categories (with actionable HR guidance):
//   rest           Recovery < 33%  or  3+ consecutive low days
//   active         Recovery 33–50% or moderate sleep deficit
//   train          Recovery 50–67%
//   push           Recovery ≥ 67% + sufficient sleep + manageable load
//
// Each zone comes with a strain target range, an HR-zone ceiling, and
// a short message for display.

export const ZONES = Object.freeze({
  rest: {
    label: 'Rest day',
    emoji: '🛌',
    strainRange: [0, 5],
    hrZoneCap: 2,          // stay in zones 1–2
    color: '#f55',
    message: 'Your body needs to recover. Prioritise sleep, light walking, and no hard effort.',
  },
  active: {
    label: 'Active recovery',
    emoji: '🚶',
    strainRange: [5, 11],
    hrZoneCap: 2,
    color: '#fa3',
    message: 'Low-intensity movement today. A walk, gentle yoga, or easy swim — keep HR in zones 1–2.',
  },
  train: {
    label: 'Training day',
    emoji: '🏃',
    strainRange: [11, 16],
    hrZoneCap: 4,
    color: '#2a8',
    message: 'Good recovery baseline. A standard workout is well-tolerated. Aim for strain 11–16.',
  },
  push: {
    label: 'Peak effort',
    emoji: '🔥',
    strainRange: [16, 21],
    hrZoneCap: 5,
    color: '#0af',
    message: 'Excellent recovery — ideal for a hard training session, race, or PR attempt.',
  },
});

/**
 * Produce a daily plan recommendation.
 *
 * @param {Object} opts
 * @param {number|null} opts.recoveryScore      - today's recovery (0–100)
 * @param {number|null} opts.sleepPerformancePct- last night's sleep performance (0–100)
 * @param {number|null} opts.sleepDebtMinutes   - 7-day accumulated debt
 * @param {number|null} opts.avgStrain7d        - mean strain over last 7 days (0–21)
 * @param {boolean}     opts.lowStreakDays       - whether 3+ consecutive low recovery days
 * @returns {{ zone: string, label, emoji, strainRange, hrZoneCap, color, message,
 *             targetStrain: number, rationale: string }}
 */
export function dailyPlan({
  recoveryScore = null,
  sleepPerformancePct = null,
  sleepDebtMinutes = null,
  avgStrain7d = null,
  lowStreakDays = false,
} = {}) {
  // Default to active recovery if we don't have enough data.
  if (recoveryScore == null) {
    return buildResult('active', 'Insufficient data to assess recovery — defaulting to active recovery.');
  }

  // Forced rest: 3+ consecutive low-recovery days regardless of today's score.
  if (lowStreakDays) {
    return buildResult('rest', '3+ consecutive low-recovery days detected. Mandatory rest to avoid overreaching.');
  }

  // Hard rest: recovery in the red.
  if (recoveryScore < 33) {
    return buildResult('rest', `Recovery ${Math.round(recoveryScore)}% is in the red zone.`);
  }

  // Significant sleep debt overrides a green recovery.
  const debtH = (sleepDebtMinutes ?? 0) / 60;
  if (debtH >= 3 && recoveryScore < 67) {
    return buildResult('active', `Sleep debt of ${debtH.toFixed(1)}h is limiting recovery potential.`);
  }

  // Accumulated strain guard: if 7-day average strain is very high, cap push.
  const highLoad = avgStrain7d != null && avgStrain7d > 16;

  if (recoveryScore >= 67) {
    if (highLoad) {
      return buildResult('train', `Recovery green (${Math.round(recoveryScore)}%) but 7-day load is high (avg ${avgStrain7d.toFixed(1)}). A moderate workout is better than an all-out session today.`);
    }
    if (sleepPerformancePct != null && sleepPerformancePct < 60) {
      return buildResult('train', `Recovery green (${Math.round(recoveryScore)}%) but last night's sleep performance was low (${Math.round(sleepPerformancePct)}%). Save the hard effort for after a better night.`);
    }
    return buildResult('push', `Recovery ${Math.round(recoveryScore)}% — prime condition for a peak effort.`);
  }

  if (recoveryScore >= 50) {
    return buildResult('train', `Recovery ${Math.round(recoveryScore)}% — good to train at moderate intensity.`);
  }

  // 33–49%: yellow zone.
  return buildResult('active', `Recovery ${Math.round(recoveryScore)}% is in the yellow zone — keep it easy today.`);
}

function buildResult(zoneKey, rationale) {
  const zone = ZONES[zoneKey];
  const [lo, hi] = zone.strainRange;
  const targetStrain = Math.round((lo + hi) / 2);
  return { zone: zoneKey, ...zone, targetStrain, rationale };
}
