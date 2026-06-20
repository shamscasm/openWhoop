// Multi-tab connection coordinator.
//
// Web Bluetooth only allows ONE tab in a browser session to hold a GATT
// connection at a time. If a second tab tries to connect, the underlying
// API call fails with a confusing "device not found" error. This module
// uses BroadcastChannel to detect when another tab has an active connection
// and lets the UI warn the user before they try.
//
// API:
//   announceConnected()    — call when this tab successfully connects
//   announceDisconnected() — call when this tab disconnects
//   isAnotherTabConnected() → Promise<boolean>  — check for active peers
//   onConflict(fn)         → register a callback fired when another tab
//                            claims connection while we're also connected

const CHANNEL_NAME = 'whoof-ble-coord';
const PING_REPLY_MS = 200;

let _channel = null;
let _connected = false;
const _conflictListeners = new Set();

function getChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (_channel) return _channel;
  _channel = new BroadcastChannel(CHANNEL_NAME);
  _channel.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'ping' && _connected) {
      _channel.postMessage({ type: 'pong', tabId: _selfId(), ts: Date.now() });
    }
    if (msg.type === 'announce-connected' && _connected && msg.tabId !== _selfId()) {
      for (const fn of _conflictListeners) fn(msg);
    }
  });
  return _channel;
}

let __selfIdCache = null;
function _selfId() {
  if (__selfIdCache) return __selfIdCache;
  __selfIdCache = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Math.random()).slice(2);
  return __selfIdCache;
}

export function announceConnected() {
  _connected = true;
  const ch = getChannel();
  if (ch) ch.postMessage({ type: 'announce-connected', tabId: _selfId(), ts: Date.now() });
}

export function announceDisconnected() {
  _connected = false;
  const ch = getChannel();
  if (ch) ch.postMessage({ type: 'announce-disconnected', tabId: _selfId(), ts: Date.now() });
}

/** Returns true if any other tab in this browser claims an active connection. */
export function isAnotherTabConnected(timeoutMs = PING_REPLY_MS) {
  const ch = getChannel();
  if (!ch) return Promise.resolve(false);
  return new Promise((resolve) => {
    const pongs = new Set();
    const handler = (e) => {
      if (e.data?.type === 'pong' && e.data.tabId && e.data.tabId !== _selfId()) {
        pongs.add(e.data.tabId);
      }
    };
    ch.addEventListener('message', handler);
    ch.postMessage({ type: 'ping', tabId: _selfId(), ts: Date.now() });
    setTimeout(() => {
      ch.removeEventListener('message', handler);
      resolve(pongs.size > 0);
    }, timeoutMs);
  });
}

export function onConflict(fn) {
  _conflictListeners.add(fn);
  return () => _conflictListeners.delete(fn);
}
