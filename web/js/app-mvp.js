// Phase 1 minimal app: Connect button + live HR card + IndexedDB writes.
// Exists alongside the v0.2 dashboard (app.js). Removed in Phase 3 when the
// real Live tab is rewired to talk to IndexedDB.

import { WhoopClient } from './ble/client.js';
import { estimateSpo2FromRaw } from './ble/parsers.js';
import { openDb } from './data/db.js';
import { insertSamplesBatch, startSession, endSession, logEvent } from './data/queries.js';
import { isoUtcNow } from './util/time.js';
import { exportAllToJson, importAllFromJson, exportSamplesCsv, exportDailyMetricsCsv, exportJournalCsv, exportWorkoutsCsv } from './data/export.js';
import {
  startHealthPolling, readShortcutResult, triggerWeightShortcut, buildIngestUrl,
} from './health/sync.js';
import { readScaleIntoProfile, setWeightManually } from './health/scale.js';
import {
  readHealthFromHash, parseAppleHealthExport, applyHealthToProfile, latestValues, dailySeriesFromExport, applyHealthDailyMetrics,
  PROFILE_KEYS,
} from './health/apple.js';
import { getProfile } from './data/queries.js';
import {
  startCapture, stopCapture, downloadCapture, isCapturing, captureStats,
} from './dev/capture.js';
import { recomputeRecent } from './metrics/rollup.js';
import { verifyData, summarizeIntegrity } from './data/integrity.js';
import { listCaptures, getCapture, deleteCapture } from './data/queries.js';
import {
  announceConnected, announceDisconnected, isAnotherTabConnected, onConflict,
} from './util/multitab.js';
import { generateInsights } from './metrics/insights.js';
import { dailyPlan } from './metrics/plan.js';
import { weeklySummary } from './metrics/weekly.js';
import { recentDailyMetrics, samplesInRange, upsertJournalEntry, recentJournalEntries, journalForDate, deleteJournalEntry } from './data/queries.js';
import {
  notificationsEnabled, requestNotifications, disableNotifications,
  notifyBackfillComplete, notifyLowRecovery, notifyLowBattery, notifyHrAnomaly,
} from './util/notify.js';
import { analyseTagCorrelations, tagInsights } from './metrics/correlate.js';
import { unlock, lock, locked, syncNow, loadConfig, saveConfig } from './sync/client.js';

const $ = (id) => document.getElementById(id);

const connectBtn = $('mvp-connect');
const disconnectBtn = $('mvp-disconnect');

let db = null;
let client = null;
let _rawModeNotifs = [];
let currentSession = null;
let sampleCount = 0;
let buffer = [];
const FLUSH_INTERVAL_MS = 1000;
let _statsInterval = null;
let _flushInterval = null;
function showError(msg) {
  const el = $('mvp-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function clearError() {
  const el = $('mvp-error');
  if (el) el.style.display = 'none';
}

function setStatus(state) {
  const statusEl = $('mvp-status');
  const connectBtn = $('mvp-connect');
  const disconnectBtn = $('mvp-disconnect');
  if (statusEl) {
    statusEl.textContent = state;
    statusEl.style.color =
      state === 'connected'    ? 'var(--rec-good)' :
      state === 'reconnecting' ? '#fa3' :
      state === 'connecting'   ? '#fc6' : '#888';
  }
  if (connectBtn) connectBtn.style.display    = (state === 'disconnected') ? 'block' : 'none';
  if (disconnectBtn) disconnectBtn.style.display = (state === 'connected')    ? 'block' : 'none';
  // Update settings-drawer strap status
  const drawerStatus = $('mvp-data-status');
  if (drawerStatus) drawerStatus.textContent = state;
  // Connection-dependent sub-panels
  for (const id of ['mvp-sync-now', 'mvp-capture', 'mvp-diag-details', 'mvp-log-details', 'mvp-stats']) {
    const el = $(id);
    if (el) el.style.display = (state === 'connected') ? '' : 'none';
  }
  // Captures list is always visible (persisted across connections)
  const capList = $('mvp-captures-details');
  if (capList) capList.style.display = '';
  if (state === 'connected') announceConnected(); else announceDisconnected();
}

function updateStrapIndicators(isWorn, charging) {
  const wristEl = $('mvp-wrist');
  const chargeEl = $('mvp-charge');
  if (wristEl && isWorn !== null && isWorn !== undefined) {
    wristEl.textContent = (isWorn ? '🟢' : '⚪') + ' Wrist';
    wristEl.title = isWorn ? 'On wrist' : 'Off wrist';
  }
  if (chargeEl && charging !== null && charging !== undefined) {
    chargeEl.textContent = (charging ? '⚡' : '⚪') + ' Charge';
    chargeEl.title = charging ? 'Charging' : 'Not charging';
  }
}

let _flushing = false;
async function flushLoop() {
  if (_flushing || !db || buffer.length === 0) return;
  _flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await insertSamplesBatch(db, batch);
  } catch (err) {
    console.error('[mvp] flush failed', err);
    buffer.unshift(...batch); // requeue
  } finally {
    _flushing = false;
  }
}

function _startFlushInterval() {
  if (_flushInterval) clearInterval(_flushInterval);
  _flushInterval = setInterval(flushLoop, FLUSH_INTERVAL_MS);
}

function _stopFlushInterval() {
  if (_flushInterval) { clearInterval(_flushInterval); _flushInterval = null; }
}

// Flush remaining samples before the tab closes
window.addEventListener('beforeunload', () => {
  if (db && buffer.length > 0) {
    const batch = buffer;
    buffer = [];
    try {
      // Synchronous-ish: use sendBeacon or just attempt best-effort flush
      navigator.sendBeacon?.('/api/flush-pending', JSON.stringify(batch));
    } catch {}
  }
});

async function setupAndConnect(deviceToUse = null) {
  clearError();
  _startStatsInterval();
  _startFlushInterval();
  if (!navigator.bluetooth) {
    const ua = navigator.userAgent;
    const isIPhone = /iPhone|iPad|iPod/.test(ua);
    const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Bluefy/.test(ua);
    if (isIPhone && isSafari) {
      showError("iPhone Safari can't access Bluetooth. Install Bluefy (App Store, $0.99) and open this page in Bluefy instead.");
    } else if (isIPhone) {
      showError("Web Bluetooth not available. Use Bluefy on iPhone or desktop Chrome on Mac.");
    } else {
      showError("Web Bluetooth not available. Use desktop Chrome on Mac (or Bluefy on iPhone).");
    }
    return;
  }
  if (!db) db = await openDb();
  client = new WhoopClient();
  window.whoofBleClient = client;

  client.on('state', async (s) => {
    setStatus(s);
    if (s === 'connected' && client._family !== 'whoop5') {
      try { await client.startRawData(); } catch (e) { console.warn('[raw] start failed', e); }
    }
    if (s === 'disconnected' && client._rawActive) {
      try { client._rawActive = false; } catch {}
    }
  });

  // Realtime sample: HR + (up to 4) RR intervals.
  let _lastHr = null;
  client.on('sample', (pkt) => {
    const hr = pkt.heartRateBpm;
    const rrList = Array.isArray(pkt.rrIntervalsMs) ? pkt.rrIntervalsMs : [];
    if (hr != null) {
      // Notify on large HR anomaly (>50 bpm jump in < 1 min of streaming).
      if (_lastHr != null && Math.abs(hr - _lastHr) > 50) {
        notifyHrAnomaly(hr, _lastHr);
      }
      _lastHr = hr;
      const txt = Math.round(hr).toString();
      const hrEl = $('mvp-hr');
      if (hrEl) hrEl.textContent = txt;
      const liveHr = document.getElementById('live-hr');
      if (liveHr) liveHr.textContent = txt;
      const nowHr = document.getElementById('now-hr');
      if (nowHr) nowHr.textContent = txt;
    }
    if (rrList.length) {
      const mvpRr = document.getElementById('mvp-rr');
      if (mvpRr) mvpRr.textContent = rrList[0];
    }
    const nowAgo = document.getElementById('now-ago');
    if (nowAgo) nowAgo.textContent = 'live';

    sampleCount += 1;
    const countEl = $('mvp-count');
    if (countEl) countEl.textContent = sampleCount.toString();
    recordSampleStats(rrList.length > 0);

    const tsUtc = isoUtcNow();
    {
      if (!rrList.length) {
        buffer.push({
          ts_utc: tsUtc, session_id: currentSession, sequence: null,
          heart_rate_bpm: hr, rr_interval_ms: null,
          spo2_pct: null, skin_temp_c: null,
          accel_x: null, accel_y: null, accel_z: null,
          motion: null, ppg_amp: null, ambient_light: null, ppg_quality: null,
          crc_ok: 1,
        });
      } else {
        for (const rr of rrList) {
          buffer.push({
            ts_utc: tsUtc, session_id: currentSession, sequence: null,
            heart_rate_bpm: hr, rr_interval_ms: rr,
            spo2_pct: null, skin_temp_c: null,
            accel_x: null, accel_y: null, accel_z: null,
            motion: null, ppg_amp: null, ambient_light: null, ppg_quality: null,
            crc_ok: 1,
          });
        }
      }
    }
  });

  // 96-byte REALTIME_RAW_DATA packets from unframed notifications (SpO₂,
  // skin temp, accel). Write to DB and log to diagnostics.
  let _sensorSampleCount = 0;
  client.on('sensorSample', (pkt) => {
    _sensorSampleCount++;
    if (_sensorSampleCount === 1 || _sensorSampleCount % 100 === 0) {
      diagOut(`[raw96] received ${_sensorSampleCount} sensor samples`);
    }
    const tsUtc = isoUtcNow();
    buffer.push({
      ts_utc: tsUtc, session_id: currentSession, sequence: pkt.seq,
      heart_rate_bpm: pkt.heartRateBpm,
      rr_interval_ms: Array.isArray(pkt.rrIntervalsMs) && pkt.rrIntervalsMs.length ? pkt.rrIntervalsMs[0] : null,
      spo2_pct: pkt.spo2Pct ?? null,
      skin_temp_c: pkt.skinTempC ?? null,
      accel_x: pkt.accelX ?? null,
      accel_y: pkt.accelY ?? null,
      accel_z: pkt.accelZ ?? null,
      motion: pkt.motion ?? null,
      ppg_amp: null, ambient_light: null, ppg_quality: null,
      crc_ok: 1,
    });
    const parts = [];
    if (pkt.heartRateBpm != null) parts.push(`HR ${Math.round(pkt.heartRateBpm)}`);
    if (pkt.spo2Pct != null) parts.push(`SpO2 ${pkt.spo2Pct}%`);
    if (pkt.skinTempC != null) parts.push(`temp ${pkt.skinTempC.toFixed(1)}°C`);
    if (pkt.motion != null) parts.push(`motion ${pkt.motion}`);
    diagOut(`[raw96] ${parts.join(', ')}  ${pkt.rawHex}`);
  });

  // Raw unframed notifications during raw data mode — log packet sizes to
  // help identify what the strap actually sends.
  client.on('rawNotification', ({ length, hex }) => {
    _rawModeNotifs.push({ length, hex });
  });

  // Historical samples streamed in by SEND_HISTORICAL_DATA flow.
  // Track per-record metadata for diagnostics (last record every ~10th).
  let _histCount = 0;
  client.on('historicalSample', async (rec) => {
    if (!db) return;
    const ts = rec.isoUtc;
    {
      // Log version/length/fields to diagnostics every 10th record so the user
      // can see what the strap actually sends (visible in Diagnostics panel).
      if (++_histCount % 10 === 1) {
        diagOut(`[hist] v=${rec.version ?? '?'} len=${rec._dataLen ?? '?'} ` +
          `spo2R=${rec.spo2Red} skinRaw=${rec.skinTempRaw}` +
          `${rec.skinTempC != null ? `/${rec.skinTempC.toFixed(1)}Cest` : ''}` +
          ` resp=${rec.respRateRaw}` +
          `${rec.respRateRpm != null ? `/${rec.respRateRpm.toFixed(1)}rpm` : ''}`);
      }
      // Historical records carry SpO2 raw ADCs — estimate % from red/IR ratio.
      // Skin temp is an experimental raw-scale estimate; raw is stored too.
      const stemp = Number.isFinite(rec.skinTempC) && rec.skinTempC >= 20 && rec.skinTempC <= 45
        ? rec.skinTempC
        : null;
      const resp = Number.isFinite(rec.respRateRpm) && rec.respRateRpm >= 4 && rec.respRateRpm <= 40
        ? rec.respRateRpm
        : null;
      const spo2 = estimateSpo2FromRaw(rec.spo2Red, rec.spo2Ir);
      const ax = rec.accelX ?? null, ay = rec.accelY ?? null, az = rec.accelZ ?? null;
      const mot = rec.motion ?? null;
      const ppg = rec.ppgAmp ?? null, amb = rec.ambientLight ?? null, pqual = rec.ppgQuality ?? null;
      const cok = rec.crcOk ?? 1;
      if (rec.rrIntervalsMs?.length) {
        const rows = rec.rrIntervalsMs.map(rr => ({
          ts_utc: ts, session_id: currentSession, sequence: null,
          heart_rate_bpm: rec.heartRateBpm, rr_interval_ms: rr,
          spo2_pct: spo2, skin_temp_c: stemp,
          skin_temp_est_c: stemp,
          spo2_red_raw: rec.spo2Red ?? null, spo2_ir_raw: rec.spo2Ir ?? null,
          skin_temp_raw: rec.skinTempRaw ?? null,
          resp_rate_raw: rec.respRateRaw ?? null, respiratory_rate: resp,
          accel_x: ax, accel_y: ay, accel_z: az,
          motion: mot, ppg_amp: ppg, ambient_light: amb, ppg_quality: pqual,
          crc_ok: cok,
        }));
        buffer.push(...rows);
      } else {
        buffer.push({
          ts_utc: ts, session_id: currentSession, sequence: null,
          heart_rate_bpm: rec.heartRateBpm, rr_interval_ms: null,
          spo2_pct: spo2, skin_temp_c: stemp,
          skin_temp_est_c: stemp,
          spo2_red_raw: rec.spo2Red ?? null, spo2_ir_raw: rec.spo2Ir ?? null,
          skin_temp_raw: rec.skinTempRaw ?? null,
          resp_rate_raw: rec.respRateRaw ?? null, respiratory_rate: resp,
          accel_x: ax, accel_y: ay, accel_z: az,
          motion: mot, ppg_amp: ppg, ambient_light: amb, ppg_quality: pqual,
          crc_ok: cok,
        });
      }
    }
  });

  client.on('historyStart', () => {
    setDataStatus('Backfilling from strap…');
    diagOut('[backfill] START received');
  });
  client.on('historyProgress', ({ samples, trim }) => {
    setDataStatus(`Backfilled ${samples.toLocaleString()} samples…`);
    diagOut(`[backfill] progress: ${samples} samples, trim=${trim ?? '?'}`);
  });
  client.on('metadata', (meta) => {
    diagOut(`[data] metadata: ${meta.kind}  cmd=${meta.cmd}`);
  });
  client.on('historicalSample', () => {
    // Suppressed from diag (too noisy) — just counts in progress.
  });
  client.on('historyComplete', async ({ samples }) => {
    setDataStatus(`Backfill done: ${samples.toLocaleString()} samples — recomputing…`, 'var(--rec-good)');
    await flushLoop();
    if (db) await logEvent(db, 'backfill', `samples=${samples}`);
    notifyBackfillComplete(samples);
    // Re-roll up daily metrics over a generous window so the dashboard reflects
    // the newly-arrived samples. The strap usually buffers ≤ 1 day of data; we
    // cover 14 days to be safe against month-long absences.
    try {
      const profile = (await getProfile(db)) ?? {};
      await recomputeRecent(db, 14, profile.age ? { ageOverride: profile.age } : {});
      setDataStatus(`Backfill done: ${samples.toLocaleString()} samples`, 'var(--rec-good)');
      window.dispatchEvent(new Event('whoop-data-changed'));
    } catch (err) {
      setDataStatus(`Backfill saved but rollup failed: ${err.message ?? err}`, '#f55');
    }
    // Safety: ensure raw data mode is active after backfill. On 4.0 we never
    // disable R10/R11, so just restart raw data if it got interrupted.
    if (client && client._family !== 'whoop5' && !client._rawActive) {
      try {
        await client.startRawData();
        diagOut('[raw-mode] restarted after backfill');
      } catch (e) {
        console.warn('[raw] restart after backfill failed', e);
      }
    }
  });
  client.on('historyError', (err) => {
    const msg = err?.message ?? String(err);
    setDataStatus('Backfill error: ' + msg, '#f55');
    console.error('[mvp] backfill error', err);
    // Ensure raw data mode is active even if backfill failed.
    if (client && client._family !== 'whoop5' && !client._rawActive) {
      client.startRawData().catch(() => {});
    }
  });

  client.on('battery', async (pct) => {
    const batStr = `${Math.round(pct)}%`;
    if (db) await logEvent(db, 'battery', batStr);
    const liveBat = document.getElementById('live-battery');
    if (liveBat) liveBat.textContent = batStr;
    const nowBat = document.getElementById('now-battery');
    if (nowBat) nowBat.textContent = batStr;
    if (pct < 20) notifyLowBattery(pct);
  });

  client.on('hello', (hello) => {
    if (db) logEvent(db, 'hello', JSON.stringify(hello)).catch(() => {});
    updateStrapIndicators(hello.isWorn, hello.charging);
  });

  client.on('clock', () => {
    const rtcEl = $('mvp-rtc');
    if (rtcEl) { rtcEl.textContent = '🟢 Clock'; rtcEl.title = 'Strap RTC in sync'; }
  });

  client.on('log', (text) => appendLog(text));

  client.on('event', async (evt) => {
    if (!db) return;
    // Surface every event we know about. Wrist / charging / double-tap drive UI.
    await logEvent(db, evt.name.toLowerCase(), evt.semantic ?? '').catch(() => {});
    if (evt.semantic === 'doubleTap') setDataStatus('Double tap detected');
    if (evt.semantic === 'wristOn'  || evt.semantic === 'wristOff') {
      updateStrapIndicators(evt.semantic === 'wristOn', null);
    }
    if (evt.semantic === 'chargingOn' || evt.semantic === 'chargingOff') {
      updateStrapIndicators(null, evt.semantic === 'chargingOn');
    }
    if (evt.semantic === 'rtcLost') {
      const rtcEl = $('mvp-rtc');
      if (rtcEl) { rtcEl.textContent = '🔴 Clock'; rtcEl.title = 'Strap RTC lost — re-syncing'; }
    }
  });

  client.on('error', (err) => {
    console.error('[mvp] ble error', err);
    const friendly = friendlyBleError(err);
    if (friendly !== null) showError(friendly);
  });

  try {
    if (deviceToUse) {
      await client.connectToDevice(deviceToUse);
    } else {
      await client.requestAndConnect();
    }
    currentSession = await startSession(db, 'mvp-session');
    await logEvent(db, 'connect', client.device?.id ?? 'unknown');
  } catch (err) {
    console.error(err);
    setStatus('disconnected');
    const friendly = friendlyBleError(err);
    if (friendly !== null) showError(friendly);
  }
}

// Translate Web Bluetooth DOMException messages into actionable user
// guidance. Chrome's raw text ("Unsupported device.", "No devices found",
// "User cancelled the requestDevice() chooser.") leaves the user with no
// idea what to do next; the real cause is almost always one of:
//   - strap is on the charger (advertising disabled)
//   - strap has gone to sleep (tap to wake)
//   - the official Whoop iOS app is holding the GATT connection
//   - the user picked the wrong row from the picker
// Returns null when the error is "user cancelled" — that's silent.
function friendlyBleError(err) {
  const msg = err?.message ?? String(err);
  const name = err?.name ?? '';
  if (/cancel/i.test(msg)) return null;
  if (/no devices? (found|chosen)/i.test(msg)) {
    return "No Whoop found nearby. Take the strap off the charger, tap it hard 2–3 times to wake it (LEDs should blink), then click Connect again within ~5 seconds.";
  }
  if (/unsupported device/i.test(msg)) {
    return "That device isn't advertising the Whoop service. Likely fixes (try in order): (1) take the strap off the charger, (2) tap it 2–3 times to wake it, (3) force-quit the official Whoop app on any nearby iPhone — a strap can only talk to one host. Then click Connect and pick the entry starting with \"WHOOP\".";
  }
  if (name === 'SecurityError' || /secure context/i.test(msg)) {
    return "Web Bluetooth requires HTTPS. Open this page from getwhoof.pages.dev (not file:// or plain http://).";
  }
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return "Web Bluetooth isn't supported in this browser. Use desktop Chrome / Edge / Brave / Arc on Mac or Windows, or Bluefy on iPhone.";
  }
  if (/gatt/i.test(msg)) {
    return `Bluetooth connection dropped (${msg}). Move closer to the strap and click Connect again.`;
  }
  return `Bluetooth: ${msg}`;
}

connectBtn.addEventListener('click', async () => {
  // Multi-tab check before we open a GATT connection that will fail silently
  // if another tab already has it.
  const conflict = await isAnotherTabConnected();
  if (conflict) {
    showError("Another tab in this browser is already connected to the Whoop. Close it first.");
    return;
  }
  // If there's a stale client with a cached device, clean it up first so the
  // browser's device picker can start fresh.
  if (client) {
    try { await client.forgetDevice(); } catch {}
  }
  client = null;
  setupAndConnect();
});

async function autoConnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const whoopDev = devices.find(d => d.name && d.name.toUpperCase().includes('WHOOP'));
    if (whoopDev) {
      console.log('[mvp] Auto-connecting to paired device:', whoopDev.name);
      try {
        await setupAndConnect(whoopDev);
      } catch (err) {
        // Cached device may have stale GATT state — fall back to device picker.
        console.warn('[mvp] auto-connect via cached device failed, falling back to picker', err);
        if (!client) client = new WhoopClient();
        await client.requestAndConnect();
      }
    }
  } catch (err) {
    console.error('[mvp] auto-connect failed', err);
  }
}

// ----- Demo-data removal ---------------------------------------------------
// Auto-seeding has been removed: a fresh/empty IndexedDB now stays empty until
// you connect a WHOOP or import Apple Health. purgeDemoOnce() (below) also
// clears any synthetic demo data left in a returning browser.

async function clearAllStores(d) {
  const stores = ['samples', 'sessions', 'device_events', 'daily_metrics', 'profile', 'sleep_stages', 'workouts', 'captures', 'journal'];
  for (const s of stores) {
    if (!d.objectStoreNames.contains(s)) continue;
    await new Promise((resolve, reject) => {
      const tx = d.transaction(s, 'readwrite');
      const req = tx.objectStore(s).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      req.onerror = () => reject(req.error);
    });
  }
}

// One-time removal of the synthetic demo dataset from a returning browser.
// Runs once (guarded by a localStorage flag) and ONLY wipes a database that is
// purely demo — every session is a 'demo …' session (the old synthetic seeder's
// label), with no real strap ('mvp-session') or imported recordings. If any real session
// exists the DB is left completely untouched, so a real recording is never
// destroyed. Returns true if it cleared anything.
async function purgeDemoOnce() {
  const FLAG = 'whoofDemoPurgedV1';
  try { if (localStorage.getItem(FLAG)) return false; } catch { return false; }
  if (!db) db = await openDb();

  let sessions = [];
  try {
    sessions = await new Promise((resolve, reject) => {
      const req = db.transaction('sessions').objectStore('sessions').getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch { sessions = []; }

  const isDemo = (s) => typeof s.label === 'string' && s.label.startsWith('demo ');
  const demoCount = sessions.filter(isDemo).length;
  const realCount = sessions.length - demoCount;

  // Set the run-once flag BEFORE wiping so a slow autoConnect()/startSession
  // can't re-enter this path and a setItem failure can't trigger a re-wipe.
  try { localStorage.setItem(FLAG, '1'); } catch {}

  let cleared = false;
  if (demoCount > 0 && realCount === 0) {
    setDataStatus('Removing demo data…');
    await clearAllStores(db);
    cleared = true;
  }
  return cleared;
}

(async () => {
  // Purge any leftover demo data to completion BEFORE auto-connecting, so a
  // real 'mvp-session' created by autoConnect() can never land mid-purge.
  const cleared = await purgeDemoOnce();
  autoConnect();
  if (cleared) {
    // Re-render the visible tab now that the demo data is gone.
    if (typeof window.refreshAll === 'function') window.refreshAll();
    else window.dispatchEvent(new Event('whoop-data-changed'));
  }

  // Empty-state hint: with auto-seed gone, an untouched DB is blank — point the
  // user at the real ingest paths instead of leaving a silent empty dashboard.
  try {
    if (!db) db = await openDb();
    const n = await new Promise((res, rej) => {
      const r = db.transaction('samples').objectStore('samples').count();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (n === 0) setDataStatus('No data yet — connect your WHOOP or import Apple Health.');
  } catch { /* non-fatal */ }

  // Refresh the data-health indicator, insights, plan, and trend-tab panels.
  await Promise.all([
    refreshHealth(),
    renderInsights(),
    renderDailyPlan(),
    renderWeeklySummary(),
    renderRecoveryCal(),
    renderTagCorrelations(),
    renderPoincareePlot(),
  ]);
})();

// Exposed so the Reset button (or dev console) can wipe all local data. No
// demo reseed — the dashboard stays empty until real data is recorded/imported.
window.resetAllData = async () => {
  if (!db) db = await openDb();
  setDataStatus('Wiping all local data…');
  await clearAllStores(db);
  setDataStatus('All local data cleared — connect your WHOOP or import Apple Health.', 'var(--rec-good)');
  if (typeof window.refreshAll === 'function') window.refreshAll();
  else window.dispatchEvent(new Event('whoop-data-changed'));
};

disconnectBtn.addEventListener('click', async () => {
  if (!client) return;
  try { await client.disconnect(); } catch (err) { console.error(err); }
  await flushLoop();
  if (currentSession && db) {
    await endSession(db, currentSession, sampleCount);
    await logEvent(db, 'disconnect', `samples=${sampleCount}`);
  }
  if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
  _stopFlushInterval();
  announceDisconnected();
});

// Forget cached device — forces the next connect to use the device picker.
const forgetBtn = document.getElementById('mvp-forget');
if (forgetBtn) forgetBtn.addEventListener('click', async () => {
  if (!client) return;
  try { await client.forgetDevice(); } catch (err) { console.error(err); }
  setStatus('disconnected');
  showError('Device forgotten. Tap Connect and choose your WHOOP from the picker.');
  announceDisconnected();
});

const syncNowBtn = $('mvp-sync-now');
if (syncNowBtn) syncNowBtn.addEventListener('click', async () => {
  if (!client?.connected) {
    setDataStatus('Not connected to strap', '#f55');
    return;
  }
  syncNowBtn.disabled = true;
  syncNowBtn.textContent = 'Syncing…';
  setDataStatus('Syncing from strap…', '#888');
  try {
    const result = await client.downloadHistory();
    if (result.alreadyRunning) {
      setDataStatus('Backfill already in progress — samples arriving…', '#888');
    } else if (result.samples === 0) {
      setDataStatus('No new historical data on strap (already synced)', '#fc3');
    }
  } catch (err) {
    setDataStatus('Sync failed: ' + (err.message ?? err), '#f55');
  }
  syncNowBtn.textContent = 'Sync from strap now';
  syncNowBtn.disabled = false;
});

// ----- R2 cloud sync --------------------------------------------------------

const SYNC_STATUS_KEY = 'whoof-sync-status';
let _syncTimer = null;

function loadSyncStatus() {
  try { return JSON.parse(localStorage.getItem(SYNC_STATUS_KEY)) || {}; } catch { return {}; }
}
function saveSyncStatus(st) {
  localStorage.setItem(SYNC_STATUS_KEY, JSON.stringify({ ...loadSyncStatus(), ...st }));
}

function syncIndicatorTitle(msg) {
  const st = loadSyncStatus();
  let t = msg || 'Cloud sync';
  if (st.lastSync) {
    const ago = Math.round((Date.now() - st.lastSync) / 60000);
    const ts = new Date(st.lastSync).toLocaleString();
    t += ` — last sync ${ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`} (${ts})`;
  }
  return t;
}

function updateSyncIndicator(state, msg) {
  const dot = $('sync-dot');
  const indicator = $('sync-indicator');
  if (dot) dot.className = 'sync-dot ' + state;
  if (indicator) indicator.title = syncIndicatorTitle(msg);
  // Also update settings status row if visible
  const iconEl = $('sync-status-icon');
  const textEl = $('sync-status-text');
  if (iconEl && textEl) {
    const icons = { locked: '🔒', unlocked: '🔓', syncing: '🔄', ok: '✅', err: '⚠️' };
    iconEl.textContent = icons[state] || '🔒';
    textEl.textContent = msg || '';
    textEl.className = 'sync-status-text' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : state === 'unlocked' ? ' warn' : '');
  }
}

function updateLastSyncLabel() {
  const label = $('sync-last-label');
  if (!label) return;
  const st = loadSyncStatus();
  if (st.lastSync) {
    const ago = Math.round((Date.now() - st.lastSync) / 60000);
    label.textContent = ago < 1 ? 'Just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
  } else {
    label.textContent = 'Never';
  }
}

async function runSync() {
  if (locked()) return;
  const syncNowBtn2 = $('sync-now-btn');
  try {
    updateSyncIndicator('syncing', 'Syncing…');
    const result = await syncNow({ db });
    if (result.status === 'conflict') {
      updateSyncIndicator('err', 'Sync conflict — try again');
    } else {
      const stores = result.added
        ? Object.entries(result.added).filter(([, v]) => v > 0).map(([s, v]) => `${s}:${v}`).join(', ')
        : 'none';
      saveSyncStatus({ lastSync: Date.now(), lastResult: 'ok', lastDetail: stores });
      updateLastSyncLabel();
      updateSyncIndicator('ok', `Synced — added ${stores}`);
    }
  } catch (err) {
    saveSyncStatus({ lastSync: Date.now(), lastResult: 'err', lastDetail: err.message });
    updateSyncIndicator('err', `Sync error: ${err.message}`);
  }
  if (syncNowBtn2) syncNowBtn2.disabled = false;
}

function startAutoSync() {
  if (_syncTimer) return;
  _syncTimer = setInterval(() => {
    if (!locked()) runSync();
  }, 5 * 60 * 1000); // every 5 minutes
}

async function initSyncUI() {
  const syncIdInput = $('sync-id-input');
  const passInput = $('sync-passphrase-input');
  const unlockBtn = $('sync-unlock-btn');
  const syncNowBtn2 = $('sync-now-btn');
  const copyBtn = $('sync-copy-id');

  if (!syncIdInput) return;

  // Load or generate syncId (must be 64 hex chars for crypto + server auth)
  const cfg = loadConfig();
  if (cfg?.syncId && /^[a-f0-9]{64}$/.test(cfg.syncId)) {
    syncIdInput.value = cfg.syncId;
  } else {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    saveConfig({ syncId: id });
    syncIdInput.value = id;
  }

  // Init display
  updateLastSyncLabel();
  setInterval(updateLastSyncLabel, 60 * 1000); // refresh relative time every minute
  const st = loadSyncStatus();
  if (locked()) {
    updateSyncIndicator('locked', 'Locked');
  } else if (st.lastResult === 'ok') {
    updateSyncIndicator('ok', 'Unlocked — ready to sync');
  } else {
    updateSyncIndicator('unlocked', 'Unlocked — ready to sync');
  }

  function updateLockUI() {
    const isLocked = locked();
    if (unlockBtn) {
      unlockBtn.textContent = isLocked ? 'Unlock' : 'Lock';
      unlockBtn.style.background = isLocked ? 'var(--recovery)' : 'var(--glass-surface-2)';
      unlockBtn.style.color = isLocked ? '#fff' : 'var(--text)';
      unlockBtn.style.borderColor = isLocked ? 'var(--recovery)' : 'var(--glass-border)';
    }
    if (syncNowBtn2) syncNowBtn2.disabled = isLocked;
    if (passInput) passInput.disabled = !isLocked;
    if (isLocked) {
      updateSyncIndicator('locked', 'Locked — enter passphrase');
    } else {
      updateSyncIndicator('unlocked', 'Unlocked — ready to sync');
    }
    startAutoSync();
  }

  updateLockUI();

  if (unlockBtn) unlockBtn.addEventListener('click', async () => {
    if (!locked()) {
      lock();
      if (passInput) passInput.value = '';
      if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
      updateLockUI();
      return;
    }
    const pass = passInput?.value?.trim();
    if (!pass) { updateSyncIndicator('err', 'Enter a passphrase'); return; }
    const syncId = syncIdInput.value?.trim();
    if (!syncId) { updateSyncIndicator('err', 'No sync ID'); return; }
    try {
      await unlock(pass, syncId);
      updateLockUI();
      updateSyncIndicator('unlocked', 'Unlocked');
    } catch (err) {
      updateSyncIndicator('err', 'Unlock failed: ' + (err.message ?? err));
    }
  });

  if (syncNowBtn2) syncNowBtn2.addEventListener('click', async () => {
    if (locked()) { updateSyncIndicator('err', 'Locked — unlock first'); return; }
    syncNowBtn2.disabled = true;
    await runSync();
  });

  // Copy sync ID
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(syncIdInput.value);
      copyBtn.style.color = 'var(--rec-good)';
      setTimeout(() => copyBtn.style.color = '', 1500);
    } catch {}
  });

  // Open settings sync section when sync indicator in top bar is clicked
  const indicator = $('sync-indicator');
  if (indicator) indicator.addEventListener('click', () => {
    const gear = $('open-settings');
    if (gear) gear.click();
  });
}

// Initialize sync UI when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSyncUI);
} else {
  initSyncUI();
}

// ----- Live session stats (RR coverage + pkts/s) ---------------------------

const STATS_WINDOW_MS = 10_000;
const recentSampleTimes = [];
let recentRrTotal = 0;
let recentSampleTotal = 0;
function recordSampleStats(hasRr) {
  const now = Date.now();
  recentSampleTimes.push(now);
  recentSampleTotal++;
  if (hasRr) recentRrTotal++;
  while (recentSampleTimes.length && recentSampleTimes[0] < now - STATS_WINDOW_MS) {
    recentSampleTimes.shift();
  }
}
function _startStatsInterval() {
  if (_statsInterval) clearInterval(_statsInterval);
  _statsInterval = setInterval(() => {
    const rateEl = $('mvp-pkt-rate');
    if (rateEl) rateEl.textContent = recentSampleTimes.length ?
      (recentSampleTimes.length / (STATS_WINDOW_MS / 1000)).toFixed(1) : '—';
    const covEl = $('mvp-rr-coverage');
    if (covEl) covEl.textContent = recentSampleTotal ?
      `${Math.round(100 * recentRrTotal / recentSampleTotal)}%` : '—';
  }, 1000);
}

// ----- Diagnostics panel ---------------------------------------------------

function diagOut(msg) {
  const el = $('diag-output');
  if (!el) return;
  const stamp = new Date().toLocaleTimeString();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
  el.textContent = el.textContent.split('\n').slice(0, 10).join('\n');
}

function wireDiagnostics() {
  const send = (label, fn) => async () => {
    if (!client?.connected) return diagOut(`${label}: not connected`);
    try {
      const r = await fn();
      diagOut(`${label}: ${r ?? 'sent'}`);
    } catch (err) {
      diagOut(`${label}: ${err.message ?? err}`);
    }
  };
  $('diag-hello')?.addEventListener('click', send('hello', () => client.sendHello()));
  $('diag-battery')?.addEventListener('click', send('battery', () => client.getBatteryLevel()));
  $('diag-clock')?.addEventListener('click', send('clock', async () => {
    const u = await client.getClock();
    return u ? new Date(u * 1000).toLocaleString() : 'no response';
  }));
  $('diag-range')?.addEventListener('click', send('range', () => client.getDataRange()));
  $('diag-haptic')?.addEventListener('click', send('haptic', () => client.runHaptics(0)));
  $('diag-imu')?.addEventListener('click', send('raw-imu', async () => {
    if (client._rawActive) { await client.stopRawData(); return 'stopped'; }
    await client.startRawData();
    return 'started';
  }));
  $('diag-batt-ext')?.addEventListener('click', send('batt-ext', () => client.getExtendedBatteryInfo()));
  $('diag-hr-profile')?.addEventListener('click', send('hr-profile', async () => {
    const next = !client._genericHrEnabled;
    await client.toggleGenericHrProfile(next);
    return next ? 'enabled — pair from Strava/Zwift now' : 'disabled';
  }));
  $('diag-raw-mode')?.addEventListener('click', async () => {
    if (!client?.connected) return diagOut('raw-mode: not connected');
    if (client._rawActive) {
      await client.stopRawData();
      // Dump packet stats.
      const byLen = {};
      for (const n of _rawModeNotifs) {
        byLen[n.length] = (byLen[n.length] || 0) + 1;
      }
      const stats = Object.entries(byLen)
        .sort((a, b) => b[1] - a[1])
        .map(([len, count]) => `${count}×${len}B`)
        .join(', ');
      diagOut(`raw-mode: stopped — ${_rawModeNotifs.length} unframed notifs (${stats})`);
      // Show first few hex lines.
      const show = _rawModeNotifs.slice(0, 3);
      for (const n of show) {
        diagOut(`  [${n.length}B] ${n.hex}`);
      }
      if (_rawModeNotifs.length > show.length) {
        diagOut(`  … +${_rawModeNotifs.length - show.length} more`);
      }
      _rawModeNotifs = [];
      return;
    }
    _rawModeNotifs = [];
    await client.startRawData();
    diagOut('raw-mode: started — capturing unframed notifications…');
  });
}
wireDiagnostics();

// ----- Wake alarm card (Overview) -----------------------------------------
//
// Surfaces the strap's built-in alarm + RTC sync on the dashboard so the user
// can pick a wake time (default 7:00) and confirm the strap clock is mapped
// correctly to the device clock. Uses the same BLE commands as the sidebar
// alarm panel — this is just a more prominent UI.

function wireWakeAlarm() {
  const timeInput = $('wake-alarm-time');
  const whenEl    = $('wake-alarm-when');
  const setBtn    = $('wake-alarm-set');
  const offBtn    = $('wake-alarm-off');
  const testBtn   = $('wake-alarm-test');
  const statusEl  = $('wake-alarm-status');
  const driftEl   = $('wake-clock-drift');
  const syncBtn   = $('wake-clock-sync');
  if (!timeInput || !setBtn) return;

  function setStatus(msg, color = 'var(--muted)') {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color; }
  }
  function nextFireDate() {
    const value = timeInput.value || '07:00';
    const [h, m] = value.split(':').map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    if (target <= new Date()) target.setDate(target.getDate() + 1);
    return target;
  }
  function renderWhen() {
    if (!whenEl) return;
    const t = nextFireDate();
    const today = new Date();
    const sameDay = t.toDateString() === today.toDateString();
    whenEl.textContent = sameDay ? 'Later today' : 'Tomorrow';
  }
  timeInput.addEventListener('input', renderWhen);
  renderWhen();

  setBtn.addEventListener('click', async () => {
    if (!client?.connected) return setStatus('Not connected — connect your strap first.', '#f55');
    const target = nextFireDate();
    try {
      await client.setAlarm(Math.floor(target.getTime() / 1000));
      setStatus(`Armed for ${target.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, 'var(--rec-good)');
    } catch (err) { setStatus(err.message ?? String(err), '#f55'); }
  });
  offBtn?.addEventListener('click', async () => {
    if (!client?.connected) return setStatus('Not connected', '#f55');
    try { await client.disableAlarm(); setStatus('Alarm disabled.'); }
    catch (err) { setStatus(err.message ?? String(err), '#f55'); }
  });
  testBtn?.addEventListener('click', async () => {
    if (!client?.connected) return setStatus('Not connected', '#f55');
    try { await client.runHaptics(0); setStatus('Buzz sent — feel the strap vibrate.', 'var(--rec-good)'); }
    catch (err) { setStatus(err.message ?? String(err), '#f55'); }
  });

  async function refreshClockDrift() {
    if (!driftEl) return;
    if (!client?.connected) { driftEl.textContent = '—'; driftEl.style.color = 'var(--muted)'; return; }
    driftEl.textContent = 'checking…';
    try {
      const strapUnix = await client.getClock();
      if (!strapUnix) { driftEl.textContent = 'no response'; driftEl.style.color = '#f55'; return; }
      const drift = strapUnix - Math.floor(Date.now() / 1000);
      const abs = Math.abs(drift);
      const inSync = abs <= 2;
      driftEl.textContent = inSync ? `in sync · ${new Date(strapUnix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `off by ${drift > 0 ? '+' : ''}${drift}s`;
      driftEl.style.color = inSync ? 'var(--rec-good)' : (abs > 10 ? '#f55' : '#fa3');
    } catch (err) {
      driftEl.textContent = 'check failed';
      driftEl.style.color = '#f55';
    }
  }
  syncBtn?.addEventListener('click', async () => {
    if (!client?.connected) return setStatus('Not connected', '#f55');
    try {
      await client.setClock();
      setStatus('Strap clock resynced to this device.', 'var(--rec-good)');
      await refreshClockDrift();
    } catch (err) { setStatus(err.message ?? String(err), '#f55'); }
  });

  client?.on?.('state', (s) => {
    if (s === 'connected') {
      setStatus('Pick a time and tap "Set alarm".');
      refreshClockDrift();
    }
  });
  client?.on?.('clock', () => refreshClockDrift());
}
wireWakeAlarm();

// ----- Saved captures list -------------------------------------------------

async function refreshCapturesList() {
  if (!db) db = await openDb();
  const list = await listCaptures(db);
  const el = $('captures-list');
  const cntEl = $('captures-count');
  if (cntEl) cntEl.textContent = `(${list.length})`;
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<div style="color:var(--muted); padding:4px;">No saved captures yet</div>';
    return;
  }
  el.innerHTML = list.map(c => {
    const date = new Date(c.created_at).toLocaleString();
    return `<div style="display:flex; gap:4px; align-items:center; padding:2px 0; border-top:1px solid var(--border);">
      <div style="flex:1;">
        <div style="color:var(--fg);">${escapeHtml(c.label)}</div>
        <div style="font-size:9px;">${date} · ${c.row_count} rows · ${(c.duration_ms / 1000).toFixed(0)}s${c.capped ? ' · capped' : ''}</div>
      </div>
      <button data-cap-id="${c.id}" data-cap-action="download" style="font-size:9px;">⬇</button>
      <button data-cap-id="${c.id}" data-cap-action="delete" style="font-size:9px;">🗑</button>
    </div>`;
  }).join('');
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const id = Number(t.dataset?.capId);
  const action = t.dataset?.capAction;
  if (!id || !action) return;
  if (!db) db = await openDb();
  if (action === 'download') {
    const full = await getCapture(db, id);
    if (!full) return;
    const blob = new Blob([full.ndjson_text], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `whoop-${full.label}-${full.created_at.replace(/[:.]/g, '-')}.ndjson`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (action === 'delete') {
    if (!confirm('Delete this capture? This cannot be undone.')) return;
    await deleteCapture(db, id);
    refreshCapturesList();
  }
});

// ----- Multi-tab guard -----------------------------------------------------

onConflict((msg) => {
  showError('Another tab connected to the Whoop. Web Bluetooth only allows one tab per session.');
});

// ----- Console log drawer --------------------------------------------------

const LOG_MAX = 30;
const logLines = [];
function appendLog(line) {
  if (!line) return;
  logLines.push(line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
  while (logLines.length > LOG_MAX) logLines.shift();
  const body = $('mvp-log-body');
  if (body) body.textContent = logLines.join('\n');
  const cnt = $('mvp-log-count');
  if (cnt) cnt.textContent = `(${logLines.length})`;
}

const captureBtn = $('mvp-capture');
let captureProgressTimer = null;
if (captureBtn) captureBtn.addEventListener('click', async () => {
  if (!client?.connected) {
    setDataStatus('Not connected to strap', '#f55');
    return;
  }
  if (!isCapturing()) {
    const label = prompt('Capture label (e.g. "walking", "still", "workout"):', 'capture');
    if (!label) return;
    startCapture(client, { label });
    captureBtn.textContent = '⏹ Stop capture';
    setDataStatus('Capturing raw packets…');
    captureProgressTimer = setInterval(() => {
      const s = captureStats();
      if (s) setDataStatus(`Capturing ${s.label}: ${s.rows} rows, ${Math.floor(s.durationMs / 1000)}s`);
    }, 1000);
  } else {
    clearInterval(captureProgressTimer);
    captureProgressTimer = null;
    const stats = captureStats();
    if (!db) db = await openDb();
    const result = await stopCapture(db);  // persist to IndexedDB
    captureBtn.textContent = '📸 Capture raw packets';
    if (result) {
      downloadCapture(result, stats?.label ?? 'capture');
      setDataStatus(`Capture saved: ${result.rowCount} rows${result.capped ? ' (capped)' : ''}`, 'var(--rec-good)');
      await refreshCapturesList();
    }
  }
});

// Show saved captures on initial load (don't need to be connected).
refreshCapturesList().catch(() => {});

// ----- Daily training plan -------------------------------------------------

// Map plan zones → inline SVG illustrations. Zone keys match plan.js
// (rest / active / train / push). Each renders at currentColor so it
// harmonises with the label colour.
const PLAN_SVG = {
  rest: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 44 V32 a4 4 0 0 1 4-4 h26 a8 8 0 0 1 8 8 v8"/><path d="M4 48 H56"/><path d="M4 48 V52"/><path d="M56 48 V52"/><circle cx="18" cy="30" r="4" fill="currentColor" stroke="none" opacity="0.4"/><text x="48" y="22" font-size="11" font-weight="700" fill="currentColor" stroke="none" font-family="Inter,sans-serif">z</text><text x="54" y="16" font-size="9" font-weight="700" fill="currentColor" stroke="none" font-family="Inter,sans-serif" opacity="0.6">z</text></svg>',
  active: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="34" cy="12" r="4"/><path d="M34 18 v12 l-10 18 M34 28 l10 8 6 -4 M24 48 l-4 6 M44 48 l4 6"/></svg>',
  train: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="10" r="4"/><path d="M32 16 v10 l-8 14 l4 12 M32 22 l10 8 8 -4 M28 38 h-6 v6 M40 36 l-4 16"/></svg>',
  push: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M32 4 C 20 16 16 26 16 34 a16 16 0 0 0 32 0 c0 -8 -4 -18 -16 -30 z" fill="currentColor" fill-opacity="0.15"/><path d="M26 34 c0 -4 2 -8 6 -12 c4 4 6 8 6 12 a6 6 0 0 1 -12 0 z" fill="currentColor" fill-opacity="0.6"/></svg>',
};

async function renderDailyPlan() {
  const zoneEl = document.getElementById('plan-zone');
  const labelEl = document.getElementById('plan-label');
  const msgEl = document.getElementById('plan-message');
  const targetEl = document.getElementById('plan-target');
  if (!zoneEl) return;
  try {
    if (!db) db = await openDb();
    const metrics = await recentDailyMetrics(db, 7);
    if (!metrics.length) return;

    const today = metrics[0]; // newest first
    const strains = metrics.map((m) => m.strain_score).filter((v) => v != null);
    const avgStrain7d = strains.length ? strains.reduce((a, b) => a + b, 0) / strains.length : null;
    const recoveries = metrics.map((m) => m.recovery_score).filter((v) => v != null);
    const lowStreakDays = recoveries.length >= 3 && recoveries.slice(0, 3).every((r) => r < 33);

    // Treat recovery=0 with no HRV as null (rollup writes zeros when no overnight)
    const hasRec = today.recovery_score != null && today.recovery_score > 0 && today.rmssd_ms != null;
    const hasSleep = today.sleep_minutes != null && today.sleep_minutes > 0;
    const plan = dailyPlan({
      recoveryScore: hasRec ? today.recovery_score : null,
      sleepPerformancePct: hasSleep ? today.sleep_performance_pct : null,
      sleepDebtMinutes: hasSleep ? today.sleep_debt_minutes : null,
      avgStrain7d,
      lowStreakDays,
    });

    // Render SVG illustration (fallback to emoji if zone unknown).
    const svg = PLAN_SVG[plan.zone] ?? null;
    if (svg) {
      zoneEl.innerHTML = svg;
      zoneEl.style.color = plan.color;
      zoneEl.style.width = "56px";
      zoneEl.style.height = "56px";
      zoneEl.style.display = "block";
      zoneEl.style.filter = `drop-shadow(0 0 18px ${plan.color}55)`;
    } else {
      zoneEl.textContent = plan.emoji;
    }
    if (labelEl) { labelEl.textContent = plan.label; labelEl.style.color = plan.color; }
    if (msgEl) {
      // Show the day-specific rationale (with actual numbers) then the zone's general advice.
      msgEl.textContent = `${plan.rationale}\n\n${plan.message}`;
    }
    if (targetEl) {
      const [lo, hi] = plan.strainRange;
      targetEl.textContent = `Target strain: ${lo}–${hi}  ·  HR zones 1–${plan.hrZoneCap}`;
    }

    // Fire low-recovery notification once per day (tagged so it deduplicates).
    if (plan.zone === 'rest' && today.recovery_score != null) {
      notifyLowRecovery(today.recovery_score);
    }
  } catch (err) {
    console.warn('[plan] render failed', err);
  }
}

window.addEventListener('whoop-data-changed', () => renderDailyPlan());

// ----- Notifications setup ------------------------------------------------

(function wireNotifications() {
  // Inject a small notification toggle into the sidebar below the health dot.
  const healthDiv = document.getElementById('mvp-health');
  if (!healthDiv) return;
  const btn = document.createElement('button');
  btn.id = 'mvp-notify-btn';
  btn.style.cssText = 'font-size:9px; margin-top:2px; width:100%;';
  const update = () => {
    btn.textContent = notificationsEnabled() ? '🔔 Alerts on' : '🔕 Enable alerts';
  };
  update();
  btn.addEventListener('click', async () => {
    if (notificationsEnabled()) {
      disableNotifications();
      update();
    } else {
      const result = await requestNotifications();
      if (result === 'denied') {
        setDataStatus('Notifications blocked — enable in browser settings', '#f55');
      } else if (result === 'unsupported') {
        setDataStatus('Notifications not supported in this browser', '#888');
      }
      update();
    }
  });
  healthDiv.after(btn);
})();

// ----- Health insights panel ---------------------------------------------

// Inline SVG icons keyed by severity — render with currentColor so they
// inherit the .insight.<sev> .ins-icon color set in styles.css.
const INSIGHT_SVG = {
  info:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  warn:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
};

async function renderInsights() {
  const card = document.getElementById('insights-card');
  const list = document.getElementById('insights-list');
  if (!card || !list) return;
  try {
    if (!db) db = await openDb();
    const metrics = await recentDailyMetrics(db, 14);
    const insights = generateInsights(metrics);
    // Update topbar counter
    const counter = document.getElementById('topbar-insight-count');
    if (counter) {
      counter.textContent = insights.length;
      counter.style.display = insights.length ? 'inline-flex' : 'none';
    }
    card.style.display = '';
    if (!insights.length) {
      list.innerHTML = `
        <div class="empty-state" style="padding:20px 8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 L9 17 L4 12"/></svg>
          <div style="font-weight:600; color:var(--text-2);">All clear</div>
          <div style="font-size:11px; color:var(--text-muted);">Insights surface when patterns emerge in your data.</div>
        </div>`;
      return;
    }
    list.innerHTML = insights.map((ins) => `
      <div class="insight ${ins.severity}">
        <span class="ins-icon">${INSIGHT_SVG[ins.severity] ?? INSIGHT_SVG.info}</span>
        <div>
          <div class="ins-title">${escapeHtml(ins.title)}</div>
          <div class="ins-body">${escapeHtml(ins.body)}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[insights] render failed', err);
  }
}

// Refresh insights whenever data changes
window.addEventListener('whoop-data-changed', () => renderInsights());
window.renderInsightsFn = renderInsights;

// ----- Data integrity ticker ---------------------------------------------

async function refreshHealth() {
  try {
    if (!db) db = await openDb();
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const to = now.toISOString();
    const report = await verifyData(db, from, to);
    const sum = summarizeIntegrity(report);
    const dot = document.getElementById('mvp-health-dot');
    const msg = document.getElementById('mvp-health-msg');
    if (dot) dot.textContent = sum.status === 'ok' ? '🟢' : sum.status === 'warn' ? '🟡' : '🔴';
    if (msg) msg.textContent = sum.message;
  } catch (err) {
    // Log visibly — silent swallow masks init bugs.
    console.error('[health] refresh failed', err);
    const dot = document.getElementById('mvp-health-dot');
    const msg = document.getElementById('mvp-health-msg');
    if (dot) dot.textContent = '🔴';
    if (msg) msg.textContent = 'check error';
  }
}
// Refresh whenever data changes (backfill complete, import, seed, etc.)
window.addEventListener('whoop-data-changed', () => refreshHealth());

$('mvp-health')?.addEventListener('click', async () => {
  if (!db) db = await openDb();
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const to = now.toISOString();
  const report = await verifyData(db, from, to);
  const lines = [
    `Samples: ${report.totalSamples.toLocaleString()}`,
    `Time gaps: ${report.timeGaps.length}`,
    `HR anomalies: ${report.hrAnomalies.length}`,
    `Duplicates: ${report.duplicates.length}`,
    `Stale since: ${report.staleSinceMs != null ? `${Math.floor(report.staleSinceMs / 3600 / 1000)}h` : '—'}`,
  ];
  alert(lines.join('\n'));
});

// ----- Data tools (seed / export / import) ---------------------------------

const dataStatus = $('mvp-data-status');
const exportBtn = $('mvp-export');
const importBtn = $('mvp-import');
const importFile = $('mvp-import-file');

function setDataStatus(msg, color = '#888') {
  dataStatus.textContent = msg;
  dataStatus.style.color = color;
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  setDataStatus('Exporting…');
  try {
    const blob = await exportAllToJson();
    triggerDownload(blob, `ms-vitality-${new Date().toISOString().slice(0, 10)}.json`);
    setDataStatus(`Exported ${(blob.size / 1024).toFixed(1)} KB`, '#2a8');
  } catch (err) {
    console.error(err);
    setDataStatus('Export failed: ' + (err.message ?? err), '#f55');
  }
  exportBtn.disabled = false;
});

importBtn.addEventListener('click', () => importFile.click());

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const samplesCsvBtn = $('mvp-export-samples-csv');
if (samplesCsvBtn) samplesCsvBtn.addEventListener('click', async () => {
  samplesCsvBtn.disabled = true;
  setDataStatus('Exporting samples…');
  try {
    if (!db) db = await openDb();
    const blob = await exportSamplesCsv(db);
    triggerDownload(blob, `ms-vitality-samples-${new Date().toISOString().slice(0, 10)}.csv`);
    setDataStatus(`Exported ${(blob.size / 1024).toFixed(1)} KB`, '#2a8');
  } catch (err) {
    setDataStatus('Export failed: ' + (err.message ?? err), '#f55');
  }
  samplesCsvBtn.disabled = false;
});

const dailyCsvBtn = $('mvp-export-daily-csv');
if (dailyCsvBtn) dailyCsvBtn.addEventListener('click', async () => {
  dailyCsvBtn.disabled = true;
  setDataStatus('Exporting daily metrics…');
  try {
    if (!db) db = await openDb();
    const blob = await exportDailyMetricsCsv(db);
    triggerDownload(blob, `ms-vitality-daily-${new Date().toISOString().slice(0, 10)}.csv`);
    setDataStatus(`Exported ${(blob.size / 1024).toFixed(1)} KB`, '#2a8');
  } catch (err) {
    setDataStatus('Export failed: ' + (err.message ?? err), '#f55');
  }
  dailyCsvBtn.disabled = false;
});

const journalCsvBtn = $('mvp-export-journal-csv');
if (journalCsvBtn) journalCsvBtn.addEventListener('click', async () => {
  journalCsvBtn.disabled = true;
  setDataStatus('Exporting journal…');
  try {
    if (!db) db = await openDb();
    const blob = await exportJournalCsv(db);
    triggerDownload(blob, `ms-vitality-journal-${new Date().toISOString().slice(0, 10)}.csv`);
    setDataStatus(`Exported ${(blob.size / 1024).toFixed(1)} KB`, '#2a8');
  } catch (err) {
    setDataStatus('Export failed: ' + (err.message ?? err), '#f55');
  }
  journalCsvBtn.disabled = false;
});

const workoutsCsvBtn = $('mvp-export-workouts-csv');
if (workoutsCsvBtn) workoutsCsvBtn.addEventListener('click', async () => {
  workoutsCsvBtn.disabled = true;
  setDataStatus('Exporting workouts…');
  try {
    if (!db) db = await openDb();
    const blob = await exportWorkoutsCsv(db);
    triggerDownload(blob, `ms-vitality-workouts-${new Date().toISOString().slice(0, 10)}.csv`);
    setDataStatus(`Exported ${(blob.size / 1024).toFixed(1)} KB`, '#2a8');
  } catch (err) {
    setDataStatus('Export failed: ' + (err.message ?? err), '#f55');
  }
  workoutsCsvBtn.disabled = false;
});

importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  importBtn.disabled = true;
  setDataStatus('Importing…');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await importAllFromJson(data);
    setDataStatus(`Imported ${result.totalRows} rows. Reloading…`, '#2a8');
    setTimeout(() => location.reload(), 500);
  } catch (err) {
    console.error(err);
    setDataStatus('Import failed: ' + (err.message ?? err), '#f55');
  }
  importBtn.disabled = false;
  importFile.value = '';
});

// ----- Reset & re-seed -----------------------------------------------------

const resetBtn = $('mvp-reset');
if (resetBtn) {
  resetBtn.addEventListener('click', async () => {
    const ok = confirm(
      'Wipe ALL local data (including any real strap recordings)?\n\nThis cannot be undone.',
    );
    if (!ok) return;
    resetBtn.disabled = true;
    try {
      await window.resetAllData();
    } finally {
      resetBtn.disabled = false;
    }
  });
}

// ----- Apple Health bridge -------------------------------------------------

const weightEl = $('mvp-weight');
const pullWeightBtn = $('mvp-pull-weight');
const healthSetupBtn = $('mvp-health-setup');
const healthModal = $('health-setup');
const healthCloseBtn = $('mvp-health-close');
async function refreshWeightDisplay() {
  if (!db) db = await openDb();
  const p = await getProfile(db);
  if (weightEl) {
    weightEl.textContent = p?.weight_kg ? `${p.weight_kg.toFixed(1)} kg` : '—';
  }
}

// Pick up values handed back by Apple. Two phone-only paths, both client-side:
//   1. A Shortcut writes #health=<base64url JSON> into the URL fragment.
//   2. The legacy WhoopPullWeight shortcut appends ?weight_from_shortcut=<qty>.
(async () => {
  if (!db) db = await openDb();
  try {
    const res = await readHealthFromHash({ location: window.location, history: window.history, db });
    if (res && res.accepted?.length) {
      const saved = res.accepted.filter((k) => PROFILE_KEYS.includes(k));
      const daily = res.accepted.filter((k) => ['steps', 'active_energy_kcal', 'respiratory_rate', 'blood_oxygen'].includes(k));
      const labels = [...saved, ...daily];
      if (labels.length) {
        setDataStatus(`Synced from Apple Health: ${labels.join(', ')}`, 'var(--rec-good)');
        window.dispatchEvent(new Event('whoop-data-changed'));
      }
    }
  } catch (err) {
    console.warn('[health] hash import failed', err);
  }
  const w = await readShortcutResult(db);
  if (w != null) {
    setDataStatus(`Pulled weight from iPhone: ${w.toFixed(1)} kg`, 'var(--rec-good)');
  }
  await refreshWeightDisplay();
})();

// Background poller for the optional Python LAN server (Health Auto Export).
// It self-terminates on the first probe when no such endpoint exists, so on a
// static Cloudflare Pages deploy this is a no-op after one call.
startHealthPolling(async () => {
  await refreshWeightDisplay();
});

if (pullWeightBtn) pullWeightBtn.addEventListener('click', () => {
  const msg = triggerWeightShortcut();
  if (msg) setDataStatus(msg);
});

const scaleBtn = $('mvp-scale');
if (scaleBtn) scaleBtn.addEventListener('click', async () => {
  if (!navigator.bluetooth) {
    setDataStatus('Web Bluetooth not available', '#f55');
    return;
  }
  scaleBtn.disabled = true;
  setDataStatus('Pairing with scale…');
  try {
    if (!db) db = await openDb();
    const m = await readScaleIntoProfile(db);
    setDataStatus(`Scale: ${m.weightKg.toFixed(1)} kg${m.heightCm ? ` · ${m.heightCm.toFixed(0)} cm` : ''}`, 'var(--rec-good)');
    await refreshWeightDisplay();
  } catch (err) {
    setDataStatus('Scale: ' + (err.message ?? err), '#f55');
  }
  scaleBtn.disabled = false;
});

const manualWeightBtn = $('mvp-manual-weight');
if (manualWeightBtn) manualWeightBtn.addEventListener('click', async () => {
  const value = prompt('Enter weight in kg:');
  if (!value) return;
  const kg = parseFloat(value);
  if (!Number.isFinite(kg)) return setDataStatus('Invalid weight', '#f55');
  try {
    if (!db) db = await openDb();
    await setWeightManually(kg, db);
    setDataStatus(`Weight set: ${kg.toFixed(1)} kg`, 'var(--rec-good)');
    await refreshWeightDisplay();
  } catch (err) {
    setDataStatus(err.message ?? String(err), '#f55');
  }
});

if (healthSetupBtn) healthSetupBtn.addEventListener('click', () => {
  if (healthModal) healthModal.style.display = 'flex';
});

if (healthCloseBtn) healthCloseBtn.addEventListener('click', () => {
  if (healthModal) healthModal.style.display = 'none';
});

// Import a full Apple Health export.xml (Health app → profile → Export All
// Health Data → unzip → export.xml). Parsed with a streaming regex (not
// DOMParser) so a large file doesn't blow up the DOM; the latest value per
// recognised metric is folded into the profile. No server involved.
const healthImportInput = $('mvp-health-import');
const healthImportBtn = $('mvp-health-import-btn');
if (healthImportBtn && healthImportInput) {
  healthImportBtn.addEventListener('click', () => healthImportInput.click());
}
if (healthImportInput) healthImportInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setDataStatus(`Reading ${file.name}…`);
  try {
    const text = await file.text();
    const series = parseAppleHealthExport(text);
    const { values } = latestValues(series);
    const keys = Object.keys(values);
    if (!keys.length) {
      setDataStatus('No recognised Health metrics in that file.', '#f55');
    } else {
      if (!db) db = await openDb();
      const merged = await applyHealthToProfile(values, db);
      const dailyResult = await applyHealthDailyMetrics(dailySeriesFromExport(series), db);
      const saved = keys.filter((k) => PROFILE_KEYS.includes(k));
      if (dailyResult.changed) await recomputeRecent(db, 14);
      const dailyLabel = dailyResult.changed ? `, daily metrics ${dailyResult.changed}d` : '';
      setDataStatus(
        (merged || dailyResult.changed) ? `Imported from Apple Health: ${saved.join(', ') || 'profile'}${dailyLabel}` : 'Health values already up to date',
        (merged || dailyResult.changed) ? 'var(--rec-good)' : undefined,
      );
      await refreshWeightDisplay();
      if (dailyResult.changed) window.dispatchEvent(new Event('whoop-data-changed'));
    }
  } catch (err) {
    setDataStatus('Import failed: ' + (err.message ?? err), '#f55');
  }
  e.target.value = '';
});

// ----- Poincaré plot (HRV scatter) ----------------------------------------
// Draws RR[n] vs RR[n+1] for the last sleep window. Uses Chart.js scatter.
// SD1 = short-term HRV (parasympathetic); SD2 = long-term (sympathetic+para).

let _poincareChart = null;

async function renderPoincareePlot() {
  const canvas = document.getElementById('poincare-plot');
  const metaEl = document.getElementById('poincare-meta');
  if (!canvas || !window.Chart) return;
  try {
    if (!db) db = await openDb();

    // Find the most recent sleep window by looking at the last ~18 hours of samples.
    const now = new Date();
    const from = new Date(now.getTime() - 18 * 3600 * 1000).toISOString();
    const samples = await samplesInRange(db, from, now.toISOString());

    // Filter to samples with RR intervals during low-motion (sleep proxy: HR < 75)
    const rrs = samples
      .filter((s) => s.rr_interval_ms != null && s.heart_rate_bpm != null && s.heart_rate_bpm < 75)
      .map((s) => s.rr_interval_ms);

    if (rrs.length < 20) {
      if (metaEl) metaEl.textContent = 'Not enough RR data from last sleep';
      return;
    }

    // Build scatter points: (RR[n], RR[n+1])
    const points = [];
    for (let i = 0; i < rrs.length - 1; i++) {
      // Plausibility filter: 300–1500 ms (20–200 bpm)
      if (rrs[i] > 300 && rrs[i] < 1500 && rrs[i + 1] > 300 && rrs[i + 1] < 1500) {
        points.push({ x: rrs[i], y: rrs[i + 1] });
      }
    }

    // Compute SD1 and SD2
    const diffs = points.map((p) => (p.y - p.x) / Math.SQRT2);
    const sums  = points.map((p) => (p.y + p.x) / Math.SQRT2);
    const sd1 = Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / Math.max(diffs.length - 1, 1));
    const sd2 = Math.sqrt(sums.reduce((a, s, _, arr) => {
      const mean = arr.reduce((x, y) => x + y, 0) / arr.length;
      return a + (s - mean) ** 2;
    }, 0) / Math.max(sums.length - 1, 1));

    if (_poincareChart) { _poincareChart.destroy(); _poincareChart = null; }

    _poincareChart = new window.Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'RR intervals',
          data: points,
          backgroundColor: 'rgba(0, 200, 120, 0.35)',
          pointRadius: 2.5,
          pointHoverRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `RR[n]=${ctx.parsed.x}ms  RR[n+1]=${ctx.parsed.y}ms`,
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: 'RR[n] (ms)', color: '#888' },
            grid: { color: 'rgba(60,60,67,0.08)' },
            ticks: { color: '#888', maxTicksLimit: 6 },
          },
          y: {
            title: { display: true, text: 'RR[n+1] (ms)', color: '#888' },
            grid: { color: 'rgba(60,60,67,0.08)' },
            ticks: { color: '#888', maxTicksLimit: 6 },
          },
        },
      },
    });

    if (metaEl) {
      metaEl.textContent = `SD1 ${sd1.toFixed(1)} ms  ·  SD2 ${sd2.toFixed(1)} ms  ·  ${points.length} beats`;
    }
  } catch (err) {
    console.warn('[poincaré] render failed', err);
  }
}

// Render on data change and when recovery tab becomes active.
window.addEventListener('whoop-data-changed', () => renderPoincareePlot());
window.addEventListener('whoop-tab-recovery', () => renderPoincareePlot());
// Make available to other modules (e.g. app.js Recovery tab loader)
window.renderPoincareePlot = renderPoincareePlot;
window.addEventListener('hashchange', () => {
  if (location.hash === '#recovery') renderPoincareePlot();
});

// ----- Activity journal ----------------------------------------------------

let _selectedTags = new Set();

/** Return today as YYYY-MM-DD in local time. */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Load an existing journal entry for `date` into the form fields. */
async function loadJournalEntry(date) {
  const tagContainer = document.getElementById('journal-tags');
  const textarea = document.getElementById('journal-text');
  if (!tagContainer || !textarea) return;
  _selectedTags.clear();
  tagContainer.querySelectorAll('.journal-tag').forEach((b) => b.classList.remove('active'));
  textarea.value = '';
  try {
    if (!db) db = await openDb();
    const entry = await journalForDate(db, date);
    if (entry) {
      textarea.value = entry.text ?? '';
      for (const tag of (entry.tags ?? [])) {
        _selectedTags.add(tag);
        const btn = tagContainer.querySelector(`[data-tag="${tag}"]`);
        if (btn) btn.classList.add('active');
      }
    }
  } catch {}
}

function wireJournal() {
  const tagContainer = document.getElementById('journal-tags');
  const textarea = document.getElementById('journal-text');
  const saveBtn = document.getElementById('journal-save');
  const statusEl = document.getElementById('journal-status');
  const dateInput = document.getElementById('journal-date');

  if (!tagContainer || !textarea || !saveBtn) return;

  // Initialise date picker to today.
  if (dateInput) {
    dateInput.value = localToday();
    dateInput.max   = localToday();
    // When the user changes the date, pre-fill from any existing entry.
    dateInput.addEventListener('change', async () => {
      await loadJournalEntry(dateInput.value);
    });
  }

  // Toggle tag selection styling.
  tagContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.journal-tag');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (_selectedTags.has(tag)) {
      _selectedTags.delete(tag);
      btn.classList.remove('active');
    } else {
      _selectedTags.add(tag);
      btn.classList.add('active');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    const tags = [..._selectedTags];
    if (!text && !tags.length) {
      if (statusEl) statusEl.textContent = 'Add a tag or note first';
      return;
    }
    saveBtn.disabled = true;
    try {
      if (!db) db = await openDb();
      const date = dateInput ? dateInput.value : localToday();
      await upsertJournalEntry(db, { date, text, tags });
      if (statusEl) statusEl.textContent = 'Saved!';
      textarea.value = '';
      _selectedTags.clear();
      tagContainer.querySelectorAll('.journal-tag').forEach((b) => b.classList.remove('active'));
      // Reset date picker back to today after saving a past entry.
      if (dateInput) dateInput.value = localToday();
      await renderJournalHistory(); // also re-renders tag correlations
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Save failed: ' + (err.message ?? err);
    }
    saveBtn.disabled = false;
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  });

  // Load today's existing entry on init.
  (async () => {
    await loadJournalEntry(localToday());
    await renderJournalHistory();
  })();
}

/** Tag emoji map used in both history rendering and elsewhere. */
const TAG_ICONS = { alcohol: '🍺', illness: '🤒', stress: '😰', travel: '✈️', race: '🏆', goodsleep: '💤', hardworkout: '💪', caffeine: '☕', meditation: '🧘', cold: '🧊', nap: '😴' };

async function renderJournalHistory() {
  const histEl = document.getElementById('journal-history');
  if (!histEl) return;
  try {
    if (!db) db = await openDb();
    const entries = await recentJournalEntries(db, 14);
    if (!entries.length) {
      histEl.textContent = 'No journal entries yet.';
    } else {
      histEl.innerHTML = entries.map((e) => {
        const d = new Date(e.date + 'T12:00:00');
        const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const tagsStr = (e.tags ?? []).map((t) => TAG_ICONS[t] ?? t).join(' ');
        return `<div style="display:flex; align-items:baseline; padding:3px 0; border-top:1px solid var(--border);" data-journal-date="${e.date}">
          <span style="color:var(--fg); font-size:11px; flex-shrink:0;">${dateStr}</span>
          ${tagsStr ? `<span style="margin-left:4px; flex-shrink:0;">${tagsStr}</span>` : ''}
          ${e.text ? `<span style="color:var(--muted); margin-left:4px; font-size:10px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(e.text.slice(0, 80))}${e.text.length > 80 ? '…' : ''}</span>` : '<span style="flex:1;"></span>'}
          <button class="journal-delete-btn" data-date="${e.date}" title="Delete entry" style="margin-left:6px; background:none; border:none; color:var(--muted); cursor:pointer; font-size:13px; padding:0 2px; line-height:1; flex-shrink:0;">×</button>
        </div>`;
      }).join('');

      // Wire delete buttons.
      histEl.querySelectorAll('.journal-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const date = btn.dataset.date;
          try {
            if (!db) db = await openDb();
            await deleteJournalEntry(db, date);
            await renderJournalHistory();
          } catch (err) {
            console.warn('[journal] delete failed', err);
          }
        });
      });
    }
  } catch (err) {
    console.warn('[journal] history failed', err);
  }
  // Refresh correlations each time history is (re)rendered.
  await renderTagCorrelations();
}

// ----- Tag correlation insights --------------------------------------------

async function renderTagCorrelations() {
  const el = document.getElementById('tag-correlations');
  if (!el) return;
  try {
    if (!db) db = await openDb();
    // Fetch up to 365 days of entries + metrics (1 journal entry per day max).
    const [entries, metrics] = await Promise.all([
      recentJournalEntries(db, 365),
      recentDailyMetrics(db, 365),
    ]);
    const corr = analyseTagCorrelations(entries, metrics);
    const insights = tagInsights(corr);
    if (!insights.length) {
      // Show a prompt only if the user has started logging but there's not enough data yet.
      if (entries.length > 0) {
        el.innerHTML = `<div style="margin-top:8px; font-size:10px; color:var(--muted); font-style:italic;">Keep logging daily tags — insights appear once you have enough data points per tag (need ≥2 tagged and ≥2 untagged days with next-day metrics).</div>`;
      } else {
        el.innerHTML = '';
      }
      return;
    }
    const totalEntries = entries.length;
    el.innerHTML = `
      <div style="margin-top:10px; border-top:1px solid var(--border); padding-top:8px;">
        <div style="font-size:10px; font-weight:600; color:var(--muted); letter-spacing:.05em; text-transform:uppercase; margin-bottom:2px;">Tag insights</div>
        <div style="font-size:10px; color:var(--muted); margin-bottom:6px;">Next-day effects from ${totalEntries} logged ${totalEntries === 1 ? 'entry' : 'entries'}</div>
        ${insights.map((ins) => {
          const icon = ins.direction === 'negative' ? '⚠️' : '✅';
          const color = ins.direction === 'negative' ? 'var(--rec-bad)' : 'var(--rec-good)';
          return `<div style="padding:3px 0; font-size:11px; color:${color};">${icon} ${escapeHtml(ins.summary)}</div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    console.warn('[correlations] render failed', err);
  }
}

wireJournal();

// ----- Weekly summary ------------------------------------------------------

async function renderWeeklySummary() {
  const el = document.getElementById('weekly-summary-text');
  if (!el) return;
  try {
    if (!db) db = await openDb();
    const [metrics, journalEntries, allMetrics] = await Promise.all([
      recentDailyMetrics(db, 7),
      recentJournalEntries(db, 365),
      recentDailyMetrics(db, 365),
    ]);
    const s = weeklySummary(metrics);
    let text = s.summary;

    // Week-over-week delta lines (requires at least 7 prior days).
    const prevMetrics = allMetrics.slice(7, 14); // days 8-14
    if (prevMetrics.length >= 4) {
      const p = weeklySummary(prevMetrics);
      const deltas = [];
      const fmt = (val, prev, unit, higherIsBetter = true) => {
        if (val == null || prev == null) return null;
        const d = val - prev;
        if (Math.abs(d) < 0.5) return null; // insignificant
        const arrow = d > 0 ? '↑' : '↓';
        const good = (higherIsBetter ? d > 0 : d < 0);
        const sign = d > 0 ? '+' : '';
        return `${good ? '✅' : '⚠️'} ${arrow} ${sign}${d.toFixed(unit === 'bpm' ? 0 : 1)}${unit}`;
      };
      const recovery = fmt(s.avgRecovery, p.avgRecovery, '% recovery');
      const hrv      = fmt(s.avgRmssd,    p.avgRmssd,    'ms HRV');
      const rhr      = fmt(s.avgRhr,      p.avgRhr,      'bpm RHR', false);
      const sleep    = fmt(s.avgSleepH,   p.avgSleepH,   'h sleep');
      [recovery, hrv, rhr, sleep].filter(Boolean).forEach((l) => deltas.push(l));
      if (deltas.length) text += '\n\n📊 vs last week\n' + deltas.join('\n');
    }

    // Append top correlation insights if available.
    const corr = analyseTagCorrelations(journalEntries, allMetrics);
    const ins = tagInsights(corr);
    if (ins.length) {
      text += '\n\n🔍 Personalised patterns\n';
      for (const i of ins.slice(0, 3)) {
        const icon = i.direction === 'negative' ? '⚠️' : '✅';
        text += `${icon} ${i.summary}\n`;
      }
    }

    el.textContent = text;
  } catch (err) {
    console.warn('[weekly] render failed', err);
  }
}

// Render weekly summary when trends tab is opened.
window.addEventListener('hashchange', () => {
  if (location.hash === '#trends') renderWeeklySummary();
});
window.addEventListener('whoop-data-changed', () => renderWeeklySummary());
window.addEventListener('whoop-data-changed', () => renderTagCorrelations());

// ----- Recovery calendar heatmap -------------------------------------------
// 30-day heatmap calendar. Metric is user-selectable via #cal-metric.
// Gray = no data. Cells are square divs arranged oldest-left → newest-right.

const CAL_METRICS = {
  recovery_score: {
    label: 'Recovery',
    unit: '%',
    fmt: (v) => Math.round(v) + '%',
    color: (v) => {
      if (v == null) return 'var(--bg-3)';
      if (v >= 67) return 'var(--rec-good)';
      if (v >= 34) return 'var(--rec-mid)';
      return 'var(--rec-bad)';
    },
    legend: [
      { label: '67–100', bg: 'var(--rec-good)' },
      { label: '34–66',  bg: 'var(--rec-mid)' },
      { label: '0–33',   bg: 'var(--rec-bad)' },
    ],
  },
  sleep_performance_pct: {
    label: 'Sleep perf',
    unit: '%',
    fmt: (v) => Math.round(v) + '%',
    color: (v) => {
      if (v == null) return 'var(--bg-3)';
      if (v >= 85) return '#2563eb';   // bright blue
      if (v >= 65) return '#60a5fa';   // medium blue
      return '#bfdbfe';                // pale blue
    },
    legend: [
      { label: '≥85%', bg: '#2563eb' },
      { label: '65–84%', bg: '#60a5fa' },
      { label: '<65%',  bg: '#bfdbfe' },
    ],
  },
  strain_score: {
    label: 'Strain',
    unit: '/21',
    fmt: (v) => v.toFixed(1),
    color: (v) => {
      if (v == null) return 'var(--bg-3)';
      if (v >= 14) return '#f97316';   // dark orange
      if (v >= 8)  return '#fbbf24';   // yellow-orange
      return '#fef3c7';                // pale amber
    },
    legend: [
      { label: '14–21',  bg: '#f97316' },
      { label: '8–13.9', bg: '#fbbf24' },
      { label: '0–7.9',  bg: '#fef3c7' },
    ],
  },
  rmssd_ms: {
    label: 'HRV',
    unit: 'ms',
    fmt: (v) => Math.round(v) + 'ms',
    // Colour relative to the array median to account for individual variation.
    color: null, // set dynamically
    legend: [
      { label: 'High',   bg: 'var(--rec-good)' },
      { label: 'Mid',    bg: 'var(--rec-mid)' },
      { label: 'Low',    bg: 'var(--rec-bad)' },
    ],
  },
};

async function renderRecoveryCal() {
  const el = document.getElementById('recovery-cal');
  if (!el) return;
  try {
    const metricKey = document.getElementById('cal-metric')?.value ?? 'recovery_score';
    const cfg = CAL_METRICS[metricKey] ?? CAL_METRICS.recovery_score;

    if (!db) db = await openDb();
    const metrics = await recentDailyMetrics(db, 30);
    const byDate = {};
    for (const m of metrics) byDate[m.date] = m[metricKey] ?? null;

    // For HRV use a dynamic colour function relative to the period median.
    let colorFn = cfg.color;
    if (!colorFn) {
      const vals = metrics.map((m) => m[metricKey]).filter((v) => v != null).sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * 0.33)] ?? 0;
      const hi = vals[Math.floor(vals.length * 0.67)] ?? Infinity;
      colorFn = (v) => {
        if (v == null) return 'var(--bg-3)';
        if (v >= hi) return 'var(--rec-good)';
        if (v >= lo) return 'var(--rec-mid)';
        return 'var(--rec-bad)';
      };
    }

    const cells = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const val = byDate[iso] ?? null;
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const label = val != null ? `${dateStr}: ${cfg.fmt(val)}` : dateStr;
      const isToday = i === 0;
      cells.push(`<div class="cal-cell" title="${label}" data-cal-date="${iso}" style="
        aspect-ratio:1; border-radius:6px;
        background:${colorFn(val)};
        opacity:${val == null ? 0.18 : 1};
        cursor:pointer;
        ${isToday ? 'box-shadow: 0 0 0 2px var(--text);' : ''}
        transition: transform 120ms;
      "></div>`);
    }

    const legendHtml = cfg.legend.map((l) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${l.bg};"></span>${l.label}</span>`
    ).join('  ');

    el.innerHTML = `
      <div id="recovery-cal-grid" style="display:grid; grid-template-columns:repeat(15, 1fr); gap:6px; margin-top:6px;">
        ${cells.join('')}
      </div>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-top:14px; font-size:11px; color:var(--text-muted);">
        ${legendHtml}
        <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:var(--surface-3);opacity:0.4;"></span>No data</span>
      </div>`;

    el.querySelectorAll('[data-cal-date]').forEach((cell) => {
      cell.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('whoop-browse-recovery', { detail: { date: cell.dataset.calDate } }));
      });
    });
  } catch (err) {
    console.warn('[recovery-cal] render failed', err);
  }
}

// Re-render calendar when metric picker changes.
document.getElementById('cal-metric')?.addEventListener('change', () => renderRecoveryCal());

window.addEventListener('hashchange', () => {
  if (location.hash === '#trends') renderRecoveryCal();
});
window.addEventListener('whoop-data-changed', () => renderRecoveryCal());

// Render calendar on initial load if already on trends tab
if (location.hash === '#trends') {
  setTimeout(() => renderRecoveryCal(), 100);
}

// ----- URL ?tab= routing for PWA manifest shortcuts -----------------------
// Manifest shortcuts use ?tab=<name>; app.js reads #hash. Bridge both so
// installed-PWA deep links work the same as in-browser navigation.

(function applyUrlTabParam() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  if (tab) {
    // Push into the hash so app.js initTabs() picks it up.
    // Do this synchronously before DOMContentLoaded fires.
    history.replaceState(null, '', `/#${tab}`);
  }
})();
