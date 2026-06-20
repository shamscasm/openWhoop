/* whoof v0.2 — dashboard front-end */

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))
    ? "—"
    : (typeof v === "number" ? v.toFixed(d) : v);
const fmtInt = (v) => v === null || v === undefined ? "—" : Math.round(v).toString();
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmtHM = (mins) => {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}h ${m}m`;
};

const COLORS = {
  recGood: getCss("--rec-good"),
  recMid:  getCss("--rec-mid"),
  recBad:  getCss("--rec-bad"),
  strain:  getCss("--strain"),
  strain2: getCss("--strain-2"),
  sleep:   getCss("--sleep"),
  muted:   getCss("--muted"),
  fg:      getCss("--fg"),
  fg2:     getCss("--fg-2"),
  border:  getCss("--border"),
  stage: {
    wake:  getCss("--stage-wake"),
    light: getCss("--stage-light"),
    deep:  getCss("--stage-deep"),
    rem:   getCss("--stage-rem"),
  },
  zone: [getCss("--zone-1"), getCss("--zone-2"), getCss("--zone-3"), getCss("--zone-4"), getCss("--zone-5")],
};

function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function recoveryColor(score) {
  if (score == null) return COLORS.muted;
  if (score >= 67) return COLORS.recGood;
  if (score >= 34) return COLORS.recMid;
  return COLORS.recBad;
}

function recoveryLabel(score) {
  if (score == null) return "needs more data";
  if (score >= 67) return "Primed";
  if (score >= 34) return "Adequate";
  return "Low — rest day";
}

function strainLabel(s) {
  if (s == null) return "—";
  if (s < 6) return "Light";
  if (s < 11) return "Moderate";
  if (s < 15) return "Strenuous";
  if (s < 18) return "Hard";
  return "All-out";
}

/**
 * One-line coach recommendation for a given recovery score.
 * Returns null when score is unavailable.
 */
function recoveryCoach(score) {
  if (score == null) return null;
  if (score >= 85) return "Peak readiness — push hard today · Target strain 16–20";
  if (score >= 67) return "Ready for high intensity · Target strain 14–18";
  if (score >= 50) return "Good capacity — moderate efforts · Target strain 10–13";
  if (score >= 34) return "Reduced capacity — easier efforts · Target strain 7–11";
  return "Rest day recommended · Keep strain below 9";
}

/* ───────────────────────────── Date navigation ─────────────────────── */
// null = "today" (live data). YYYY-MM-DD string = historical view.
let _browseDate = null;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetDate(iso, deltaDays) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderDateNav(elId, iso) {
  const el = $(elId);
  if (!el) return;
  const todayStr = todayIso();
  const isToday = iso === todayStr;
  el.innerHTML = `
    <span style="display:inline-flex;gap:4px;align-items:center;">
      <button class="date-nav-btn" data-delta="-1" style="font-size:13px;padding:1px 6px;line-height:1.4;" title="Previous day">‹</button>
      <span style="font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;">${new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
      <button class="date-nav-btn" data-delta="+1" ${isToday ? "disabled" : ""} style="font-size:13px;padding:1px 6px;line-height:1.4;" title="Next day">›</button>
    </span>`;
  el.querySelectorAll(".date-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = parseInt(btn.dataset.delta, 10);
      const next = offsetDate(iso, delta);
      if (next > todayStr) return; // never go into the future
      _browseDate = next;
      loadActiveTab().catch((e) => setStatus("error: " + e.message));
    });
  });
}

async function fetchJSON(url, opts) {
  // Try the in-browser IndexedDB shim first (v0.3). If it returns null,
  // the path isn't routed — fall back to network fetch for compatibility.
  if (window.whoofApi) {
    const shimResult = await window.whoofApi.handle(url, opts);
    if (shimResult !== null) return shimResult;
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/* ───────────────────────────── Tab routing ─────────────────────────── */

const TABS = ["overview", "recovery", "sleep", "strain", "trends", "live", "activity", "body", "coach"];
let activeTab = "overview";

function setTab(name) {
  if (!TABS.includes(name)) name = "overview";
  // Reset date navigation when the user explicitly switches tabs.
  if (name !== activeTab) _browseDate = null;
  activeTab = name;
  // Sidebar tabs + mobile bottom-nav tabs share .active styling
  document.querySelectorAll(".tab, .mtab").forEach((t) => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-current", isActive ? "page" : "false");
    if (t.classList.contains("tab")) t.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.dataset.panel === name));
  history.replaceState(null, "", "#" + name);
  // Scroll to top on tab switch (especially helpful on mobile)
  window.scrollTo({ top: 0, behavior: "instant" });
  loadActiveTab().catch((e) => setStatus("error: " + e.message));
}

function initTabs() {
  document.querySelectorAll(".tab, .mtab").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  const coachForm = $("coach-form");
  if (coachForm) {
    coachForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("coach-input");
      if (!input) return;
      const text = input.value;
      input.value = "";
      sendCoachMessage(text);
    });
  }
  const initial = (location.hash || "#overview").slice(1);
  setTab(initial);
}

async function loadActiveTab() {
  const panel = document.querySelector(`.tab-panel[data-panel="${activeTab}"]`);
  if (panel) panel.classList.add("loading");
  try {
    switch (activeTab) {
      case "overview": return await loadOverview();
      case "recovery": return await loadRecovery();
      case "sleep":    return await loadSleep();
      case "strain":   return await loadStrain();
      case "trends":   return await loadTrends();
      case "live":     return await loadLive();
      case "body":     return await loadBody();
      case "activity": return await loadActivity();
      case "coach":    return await loadCoach();
    }
  } catch (e) {
    console.error(`[loadActiveTab] ${activeTab} failed:`, e);
    setStatus(`error: ${e.message}`);
  } finally {
    if (panel) panel.classList.remove("loading");
  }
}

/* ───────────────────────────── Coach (AI) ──────────────────────────── */

let _coachMetrics = null;     // today's metric snapshot, fetched lazily
let _coachHistory = [];       // [{role, content}] prior turns for context
let _coachGreeted = false;
let _coachBusy = false;

function coachBubble(role, text) {
  const log = $("coach-log");
  if (!log) return null;
  const wrap = document.createElement("div");
  const isUser = role === "user";
  wrap.style.cssText = `max-width:82%; padding:10px 14px; border-radius:14px; font-size:14px; line-height:1.5; white-space:pre-wrap; ` +
    (isUser
      ? "align-self:flex-end; background:#03B5F3; color:#04121b; border-bottom-right-radius:4px;"
      : "align-self:flex-start; background:rgba(255,255,255,.06); color:var(--text); border-bottom-left-radius:4px;");
  wrap.textContent = text;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

async function loadCoach() {
  // Pull today's full metric row once (recovery summary is the whole dm).
  if (!_coachMetrics) {
    try {
      const [recovery, body] = await Promise.all([
        fetchJSON(`/api/recovery?date=${todayIso()}`),
        fetchJSON(`/api/body?date=${todayIso()}&days=14`).catch(() => null),
      ]);
      _coachMetrics = { ...(recovery.summary || {}), body: body || null };
    } catch { _coachMetrics = {}; }
  }
  if (!_coachGreeted) {
    _coachGreeted = true;
    const r = _coachMetrics.recovery_score;
    const hello = r != null
      ? `Hey — your recovery is ${Math.round(r)}% today. Ask me anything about your recovery, strain, sleep, or stress.`
      : `Hey — connect your strap to compute today's metrics, then ask me about your recovery, strain, sleep, or stress.`;
    coachBubble("assistant", hello);
  }
}

async function sendCoachMessage(text) {
  if (_coachBusy) return;
  const msg = text.trim();
  if (!msg) return;
  _coachBusy = true;
  const send = $("coach-send");
  if (send) send.disabled = true;
  coachBubble("user", msg);
  _coachHistory.push({ role: "user", content: msg });
  // Cap history to prevent memory leak on long sessions
  if (_coachHistory.length > 50) _coachHistory = _coachHistory.slice(-30);
  const thinking = coachBubble("assistant", "…");
  try {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, metrics: _coachMetrics || {}, history: _coachHistory.slice(0, -1) }),
    });
    const data = await res.json().catch(() => ({}));
    const reply = res.ok && data.reply
      ? data.reply
      : (res.status === 503
        ? "Coach isn't enabled on this deployment yet (Workers AI binding missing)."
        : `Sorry — I couldn't answer that (${data.message || res.status}).`);
    if (thinking) thinking.textContent = reply;
    if (res.ok && data.reply) _coachHistory.push({ role: "assistant", content: data.reply });
  } catch (e) {
    if (thinking) thinking.textContent = "Network error reaching the coach.";
  } finally {
    _coachBusy = false;
    if (send) send.disabled = false;
  }
}

/* ───────────────────────────── Status line ─────────────────────────── */

function setStatus(html) { const el = $("status-line"); if (el) el.innerHTML = html; }

function fmtAgo(ts) {
  const ago = Math.round((Date.now() - ts) / 1000);
  if (ago < 5) return "just now";
  if (ago < 60) return ago + "s ago";
  if (ago < 3600) return Math.round(ago / 60) + "m ago";
  return Math.round(ago / 3600) + "h ago";
}

async function refreshStatus() {
  try {
    const s = await fetchJSON("/api/status");
    const items = [];
    if (s.latest_sample) {
      const ago = Math.round((Date.now() - new Date(s.latest_sample.ts_utc)) / 1000);
      items.push(`<span class="stat-item">Last reading <strong>${ago < 60 ? ago + "s" : Math.round(ago / 60) + "m"} ago</strong></span>`);
    }
    if (s.latest_battery) items.push(`<span class="stat-item">Battery <strong>${s.latest_battery.detail}</strong></span>`);
    items.push(`<span class="stat-item">${s.sample_count.toLocaleString()} samples · ${s.days_recorded} days</span>`);
    try {
      const syncSt = JSON.parse(localStorage.getItem("whoof-sync-status") || "{}");
      if (syncSt.lastSync) items.push(`<span class="stat-item">☁️ ${fmtAgo(syncSt.lastSync)}</span>`);
    } catch {}
    setStatus(items.join(""));
  } catch (e) {
    setStatus(`<span class="stat-item">⚠️ ${escapeHtml(e.message)}</span>`);
  }
}

/* ───────────────────────────── Charts cache ────────────────────────── */

const charts = {};
function makeOrUpdate(id, cfg) {
  const canvas = $(id);
  if (!canvas) return;
  if (charts[id]) {
    const chart = charts[id];
    const ds = cfg.data.datasets;
    // Add new datasets if needed
    while (chart.data.datasets.length < ds.length) {
      chart.data.datasets.push({});
    }
    // Remove extra datasets if needed
    while (chart.data.datasets.length > ds.length) {
      chart.data.datasets.pop();
    }
    ds.forEach((d, i) => {
      const t = chart.data.datasets[i];
      t.data = d.data;
      if (d.backgroundColor !== undefined) t.backgroundColor = d.backgroundColor;
      if (d.borderColor !== undefined) t.borderColor = d.borderColor;
      if (d.pointBackgroundColor !== undefined) t.pointBackgroundColor = d.pointBackgroundColor;
      if (d.borderWidth !== undefined) t.borderWidth = d.borderWidth;
      if (d.pointRadius !== undefined) t.pointRadius = d.pointRadius;
      if (d.tension !== undefined) t.tension = d.tension;
      if (d.fill !== undefined) t.fill = d.fill;
      if (d.borderDash !== undefined) t.borderDash = d.borderDash;
      if (d.label !== undefined) t.label = d.label;
      if (d.stack !== undefined) t.stack = d.stack;
      if (d.order !== undefined) t.order = d.order;
    });
    if (cfg.data.labels) chart.data.labels = cfg.data.labels;
    chart.update('none');
    return;
  }
  cfg.options = autoHideLegend(cfg.options, cfg.data);
  charts[id] = new Chart(canvas, cfg);
}

/**
 * Auto-disable the legend on single-series charts (visual noise).
 * Adapts a Chart.js options block based on its data.
 */
function autoHideLegend(opts, data) {
  const n = (data?.datasets?.length) || 0;
  if (n <= 1) {
    opts = opts || {};
    opts.plugins = opts.plugins || {};
    opts.plugins.legend = { ...(opts.plugins.legend || {}), display: false };
  }
  return opts;
}
function commonOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: {
          color: COLORS.fg2,
          usePointStyle: true,
          pointStyle: "circle",
          boxWidth: 6,
          boxHeight: 6,
          padding: 14,
          font: { size: 11, weight: "600", family: "Inter, system-ui, sans-serif" },
        },
        align: "end",
      },
      tooltip: {
        backgroundColor: "rgba(15,15,20,0.95)",
        borderColor: "rgba(60,60,67,0.08)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        titleFont: { size: 11, weight: "600" },
        bodyFont: { size: 12 },
        displayColors: true,
        boxPadding: 4,
      },
    },
    scales: {
      x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
    },
    ...extra,
  };
}

/* ───────────────────────────── Recovery ring (SVG) ─────────────────── */

const _ringCache = new Map();

function drawRing(svg, score, color, maxVal = 100, opts = {}) {
  if (!svg) return;
  const key = svg.id || svg.dataset.ringKey || (svg.dataset.ringKey = "r" + Math.random().toString(36).slice(2, 8));

  const stroke = opts.stroke ?? 18;
  const colorTo = opts.colorTo ?? color;
  const glow = opts.glow ?? true;
  const size = 300;
  const cx = size / 2, cy = size / 2;
  const r = (size - stroke) / 2 - 4;
  const startAngle = -225, endAngle = 45;
  const total = endAngle - startAngle;
  const pct = score == null ? 0 : Math.max(0, Math.min(maxVal, score)) / maxVal;

  const pt = (angleDeg, radius) => {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
  };
  const arcPath = (a0, a1, radius) => {
    const [x0, y0] = pt(a0, radius);
    const [x1, y1] = pt(a1, radius);
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`;
  };

  let cached = _ringCache.get(key);

  if (!cached) {
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    const gid = "g" + key;
    const fid = "f" + key;
    svg.innerHTML = `
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${color}"/>
          <stop offset="100%" stop-color="${colorTo}"/>
        </linearGradient>
        ${glow ? `<filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="6" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>` : ""}
      </defs>
      <path class="track" fill="none" stroke="rgba(60,60,67,0.08)" stroke-width="${stroke}" stroke-linecap="round"/>
      <path class="fill" fill="none" stroke="url(#${gid})" stroke-width="${stroke}" stroke-linecap="round"/>
      <circle class="head" r="${stroke / 2}"/>
    `;
    cached = {
      track: svg.querySelector(".track"),
      fill: svg.querySelector(".fill"),
      head: svg.querySelector(".head"),
      gid, fid,
    };
    _ringCache.set(key, cached);
  }

  const { track, fill, head, gid, fid } = cached;

  track.setAttribute("d", arcPath(startAngle, endAngle, r));
  track.setAttribute("stroke-width", stroke);

  if (pct > 0) {
    const fillEnd = startAngle + total * pct;
    fill.setAttribute("d", arcPath(startAngle, fillEnd, r));
    fill.setAttribute("stroke-width", stroke);
    fill.setAttribute("filter", glow ? `url(#${fid})` : "");
    fill.style.display = "";
    const [headX, headY] = pt(fillEnd, r);
    head.setAttribute("cx", headX);
    head.setAttribute("cy", headY);
    head.setAttribute("fill", colorTo);
    head.setAttribute("r", stroke / 2);
    head.style.display = "";
  } else {
    fill.style.display = "none";
    head.style.display = "none";
  }

  const grad = svg.querySelector(`#${gid}`);
  if (grad) {
    grad.querySelector("stop:first-child").setAttribute("stop-color", color);
    grad.querySelector("stop:last-child").setAttribute("stop-color", colorTo);
  }
}

function drawRecoveryRing(svg, score) {
  drawRing(svg, score, recoveryColor(score), 100, { stroke: 20 });
}
function drawGaugeRing(svg, score, color, formatFn, maxVal = 100) {
  drawRing(svg, score, color, maxVal, { stroke: 18 });
}

/* ───────────────────────────── Hypnogram (SVG) ─────────────────────── */

const STAGE_ORDER = ["wake", "rem", "light", "deep"]; // top→bottom

function drawHypnogram(svg, stages) {
  // Empty state: friendly moon illustration + caption
  if (!stages || !stages.length) {
    svg.setAttribute("viewBox", "0 0 1000 220");
    svg.innerHTML = `
      <defs>
        <radialGradient id="moonGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#2547D4" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#2547D4" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="500" cy="100" r="80" fill="url(#moonGrad)"/>
      <path d="M 530 70 A 38 38 0 1 0 530 130 A 28 28 0 1 1 530 70 Z" fill="#4D7CFF" opacity="0.85"/>
      <circle cx="430" cy="55" r="1.5" fill="#4D7CFF" opacity="0.6"/>
      <circle cx="570" cy="40" r="1.5" fill="#4D7CFF" opacity="0.6"/>
      <circle cx="600" cy="160" r="1.2" fill="#4D7CFF" opacity="0.5"/>
      <circle cx="410" cy="170" r="1.2" fill="#4D7CFF" opacity="0.5"/>
      <text x="500" y="200" text-anchor="middle" fill="${COLORS.muted}" style="font-size:13px;font-weight:500;font-family:Inter,system-ui,sans-serif;">No sleep recorded for this night</text>
    `;
    return;
  }
  return _drawHypnogramReal(svg, stages);
}

function _drawHypnogramReal(svg, stages) {
  const width = 1000, height = 220, padTop = 20, padBottom = 30, padLR = 8;
  const rowH = (height - padTop - padBottom) / STAGE_ORDER.length;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!stages.length) {
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:13px;">No sleep detected for this night.</text>`;
    return;
  }
  const t0 = new Date(stages[0].start).getTime();
  const t1 = new Date(stages[stages.length - 1].end).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (t) => padLR + ((new Date(t).getTime() - t0) / span) * (width - padLR * 2);
  const rowY = (stage) => padTop + STAGE_ORDER.indexOf(stage) * rowH + 4;

  const labels = STAGE_ORDER.map((s, i) => `
    <line x1="${padLR}" x2="${width - padLR}" y1="${padTop + i * rowH + rowH / 2}" y2="${padTop + i * rowH + rowH / 2}" stroke="${COLORS.border}" stroke-dasharray="2 4" />
    <text x="${padLR}" y="${padTop + i * rowH + 14}" fill="${COLORS.muted}" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;">${s}</text>
  `).join("");

  const blocks = stages.map((s) => {
    const x0 = x(s.start), x1 = x(s.end);
    const w = Math.max(1, x1 - x0);
    return `<rect x="${x0}" y="${rowY(s.stage)}" width="${w}" height="${rowH - 8}" rx="3" fill="${COLORS.stage[s.stage] || COLORS.muted}" opacity="0.92" />`;
  }).join("");

  // Time ticks (start, mid, end)
  const fmtT = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const ticks = `
    <text x="${padLR}" y="${height - 8}" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[0].start)}</text>
    <text x="${width / 2}" y="${height - 8}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[Math.floor(stages.length / 2)].start)}</text>
    <text x="${width - padLR}" y="${height - 8}" text-anchor="end" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[stages.length - 1].end)}</text>
  `;

  svg.innerHTML = labels + blocks + ticks;
}

/* ───────────────────────────── Zones donut (SVG) ───────────────────── */

function drawZonesDonut(svg, zoneMinutes) {
  const size = 200, cx = 100, cy = 100, r = 78, stroke = 22;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const total = zoneMinutes.reduce((a, b) => a + b, 0);
  if (!total) {
    svg.innerHTML = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" />
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:12px;">no zone data</text>
    `;
    return;
  }
  const circ = 2 * Math.PI * r;
  let offset = 0;
  let parts = "";
  zoneMinutes.forEach((m, i) => {
    if (!m) return;
    const len = (m / total) * circ;
    parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.zone[i]}"
      stroke-width="${stroke}" stroke-dasharray="${len} ${circ - len}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += len;
  });
  const totalH = total / 60;
  svg.innerHTML = `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" />
    ${parts}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${COLORS.fg}" style="font-size:24px;font-weight:600;">${totalH.toFixed(1)}h</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;">in zones</text>
  `;
}

/* ───────────────────────────── Overview tab ────────────────────────── */

async function loadOverview() {
  const [overview, today] = await Promise.all([
    fetchJSON("/api/overview"),
    fetchJSON("/api/today?downsample=20"),
  ]);

  const today_d = new Date();
  const dateStr = today_d.toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
  if ($("overview-date")) $("overview-date").textContent = dateStr;
  if ($("topbar-date"))   $("topbar-date").textContent   = `Today · ${today_d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const hour = today_d.getHours();
  const greeting = hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 22 ? "Good evening" : "Good night";
  const welcomeEl = document.querySelector(".welcome-text");
  if (welcomeEl) welcomeEl.textContent = `${greeting}!`;

  const m = overview.metrics || {};
  const trend7 = overview.trend7 || [];
  const prior = trend7.slice(0, -1);
  const baseline = (key) => {
    const vs = prior.map((r) => r[key]).filter((v) => v != null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };
  const deltaVal = (cur, key) => cur != null ? cur - baseline(key) : null;

  // ─── Score ribbon ──────────────────────────────────────────────
  const hasSleep = m.sleep_minutes != null && m.sleep_minutes > 0;
  const hasRec = m.recovery_score != null && m.recovery_score > 0 && m.rmssd_ms != null;
  const recScore = hasRec ? m.recovery_score : null;
  const strainScore = m.strain_score;
  const sleepPerf = hasSleep ? m.sleep_performance_pct : null;

  const ribbonRec = $("ribbon-recovery-ring");
  if (ribbonRec) drawRing(ribbonRec, recScore, recoveryColor(recScore), 100, { stroke: 8, glow: false });
  const ribbonRecNum = $("ribbon-recovery-num");
  if (ribbonRecNum) {
    ribbonRecNum.innerHTML = hasRec ? `${Math.round(recScore)}<span class="unit">%</span>` : `—<span class="unit">%</span>`;
    ribbonRecNum.style.color = hasRec ? "var(--text)" : "var(--text-faint)";
  }

  const ribbonSleep = $("ribbon-sleep-ring");
  if (ribbonSleep) drawRing(ribbonSleep, sleepPerf, COLORS.sleep, 100, { stroke: 8, glow: false });
  const ribbonSleepNum = $("ribbon-sleep-num");
  if (ribbonSleepNum) {
    ribbonSleepNum.innerHTML = hasSleep ? `${Math.round(sleepPerf)}<span class="unit">%</span>` : `—<span class="unit">%</span>`;
    ribbonSleepNum.style.color = hasSleep ? "var(--text)" : "var(--text-faint)";
  }

  const ribbonStrain = $("ribbon-strain-ring");
  if (ribbonStrain) drawRing(ribbonStrain, strainScore, "#03B5F3", 21, { stroke: 8, glow: false });
  const ribbonStrainNum = $("ribbon-strain-num");
  if (ribbonStrainNum) {
    ribbonStrainNum.textContent = strainScore != null ? strainScore.toFixed(1) : "—";
    ribbonStrainNum.style.color = strainScore != null ? "var(--strain)" : "var(--text-faint)";
  }

  // ─── Hero card ─────────────────────────────────────────────────
  const heroRing = $("hero-recovery-ring");
  if (heroRing) drawRing(heroRing, recScore, recoveryColor(recScore), 100, { stroke: 14, glow: true });
  const heroScore = $("hero-score");
  if (heroScore) {
    heroScore.innerHTML = hasRec ? `${Math.round(recScore)}<span class="unit">%</span>` : `—<span class="unit">%</span>`;
    heroScore.style.color = hasRec ? "var(--text)" : "var(--text-faint)";
  }
  const heroStatus = $("hero-status");
  if (heroStatus) {
    if (!hasRec) {
      heroStatus.textContent = "No data yet";
      heroStatus.style.color = "var(--text-faint)";
    } else {
      const labels = { good: "Optimal", mid: "Adequate", bad: "Low" };
      const tier = recScore >= 67 ? "good" : recScore >= 34 ? "mid" : "bad";
      heroStatus.textContent = labels[tier];
      heroStatus.style.color = recoveryColor(recScore);
    }
  }
  const heroCoach = $("hero-coach");
  if (heroCoach) {
    heroCoach.textContent = hasRec ? (recoveryCoach(recScore) ?? "") : "Wear your strap overnight to compute recovery.";
  }

  // Hero 2x2 metrics with deltas
  const setHeroMetric = (id, val, fmtFn, delta) => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = val != null ? fmtFn(val) : "—";
    el.style.color = val != null ? "var(--text)" : "var(--text-faint)";
    if (delta != null && val != null) {
      const deltaEl = el.parentElement?.querySelector(".hero-metric-delta");
      if (deltaEl) {
        const pct = baseline("rmssd_ms") ? ((delta / baseline("rmssd_ms")) * 100).toFixed(0) : null;
        const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
        // For RHR higher is worse; for HRV higher is better.
        const higherIsGood = id !== "hero-rhr";
        const badDelta = higherIsGood ? -3 : 3;
        const goodDelta = higherIsGood ? 3 : -3;
        const color = delta > goodDelta ? "var(--recovery)" : delta < badDelta ? "var(--bad)" : "var(--text-faint)";
        deltaEl.textContent = id === "hero-hrv"
          ? `${arrow} ${Math.abs(delta).toFixed(0)} ms`
          : `${arrow} ${Math.abs(delta).toFixed(1)} bpm`;
        deltaEl.style.color = color;
      }
    }
  };
  setHeroMetric("hero-hrv", m.rmssd_ms, (v) => fmtInt(v) + ' <span style="font-size:10px;font-weight:600;color:var(--text-muted)">ms</span>', deltaVal(m.rmssd_ms, "rmssd_ms"));
  setHeroMetric("hero-rhr", m.resting_hr, (v) => fmtInt(v) + ' <span style="font-size:10px;font-weight:600;color:var(--text-muted)">bpm</span>', deltaVal(m.resting_hr, "resting_hr"));
  const respEl = $("hero-resp");
  if (respEl) respEl.innerHTML = m.respiratory_rate != null ? m.respiratory_rate.toFixed(1) + ' <span style="font-size:10px;font-weight:600;color:var(--text-muted)">bpm</span>' : "—";
  const tempEl = $("hero-temp");
  if (tempEl) {
    const dev = m.skin_temp_deviation_c;
    tempEl.innerHTML = dev != null ? (dev > 0 ? "+" : "") + dev.toFixed(2) + ' <span style="font-size:10px;font-weight:600;color:var(--text-muted)">°C</span>' : "—";
  }

  // ─── Vitals strip ──────────────────────────────────────────────
  const ls = overview.latest_sample;
  const setVital = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  if (ls) {
    setVital("vitals-hr", fmtInt(ls.heart_rate_bpm));
    setVital("vitals-resp", ls.respiratory_rate != null ? ls.respiratory_rate.toFixed(1) : "—");
    setVital("vitals-temp", ls.skin_temp_c != null ? ls.skin_temp_c.toFixed(1) + "°" : "—");
    setVital("vitals-spo2", ls.spo2_pct != null ? ls.spo2_pct.toFixed(0) + "%" : "—");
    const ago = Math.round((Date.now() - new Date(ls.ts_utc)) / 1000);
    setVital("vitals-ago", ago < 60 ? ago + "s" : Math.round(ago / 60) + "m");
  } else {
    setVital("vitals-hr", "—");
    setVital("vitals-resp", "—");
    setVital("vitals-temp", "—");
    setVital("vitals-spo2", "—");
    setVital("vitals-ago", "—");
  }
  setVital("vitals-battery", overview.battery?.detail ?? "—");

  // ─── Insights are rendered by renderInsights() in app-mvp.js ────
  // (uses the generateInsights engine from metrics/insights.js)
  // Refresh on overview load so insights stay current:
  if (typeof window.renderInsightsFn === 'function') window.renderInsightsFn();

  const stepsEl = $("overview-steps");
  const stepsSourceEl = $("overview-steps-source");
  const activeEnergyEl = $("overview-active-energy");
  if (stepsEl) stepsEl.textContent = m.steps != null ? fmtInt(m.steps) : "—";
  if (stepsSourceEl) {
    const source = m.steps_source === "apple_health" ? "Apple Health backup" : m.steps_source === "strap_accel" ? "Strap accelerometer estimate" : "Import Apple Health or stream live accel";
    const conf = m.steps_confidence_pct != null ? ` · ${Math.round(m.steps_confidence_pct)}% conf` : "";
    stepsSourceEl.textContent = `${source}${conf}`;
  }
  if (activeEnergyEl) {
    activeEnergyEl.textContent = m.active_energy_kcal != null ? `${fmtInt(m.active_energy_kcal)} active kcal from Apple` : "";
  }

  // ─── Timeline ──────────────────────────────────────────────────
  const timelineList = $("timeline-list");
  if (timelineList) {
    const items = [];
    const fmtLocalHm = (iso) => {
      if (!iso) return null;
      try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return iso.slice(11, 16); }
    };
    if (m.bedtime_local) {
      const t = fmtLocalHm(m.bedtime_local);
      if (t) items.push({ time: t, title: "Bedtime", meta: "", dot: "#5E5CE6" });
    }
    if (hasSleep) {
      items.push({
        time: m.wake_local ? fmtLocalHm(m.wake_local) : "—",
        title: `Wake · ${fmtHM(m.sleep_minutes)} asleep`,
        meta: `Perf ${Math.round(sleepPerf)}% · ${Math.round(m.respiratory_rate || 0)} resp/min`,
        dot: COLORS.recGood,
      });
    } else if (m.wake_local) {
      const t = fmtLocalHm(m.wake_local);
      if (t) items.push({ time: t, title: "Wake", meta: "", dot: COLORS.muted });
    }
    (overview.recent_workouts || []).forEach((w) => {
      const start = new Date(w.start_utc);
      const dur = Math.round((w.duration_seconds || 0) / 60);
      items.push({
        time: start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        title: w.label || "Workout",
        meta: `${dur} min · avg ${fmtInt(w.avg_hr)} bpm · strain ${(w.strain || 0).toFixed(1)}`,
        dot: "#FF9F0A",
      });
    });
    items.sort((a, b) => (a.time > b.time ? 1 : -1));
    if (items.length) {
      timelineList.innerHTML = items.map((it) =>
        `<div class="timeline-item">
          <div class="timeline-dot" style="background:${it.dot}"></div>
          <div class="timeline-body">
            <div class="timeline-title">${escapeHtml(it.title)}</div>
            ${it.meta ? `<div class="timeline-meta">${escapeHtml(it.meta)}</div>` : ""}
          </div>
          <div class="timeline-time">${escapeHtml(it.time)}</div>
        </div>`
      ).join("");
    } else {
      timelineList.innerHTML = '<div class="timeline-empty">Wear your strap overnight to build your timeline.</div>';
    }
  }

  // ─── Temperature ───────────────────────────────────────────────
  const tempDevEl = $("overview-temp-dev");
  const tempMarkerEl = $("overview-temp-marker");
  const tempNoteEl = $("overview-temp-note");
  if (tempDevEl && tempMarkerEl && tempNoteEl) {
    const dev = m.skin_temp_deviation_c;
    if (dev == null) {
      tempDevEl.textContent = "—";
      tempMarkerEl.style.left = "50%";
      tempMarkerEl.style.background = "var(--text-faint)";
      tempNoteEl.textContent = "Wear overnight to build a temp baseline.";
    } else {
      const abs = Math.abs(dev);
      const sign = dev > 0 ? "+" : dev < 0 ? "−" : "";
      const pct = Math.max(6, Math.min(94, 50 + (dev / 1.2) * 44));
      const color = abs > 0.6 ? "var(--bad)" : abs > 0.3 ? "var(--warn)" : "var(--recovery)";
      tempDevEl.textContent = `${sign}${abs.toFixed(2)}`;
      tempMarkerEl.style.left = `${pct}%`;
      tempMarkerEl.style.background = color;
      tempNoteEl.textContent = abs > 0.6
        ? "Outside your normal range."
        : abs > 0.3
          ? "Slightly away from baseline."
          : "Near your normal baseline.";
    }
  }

  // ─── Plans ─────────────────────────────────────────────────────
  // Plan card is populated by app-mvp.js via the whoop-data-changed event.

  // ─── Workouts ──────────────────────────────────────────────────
  renderWorkoutList($("overview-workouts"), overview.recent_workouts || []);

  // ─── HR today chart ────────────────────────────────────────────
  const pts = today.points || [];
  const chartLabels = pts.map((p) => p.t.slice(11, 16));
  const chartData = pts.map((p) => p.hr);
  makeOrUpdate("hr-today", {
    type: "line",
    data: { labels: chartLabels, datasets: [{
      label: "HR",
      data: chartData,
      borderColor: COLORS.recGood,
      backgroundColor: COLORS.recGood + "22",
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.25,
      fill: true,
    }] },
    options: commonOpts(),
  });

  // ─── Battery ring ──────────────────────────────────────────────
  const bat = overview.battery;
  const batPctEl = $("battery-pct-label");
  const batRingFill = $("battery-ring-fill");
  const batPctText = $("battery-pct-text");
  const batSyncEl = $("battery-last-sync");
  if (bat && bat.detail) {
    const pct = Math.round(parseFloat(bat.detail));
    const circ = 2 * Math.PI * 26;
    const offset = circ - (pct / 100) * circ;
    const color = pct > 60 ? "var(--rec-good)" : pct > 20 ? "var(--warn)" : "var(--rec-bad)";
    if (batPctEl) batPctEl.innerHTML = `${pct}<span class="unit">%</span>`;
    if (batRingFill) {
      batRingFill.style.stroke = color;
      batRingFill.style.strokeDashoffset = offset;
    }
    if (batPctText) {
      batPctText.textContent = `${pct}%`;
      batPctText.style.fill = color;
    }
    // Show last sync time from the battery event timestamp
    if (batSyncEl) {
      let text = "";
      if (bat.ts_utc) {
        const d = new Date(bat.ts_utc);
        const ago = Math.round((Date.now() - d) / 60000);
        text = ago < 1 ? "Just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      } else {
        text = "—";
      }
      // Overlay cloud sync time if more recent
      try {
        const syncSt = JSON.parse(localStorage.getItem("whoof-sync-status") || "{}");
        if (syncSt.lastSync && (!bat.ts_utc || syncSt.lastSync > new Date(bat.ts_utc).getTime())) {
          text = "☁️ " + fmtAgo(syncSt.lastSync);
        }
      } catch {}
      batSyncEl.textContent = "Synced: " + text;
    }
  } else {
    if (batPctEl) batPctEl.innerHTML = '—<span class="unit">%</span>';
    if (batRingFill) batRingFill.style.strokeDashoffset = "0";
    if (batPctText) batPctText.textContent = "—%";
    if (batSyncEl) batSyncEl.textContent = "Synced: —";
  }
}

function drawSleepBarsMini(el, m) {
  const stages = [
    { k: "deep",  v: m.deep_sleep_minutes  || 0, c: COLORS.stage.deep },
    { k: "rem",   v: m.rem_sleep_minutes   || 0, c: COLORS.stage.rem },
    { k: "light", v: m.light_sleep_minutes || 0, c: COLORS.stage.light },
    { k: "wake",  v: m.wake_minutes        || 0, c: COLORS.stage.wake },
  ];
  const total = stages.reduce((a, b) => a + b.v, 0) || 1;
  el.innerHTML = stages.map((s) =>
    `<span style="flex: ${s.v / total}; background:${s.c};"></span>`
  ).join("");
}

function renderWorkoutList(el, workouts) {
  if (!workouts.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 L 10 14 L 14 17 L 19 8"/><circle cx="6" cy="18" r="1.5" fill="currentColor"/><circle cx="10" cy="14" r="1.5" fill="currentColor"/><circle cx="14" cy="17" r="1.5" fill="currentColor"/><circle cx="19" cy="8" r="1.5" fill="currentColor"/></svg>
      No workouts detected yet
    </div>`;
    return;
  }
  el.innerHTML = workouts.map((w) => {
    const start = new Date(w.start_utc);
    const dur = Math.round((w.duration_seconds || 0) / 60);
    const labelTxt = escapeHtml(w.label || "Workout");
    return `<div class="workout-row" data-workout-id="${w.id}">
      <div class="wo-time">${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}<br><span style="opacity:0.6">${dur} min</span></div>
      <div>
        <div class="wo-name workout-label" style="cursor:pointer;" title="Click to rename">${labelTxt}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">avg ${fmtInt(w.avg_hr)} · max ${fmtInt(w.max_hr)} bpm · ${fmtInt(w.calories)} kcal</div>
      </div>
      <div class="wo-strain">${(w.strain ?? 0).toFixed(1)}</div>
    </div>`;
  }).join("");

  // Wire inline label editing.
  el.querySelectorAll(".workout-label").forEach((trigger) => {
    trigger.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-workout-id]");
      if (!row) return;
      const id = parseInt(row.dataset.workoutId, 10);
      const current = trigger.textContent === "Workout" ? "" : trigger.textContent;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = current;
      inp.placeholder = "e.g. Running";
      inp.style.cssText = "font-size:10px;padding:2px 5px;border-radius:4px;border:1px solid var(--border);background:var(--bg-3);color:var(--fg);width:90px;";
      trigger.replaceWith(inp);
      inp.focus();
      inp.select();
      const save = async () => {
        const label = inp.value.trim();
        try {
          await fetchJSON("/api/workout-label", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, label }),
          });
        } catch {}
        // Re-render by reloading the active tab.
        if (location.hash === "#strain") loadStrain();
        else if (location.hash === "" || location.hash === "#overview") loadOverview();
      };
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } else if (e.key === "Escape") inp.blur(); });
    });
  });
}

/* ───────────────────────────── Recovery tab ────────────────────────── */

async function loadRecovery() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/recovery?date=${dateParam}`);
  renderDateNav("recovery-date", data.date ?? dateParam);

  const m = data.summary || {};
  // recovery_score=0 with no HRV is "no data", same as in Overview
  const hasRec = data.summary != null && m.recovery_score != null && m.recovery_score > 0 && m.rmssd_ms != null;
  const recScore = hasRec ? m.recovery_score : null;
  const recColor = recoveryColor(recScore);
  drawRing($("recovery-ring-big"), recScore, recColor, 100, { stroke: 26 });
  if ($("recovery-ring-big-num")) {
    $("recovery-ring-big-num").innerHTML = hasRec
      ? `${Math.round(recScore)}<span class="unit">%</span>`
      : `—<span class="unit">%</span>`;
    $("recovery-ring-big-num").style.color = hasRec ? "var(--text)" : "var(--text-faint)";
  }
  if ($("recovery-state-big")) {
    $("recovery-state-big").textContent = hasRec ? recoveryLabel(recScore).toUpperCase() : "No data yet";
    $("recovery-state-big").style.color = hasRec ? recColor : "var(--text-faint)";
  }
  if ($("recovery-coach")) {
    const coach = hasRec ? (recoveryCoach(recScore) ?? "") : "Wear your strap overnight to compute recovery.";
    $("recovery-coach").textContent = coach;
  }

  // Components
  const comps = [
    { name: "HRV",       v: m.recovery_hrv_component   },
    { name: "Resting HR",v: m.recovery_rhr_component   },
    { name: "Sleep",     v: m.recovery_sleep_component },
    { name: "Respiratory", v: m.recovery_resp_component },
    { name: "Prior strain", v: m.recovery_strain_component },
  ];
  // HRV baseline tag line (today vs. 14-day baseline)
  let hrvTagLine = "";
  if (m.rmssd_ms != null && m.hrv_baseline_ms != null) {
    const delta = m.rmssd_ms - m.hrv_baseline_ms;
    const pct = Math.abs(delta / m.hrv_baseline_ms * 100).toFixed(0);
    const sign = delta >= 0 ? "+" : "−";
    const color = delta >= 0 ? COLORS.recGood : COLORS.recBad;
    hrvTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:4px;">
      HRV today <strong style="color:var(--fg)">${m.rmssd_ms.toFixed(0)} ms</strong>
      vs. 14-day baseline <strong style="color:var(--fg)">${m.hrv_baseline_ms.toFixed(0)} ms</strong>
      <span style="color:${color}">(${sign}${pct}%)</span>
    </div>`;
  }
  // Resting HR baseline tag line — computed from trend data (prior days only)
  let rhrTagLine = "";
  if (m.resting_hr != null) {
    const trend = data.trend || [];
    const rhrHist = trend.slice(0, -1).map((r) => r.resting_hr).filter((v) => v != null);
    if (rhrHist.length >= 3) {
      const rhrBase = rhrHist.reduce((a, b) => a + b, 0) / rhrHist.length;
      const delta = m.resting_hr - rhrBase;
      const sign = delta >= 0 ? "+" : "−";
      // Elevated RHR is a bad sign; lower is good.
      const color = delta > 3 ? COLORS.recBad : delta < -3 ? COLORS.recGood : COLORS.muted;
      rhrTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:4px;">
        RHR today <strong style="color:var(--fg)">${Math.round(m.resting_hr)} bpm</strong>
        vs. 14-day baseline <strong style="color:var(--fg)">${Math.round(rhrBase)} bpm</strong>
        <span style="color:${color}">(${sign}${Math.abs(delta).toFixed(1)} bpm)</span>
      </div>`;
    }
  }
  // Skin temp baseline tag line (today vs. 14-day baseline)
  let skinTagLine = "";
  if (m.avg_skin_temp_c != null && m.skin_temp_deviation_c != null) {
    const dev = m.skin_temp_deviation_c;
    const sign = dev >= 0 ? "+" : "−";
    const color = Math.abs(dev) > 0.5 ? (dev > 0 ? COLORS.recMid : COLORS.strain) : COLORS.muted;
    skinTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:8px;">
      Skin temp est. <strong style="color:var(--fg)">${m.avg_skin_temp_c.toFixed(1)}°C</strong>
      (<span style="color:${color}">${sign}${Math.abs(dev).toFixed(2)}°C vs. baseline</span>)
    </div>`;
  }
  const recoveryCompsEl = $("recovery-components");
  if (recoveryCompsEl) recoveryCompsEl.innerHTML = hrvTagLine + rhrTagLine + skinTagLine + comps.map((c) => `
    <div class="component-row">
      <div class="name">${c.name}</div>
      <div class="barwrap"><div class="bar" style="width:${c.v == null ? 0 : Math.max(0, Math.min(100, c.v))}%;background:${recoveryColor(c.v)}"></div></div>
      <div class="val">${c.v == null ? "—" : Math.round(c.v)}</div>
    </div>
  `).join("");

  // ---- Stress (daytime average) --------------------------------------------
  if ($("rec-stress")) {
    const st = m.stress_avg;
    $("rec-stress").textContent = st == null ? "—" : Math.round(st);
    const lbl = $("rec-stress-label");
    if (lbl) {
      if (st == null) { lbl.textContent = ""; }
      else {
        const tier = st < 34 ? ["CALM", COLORS.recGood] : st < 67 ? ["MODERATE", COLORS.recMid] : ["HIGH", COLORS.recBad];
        lbl.textContent = tier[0];
        lbl.style.color = tier[1];
      }
    }
  }

  // ---- Fitness & longevity (VO2max, fitness age, WHOOP age) ----------------
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setText("rec-vo2max", m.vo2max != null ? m.vo2max.toFixed(1) : "—");
  setText("rec-vo2max-cat", m.vo2max_category ?? "—");
  setText("rec-fitness-age", m.fitness_age != null ? Math.round(m.fitness_age) : "—");
  setText("rec-whoop-age", m.whoop_age != null ? Math.round(m.whoop_age) : "—");
  if ($("rec-whoop-age-sub")) {
    if (m.whoop_age != null && m.whoop_age_delta != null) {
      const d = m.whoop_age_delta;
      const col = d < 0 ? COLORS.recGood : d > 0 ? COLORS.recBad : COLORS.muted;
      $("rec-whoop-age-sub").innerHTML =
        `WHOOP age · <span style="color:${col}">${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(1)}y vs actual</span>`;
    } else {
      $("rec-whoop-age-sub").textContent = "WHOOP age";
    }
  }

  // ---- Health Monitor — today's vitals vs personal baseline ----------------
  const hm = data.health_monitor;
  if ($("rec-health-monitor")) {
    if (hm && hm.vitals && hm.vitals.length) {
      const dotColor = (s) =>
        s === "normal" ? COLORS.recGood
        : (s === "elevated" || s === "low") ? COLORS.recBad
        : COLORS.muted;
      $("rec-health-monitor").innerHTML = hm.vitals.map((v) => `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--hairline);">
          <span style="width:8px; height:8px; border-radius:50%; background:${dotColor(v.status)}; flex-shrink:0;"></span>
          <span style="flex:1; font-size:12px;">${v.label}</span>
          <span style="font-variant-numeric:tabular-nums; font-size:12px; color:var(--fg);">${v.value == null ? "—" : v.value + " " + v.unit}</span>
          <span style="font-size:10px; color:var(--muted); width:72px; text-align:right;">${v.status === "unavailable" ? "" : v.status}</span>
        </div>
      `).join("");
      if ($("rec-health-overall")) {
        const oc = hm.overall === "green" ? COLORS.recGood : hm.overall === "yellow" ? COLORS.recMid : COLORS.recBad;
        $("rec-health-overall").innerHTML = `<span style="color:${oc}">●</span>`;
      }
    } else {
      $("rec-health-monitor").innerHTML =
        `<div style="font-size:11px; color:var(--muted);">Wear your strap a few more days to build a baseline.</div>`;
      if ($("rec-health-overall")) $("rec-health-overall").innerHTML = "";
    }
  }

  // Trend charts
  const trend = data.trend || [];
  const labels = trend.map((r) => r.date.slice(5));

  // 30-day recovery score chart with color-coded bars (green/yellow/red zones)
  const recScores = trend.map((r) => r.recovery_score);
  makeOrUpdate("recovery-30d", {
    type: "bar",
    data: { labels, datasets: [{
      label: "Recovery %",
      data: recScores,
      backgroundColor: recScores.map((v) =>
        v == null ? "transparent"
        : v >= 67 ? COLORS.recGood
        : v >= 33 ? COLORS.recMid
        : COLORS.recBad
      ),
      borderWidth: 0,
    }] },
    options: commonOpts({
      scales: {
        x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
        y: { min: 0, max: 100, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
      },
    }),
  });

  makeOrUpdate("hrv-30d", {
    type: "line",
    data: { labels, datasets: [{
      label: "RMSSD (ms)", data: trend.map((r) => r.rmssd_ms),
      borderColor: COLORS.recGood, backgroundColor: COLORS.recGood + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });
  makeOrUpdate("rhr-30d", {
    type: "line",
    data: { labels, datasets: [{
      label: "Resting HR (bpm)", data: trend.map((r) => r.resting_hr),
      borderColor: COLORS.strain, backgroundColor: COLORS.strain + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });
  makeOrUpdate("temp-30d", {
    type: "bar",
    data: { labels, datasets: [{
      label: "Δ°C vs baseline",
      data: trend.map((r) => r.skin_temp_deviation_c),
      backgroundColor: trend.map((r) => (r.skin_temp_deviation_c ?? 0) > 0 ? COLORS.recMid : COLORS.strain),
    }] },
    options: commonOpts(),
  });

  // Poincaré plot is rendered by app-mvp.js — notify it to refresh.
  window.dispatchEvent(new CustomEvent("whoop-tab-recovery"));
}

/* ───────────────────────────── Sleep tab ───────────────────────────── */

async function loadSleep() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/sleep?date=${dateParam}`);
  renderDateNav("sleep-date", data.date ?? dateParam);

  const m = data.summary || {};
  drawHypnogram($("hypnogram"), data.stages);
  const hypnogramLegendEl = $("hypnogram-legend");
  if (hypnogramLegendEl) hypnogramLegendEl.innerHTML = ["wake", "light", "rem", "deep"].map((s) =>
    `<span><span class="swatch" style="background:${COLORS.stage[s]}"></span>${s}</span>`
  ).join("");

  // Treat sleep_minutes ≤ 0 as "no real sleep data" (rollup writes zeros)
  const hasSleep = m.sleep_minutes != null && m.sleep_minutes > 0;

  const setSleepTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setSleepTxt("sleep-total", hasSleep ? fmtHM(m.sleep_minutes) : "—");
  setSleepTxt("sleep-performance", hasSleep ? (m.sleep_performance_pct ?? "—") : "—");
  setSleepTxt("sleep-need-line", (hasSleep && m.sleep_need_minutes)
    ? `need ${fmtHM(m.sleep_need_minutes)}`
    : (m.sleep_need_minutes ? `need ${fmtHM(m.sleep_need_minutes)}` : ""));
  if ($("sleep-source")) {
    const source = m.sleep_source ? (m.sleep_source === 'motion+hr' ? 'Motion + HR' : 'HR-only fallback') : '—';
    $("sleep-source").textContent = hasSleep ? `Source: ${source}` : '—';
  }
  if ($("sleep-confidence")) {
    const conf = m.sleep_confidence_pct;
    $("sleep-confidence").textContent = hasSleep && conf != null ? `Confidence: ${Math.round(conf)}%` : '';
  }
  const debt = m.sleep_debt_minutes;
  setSleepTxt("sleep-debt", debt == null ? "—" : (debt / 60).toFixed(1));
  setSleepTxt("sleep-consistency", hasSleep ? (m.sleep_consistency_pct ?? "—") : "—");
  setSleepTxt("sleep-resp", hasSleep ? (m.respiratory_rate ?? "—") : "—");
  setSleepTxt("sleep-spo2", hasSleep ? (m.avg_spo2 ?? "—") : "—");

  // Quality score (composite) — suppress when no sleep
  const quality = hasSleep ? (data.quality || {}) : {};
  if ($("sleep-quality")) {
    $("sleep-quality").textContent = quality.score ?? "—";
    if (quality.score != null) {
      const colorFor = (v) => v >= 80 ? COLORS.recGood : v >= 60 ? COLORS.recMid : COLORS.recBad;
      $("sleep-quality").style.color = colorFor(quality.score);
    } else {
      $("sleep-quality").style.color = "var(--text-faint)";
    }
    const labels = {
      performance: "Need fulfillment",
      efficiency:  "Efficiency",
      restorative: "Restorative",
      consistency: "Consistency",
      debt:        "Debt",
    };
    const qualityBreakdownEl = $("sleep-quality-breakdown");
    if (qualityBreakdownEl) qualityBreakdownEl.innerHTML = Object.entries(quality.breakdown || {})
      .map(([k, v]) => `<div>${labels[k] || k}</div><div style="text-align:right; font-weight:600; color:var(--fg2);">${v}</div>`)
      .join("");
    // Quality ring
    const qSvg = $("sleep-quality-ring");
    if (qSvg) {
      const qColor = quality.score != null
        ? (quality.score >= 80 ? COLORS.recGood : quality.score >= 60 ? COLORS.recMid : COLORS.recBad)
        : COLORS.muted;
      drawRing(qSvg, quality.score, qColor, 100, { stroke: 18, glow: false });
    }
  }

  // Bedtime / wake time: stored as local ISO 'YYYY-MM-DDTHH:MM', display as HH:MM.
  function fmtLocalIso(iso) {
    if (!iso) return "—";
    const t = iso.slice(11, 16); // HH:MM part
    if (!t) return "—";
    try {
      const [h, min] = t.split(":").map(Number);
      const d = new Date(2000, 0, 1, h, min);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return t; }
  }
  if ($("sleep-bedtime")) $("sleep-bedtime").textContent = fmtLocalIso(m.bedtime_local);
  if ($("sleep-wake"))    $("sleep-wake").textContent    = fmtLocalIso(m.wake_local);

  // Stage breakdown bars
  const stages = [
    { k: "Deep",  v: m.deep_sleep_minutes  || 0, c: COLORS.stage.deep },
    { k: "REM",   v: m.rem_sleep_minutes   || 0, c: COLORS.stage.rem },
    { k: "Light", v: m.light_sleep_minutes || 0, c: COLORS.stage.light },
    { k: "Wake",  v: m.wake_minutes        || 0, c: COLORS.stage.wake },
  ];
  const tot = stages.reduce((a, b) => a + b.v, 0) || 1;
  const stageBarsEl = $("stage-bars");
  if (stageBarsEl) stageBarsEl.innerHTML = stages.map((s) => `
    <div class="row">
      <div class="lbl">${s.k}</div>
      <div class="barwrap"><div class="bar" style="width:${s.v / tot * 100}%;background:${s.c}"></div></div>
      <div class="v">${fmtHM(s.v)}</div>
    </div>
  `).join("");

  // Sleep trend charts
  const trend = data.trend || [];
  const tLabels = trend.map((r) => r.date.slice(5));
  makeOrUpdate("sleep-trend", {
    type: "bar",
    data: {
      labels: tLabels,
      datasets: [
        { label: "Deep",  data: trend.map((r) => r.deep_sleep_minutes  ?? 0), backgroundColor: COLORS.stage.deep,  stack: "s" },
        { label: "REM",   data: trend.map((r) => r.rem_sleep_minutes   ?? 0), backgroundColor: COLORS.stage.rem,   stack: "s" },
        { label: "Light", data: trend.map((r) => r.light_sleep_minutes ?? 0), backgroundColor: COLORS.stage.light, stack: "s" },
      ],
    },
    options: commonOpts({
      scales: {
        x: { stacked: true, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
        y: { stacked: true, ticks: { color: COLORS.muted, callback: (v) => fmtHM(v) }, grid: { color: COLORS.border } },
      },
    }),
  });
  makeOrUpdate("sleep-rr-trend", {
    type: "line",
    data: { labels: tLabels, datasets: [{
      label: "RR (breaths/min)", data: trend.map((r) => r.respiratory_rate),
      borderColor: COLORS.recMid, backgroundColor: COLORS.recMid + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });

  // 30-day quality-score bars (same color zones as Quality card)
  const qScores = trend.map((r) => r.quality_score);
  makeOrUpdate("sleep-quality-trend", {
    type: "bar",
    data: { labels: tLabels, datasets: [{
      label: "Quality /100",
      data: qScores,
      backgroundColor: qScores.map((v) =>
        v == null ? "transparent"
        : v >= 80 ? COLORS.recGood
        : v >= 60 ? COLORS.recMid
        : COLORS.recBad
      ),
      borderWidth: 0,
    }] },
    options: commonOpts({
      scales: {
        x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
        y: { min: 0, max: 100, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
      },
    }),
  });
}

/* ───────────────────────────── Strain tab ──────────────────────────── */

async function loadStrain() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/strain?date=${dateParam}`);
  renderDateNav("strain-date", data.date ?? dateParam);
  const m = data.summary || {};
  // Hero ring
  if ($("strain-hero-ring")) {
    drawRing($("strain-hero-ring"), m.strain_score, "#03B5F3", 21, { stroke: 22, colorTo: "#00D4FF" });
  }
  const strainBigEl = $("strain-big");
  if (strainBigEl) strainBigEl.textContent = m.strain_score == null ? "—" : m.strain_score.toFixed(1);
  const strainLabelEl = $("strain-label");
  if (strainLabelEl) strainLabelEl.textContent = m.strain_score == null ? "no activity yet" : strainLabel(m.strain_score).toUpperCase();
  if ($("strain-label")) $("strain-label").style.color = m.strain_score == null ? "var(--text-faint)" : "var(--strain)";
  if ($("strain-target")) {
    const coach = recoveryCoach(m.recovery_score);
    $("strain-target").textContent = coach ? `Based on recovery: ${coach.split("·")[1]?.trim() ?? ""}` : "";
  }
  const strainCalsEl = $("strain-cals");
  if (strainCalsEl) strainCalsEl.textContent = fmtInt(m.calories);

  // Zone-weighted strain (interpretable companion score)
  if ($("strain-zone")) {
    $("strain-zone").textContent = m.zone_weighted_strain_score == null
      ? "—" : m.zone_weighted_strain_score.toFixed(1);
  }

  // Energy bank — active/resting split + remaining strain budget gauge
  if ($("energy-active")) {
    $("energy-active").textContent = m.energy_kcal_active == null ? "—" : fmtInt(m.energy_kcal_active);
    $("energy-resting").textContent = m.energy_kcal_resting == null ? "—" : fmtInt(m.energy_kcal_resting);
    const remaining = m.energy_bank_remaining;
    $("energy-remaining").textContent = remaining == null ? "—" : remaining.toFixed(1);
    // Fill = remaining as a fraction of today's recovery-set budget (recovery/100·21).
    const budget = m.recovery_score != null ? (m.recovery_score / 100) * 21 : 21;
    const pct = (remaining == null || budget <= 0) ? 0 : Math.max(0, Math.min(100, (remaining / budget) * 100));
    if ($("energy-bank-fill")) $("energy-bank-fill").style.width = `${pct}%`;
  }

  // Zones row — modernised with vertical bars + labels
  const zoneMins = (m && m.zone_minutes) || [0, 0, 0, 0, 0];
  const maxZ = Math.max(...zoneMins, 1);
  const zoneColors = [COLORS.zone[0], COLORS.zone[1], COLORS.zone[2], COLORS.zone[3], COLORS.zone[4]];
  const zoneRow = $("zones-row");
  if (zoneRow) zoneRow.innerHTML = ["Z1", "Z2", "Z3", "Z4", "Z5"].map((nm, i) => `
    <div class="zone-cell">
      <div style="height:60px; display:flex; align-items:end; justify-content:center; margin-bottom:8px;">
        <div style="width:18px; height:${Math.max(4, (zoneMins[i] / maxZ) * 60)}px; background:${zoneColors[i]}; border-radius:4px; box-shadow:0 0 12px ${zoneColors[i]}66;"></div>
      </div>
      <div class="zlbl">${nm}</div>
      <div class="zval">${fmtHM(zoneMins[i])}</div>
      <div style="font-size:9px; color:var(--text-faint); margin-top:2px;">${zonePctLabel(i)}</div>
    </div>
  `).join("");

  drawZonesDonut($("zones-donut"), zoneMins);

  // Strain curve
  const curve = data.curve || [];
  const labels = curve.map((p) => p.t.slice(11, 16));
  makeOrUpdate("strain-curve", {
    type: "line",
    data: { labels, datasets: [{
      label: "Cumulative strain",
      data: curve.map((p) => p.strain),
      borderColor: COLORS.strain,
      backgroundColor: COLORS.strain + "22",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      fill: true,
    }] },
    options: commonOpts({ scales: { x: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } }, y: { min: 0, max: 21, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } } } }),
  });

  renderWorkoutList($("strain-workouts"), data.workouts || []);

  // 30-day strain trend bars
  const trend = data.trend || [];
  if (trend.length && $("strain-30d")) {
    const tLabels = trend.map((r) => r.date.slice(5));
    const tData = trend.map((r) => r.strain_score);
    makeOrUpdate("strain-30d", {
      type: "bar",
      data: { labels: tLabels, datasets: [{
        label: "Strain /21",
        data: tData,
        backgroundColor: tData.map((v) => v == null ? "transparent" : COLORS.strain),
        borderWidth: 0,
      }] },
      options: commonOpts({
        scales: {
          x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
          y: { min: 0, max: 21, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
        },
      }),
    });
  }

  // ACWR card
  const acwr = data.acwr;
  if ($("acwr-ratio")) {
    if (acwr) {
      $("acwr-ratio").textContent = acwr.ratio.toFixed(2);
      const bandStyles = {
        'sweet-spot': { label: "SWEET SPOT", color: COLORS.recGood },
        'elevated':   { label: "ELEVATED",   color: COLORS.recMid  },
        'high-risk':  { label: "HIGH RISK",  color: COLORS.recBad  },
        'detraining': { label: "DETRAINING", color: COLORS.muted   },
      };
      const b = bandStyles[acwr.band] || bandStyles['sweet-spot'];
      $("acwr-band").textContent = b.label;
      $("acwr-band").style.color = b.color;
      $("acwr-ratio").style.color = b.color;
      $("acwr-detail").textContent =
        `acute ${acwr.acute.toFixed(1)} · chronic ${acwr.chronic.toFixed(1)} · target 0.8–1.3`;
    } else {
      $("acwr-ratio").textContent = "—";
      $("acwr-band").textContent = "need 10+ days of strain data";
      $("acwr-band").style.color = "var(--muted)";
      $("acwr-detail").textContent = "";
    }
  }
}

function zonePctLabel(i) {
  return ["50-60%", "60-70%", "70-80%", "80-90%", "90+%"][i];
}

/* ───────────────────────────── Trends tab ──────────────────────────── */

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function loadTrends() {
  const metricEl = $("trend-metric");
  const daysEl = $("trend-days");
  if (!metricEl || !daysEl) return;
  const metric = metricEl.value;
  const days = parseInt(daysEl.value, 10);
  const [trend, history] = await Promise.all([
    fetchJSON(`/api/trends?metric=${metric}&days=${days}`),
    fetchJSON(`/api/history?days=${days}`),
  ]);
  const trendTitleEl = $("trend-title");
  if (trendTitleEl) trendTitleEl.textContent = `${metricLabel(metric)} · ${days} days`;

  const labels = trend.series.map((r) => r.date.slice(5));
  const rawValues = trend.series.map((r) => r.value);

  // 7-day centred rolling average overlay.
  const W = 7;
  const rolling = rawValues.map((_, i) => {
    const half = Math.floor(W / 2);
    const lo = Math.max(0, i - half);
    const hi = Math.min(rawValues.length, i + half + 1);
    const window = rawValues.slice(lo, hi).filter((v) => v != null);
    return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });

  makeOrUpdate("trend-main", {
    type: "line",
    data: { labels, datasets: [
      {
        label: metricLabel(metric),
        data: rawValues,
        borderColor: metricColor(metric),
        backgroundColor: metricColor(metric) + "22",
        borderWidth: 1.5,
        pointRadius: 1.5,
        tension: 0.2,
        fill: true,
        order: 2,
      },
      {
        label: "7-day avg",
        data: rolling,
        borderColor: metricColor(metric),
        backgroundColor: "transparent",
        borderWidth: 2.5,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.4,
        fill: false,
        order: 1,
      },
    ] },
    options: commonOpts(),
  });

  const wd = trend.weekday_averages || {};
  makeOrUpdate("trend-weekday", {
    type: "bar",
    data: {
      labels: WEEKDAY_LABELS,
      datasets: [{
        label: metricLabel(metric),
        data: WEEKDAY_LABELS.map((_, i) => wd[i]),
        backgroundColor: metricColor(metric),
      }],
    },
    options: commonOpts(),
  });

  renderTrendsTable(history.days || []);
  renderPersonalRecords();
}

async function renderPersonalRecords() {
  const el = $("personal-records");
  if (!el) return;
  try {
    const prs = await fetchJSON("/api/personal-records");
    const items = [
      { label: "Best HRV",         pr: prs.hrv_max,        fmt: (v) => v.toFixed(0) + " ms",  color: COLORS.recGood  },
      { label: "Lowest RHR",       pr: prs.rhr_min,        fmt: (v) => v.toFixed(0) + " bpm", color: COLORS.strain   },
      { label: "Peak recovery",    pr: prs.recovery_max,   fmt: (v) => v.toFixed(0) + "%",     color: COLORS.recGood  },
      { label: "Longest sleep",    pr: prs.sleep_max_min,  fmt: (v) => fmtHM(v),               color: COLORS.stage.deep },
      { label: "Peak strain",      pr: prs.strain_max,     fmt: (v) => v.toFixed(1) + "/21",   color: COLORS.recMid   },
      { label: "Best sleep perf",  pr: prs.sleep_perf_max, fmt: (v) => v.toFixed(0) + "%",     color: COLORS.recGood  },
    ];
    el.innerHTML = items.map(({ label, pr, fmt, color }) => {
      if (!pr) return `<div style="background:var(--card-bg2);border-radius:8px;padding:10px 12px;"><div style="font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">${label}</div><div style="font-size:20px;font-weight:700;color:var(--muted);margin-top:2px;">—</div></div>`;
      return `<div style="background:var(--card-bg2);border-radius:8px;padding:10px 12px;">
        <div style="font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">${label}</div>
        <div style="font-size:20px;font-weight:700;color:${color};margin-top:2px;">${fmt(pr.value)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1px;">${pr.date}</div>
      </div>`;
    }).join("");
  } catch (e) {
    console.warn("[personal-records]", e);
  }
}

function metricLabel(m) {
  return {
    recovery_score: "Recovery",
    rmssd_ms: "HRV (RMSSD ms)",
    resting_hr: "Resting HR",
    strain_score: "Strain",
    sleep_minutes: "Sleep (min)",
    sleep_performance_pct: "Sleep performance %",
    sleep_debt_minutes: "Sleep debt (min)",
    avg_hr: "Avg HR",
    avg_spo2: "SpO₂",
    skin_temp_deviation_c: "Skin temp est. Δ°C",
    respiratory_rate: "Respiratory rate",
    calories: "Calories",
    stress_avg: "Stress avg",
    steps: "Steps",
    active_energy_kcal: "Active kcal",
  }[m] || m;
}
function metricColor(m) {
  if (m.includes("recovery") || m.includes("rmssd") || m.includes("sleep_performance")) return COLORS.recGood;
  if (m.includes("strain") || m.includes("calories")) return COLORS.strain;
  if (m.includes("sleep")) return COLORS.sleep;
  if (m.includes("stress")) return COLORS.recBad;
  return COLORS.fg2;
}

function renderTrendsTable(days) {
  const cols = [
    ["date", "Date"], ["recovery_score", "Rec"], ["strain_score", "Strain"],
    ["rmssd_ms", "HRV"], ["resting_hr", "RHR"], ["sleep_minutes", "Sleep"],
    ["sleep_performance_pct", "Sleep %"], ["sleep_debt_minutes", "Debt"],
    ["respiratory_rate", "Resp"], ["avg_spo2", "SpO₂"],
    ["skin_temp_deviation_c", "Δ°C"], ["calories", "kcal"],
    ["steps", "Steps"], ["active_energy_kcal", "Act kcal"],
  ];
  const head = `<thead><tr>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${days.map((d) => `
    <tr>${cols.map(([k]) => {
      let v = d[k];
      if (k === "date") v = v;
      else if (k === "sleep_minutes") v = v ? fmtHM(v) : "—";
      else if (k === "sleep_debt_minutes") v = v != null ? fmtHM(v) : "—";
      else if (typeof v === "number") v = k === "rmssd_ms" || k === "resting_hr" || k === "calories" || k === "steps" || k === "active_energy_kcal" ? Math.round(v) : v.toFixed(1);
      else if (v == null) v = "—";
      return `<td>${v}</td>`;
    }).join("")}</tr>
  `).join("")}</tbody>`;
  const trendsTableEl = $("trends-table");
  if (trendsTableEl) trendsTableEl.innerHTML = head + body;
}

/* ───────────────────────────── Body tab ────────────────────────────── */

async function loadBody() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/body?date=${dateParam}&days=30`);
  renderDateNav("body-date", data.date ?? dateParam);

  const eaten = data.eaten || {};
  const deficit = data.deficit;
  const balanceEl = $("body-balance");
  if (balanceEl) {
    balanceEl.textContent = deficit == null ? "—" : `${deficit >= 0 ? "−" : "+"}${Math.abs(deficit).toLocaleString()} kcal`;
    balanceEl.style.color = deficit == null ? "var(--text-faint)" : deficit >= 0 ? "var(--rec-good)" : "var(--rec-bad)";
  }
  if ($("body-balance-note")) {
    $("body-balance-note").textContent = deficit == null
      ? "Add age, height, weight, and food logs for a useful calorie read."
      : deficit >= 0
        ? "Estimated deficit. Keep protein high and avoid crash dieting."
        : "Estimated surplus. Useful for muscle gain, not for cutting.";
  }
  const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v == null ? "—" : (typeof v === "number" ? Math.round(v).toLocaleString() : String(v)); };
  setTxt("body-eaten", eaten.calories);
  setTxt("body-burned", data.burned);
  setTxt("body-bmr", data.bmr);
  setTxt("macro-protein", eaten.protein_g != null ? `${Math.round(eaten.protein_g)}g` : null);
  setTxt("macro-carbs", eaten.carbs_g != null ? `${Math.round(eaten.carbs_g)}g` : null);
  setTxt("macro-fat", eaten.fat_g != null ? `${Math.round(eaten.fat_g)}g` : null);

  const foodList = $("food-list");
  if (foodList) {
    const rows = data.food_entries || [];
    foodList.innerHTML = rows.length ? rows.map((row) => `
      <div class="food-row">
        <div><strong>${escapeHtml(row.name || "Food")}</strong><span>${escapeHtml(row.meal || "snack")} · ${Math.round(row.calories || 0)} kcal</span></div>
        <button type="button" data-food-id="${row.id}" title="Delete">×</button>
      </div>
    `).join("") : `<div class="empty-state">No food logged today.</div>`;
    foodList.querySelectorAll("[data-food-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this food entry?")) return;
        await fetchJSON(`/api/food?id=${btn.dataset.foodId}`, { method: "DELETE" });
        loadBody().catch((e) => setStatus("error: " + e.message));
      });
    });
  }

  const latestWeight = data.latest_weight?.weight_kg ?? data.profile?.weight_kg ?? null;
  if ($("body-latest-weight")) $("body-latest-weight").textContent = latestWeight == null ? "—" : Number(latestWeight).toFixed(1);
  if ($("body-projection")) {
    const p = data.projected_kg_4w;
    $("body-projection").textContent = p == null ? "—" : `${p >= 0 ? "−" : "+"}${Math.abs(p).toFixed(1)}`;
    $("body-projection").style.color = p == null ? "var(--text-faint)" : p >= 0 ? "var(--rec-good)" : "var(--rec-bad)";
  }

  const weights = data.weights || [];
  makeOrUpdate("body-weight-chart", {
    type: "line",
    data: { labels: weights.map((r) => r.date.slice(5)), datasets: [{
      label: "Weight kg",
      data: weights.map((r) => r.weight_kg),
      borderColor: COLORS.sleep,
      backgroundColor: COLORS.sleep + "22",
      pointRadius: 2,
      borderWidth: 1.8,
      tension: 0.25,
      fill: true,
    }] },
    options: commonOpts(),
  });

  const trend = data.nutrition_trend || [];
  makeOrUpdate("body-cal-chart", {
    type: "bar",
    data: { labels: trend.map((r) => r.date.slice(5)), datasets: [{
      label: "Calories eaten",
      data: trend.map((r) => r.calories),
      backgroundColor: COLORS.strain,
    }] },
    options: commonOpts(),
  });
}

function estimateFoodFromText(text) {
  const s = text.toLowerCase();
  let calories = 250;
  let protein = 10, carbs = 25, fat = 8;
  const add = (kcal, p = 0, c = 0, f = 0) => { calories += kcal; protein += p; carbs += c; fat += f; };
  if (/egg/.test(s)) add(140, 12, 1, 10);
  if (/chicken|fish|paneer|tofu|protein/.test(s)) add(250, 30, 4, 8);
  if (/rice|pasta|bread|toast|roti|potato/.test(s)) add(250, 5, 50, 2);
  if (/avocado|oil|butter|cheese|nuts/.test(s)) add(180, 4, 5, 16);
  if (/salad|veg|vegetable|fruit/.test(s)) add(80, 2, 16, 1);
  if (/large|big|double/.test(s)) calories *= 1.35;
  if (/small|half|light/.test(s)) calories *= 0.75;
  return {
    name: text.trim().slice(0, 80) || "AI food estimate",
    calories: Math.max(50, Math.round(calories)),
    protein_g: Math.max(0, Math.round(protein)),
    carbs_g: Math.max(0, Math.round(carbs)),
    fat_g: Math.max(0, Math.round(fat)),
  };
}

function initBodyForms() {
  const foodForm = $("food-form");
  if (foodForm) {
    foodForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(foodForm);
      await fetchJSON("/api/food", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(f.entries())),
      });
      foodForm.reset();
      loadBody().catch((e) => setStatus("error: " + e.message));
    });
  }
  const aiBtn = $("ai-food-estimate");
  if (aiBtn) {
    aiBtn.addEventListener("click", () => {
      const text = $("ai-food-text")?.value || "";
      const est = estimateFoodFromText(text);
      if (foodForm) {
        foodForm.name.value = est.name;
        foodForm.calories.value = est.calories;
        foodForm.protein_g.value = est.protein_g;
        foodForm.carbs_g.value = est.carbs_g;
        foodForm.fat_g.value = est.fat_g;
      }
      if ($("ai-food-result")) $("ai-food-result").textContent = `Draft: ${est.calories} kcal · P${est.protein_g} C${est.carbs_g} F${est.fat_g}. Review then Add food.`;
    });
  }
  const weightForm = $("weight-form");
  if (weightForm) {
    weightForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(weightForm);
      await fetchJSON("/api/weight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(f.entries())),
      });
      weightForm.reset();
      loadBody().catch((e) => setStatus("error: " + e.message));
    });
  }
  const woForm = $("manual-workout-form");
  if (woForm) {
    woForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(woForm);
      const payload = Object.fromEntries(f.entries());
      payload.date = todayIso();
      if (!payload.start_time) {
        const now = new Date();
        payload.start_time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      }
      await fetchJSON("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      woForm.reset();
      setStatus("workout saved");
      loadBody().catch((e) => setStatus("error: " + e.message));
    });
  }
}

/* ───────────────────────────── Activity tab ───────────────────────── */

async function loadActivity() {
  const [historyData, workoutData] = await Promise.all([
    fetchJSON("/api/history?days=30"),
    fetchJSON("/api/workouts?days=30"),
  ]);
  const days = historyData.days || [];
  const today = days[0] || {};
  const workouts = (workoutData.workouts || []).slice(0, 20);

  // Today stats
  const steps = today.steps;
  const stepsSource = today.steps_source;
  const stepsConf = today.steps_confidence_pct;
  const activeKcal = today.active_energy_kcal ?? today.calories ?? null;
  const strain = today.strain_score;

  if ($("activity-steps")) $("activity-steps").textContent = steps != null ? fmtInt(steps) : "—";
  if ($("activity-steps-source")) {
    $("activity-steps-source").textContent = steps != null
      ? `${stepsSource === "apple_health" ? "Apple Health" : "Strap accel"} · ${Math.round(stepsConf ?? 0)}% conf`
      : "No step data";
  }
  if ($("activity-kcal")) $("activity-kcal").textContent = activeKcal != null ? fmtInt(activeKcal) : "—";
  if ($("activity-strain")) $("activity-strain").textContent = strain != null ? strain.toFixed(1) : "—";

  // HR zone minutes
  const zones = today.zone_minutes || [0, 0, 0, 0, 0];
  const zoneLabels = ["Z1", "Z2", "Z3", "Z4", "Z5"];
  const zoneColors = ["#8bc34a", "#cddc39", "#ffc107", "#ff9800", "#f44336"];
  const zoneMax = Math.max(...zones, 1);
  const zoneEl = $("activity-zone-bars");
  if (zoneEl) {
    zoneEl.innerHTML = zones.map((v, i) => `
      <div class="zone-row">
        <span class="zone-label">${zoneLabels[i]}</span>
        <div class="zone-track"><div class="zone-fill" style="width:${(v / zoneMax) * 100}%;background:${zoneColors[i]}"></div></div>
        <span class="zone-val">${v}m</span>
      </div>
    `).join("");
  }

  // Recent workouts
  const woEl = $("activity-workouts");
  if (woEl) {
    if (workouts.length === 0) {
      woEl.innerHTML = '<div class="muted" style="text-align:center;padding:12px 0;">No workouts yet</div>';
    } else {
      woEl.innerHTML = workouts.map((w) => {
        const d = new Date(w.start_utc);
        const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const dur = w.duration_seconds ? Math.round(w.duration_seconds / 60) + "m" : "—";
        return `<div class="wo-row">
          <div class="wo-left">
            <strong>${escapeHtml(w.label || "Workout")}</strong>
            <span class="wo-meta">${date} ${time} · ${dur}</span>
          </div>
          <div class="wo-right">
            ${w.avg_hr ? `<span class="wo-hr">${Math.round(w.avg_hr)} bpm</span>` : ""}
            ${w.strain != null ? `<span class="wo-strain">${w.strain.toFixed(1)}</span>` : ""}
            ${w.calories ? `<span class="wo-cal">${Math.round(w.calories)} kcal</span>` : ""}
          </div>
        </div>`;
      }).join("");
    }
  }

  // Steps 7-day bar chart
  const last7 = days.slice(0, 7).reverse();
  const sLabels = last7.map((r) => r.date.slice(5));
  const sData = last7.map((r) => r.steps ?? 0);
  makeOrUpdate("activity-steps-chart", {
    type: "bar",
    data: { labels: sLabels, datasets: [{
      label: "Steps",
      data: sData,
      backgroundColor: sData.map((v) => v > 0 ? "var(--rec-good)" : "var(--text-faint)"),
      borderRadius: 4,
      borderWidth: 0,
    }] },
    options: commonOpts({ scales: {
      x: { ticks: { color: COLORS.muted }, grid: { display: false } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
    } }),
  });

  // Active kcal 7-day line chart
  const kcalData = last7.map((r) => (r.active_energy_kcal ?? r.calories ?? 0));
  makeOrUpdate("activity-kcal-chart", {
    type: "bar",
    data: { labels: sLabels, datasets: [{
      label: "Active kcal",
      data: kcalData,
      backgroundColor: kcalData.map((v) => v > 0 ? "var(--warn)" : "var(--text-faint)"),
      borderRadius: 4,
      borderWidth: 0,
    }] },
    options: commonOpts({ scales: {
      x: { ticks: { color: COLORS.muted }, grid: { display: false } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
    } }),
  });
}

/* ───────────────────────────── Live tab ────────────────────────────── */

async function loadLive() {
  const data = await fetchJSON("/api/live?seconds=300");
  const last = data.latest_sample;

  // ─── Data stream status card ─────────────────────────────────
  const statusEl = document.getElementById("live-data-status");
  if (statusEl) {
    const ble = window.whoofBleClient;
    const rawActive = ble?._rawActive ?? false;
    const connected = ble?.connected ?? false;
    const family = ble?._family ?? '?';
    const points5m = data.points?.length ?? 0;
    const hasSpo2 = data.points?.some(p => p.spo2 != null) ?? false;
    const hasTemp = data.points?.some(p => p.temp != null) ?? false;
    const hasMotion = data.points?.some(p => p.motion != null) ?? false;
    const liveSteps = data.live_steps?.steps;
    const imuCount = counts['IMU_PARSED'] ?? 0;
    const raw96Count = counts['RAW96_PARSED'] ?? 0;
    const unframedCount = counts['UNFRAMED'] ?? 0;
    const lines = [
      `<b>BLE:</b> ${connected ? 'connected' : 'disconnected'} (${family})`,
      `<b>Raw data mode:</b> ${rawActive ? '✅ ACTIVE' : '❌ INACTIVE'}`,
      `<b>Points (5 min):</b> ${points5m}`,
      `<b>Packets:</b> IMU=${imuCount} | RAW96=${raw96Count} | UNFRAMED=${unframedCount} | HR=${counts['REALTIME_DATA'] ?? 0}`,
      `<b>Sensor data in window:</b> SpO2=${hasSpo2 ? '✅' : '❌'} Temp=${hasTemp ? '✅' : '❌'} Motion=${hasMotion ? '✅' : '❌'}`,
      `<b>Live steps:</b> ${liveSteps ?? '—'}`,
      `<b>Latest:</b> HR=${last?.heart_rate_bpm ?? '—'} SpO2=${last?.spo2_pct ?? '—'} Temp=${last?.skin_temp_c?.toFixed(1) ?? '—'} Motion=${last?.motion ?? '—'}`,
    ];
    statusEl.innerHTML = lines.join('<br>');
  }

  if (last) {
    $("live-hr").textContent = fmtInt(last.heart_rate_bpm);
    const liveResp = document.getElementById("live-resp");
    const liveTempEst = document.getElementById("live-temp-est");
    const liveSpo2 = document.getElementById("live-spo2");
    if (liveResp) liveResp.textContent = last.respiratory_rate != null ? last.respiratory_rate.toFixed(1) : "—";
    if (liveTempEst) liveTempEst.textContent = last.skin_temp_c != null ? last.skin_temp_c.toFixed(1) : "—";
    if (liveSpo2) liveSpo2.textContent = last.spo2_pct != null ? last.spo2_pct.toFixed(0) : "—";
    const motionEl = document.getElementById("live-motion");
    if (motionEl) motionEl.textContent = last.motion != null ? last.motion.toFixed(0) : "—";
    const motionSourceEl = document.getElementById("live-motion-source");
    if (motionSourceEl) {
      const ms = data.latest_motion;
      if (last.motion != null && ms?.ts_utc) {
        const ageSec = Math.max(0, Math.round((Date.now() - new Date(ms.ts_utc)) / 1000));
        const age = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
        motionSourceEl.textContent = `${ms.source === "strap_motion" ? "strap motion" : "strap accel"} · ${age}`;
      } else {
        motionSourceEl.textContent = "waiting for accel stream";
      }
    }
    const liveSteps = document.getElementById("live-steps");
    const liveStepsSource = document.getElementById("live-steps-source");
    const liveStepData = data.live_steps || {};
    if (liveSteps) liveSteps.textContent = liveStepData.steps != null ? fmtInt(liveStepData.steps) : "—";
    if (liveStepsSource) {
      liveStepsSource.textContent = liveStepData.steps != null
        ? `strap accel · ${Math.round(liveStepData.confidencePct ?? 0)}% conf`
        : "walk with live accel streaming";
    }
    const ago = Math.round((Date.now() - new Date(last.ts_utc)) / 1000);
    $("live-status").textContent = ago < 60 ? `last sample ${ago}s ago` : `last sample ${Math.round(ago / 60)}m ago`;
  } else {
    $("live-status").textContent = "no samples yet";
  }
  $("live-battery").textContent = data.battery?.detail ?? "—";

  const livePoints = data.points || [];
  const labels = livePoints.map((p) => p.t.slice(11, 19));
  makeOrUpdate("live-chart", {
    type: "line",
    data: { labels, datasets: [{
      label: "HR",
      data: livePoints.map((p) => p.hr),
      borderColor: COLORS.recGood,
      backgroundColor: COLORS.recGood + "22",
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.25,
      fill: true,
    }] },
    options: commonOpts(),
  });

  const eventsEl = $("live-events");
  if (eventsEl) {
    const raw = data.events || [];
    const seen = new Set();
    const deduped = [];
    for (const e of raw) {
      const key = `${e.kind}|${e.detail ?? ""}|${e.ts_utc?.slice(0, 16) ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }
    eventsEl.innerHTML = deduped.map((e) => {
      const t = new Date(e.ts_utc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      let detail = e.detail ?? "";
      const kind = e.kind;
      // Format specific event types
      if (kind === "hello" && detail) {
        try { const h = JSON.parse(detail); detail = `${h.model ?? ""} · ${h.firmware ?? ""}`; } catch {}
      }
      if (kind === "battery" && detail) detail = `Battery ${detail}`;
      if (kind === "clock") detail = "RTC synced";
      if (detail.length > 40) detail = detail.slice(0, 37) + "...";
      return `<div class="ev"><span class="kind">${escapeHtml(kind)}</span><span class="detail" title="${escapeHtml(e.detail ?? "")}">${escapeHtml(detail)}</span><span class="time">${escapeHtml(t)}</span></div>`;
    }).join("") || `<div class="muted" style="padding:8px 0;text-align:center;">No events yet</div>`;
  }

  const sampleRate = data.points.length / 300;
  $("live-stats").innerHTML = `
    <div class="kv-row"><span class="k">Points in window</span><span class="v">${data.points.length}</span></div>
    <div class="kv-row"><span class="k">Effective rate</span><span class="v">${sampleRate.toFixed(2)} Hz</span></div>
    <div class="kv-row"><span class="k">Server time</span><span class="v">${new Date(data.now_utc).toLocaleTimeString()}</span></div>
  `;

  // ─── Debug buttons for raw data mode ─────────────────────────
  const ble = window.whoofBleClient;
  const startRawBtn = $("live-start-raw");
  const enableOptBtn = $("live-enable-optical");
  const stopRawBtn = $("live-stop-raw");
  const copyLogBtn = $("live-copy-log");
  if (startRawBtn) startRawBtn.onclick = async () => {
    if (!ble?.connected) return alert('Not connected');
    try { await ble.startRawData(); alert('Raw data started (cmd 81)'); } catch (e) { alert('Failed: ' + e.message); }
  };
  if (enableOptBtn) enableOptBtn.onclick = async () => {
    if (!ble?.connected) return alert('Not connected');
    try { await ble.enableR10R11(); alert('R10/R11 optical enabled (cmd 63 [0x01])'); } catch (e) { alert('Failed: ' + e.message); }
  };
  if (stopRawBtn) stopRawBtn.onclick = async () => {
    if (!ble?.connected) return alert('Not connected');
    try { await ble.stopRawData(); alert('Raw data stopped (cmd 82)'); } catch (e) { alert('Failed: ' + e.message); }
  };
  if (copyLogBtn) copyLogBtn.onclick = async () => {
    const counts = ble?.getPacketCounts?.() ?? {};
    const header = [
      `=== WHOOF DEBUG LOG ===`,
      `Time: ${new Date().toISOString()}`,
      `BLE: ${ble?.connected ? 'connected' : 'disconnected'} (${ble?._family})`,
      `Raw active: ${ble?._rawActive}`,
      `Packet counts: ${JSON.stringify(counts)}`,
      `Raw notif count: ${ble?._rawNotifCount ?? 0}`,
      `=======================`,
    ].join('\n');
    const log = header + '\n' + (window.getDebugLog?.() ?? 'No log data');
    try { await navigator.clipboard.writeText(log); alert('Log copied to clipboard!'); } catch { alert('Copy failed — check the log panel below'); }
  };

  // Also show packet counts in the status card
  if (statusEl && ble?.connected) {
    const counts = ble.getPacketCounts?.() ?? {};
    statusEl.innerHTML += `<br><b>Packet counts:</b> ${JSON.stringify(counts)}`;
  }
}

/* ───────────────────────────── Settings drawer ─────────────────────── */

function initDrawer() {
  const drawer = $("settings-drawer");
  const backdrop = $("drawer-backdrop");
  function open() {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    loadProfile();
  }
  function close() {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
  }
  $("open-settings").addEventListener("click", open);
  $("close-settings").addEventListener("click", close);
  backdrop.addEventListener("click", close);

  // "More" section buttons — navigate to tab and close drawer
  for (const [btnId, tab] of [["drawer-coach-btn", "coach"], ["drawer-trends-btn", "trends"], ["drawer-activity-btn", "activity"]]) {
    const btn = $(btnId);
    if (btn) btn.addEventListener("click", () => { close(); setTab(tab); });
  }

  $("settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const payload = {};
    for (const [k, v] of f.entries()) {
      payload[k] = v === "" ? null : v;
    }
    await fetchJSON("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    close();
    refreshAll();
  });

  let _recomputeTimer = null;
  $("recompute-btn").addEventListener("click", async () => {
    if (_recomputeTimer) clearTimeout(_recomputeTimer);
    $("recompute-btn").textContent = "Recomputing…";
    try {
      await fetchJSON("/api/recompute", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      $("recompute-btn").textContent = "Done";
    } catch (e) {
      $("recompute-btn").textContent = "Error: " + e.message;
    }
    _recomputeTimer = setTimeout(() => { $("recompute-btn").textContent = "Recompute last 7 days"; }, 1800);
    refreshAll();
  });
}

async function loadProfile() {
  try {
    const p = await fetchJSON("/api/profile");
    const form = $("settings-form");
    if (!form) return;
    form.age.value = p.age ?? "";
    form.sex.value = p.sex ?? "";
    form.weight_kg.value = p.weight_kg ?? "";
    form.height_cm.value = p.height_cm ?? "";
    form.max_hr_override.value = p.max_hr_override ?? "";
  } catch (e) {
    console.warn("[profile] load failed:", e.message);
  }
}

/* ───────────────────────────── Trends control ──────────────────────── */

function initTrendsControls() {
  ["trend-metric", "trend-days"].forEach((id) =>
    $(id).addEventListener("change", () => loadTrends().catch((e) => setStatus("error: " + e.message))));
  const btn = $("export-csv");
  if (btn) btn.addEventListener("click", () => exportDailyMetricsCsv().catch((e) => setStatus("export failed: " + e.message)));

  // Copy weekly summary text to clipboard
  let _copyTimer = null;
  const copyBtn = $("copy-weekly");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = $("weekly-summary-text")?.textContent?.trim();
      if (!text || text === "Loading…") {
        setStatus("nothing to copy yet");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        if (_copyTimer) clearTimeout(_copyTimer);
        const original = copyBtn.textContent;
        copyBtn.textContent = "✓ Copied";
        _copyTimer = setTimeout(() => { copyBtn.textContent = original; }, 1500);
      } catch (e) {
        setStatus("clipboard failed: " + e.message);
      }
    });
  }
}

/**
 * Fetch all daily_metrics rows and download them as a CSV file.
 * Pure client-side — no upload anywhere.
 */
async function exportDailyMetricsCsv() {
  const { days } = await fetchJSON("/api/history?days=3650");
  if (!days || !days.length) {
    setStatus("no data to export");
    return;
  }
  // Union of all keys across rows, sorted with 'date' first.
  const keySet = new Set();
  for (const row of days) Object.keys(row).forEach((k) => keySet.add(k));
  const keys = ["date", ...Array.from(keySet).filter((k) => k !== "date").sort()];

  function escapeCell(v) {
    if (v == null) return "";
    const s = Array.isArray(v) ? v.join("|") : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const header = keys.join(",");
  const rows = days.map((row) => keys.map((k) => escapeCell(row[k])).join(","));
  const csv = [header, ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `whoof-daily-metrics-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus(`exported ${days.length} day${days.length === 1 ? "" : "s"} to CSV`);
}

/* ───────────────────────────── Sleep tab alarm ─────────────────────── */

const ALARM_STORAGE_KEY = "whoof-sleep-alarm";

function loadAlarmConfig() {
  try { return JSON.parse(localStorage.getItem(ALARM_STORAGE_KEY)) || {}; } catch { return {}; }
}
function saveAlarmConfig(cfg) {
  localStorage.setItem(ALARM_STORAGE_KEY, JSON.stringify({ ...loadAlarmConfig(), ...cfg }));
}

function initSleepAlarm() {
  const timeInput = $("sleep-alarm-time");
  const setBtn = $("sleep-alarm-set");
  const offBtn = $("sleep-alarm-off");
  const testBtn = $("sleep-alarm-test");
  const statusEl = $("sleep-alarm-status");
  const driftEl = $("sleep-clock-drift");
  if (!timeInput || !setBtn) return;

  // Restore saved time
  const saved = loadAlarmConfig();
  if (saved.time) timeInput.value = saved.time;
  if (saved.armed) {
    statusEl.textContent = `Armed for ${saved.time}`;
    statusEl.style.color = "var(--rec-good)";
  }

  function setStatus(msg, color) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || "var(--text-muted)"; }
  }

  function getBleClient() {
    return window.whoofBleClient || null;
  }

  setBtn.addEventListener("click", async () => {
    const val = timeInput.value;
    if (!val) { setStatus("Pick a time", "#f55"); return; }
    saveAlarmConfig({ time: val, armed: true });
    setStatus(`Armed for ${val}`, "var(--rec-good)");

    // Try BLE strap alarm
    const client = getBleClient();
    if (client && client.connected) {
      try {
        const [h, m] = val.split(":").map(Number);
        const target = new Date();
        target.setHours(h, m, 0, 0);
        if (target <= new Date()) target.setDate(target.getDate() + 1);
        await client.setAlarm(Math.floor(target.getTime() / 1000));
        setStatus(`Strap armed for ${target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "var(--rec-good)");
      } catch (err) {
        setStatus(`BLE alarm failed: ${err.message}`, "#f55");
      }
    } else {
      setStatus(`Browser alarm set for ${val}`, "var(--rec-good)");
    }
  });

  offBtn.addEventListener("click", async () => {
    saveAlarmConfig({ armed: false });
    setStatus("Alarm disabled");
    statusEl.style.color = "var(--text-muted)";

    const client = getBleClient();
    if (client && client.connected) {
      try { await client.disableAlarm(); } catch {}
    }
  });

  testBtn.addEventListener("click", async () => {
    const client = getBleClient();
    if (client && client.connected) {
      try { await client.runHaptics(0); setStatus("Buzz sent", "var(--rec-good)"); } catch (err) { setStatus(err.message, "#f55"); }
    } else {
      setStatus("Strap not connected", "var(--warn)");
    }
  });

  // Clock drift check
  async function refreshClockDrift() {
    if (!driftEl) return;
    const client = getBleClient();
    if (!client || !client.connected) {
      driftEl.textContent = "—";
      driftEl.style.color = "var(--text-muted)";
      return;
    }
    try {
      const strapUnix = await client.getClock();
      if (!strapUnix) { driftEl.textContent = "no response"; driftEl.style.color = "#f55"; return; }
      const drift = strapUnix - Math.floor(Date.now() / 1000);
      const abs = Math.abs(drift);
      const inSync = abs <= 2;
      driftEl.textContent = inSync
        ? `in sync · ${new Date(strapUnix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : `off by ${drift > 0 ? "+" : ""}${drift}s`;
      driftEl.style.color = inSync ? "var(--rec-good)" : (abs > 10 ? "#f55" : "#fa3");
    } catch { driftEl.textContent = "check failed"; driftEl.style.color = "#f55"; }
  }

  // Check clock drift every time sleep tab loads
  refreshClockDrift();

  // Also refresh when BLE client connects/disconnects
  let _alarmCheckClient = setInterval(() => {
    const client = getBleClient();
    if (client && client.connected) {
      refreshClockDrift();
      clearInterval(_alarmCheckClient);
    }
  }, 2000);

  // Periodic alarm checker (fires browser notification when alarm is due)
  let _alarmInterval = setInterval(() => {
    const cfg = loadAlarmConfig();
    if (!cfg.armed || !cfg.time) return;
    const [h, m] = cfg.time.split(":").map(Number);
    const now = new Date();
    // Only fire within the first minute of the alarm time
    if (now.getHours() === h && now.getMinutes() === m && now.getSeconds() < 5) {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      const diff = now - today;
      // Only fire if within 5s of the exact minute (prevent repeat fires)
      if (diff >= 0 && diff < 5000) {
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("⏰ Wake up!", {
              body: "Your Whoop alarm is going off.",
              icon: "/icons/icon-192.png",
              tag: "sleep-alarm",
              requireInteraction: true,
            });
          } catch {}
        }
        // Auto-disarm after firing
        saveAlarmConfig({ armed: false });
        if (statusEl) {
          statusEl.textContent = "Rang at " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          statusEl.style.color = "var(--text-muted)";
        }
      }
    }
  }, 10000);
}

/* ───────────────────────────── Boot ────────────────────────────────── */

async function refreshAll() {
  await refreshStatus();
  await loadActiveTab().catch((e) => setStatus("error: " + e.message));
}

function init() {
  initTabs();
  initDrawer();
  initTrendsControls();
  initBodyForms();
  // Persistent topbar date (independent of which tab the user is on)
  const td = new Date();
  if ($("topbar-date")) {
    $("topbar-date").textContent = `Today · ${td.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  refreshAll();
  // Lightweight status polling only (never rebuilds full DOM).
  setInterval(refreshStatus, 30000);
  // Live tab refresh while it's the active tab (chart, motion age, steps, battery).
  setInterval(() => {
    if (activeTab === "live") loadLive().catch(() => {});
  }, 15000);
  // Periodic mini-rollup: recompute today's daily_metrics every 5 minutes so
  // steps, strain, calories, and other derived metrics stay current during
  // active streaming without requiring a page reload or backfill trigger.
  setInterval(() => {
    fetchJSON("/api/recompute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then(() => {
      window.dispatchEvent(new Event('whoop-data-changed'));
    }).catch(() => {});
  }, 300_000);
  // Re-render only when app-mvp.js mutates IndexedDB.
  window.addEventListener("whoop-data-changed", () => {
    refreshStatus();
    loadActiveTab().catch((e) => setStatus("error: " + e.message));
  });
  // Recovery calendar cell click: jump to Recovery tab for that date.
  window.addEventListener("whoop-browse-recovery", (e) => {
    setTab("recovery");
    _browseDate = e.detail.date;
    loadRecovery().catch(() => {});
  });
  // Sleep tab alarm wiring (runs after DOM is ready).
  initSleepAlarm();
}

// Expose so the BLE/seed module can poke us after writing data.
window.refreshAll = refreshAll;

document.addEventListener("DOMContentLoaded", init);
