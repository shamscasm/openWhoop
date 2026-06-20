// Apple Health bridge. Pulls weight (and friends) from a server-side snapshot
// populated by Health Auto Export over the LAN, and folds them into our
// profile row in IndexedDB.
//
// Two ingest paths:
//   1. iPhone HAE app → POST http://<mac-ip>:8765/api/health/ingest
//      → Python dashboard.py persists to data/health-latest.json
//      → this module polls GET /api/health/latest and copies values into profile.
//   2. Apple Shortcut "WhoopPullWeight" → opens
//      shortcuts://x-callback-url/run-shortcut?name=...&x-success=<our-url>?weight_from_shortcut=
//      → the shortcut bounces back with the value as a query param; readShortcutResult() picks it up.

import { openDb } from '../data/db.js';
import { getProfile, putProfile } from '../data/queries.js';

const POLL_INTERVAL_MS = 60_000;     // poll once a minute
const SHORTCUT_NAME = 'WhoopPullWeight';
const SHORTCUT_RESULT_PARAM = 'weight_from_shortcut';

/**
 * Fetch the server-side health snapshot. Returns
 *   { values: { weight_kg, weight_kg_date, height_cm, ... }, updated_at }
 * or null if the server isn't reachable / endpoint doesn't exist.
 */
export async function fetchHealthSnapshot() {
  try {
    const r = await fetch('/api/health/latest', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Pull the latest weight/height from the server snapshot and persist any
 * differences to profile. Returns the merged profile (or null if nothing
 * changed / no snapshot).
 */
export async function applySnapshotToProfile(db = null) {
  const snap = await fetchHealthSnapshot();
  if (!snap || !snap.values) return null;
  const d = db ?? (await openDb());
  const existing = (await getProfile(d)) ?? {};
  const merged = { ...existing };
  let changed = false;
  for (const key of ['weight_kg', 'height_cm', 'resting_hr', 'vo2_max']) {
    const v = snap.values[key];
    if (v != null && (existing[key] == null || Math.abs(existing[key] - v) > 0.01)) {
      merged[key] = v;
      changed = true;
    }
  }
  if (!changed) return existing;
  await putProfile(d, merged);
  return merged;
}

/**
 * Start the background polling loop. Call once on app init.
 * Returns a stop() function.
 */
export function startHealthPolling(onUpdate = () => {}) {
  // The Python LAN snapshot server is only reachable from the local dashboard
  // itself (http://localhost or an http LAN IP). On an https static deploy
  // (Cloudflare Pages) it's both same-origin-absent and mixed-content-blocked,
  // so don't poll at all — this avoids endless 404s/console spam on the site.
  if (typeof location !== 'undefined' && location.protocol === 'https:') {
    const h = location.hostname;
    const isLan = h === 'localhost' || h === '127.0.0.1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    if (!isLan) return () => {};
  }

  let timer = null;
  let misses = 0;
  const MAX_MISSES = 3; // ride out transient failures before giving up
  const tick = async () => {
    try {
      const updated = await applySnapshotToProfile();
      if (updated == null) {
        // No snapshot this tick. After a few misses assume there's no Python
        // server and stop, but tolerate transient network blips first. Not
        // clearing on the first miss also dodges a timer-still-null race when
        // the first tick resolves before setInterval below has assigned it.
        if (++misses >= MAX_MISSES && timer) { clearInterval(timer); timer = null; }
        return;
      }
      misses = 0;
      onUpdate(updated);
    } catch (err) {
      console.warn('[health] poll failed', err);
    }
  };
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  return () => { if (timer) clearInterval(timer); };
}

/**
 * Read a shortcut callback result from the URL (?weight_from_shortcut=75.5)
 * and persist it. Returns the new weight if found, null otherwise.
 */
export async function readShortcutResult(db = null) {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(SHORTCUT_RESULT_PARAM);
  if (!raw) return null;
  let weight = parseFloat(raw);
  if (!Number.isFinite(weight)) return null;

  // Apple's Body Mass sample is locale-dependent, so the Shortcut can pass an
  // optional ?weight_unit=lb. Convert pounds to kg before range-validating.
  const unit = (url.searchParams.get('weight_unit') || '').toLowerCase();
  if (unit === 'lb' || unit === 'lbs' || unit === 'pound' || unit === 'pounds') {
    weight *= 0.45359237;
  }
  if (weight <= 0 || weight > 500) return null;
  weight = Math.round(weight * 100) / 100;

  const d = db ?? (await openDb());
  const existing = (await getProfile(d)) ?? {};
  await putProfile(d, { ...existing, weight_kg: weight });

  // Clean the URL so a refresh doesn't re-apply.
  url.searchParams.delete(SHORTCUT_RESULT_PARAM);
  url.searchParams.delete('weight_unit');
  history.replaceState({}, '', url.toString());

  return weight;
}

/**
 * Open the Shortcut. The Shortcut should:
 *   1. Find Health Sample → Body Mass → most recent 1
 *   2. Get the .qty
 *   3. Open URL → x-success with ?weight_from_shortcut=<qty>
 *
 * Works in Safari and (likely) Bluefy on iPhone. Returns a hint string to
 * show the user when nothing happens (desktop, no shortcut installed, etc.).
 */
export function triggerWeightShortcut() {
  if (typeof window === 'undefined' || !window.location) {
    return 'Shortcuts only available on iPhone';
  }
  // Hand the Shortcut a clean current-page URL as x-success. The Shortcut's
  // own final step appends ?weight_from_shortcut=<qty>&weight_unit=<unit> to it,
  // so we must NOT pre-set a placeholder here (the old __VALUE__ never got
  // substituted and broke the callback).
  const successUrl = new URL(window.location.href);
  successUrl.searchParams.delete(SHORTCUT_RESULT_PARAM);
  successUrl.searchParams.delete('weight_unit');
  const shortcutUrl = `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&x-success=${encodeURIComponent(successUrl.toString())}`;
  window.location.href = shortcutUrl;
  return null;
}

/**
 * Discover the LAN URL the user should paste into Health Auto Export.
 * Returns a string like "http://192.168.1.50:8765/api/health/ingest" or a
 * placeholder if we can't tell.
 */
export function buildIngestUrl() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname || 'YOUR_MAC_IP';
  // Only a private-LAN host can actually run the Python ingest server. From
  // localhost (the Mac itself) or a public deploy (Cloudflare Pages), the
  // iPhone can't reach the current host, so show a copy-paste placeholder for
  // the Mac's LAN IP. The port is always the dashboard's 8765, not this page's.
  const isLanIp =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  const displayHost = isLanIp ? host : 'YOUR_MAC_IP';
  return `http://${displayHost}:8765/api/health/ingest`;
}
