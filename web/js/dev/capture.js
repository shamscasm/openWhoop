// Raw-packet capture mode.
//
// Records every framed packet WhoopClient receives during a window, tagged
// with high-resolution timestamps. Output is a hex-encoded NDJSON file —
// one packet per line — that we can analyse offline to crack the rest of
// the realtime packet body (bytes 18+: PPG, accel, gyro, etc.).
//
// Usage from the UI:
//   import { startCapture, stopCapture, downloadCapture } from './dev/capture.js';
//   startCapture(client, { label: 'walking-at-3mph' });
//   ... user walks for 3 minutes ...
//   const blob = await stopCapture();
//   downloadCapture(blob);

import { PacketType } from '../ble/packet.js';
import { saveCapture } from '../data/queries.js';

let _state = null;

// Per-capture row cap to bound memory. At ~96 bytes/row * 50k rows that's ~5MB.
const MAX_ROWS = 50_000;

/**
 * Begin capturing. Subscribes to a client's 'sample', 'historicalSample',
 * 'event', 'response', 'log', and 'imu' streams. Returns an opaque handle
 * that stopCapture() consumes. Captures expose:
 *   - tsMs: ms since capture start
 *   - kind: 'realtime' | 'historical' | 'event' | 'response' | 'imu' | 'log'
 *   - hex: lower-case hex string of the inner data (no framing) for binary kinds
 *   - decoded: the parsed object the client emitted
 */
export function startCapture(client, { label = 'capture' } = {}) {
  if (_state) throw new Error('Capture already in progress; stop it first');
  _state = {
    label,
    startedAt: Date.now(),
    rows: [],
    disposers: [],
  };

  const push = (kind, decoded, rawBytes = null) => {
    if (_state.rows.length >= MAX_ROWS) {
      if (!_state.capped) {
        _state.capped = true;
        // Surface once via the row stream itself, then silently drop.
        _state.rows.push({
          tsMs: Date.now() - _state.startedAt,
          kind: '__capped__',
          hex: null,
          decoded: { reason: `row cap ${MAX_ROWS} reached; further packets dropped` },
        });
      }
      return;
    }
    _state.rows.push({
      tsMs: Date.now() - _state.startedAt,
      kind,
      hex: rawBytes ? toHex(rawBytes) : null,
      decoded: decoded ? sanitize(decoded) : null,
    });
  };

  _state.disposers.push(client.on('sample',           (s) => push('realtime',   s, s.raw)));
  _state.disposers.push(client.on('historicalSample', (s) => push('historical', s)));
  _state.disposers.push(client.on('event',            (e) => push('event',      e)));
  _state.disposers.push(client.on('response',         (r) => push('response',   r, r.data)));
  _state.disposers.push(client.on('log',              (t) => push('log',        { text: t })));
  _state.disposers.push(client.on('imu',              (i) => push('imu',        i, i.data)));

  return _state;
}

/**
 * End capture. Returns { text, blob, rowCount, capped } — text is the raw
 * NDJSON, blob is a downloadable wrapper, capped is true if MAX_ROWS was
 * hit. Pass `db` to also persist the capture into the IndexedDB `captures`
 * store. Returns null if nothing was running.
 */
export async function stopCapture(db = null) {
  if (!_state) return null;
  for (const d of _state.disposers) d();
  const meta = {
    label: _state.label,
    startedAt: new Date(_state.startedAt).toISOString(),
    durationMs: Date.now() - _state.startedAt,
    rowCount: _state.rows.length,
    capped: !!_state.capped,
    schema: 'whoof-capture/v1',
  };
  const lines = [JSON.stringify({ _meta: meta })];
  for (const row of _state.rows) lines.push(JSON.stringify(row));
  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const rowCount = _state.rows.length;
  const capped = !!_state.capped;
  _state = null;

  if (db) {
    try {
      await saveCapture(db, {
        label: meta.label,
        created_at: meta.startedAt,
        duration_ms: meta.durationMs,
        row_count: rowCount,
        capped,
        ndjson_text: text,
      });
    } catch (err) {
      // Persisting is best-effort; the caller still gets the blob.
      console.warn('[capture] persist failed', err);
    }
  }

  return { text, blob, rowCount, capped };
}

/** Trigger a browser download. Accepts either the result object or a raw Blob. */
export function downloadCapture(result, label = 'capture') {
  if (!result) return;
  const blob = result instanceof Blob ? result : result.blob;
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `whoop-${label}-${stamp}.ndjson`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function isCapturing() { return _state !== null; }
export function captureStats() {
  if (!_state) return null;
  return {
    label: _state.label,
    rows: _state.rows.length,
    durationMs: Date.now() - _state.startedAt,
  };
}

// ---- helpers -------------------------------------------------------------

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xf).toString(16);
  }
  return out;
}

function sanitize(obj) {
  // Drop Uint8Array fields so JSON.stringify produces compact rows; the
  // hex column already carries the binary content.
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Uint8Array) continue;
    out[k] = v;
  }
  return out;
}
