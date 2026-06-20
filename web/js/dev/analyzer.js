// NDJSON capture analyzer.
//
// Takes a captured NDJSON file (produced by web/js/dev/capture.js) and computes
// per-byte-offset statistics across packets of the same kind. The output
// quickly reveals which bytes of the 96-byte realtime packet body are:
//
//   - constant (same value in every packet)            → header / framing
//   - slowly varying (small stddev)                    → state flags
//   - rapidly varying around a centre (large stddev)   → sensor signal
//   - monotonically increasing                         → counter / timestamp
//   - bimodal (only 0 and 0xff)                        → boolean flag
//
// This is the offline tool that turns labeled capture sessions (still,
// walking, workout) into the byte-18+ decode table for the realtime packet.

/**
 * Parse an NDJSON capture file text into rows + meta.
 *   text: string contents of a .ndjson capture
 *   → { meta, rows: [{ tsMs, kind, hex, decoded }, ...] }
 */
export function parseCaptureFile(text) {
  const lines = text.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return { meta: null, rows: [] };
  let meta = null;
  const rows = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj._meta) {
      meta = obj._meta;
    } else if (obj.kind) {
      rows.push(obj);
    }
  }
  return { meta, rows };
}

/**
 * Compute per-offset statistics across all packets of one kind.
 *   rows: parsed capture rows
 *   kind: 'realtime' | 'historical' | 'event' | 'response' | 'imu'
 *
 * Returns an array of length max(packet.hex.length / 2), each entry:
 *   { offset, min, max, mean, stddev, unique, samples: { hist[256] } }
 * Only counts packets that have a hex field.
 */
export function byteStats(rows, kind) {
  const matching = rows.filter(r => r.kind === kind && r.hex);
  if (matching.length === 0) return [];

  // Convert hex strings to byte arrays
  const byteArrays = matching.map(r => hexToBytes(r.hex));
  const maxLen = Math.max(...byteArrays.map(b => b.length));

  const stats = [];
  for (let off = 0; off < maxLen; off++) {
    const values = [];
    const hist = new Uint32Array(256);
    for (const arr of byteArrays) {
      if (off < arr.length) {
        values.push(arr[off]);
        hist[arr[off]]++;
      }
    }
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const uniqueValues = new Set(values).size;
    stats.push({
      offset: off,
      count: values.length,
      min, max, mean, stddev,
      unique: uniqueValues,
      hist,
    });
  }
  return stats;
}

/**
 * Compare byte stats between two captures of the same kind (e.g. "still"
 * vs "walking"). Returns offsets where mean or stddev differs substantially.
 * The biggest differences in mean are most likely the byte positions
 * carrying the variable being studied (accel/motion/HR-derivative/etc.).
 */
export function compareCaptures(statsA, statsB, { meanThresh = 5, stdThresh = 5 } = {}) {
  const out = [];
  const len = Math.min(statsA.length, statsB.length);
  for (let i = 0; i < len; i++) {
    const a = statsA[i];
    const b = statsB[i];
    const dMean = b.mean - a.mean;
    const dStd = b.stddev - a.stddev;
    if (Math.abs(dMean) >= meanThresh || Math.abs(dStd) >= stdThresh) {
      out.push({
        offset: i,
        deltaMean: dMean,
        deltaStd: dStd,
        statsA: { mean: a.mean, stddev: a.stddev, unique: a.unique },
        statsB: { mean: b.mean, stddev: b.stddev, unique: b.unique },
      });
    }
  }
  // Sort by abs(deltaMean+deltaStd) so the biggest differences float to top
  return out.sort((x, y) =>
    (Math.abs(y.deltaMean) + Math.abs(y.deltaStd)) - (Math.abs(x.deltaMean) + Math.abs(x.deltaStd))
  );
}

/**
 * Detect monotonic counters (sequence numbers). Returns offsets whose values
 * are strictly increasing across packets (with wraparound tolerated).
 */
export function findCounters(rows, kind) {
  const matching = rows.filter(r => r.kind === kind && r.hex);
  if (matching.length < 3) return [];
  const arrays = matching.map(r => hexToBytes(r.hex));
  const maxLen = Math.max(...arrays.map(b => b.length));
  const counters = [];
  for (let off = 0; off < maxLen; off++) {
    let monotonic = true;
    let lastVal = null;
    let totalIncrease = 0;
    for (const arr of arrays) {
      if (off >= arr.length) { monotonic = false; break; }
      if (lastVal !== null) {
        // Allow wraparound on uint8: 255 → 0 is a +1, not a decrease
        const delta = (arr[off] - lastVal + 256) % 256;
        if (delta === 0 || delta > 50) { monotonic = false; break; }
        totalIncrease += delta;
      }
      lastVal = arr[off];
    }
    if (monotonic && totalIncrease > 0) {
      counters.push({ offset: off, totalIncrease, avgDelta: totalIncrease / (arrays.length - 1) });
    }
  }
  return counters;
}

/**
 * Convert a lower-case hex string to a Uint8Array.
 */
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Produce a one-paragraph summary of a single capture file for humans:
 * how many packets of each kind, total bytes, capture duration, etc.
 */
export function summarize({ meta, rows }) {
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const totalBytes = rows.reduce((acc, r) => acc + (r.hex ? r.hex.length / 2 : 0), 0);
  return {
    label: meta?.label ?? '(unknown)',
    durationMs: meta?.durationMs ?? 0,
    rowCount: rows.length,
    byKind,
    totalBytes,
  };
}
