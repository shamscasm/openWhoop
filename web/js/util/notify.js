// Browser Notification API wrapper.
//
// Permission is opt-in — the user must click "Enable alerts" before we ever
// request the browser prompt. We never ask proactively.
//
// Exported for use by app-mvp.js (which imports this module).

const STORAGE_KEY = 'whoof-notifications-enabled';

/** True if the user has granted permission AND opted in. */
export function notificationsEnabled() {
  if (!('Notification' in window)) return false;
  return Notification.permission === 'granted' && localStorage.getItem(STORAGE_KEY) === '1';
}

/**
 * Request permission and store opt-in.
 * Returns 'granted' | 'denied' | 'default' | 'unsupported'.
 */
export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const result = await Notification.requestPermission();
  if (result === 'granted') localStorage.setItem(STORAGE_KEY, '1');
  return result;
}

/** Revoke opt-in (does not revoke browser permission — user must do that). */
export function disableNotifications() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Send a notification if enabled. No-ops silently if permission is missing.
 * @param {string} title
 * @param {Object} opts  - Notification options (body, icon, tag, requireInteraction)
 */
export function notify(title, opts = {}) {
  if (!notificationsEnabled()) return;
  try {
    const n = new Notification(title, {
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      silent: false,
      ...opts,
    });
    // Auto-close after 8 seconds unless requireInteraction is set.
    if (!opts.requireInteraction) setTimeout(() => n.close(), 8000);
  } catch (err) {
    console.warn('[notify] failed', err);
  }
}

// Pre-defined alert helpers so callers don't need to craft messages.

export function notifyBackfillComplete(sampleCount) {
  notify(`Whoop sync complete`, {
    body: `${sampleCount.toLocaleString()} samples received from your strap.`,
    tag: 'backfill',
  });
}

export function notifyLowRecovery(score) {
  notify(`🛌 Rest day recommended`, {
    body: `Recovery is ${Math.round(score)}% — in the red zone. Take it easy today.`,
    tag: 'recovery-low',
    requireInteraction: true,
  });
}

export function notifyLowBattery(pct) {
  notify(`⚡ Whoop battery low: ${Math.round(pct)}%`, {
    body: 'Charge your Whoop to ensure continuous tracking.',
    tag: 'battery',
  });
}

export function notifyHrAnomaly(hr, prev) {
  notify(`❤️ HR anomaly detected`, {
    body: `Heart rate jumped from ${Math.round(prev)} to ${Math.round(hr)} bpm.`,
    tag: 'hr-anomaly',
  });
}
