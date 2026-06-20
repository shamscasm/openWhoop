function motionValue(row) {
  if (row.motion != null && Number.isFinite(row.motion)) return Math.abs(row.motion);
  if (row.accel_x == null && row.accel_y == null && row.accel_z == null) return null;
  return Math.abs(row.accel_x || 0) + Math.abs(row.accel_y || 0) + Math.abs(row.accel_z || 0);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function estimateStepsFromAccel(rows) {
  const points = [];
  for (const row of rows || []) {
    const v = motionValue(row);
    if (v == null) continue;
    const t = +new Date(row.ts_utc);
    if (!Number.isFinite(t)) continue;
    points.push({ t, v });
  }
  if (points.length < 20) return { steps: null, source: null, confidencePct: null };
  points.sort((a, b) => a.t - b.t);

  let ema = points[0].v;
  const alpha = 0.08;
  const hp = [];
  for (const p of points) {
    ema = alpha * p.v + (1 - alpha) * ema;
    hp.push(Math.abs(p.v - ema));
  }
  const p75 = percentile(hp, 0.75) ?? 0;
  const p90 = percentile(hp, 0.90) ?? 0;
  const threshold = Math.max(18, p75 * 1.6, p90 * 0.75);
  let steps = 0;
  let lastStepMs = -Infinity;
  for (let i = 1; i < hp.length - 1; i++) {
    if (hp[i] < threshold || hp[i] < hp[i - 1] || hp[i] < hp[i + 1]) continue;
    const dt = points[i].t - lastStepMs;
    if (dt < 280 || (dt > 2500 && lastStepMs !== -Infinity)) continue;
    steps += 1;
    lastStepMs = points[i].t;
  }

  const spanHours = (points[points.length - 1].t - points[0].t) / 3_600_000;
  const coverageScore = Math.min(1, points.length / 2000) * 45;
  const spanScore = Math.min(1, spanHours / 8) * 35;
  const signalScore = p90 > 0 ? 20 : 0;
  const confidencePct = Math.round(Math.min(85, coverageScore + spanScore + signalScore));
  return {
    steps: steps > 0 ? steps : null,
    source: steps > 0 ? 'strap_accel' : null,
    confidencePct: steps > 0 ? confidencePct : null,
  };
}
