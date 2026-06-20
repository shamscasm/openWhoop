// Pages Function backing the AI Coach tab.
//
// Runs entirely on Cloudflare Workers AI (free tier, no third-party key): the
// browser POSTs the user's question plus a snapshot of today's metrics, and we
// ask a Llama model to answer like a concise WHOOP-style coach grounded in
// those numbers. Same-origin only (the app calls /api/coach on its own origin),
// so no CORS. No data is persisted — the metrics ride in the request and are
// gone when it returns.
//
// Requires an `AI` binding (wrangler.toml [ai] binding = "AI"). If the binding
// is absent (e.g. a preview without Workers AI enabled) we return 503 with a
// clear message so the UI degrades to its built-in rule-based tips.

const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_MESSAGE = 1000;
const MAX_HISTORY = 8;

// Whitelist the metric fields we forward, so we never echo anything unexpected
// and the prompt stays small + stable.
const METRIC_FIELDS = [
  'recovery_score', 'rmssd_ms', 'hrv_baseline_ms', 'resting_hr', 'strain_score',
  'zone_weighted_strain_score', 'sleep_minutes', 'sleep_performance_pct',
  'sleep_need_minutes', 'respiratory_rate', 'stress_avg', 'calories',
  'energy_kcal_active', 'energy_bank_remaining', 'vo2max', 'whoop_age',
];

function metricsLine(metrics) {
  if (!metrics || typeof metrics !== 'object') return 'No metrics available for today.';
  const parts = [];
  for (const k of METRIC_FIELDS) {
    const v = metrics[k];
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length ? parts.join(', ') : 'No metrics available for today.';
}

function systemPrompt(metrics) {
  return [
    'You are the in-app recovery coach for "whoof", a WHOOP-style wearable app.',
    "Answer the user's question in 2-4 short sentences, grounded in their numbers below.",
    'Recovery and sleep_performance are 0-100 (higher better). strain is 0-21.',
    'stress_avg is 0-100 (higher = more stressed). Reference the actual values when relevant.',
    'Be specific and practical. Do not give medical advice or diagnose. No markdown headings.',
    '',
    `Today's metrics: ${metricsLine(metrics)}`,
  ].join('\n');
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.AI) {
    return Response.json(
      { error: 'coach_unavailable', message: 'AI coach is not enabled on this deployment.' },
      { status: 503 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_request', message: 'Expected JSON body.' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  if (!message) {
    return Response.json({ error: 'bad_request', message: 'Empty message.' }, { status: 400 });
  }

  // Optional prior turns: [{ role: 'user'|'assistant', content }]
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }))
    : [];

  const messages = [
    { role: 'system', content: systemPrompt(body.metrics) },
    ...history,
    { role: 'user', content: message },
  ];

  try {
    const result = await env.AI.run(MODEL, { messages, max_tokens: 320 });
    const reply = (result && (result.response ?? result.result?.response)) || '';
    if (!reply) {
      return Response.json({ error: 'empty', message: 'No response generated.' }, { status: 502 });
    }
    return Response.json({ reply: reply.trim() });
  } catch (err) {
    return Response.json(
      { error: 'inference_failed', message: String(err && err.message ? err.message : err) },
      { status: 502 },
    );
  }
}
