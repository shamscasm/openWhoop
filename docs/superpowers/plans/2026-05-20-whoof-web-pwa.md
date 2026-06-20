# whoof v0.3 (Browser PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `whoof` from a Python recorder + HTTP dashboard to a pure-browser PWA that reads the Whoop 4.0 via Web Bluetooth, stores data in IndexedDB, and computes every metric in JavaScript. One codebase runs in Mac Chrome (dev) and iPhone Bluefy (target).

**Architecture:** Static SPA, no backend. Web Bluetooth → in-browser 96-byte packet decode → IndexedDB writes → on-demand daily rollups. The v0.2 UI (HTML/CSS + render functions in `web/app.js`) is reused; the v0.2 Python backend (`db.py`, `dashboard.py`, `recorder.py`, `metrics.py`, `sleep.py`, `zones.py`, `workouts.py`) is replaced.

**Tech Stack:** Vanilla JS (ES modules, no production build step), `idb` for IndexedDB ergonomics (vendored), Chart.js (vendored, was CDN), `vitest` + `fake-indexeddb` for tests, existing Python `http.server` for dev static hosting on `localhost`.

**Repo state:** Project is not currently a git repo. Plan does NOT include `git commit` steps — substitute "snapshot checkpoint" if/when a repo is initialized. Use `npm test` after every implementation step to verify.

**Spec:** [`docs/superpowers/specs/2026-05-20-whoof-web-pwa-design.md`](../specs/2026-05-20-whoof-web-pwa-design.md)

---

## File structure (final state)

```
web/
  index.html                   (edited: add Connect button + status pill; swap CDN <script> for vendored)
  styles.css                   (unchanged)
  manifest.json                (NEW — deferred to Phase 5)
  sw.js                        (NEW — deferred to Phase 5)
  vendor/
    chart.umd.min.js           (vendored Chart.js 4.4.0)
    idb.min.js                 (vendored idb 8.x, ~3KB gzipped)
  js/
    app.js                     (refactor of v0.2 app.js — IndexedDB instead of fetch)
    ble/
      uuids.js                 (SERVICE_UUID + 5 characteristic UUIDs)
      crc.js                   (CRC-32 with Whoop params)
      protocol.js              (build_command, parse_response_header, REALTIME_PACKET_SIZE)
      parser.js                (parse_realtime_packet → object, mirrors RealtimePacket)
      client.js                (Web Bluetooth: connect, subscribe, write start cmd, disconnect, reconnect)
    data/
      schema.js                (object-store names + index definitions)
      db.js                    (openDb() with versioned onupgradeneeded)
      queries.js               (insertSample, samplesInRange, todayMetrics, upsertDailyMetric, ...)
    metrics/
      hrv.js                   (filter_rr, rmssd, sdnn, pnn50)
      recovery.js              (z-score recovery + 4-component breakdown)
      strain.js                (Borg-style strain curve)
      zones.js                 (HR zones + calories Keytel)
      sleep.js                 (stage classifier, need/debt/consistency, respiratory rate)
      workouts.js              (auto-detection)
      rollup.js                (orchestrate daily rollups, fill missing dates on dashboard load)
    util/
      time.js                  (local-day boundaries, formatters)
      events.js                (tiny event emitter for BLE → UI)
    dev/
      seed.js                  (port of seed-demo; hidden behind ?demo=1)

tests/js/                      (NEW — JS tests; existing Python tests/ stay as porting reference)
  ble/
    crc.test.js
    protocol.test.js
    parser.test.js
  data/
    db.test.js
    queries.test.js
  metrics/
    hrv.test.js
    recovery.test.js
    strain.test.js
    zones.test.js
    sleep.test.js
    workouts.test.js
  setup.js                     (fake-indexeddb shim + jsdom polyfills)

package.json                   (NEW — vitest, fake-indexeddb, jsdom devDeps)
vitest.config.js               (NEW — point at tests/js, load setup.js)
.npmrc                         (NEW — `save-exact=true`)

whoof/                     (trimmed Python — kept for static-serve only)
  cli.py                       (trimmed: keep `dash`; remove record/rollup/scan/info/battery/status/seed-demo)
  static_server.py             (renamed from dashboard.py; serves /web; no API routes)

# DEPRECATED but kept on disk for reference until v0.3 ships:
#   whoof/db.py, metrics.py, sleep.py, zones.py, workouts.py, recorder.py, dashboard.py
#   vendor/whoop-reader (Python BLE driver) — used as porting reference only
```

---

## Phase 0 — Scaffolding

### Task 0.1: Node toolchain for tests

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `tests/js/setup.js`
- Create: `.gitignore` entry for `node_modules/` (append to existing `.gitignore`)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "whoof-web",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.4",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^25.0.1"
  }
}
```

- [ ] **Step 2: Write `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/js/**/*.test.js'],
    environment: 'jsdom',
    setupFiles: ['./tests/js/setup.js'],
  },
});
```

- [ ] **Step 3: Write `tests/js/setup.js`**

```js
import 'fake-indexeddb/auto';
```

- [ ] **Step 4: Append `node_modules/` to `.gitignore`**

```bash
grep -qxF 'node_modules/' .gitignore || echo 'node_modules/' >> .gitignore
```

- [ ] **Step 5: Install**

```bash
npm install
```

Expected: exit 0; `node_modules/` populated; `package-lock.json` created.

- [ ] **Step 6: Sanity-test the runner**

Write a throwaway `tests/js/setup.test.js`:

```js
import { describe, it, expect } from 'vitest';
describe('setup', () => {
  it('has indexedDB shim', () => {
    expect(typeof indexedDB).toBe('object');
    expect(typeof indexedDB.open).toBe('function');
  });
});
```

Run: `npm test`
Expected: 1 passed.

Delete `tests/js/setup.test.js` afterward.

---

### Task 0.2: Vendor Chart.js and idb

**Files:**
- Create: `web/vendor/chart.umd.min.js`
- Create: `web/vendor/idb.min.js`

- [ ] **Step 1: Download Chart.js 4.4.0 UMD build**

```bash
curl -L -o web/vendor/chart.umd.min.js \
  https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
```

Verify: `wc -c web/vendor/chart.umd.min.js` — expect ≥ 200000 bytes.

- [ ] **Step 2: Download idb 8.x ESM build**

```bash
curl -L -o web/vendor/idb.min.js \
  https://cdn.jsdelivr.net/npm/idb@8.0.0/build/index.min.js
```

Verify: file is non-empty and exports `openDB` (`grep -l openDB web/vendor/idb.min.js`).

- [ ] **Step 3: Update `web/index.html` script tag**

Replace line 292 of `web/index.html`:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

with:

```html
<script src="/vendor/chart.umd.min.js"></script>
```

- [ ] **Step 4: Smoke test the dashboard still loads**

```bash
./run.sh --db /tmp/whoop-demo.db dash --port 8765 &
sleep 1
curl -sf http://localhost:8765/vendor/chart.umd.min.js | head -c 100
kill %1
```

Expected: Chart.js minified preamble appears (`/*! Chart.js v4.4.0`).

---

## Phase 1 — BLE + IndexedDB MVP

### Task 1.1: CRC-32 (Whoop variant)

**Files:**
- Create: `web/js/ble/crc.js`
- Create: `tests/js/ble/crc.test.js`

Source: `vendor/whoop-reader/whoop_reader/protocol.py:117-171` (`_reflect`, `_build_crc_table`, `crc32_whoop`).

- [ ] **Step 1: Write the failing test**

```js
// tests/js/ble/crc.test.js
import { describe, it, expect } from 'vitest';
import { crc32Whoop, verifyCrc } from '../../../web/js/ble/crc.js';

describe('crc32Whoop', () => {
  it('matches the empty-input known value', () => {
    // Python reference: crc32_whoop(b'') = (reflect(0xFFFFFFFF,32) ^ 0xF43F44AC)
    // = 0xFFFFFFFF ^ 0xF43F44AC = 0x0BC0BB53
    expect(crc32Whoop(new Uint8Array())).toBe(0x0bc0bb53);
  });

  it('produces a stable value for a known buffer', () => {
    const data = new Uint8Array([0xaa, 0x03, 0x00, 0x00]);
    const crc = crc32Whoop(data);
    expect(typeof crc).toBe('number');
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffffffff);
  });

  it('verifyCrc returns true for matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, crc32Whoop(data))).toBe(true);
  });

  it('verifyCrc returns false for non-matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, 0xdeadbeef)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

`npm test -- crc` → all 4 tests fail (module not found).

- [ ] **Step 3: Implement `web/js/ble/crc.js`**

```js
// CRC-32 used by Whoop 4.0 BLE protocol.
// Poly 0x04C11DB7, init 0xFFFFFFFF, reflect in/out, xor-out 0xF43F44AC.
// Reference: vendor/whoop-reader/whoop_reader/protocol.py:117

const POLY = 0x04c11db7;
const INIT = 0xffffffff;
const XOR_OUT = 0xf43f44ac;

function reflect(value, width) {
  let result = 0;
  for (let i = 0; i < width; i++) {
    if (value & (1 << i)) result |= 1 << (width - 1 - i);
  }
  return result >>> 0;
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0;
    for (let b = 0; b < 8; b++) {
      crc = ((crc & 0x80000000) ? ((crc << 1) ^ POLY) : (crc << 1)) >>> 0;
    }
    t[i] = crc;
  }
  return t;
})();

export function crc32Whoop(data) {
  let crc = INIT;
  for (const byte of data) {
    const ref = reflect(byte, 8);
    const idx = ((crc >>> 24) ^ ref) & 0xff;
    crc = (((crc << 8) >>> 0) ^ TABLE[idx]) >>> 0;
  }
  crc = reflect(crc, 32);
  return (crc ^ XOR_OUT) >>> 0;
}

export function verifyCrc(data, expected) {
  return crc32Whoop(data) === (expected >>> 0);
}
```

- [ ] **Step 4: Run test, expect pass**

`npm test -- crc` → 4 passed.

- [ ] **Step 5: Cross-check against Python**

```bash
.venv/bin/python -c "from whoop_reader.protocol import crc32_whoop; print(hex(crc32_whoop(bytes([0xaa,0x03,0x00,0x00]))))"
```

Then run the same input through the JS in a one-liner and confirm match:

```bash
node --input-type=module -e "import('./web/js/ble/crc.js').then(({crc32Whoop}) => console.log('0x' + crc32Whoop(new Uint8Array([0xaa,0x03,0x00,0x00])).toString(16)))"
```

Both outputs must match. If they don't, the JS port is wrong — debug before proceeding.

---

### Task 1.2: Protocol constants and frame builder

**Files:**
- Create: `web/js/ble/uuids.js`
- Create: `web/js/ble/protocol.js`
- Create: `tests/js/ble/protocol.test.js`

Source: `vendor/whoop-reader/whoop_reader/protocol.py:22-100, 196-257`.

- [ ] **Step 1: Write `web/js/ble/uuids.js`**

```js
export const SERVICE_UUID         = '61080000-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_COMMAND_UUID    = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_RESPONSE_UUID   = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_EVENT_UUID      = '61080003-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_DATA_UUID       = '61080004-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CHAR_DIAG_UUID       = '61080005-8d6d-82b8-614a-1c8cb0f8dcc6';

export const CMD_GET_BATTERY      = 0x01;
export const CMD_GET_DEVICE_INFO  = 0x02;
export const CMD_START_REALTIME   = 0x03;
export const CMD_STOP_REALTIME    = 0x04;
export const CMD_GET_HELLO        = 0x05;

export const PACKET_HEADER        = 0xaa;
export const REALTIME_PACKET_SIZE = 96;
```

- [ ] **Step 2: Write the failing test for `protocol.js`**

```js
// tests/js/ble/protocol.test.js
import { describe, it, expect } from 'vitest';
import { buildCommand, parseResponseHeader } from '../../../web/js/ble/protocol.js';
import { CMD_START_REALTIME, PACKET_HEADER } from '../../../web/js/ble/uuids.js';

describe('buildCommand', () => {
  it('frames a no-payload command as [AA][cmd][00 00][crc4]', () => {
    const frame = buildCommand(CMD_START_REALTIME);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(frame.length).toBe(8); // header + cmd + 2-byte len + 4-byte CRC
    expect(frame[0]).toBe(PACKET_HEADER);
    expect(frame[1]).toBe(CMD_START_REALTIME);
    expect(frame[2]).toBe(0x00);
    expect(frame[3]).toBe(0x00);
  });

  it('includes payload bytes in the frame', () => {
    const frame = buildCommand(0x10, new Uint8Array([0xde, 0xad]));
    expect(frame.length).toBe(10); // 4 header + 2 payload + 4 crc
    expect(frame[4]).toBe(0xde);
    expect(frame[5]).toBe(0xad);
  });
});

describe('parseResponseHeader', () => {
  it('returns code, length, and payload', () => {
    // Build a valid frame: header=AA, code=0x01, len=2, payload=[0x42,0x43]
    const data = new Uint8Array([0xaa, 0x01, 0x02, 0x00, 0x42, 0x43]);
    const { code, payload } = parseResponseHeader(data);
    expect(code).toBe(0x01);
    expect(Array.from(payload)).toEqual([0x42, 0x43]);
  });

  it('throws on bad header byte', () => {
    expect(() => parseResponseHeader(new Uint8Array([0xff, 0, 0, 0]))).toThrow();
  });
});
```

- [ ] **Step 3: Run, expect failure**

`npm test -- protocol` → fails (module not found).

- [ ] **Step 4: Implement `web/js/ble/protocol.js`**

```js
import { crc32Whoop, verifyCrc } from './crc.js';
import { PACKET_HEADER } from './uuids.js';

export function buildCommand(cmd, payload = new Uint8Array()) {
  const len = payload.length;
  const head = new Uint8Array(4 + len);
  head[0] = PACKET_HEADER;
  head[1] = cmd & 0xff;
  head[2] = len & 0xff;
  head[3] = (len >> 8) & 0xff;
  head.set(payload, 4);
  const crc = crc32Whoop(head);
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out[head.length + 0] =  crc        & 0xff;
  out[head.length + 1] = (crc >>>  8) & 0xff;
  out[head.length + 2] = (crc >>> 16) & 0xff;
  out[head.length + 3] = (crc >>> 24) & 0xff;
  return out;
}

export function parseResponseHeader(data) {
  if (data.length < 4) throw new Error(`Frame too short: ${data.length} bytes`);
  if (data[0] !== PACKET_HEADER) {
    throw new Error(`Invalid header byte: 0x${data[0].toString(16)}`);
  }
  const code = data[1];
  const payloadLen = data[2] | (data[3] << 8);
  const payload = data.slice(4, 4 + payloadLen);

  // Verify CRC if frame is long enough
  if (data.length >= 4 + payloadLen + 4) {
    const crcExpected =
      (data[4 + payloadLen]       ) |
      (data[4 + payloadLen + 1] <<  8) |
      (data[4 + payloadLen + 2] << 16) |
      (data[4 + payloadLen + 3] << 24);
    const body = data.slice(0, 4 + payloadLen);
    if (!verifyCrc(body, crcExpected >>> 0)) {
      throw new Error(`CRC mismatch on response frame`);
    }
  }
  return { code, payload };
}
```

- [ ] **Step 5: Run, expect pass**

`npm test -- protocol` → all pass.

---

### Task 1.3: 96-byte realtime packet parser

**Files:**
- Create: `web/js/ble/parser.js`
- Create: `tests/js/ble/parser.test.js`

Source: `vendor/whoop-reader/whoop_reader/parser.py:148-243`.

- [ ] **Step 1: Write failing test**

```js
// tests/js/ble/parser.test.js
import { describe, it, expect } from 'vitest';
import { crc32Whoop } from '../../../web/js/ble/crc.js';
import { parseRealtimePacket } from '../../../web/js/ble/parser.js';

function buildPacket({ seq = 1, hr = 72, rr = 833, spo2 = 98, tempByte = 58 } = {}) {
  const pkt = new Uint8Array(96);
  pkt[0] = seq;
  const hrRaw = Math.round(hr * 100);
  pkt[1] = hrRaw & 0xff;
  pkt[2] = (hrRaw >> 8) & 0xff;
  pkt[3] = rr & 0xff;
  pkt[4] = (rr >> 8) & 0xff;
  pkt[5] = spo2;
  pkt[6] = tempByte; // (58 - 25) = 33 C skin temp
  // bytes 7..91 zero
  const body = pkt.slice(0, 92);
  const crc = crc32Whoop(body);
  pkt[92] = crc & 0xff;
  pkt[93] = (crc >>> 8) & 0xff;
  pkt[94] = (crc >>> 16) & 0xff;
  pkt[95] = (crc >>> 24) & 0xff;
  return pkt;
}

describe('parseRealtimePacket', () => {
  it('decodes a well-formed packet', () => {
    const p = parseRealtimePacket(buildPacket());
    expect(p.sequence).toBe(1);
    expect(p.heartRateBpm).toBeCloseTo(72, 1);
    expect(p.rrIntervalMs).toBe(833);
    expect(p.spo2Pct).toBe(98);
    expect(p.skinTempC).toBeCloseTo(33, 5);
    expect(p.crcValid).toBe(true);
  });

  it('flags bad CRC', () => {
    const p = buildPacket();
    p[92] ^= 0xff; // corrupt CRC
    expect(parseRealtimePacket(p).crcValid).toBe(false);
  });

  it('out-of-range HR becomes null', () => {
    const p = buildPacket({ hr: 5 }); // hr*100 = 500, below 2000 threshold
    expect(parseRealtimePacket(p).heartRateBpm).toBeNull();
  });

  it('throws on non-96-byte input', () => {
    expect(() => parseRealtimePacket(new Uint8Array(95))).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `web/js/ble/parser.js`**

```js
import { crc32Whoop } from './crc.js';
import { REALTIME_PACKET_SIZE } from './uuids.js';

function u16le(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function i16le(buf, off) {
  const v = u16le(buf, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}
function u32le(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * Parse a 96-byte real-time data packet from CHAR_DATA.
 * Mirrors vendor/whoop-reader/whoop_reader/parser.py::parse_realtime_packet.
 */
export function parseRealtimePacket(data) {
  if (data.length !== REALTIME_PACKET_SIZE) {
    throw new Error(`Expected ${REALTIME_PACKET_SIZE}-byte packet, got ${data.length}`);
  }
  const raw = data instanceof Uint8Array ? data : new Uint8Array(data);

  const body = raw.subarray(0, 92);
  const crcReceived = u32le(raw, 92);
  const crcValid = crc32Whoop(body) === crcReceived;

  const sequence = raw[0];

  const hrRaw = u16le(raw, 1);
  const heartRateBpm = (hrRaw >= 2000 && hrRaw <= 25000) ? hrRaw / 100 : null;

  const rrRaw = u16le(raw, 3);
  const rrIntervalMs = (rrRaw >= 200 && rrRaw <= 2000) ? rrRaw : null;

  const spo2Raw = raw[5];
  const spo2Pct = (spo2Raw >= 50 && spo2Raw <= 100) ? spo2Raw : null;

  const tempRaw = raw[6];
  let skinTempC = null;
  if (tempRaw > 0) {
    const t = tempRaw - 25;
    if (t >= 20 && t <= 45) skinTempC = t;
  }

  return {
    sequence,
    heartRateBpm,
    rrIntervalMs,
    spo2Pct,
    skinTempC,
    accelX: i16le(raw, 7),
    accelY: i16le(raw, 9),
    accelZ: i16le(raw, 11),
    motion: raw[13],
    ppgAmp: u16le(raw, 14),
    ambientLight: u16le(raw, 16),
    ppgQuality: u16le(raw, 18),
    unknown20_91: raw.slice(20, 92),
    crcValid,
    raw,
  };
}
```

- [ ] **Step 4: Run, expect pass.**

---

### Task 1.4: IndexedDB schema + open

**Files:**
- Create: `web/js/data/schema.js`
- Create: `web/js/data/db.js`
- Create: `tests/js/data/db.test.js`

Source: `whoof/db.py:15-110` (schema).

- [ ] **Step 1: Write `web/js/data/schema.js`** (single source of truth for stores + indexes)

```js
// IndexedDB schema for whoof v0.3.
// Mirrors the SQLite schema in whoof/db.py.

export const DB_NAME = 'whoof';
export const DB_VERSION = 1;

export const STORES = {
  samples:        { keyPath: 'id', autoIncrement: true,
                    indexes: [['ts_utc'], ['session_id'], ['session_sequence', ['session_id', 'sequence']]] },
  sessions:       { keyPath: 'id', autoIncrement: true,
                    indexes: [['started_at']] },
  device_events:  { keyPath: 'id', autoIncrement: true,
                    indexes: [['ts_utc']] },
  daily_metrics:  { keyPath: 'date',
                    indexes: [] },
  profile:        { keyPath: 'id',
                    indexes: [] },
  sleep_stages:   { keyPath: 'id', autoIncrement: true,
                    indexes: [['date'], ['start_utc']] },
  workouts:       { keyPath: 'id', autoIncrement: true,
                    indexes: [['date']] },
};
```

- [ ] **Step 2: Write failing test**

```js
// tests/js/data/db.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { STORES } from '../../../web/js/data/schema.js';

describe('openDb', () => {
  beforeEach(() => {
    // fake-indexeddb auto-shim provides a fresh DB per file when we delete first
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('whoof');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('creates all object stores at version 1', async () => {
    const db = await openDb();
    const names = Array.from(db.objectStoreNames);
    for (const store of Object.keys(STORES)) {
      expect(names).toContain(store);
    }
    db.close();
  });

  it('creates indexes on samples store', async () => {
    const db = await openDb();
    const tx = db.transaction('samples');
    const idxNames = Array.from(tx.objectStore('samples').indexNames);
    expect(idxNames).toContain('ts_utc');
    expect(idxNames).toContain('session_id');
    expect(idxNames).toContain('session_sequence');
    db.close();
  });
});
```

- [ ] **Step 3: Run, expect failure.**

- [ ] **Step 4: Implement `web/js/data/db.js`**

```js
import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, {
          keyPath: def.keyPath,
          autoIncrement: !!def.autoIncrement,
        });
        for (const [idxName, keyPath] of def.indexes) {
          store.createIndex(idxName, keyPath ?? idxName);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 5: Run, expect pass.**

---

### Task 1.5: IndexedDB queries

**Files:**
- Create: `web/js/data/queries.js`
- Create: `tests/js/data/queries.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/js/data/queries.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import {
  insertSample, samplesInRange, startSession, endSession, logEvent,
} from '../../../web/js/data/queries.js';

let db;
beforeEach(async () => {
  await new Promise((r) => {
    const req = indexedDB.deleteDatabase('whoof');
    req.onsuccess = r; req.onerror = r; req.onblocked = r;
  });
  db = await openDb();
});

describe('queries', () => {
  it('inserts and retrieves samples by ts_utc range', async () => {
    const sess = await startSession(db, 'test');
    const base = Date.parse('2026-05-20T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      await insertSample(db, {
        ts_utc: new Date(base + i * 1000).toISOString(),
        session_id: sess,
        sequence: i,
        heart_rate_bpm: 70 + i,
        rr_interval_ms: 800,
        spo2_pct: 98,
        skin_temp_c: 33,
        accel_x: 0, accel_y: 0, accel_z: 0,
        motion: 0, ppg_amp: 0, ambient_light: 0, ppg_quality: 0,
        crc_ok: 1,
      });
    }
    const rows = await samplesInRange(db,
      new Date(base + 1000).toISOString(),
      new Date(base + 3000).toISOString());
    expect(rows).toHaveLength(3);
    expect(rows[0].heart_rate_bpm).toBe(71);
  });

  it('startSession / endSession round-trip', async () => {
    const id = await startSession(db, 'morning');
    expect(typeof id).toBe('number');
    await endSession(db, id, 100);
    const sess = await new Promise((r) =>
      (db.transaction('sessions').objectStore('sessions').get(id).onsuccess = (e) => r(e.target.result)));
    expect(sess.sample_count).toBe(100);
    expect(sess.ended_at).toBeTruthy();
  });

  it('logEvent appends to device_events', async () => {
    await logEvent(db, 'connect', 'aa:bb:cc');
    const tx = db.transaction('device_events');
    const all = await new Promise((r) =>
      (tx.objectStore('device_events').getAll().onsuccess = (e) => r(e.target.result)));
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('connect');
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `web/js/data/queries.js`**

```js
function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function insertSample(db, sample) {
  const tx = db.transaction('samples', 'readwrite');
  await req2promise(tx.objectStore('samples').add(sample));
  await new Promise((r) => (tx.oncomplete = r));
}

export async function insertSamplesBatch(db, samples) {
  const tx = db.transaction('samples', 'readwrite');
  const store = tx.objectStore('samples');
  for (const s of samples) store.add(s);
  await new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function samplesInRange(db, isoFrom, isoTo) {
  const tx = db.transaction('samples');
  const idx = tx.objectStore('samples').index('ts_utc');
  const range = IDBKeyRange.bound(isoFrom, isoTo);
  return await req2promise(idx.getAll(range));
}

export async function startSession(db, label) {
  const tx = db.transaction('sessions', 'readwrite');
  const id = await req2promise(tx.objectStore('sessions').add({
    started_at: new Date().toISOString(),
    ended_at: null,
    label: label ?? null,
    notes: null,
    sample_count: 0,
  }));
  await new Promise((r) => (tx.oncomplete = r));
  return id;
}

export async function endSession(db, id, sampleCount) {
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const sess = await req2promise(store.get(id));
  if (!sess) return;
  sess.ended_at = new Date().toISOString();
  sess.sample_count = sampleCount;
  store.put(sess);
  await new Promise((r) => (tx.oncomplete = r));
}

export async function logEvent(db, kind, detail) {
  const tx = db.transaction('device_events', 'readwrite');
  tx.objectStore('device_events').add({
    ts_utc: new Date().toISOString(),
    kind,
    detail: detail ?? null,
  });
  await new Promise((r) => (tx.oncomplete = r));
}

export async function getProfile(db) {
  return await req2promise(db.transaction('profile').objectStore('profile').get(1));
}

export async function putProfile(db, profile) {
  const tx = db.transaction('profile', 'readwrite');
  tx.objectStore('profile').put({ ...profile, id: 1, updated_at: new Date().toISOString() });
  await new Promise((r) => (tx.oncomplete = r));
}

export async function getDailyMetric(db, date) {
  return await req2promise(db.transaction('daily_metrics').objectStore('daily_metrics').get(date));
}

export async function upsertDailyMetric(db, dm) {
  const tx = db.transaction('daily_metrics', 'readwrite');
  tx.objectStore('daily_metrics').put({ ...dm, computed_at: new Date().toISOString() });
  await new Promise((r) => (tx.oncomplete = r));
}

export async function recentDailyMetrics(db, days) {
  const tx = db.transaction('daily_metrics');
  const all = await req2promise(tx.objectStore('daily_metrics').getAll());
  return all.sort((a, b) => (a.date > b.date ? -1 : 1)).slice(0, days);
}
```

- [ ] **Step 4: Run, expect pass.**

---

### Task 1.6: Event emitter utility

**Files:**
- Create: `web/js/util/events.js`
- Create: `tests/js/util/events.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { createEmitter } from '../../../web/js/util/events.js';

describe('createEmitter', () => {
  it('on / emit delivers payloads to listener', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x', 42);
    expect(fn).toHaveBeenCalledWith(42);
  });
  it('off unsubscribes', () => {
    const e = createEmitter();
    const fn = vi.fn();
    const dispose = e.on('x', fn);
    dispose();
    e.emit('x', 1);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `web/js/util/events.js`**

```js
export function createEmitter() {
  const listeners = new Map(); // event -> Set<fn>
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
  };
}
```

- [ ] **Step 4: Run, expect pass.**

---

### Task 1.7: Web Bluetooth client

**Files:**
- Create: `web/js/ble/client.js`

This task is hardware-dependent and cannot be unit-tested without a real band. Skip TDD here; verify manually in Phase 1's integration step (Task 1.10).

- [ ] **Step 1: Implement `web/js/ble/client.js`**

```js
import {
  SERVICE_UUID, CHAR_COMMAND_UUID, CHAR_DATA_UUID, CHAR_EVENT_UUID,
  CMD_START_REALTIME, CMD_STOP_REALTIME, CMD_GET_BATTERY, REALTIME_PACKET_SIZE,
} from './uuids.js';
import { buildCommand, parseResponseHeader } from './protocol.js';
import { parseRealtimePacket } from './parser.js';
import { createEmitter } from '../util/events.js';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WhoopClient {
  constructor() {
    this.emitter = createEmitter();
    this.device = null;
    this.server = null;
    this.charCmd = null;
    this.charData = null;
    this.charEvent = null;
    this.connected = false;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._intentionalDisconnect = false;
  }

  on(event, fn) { return this.emitter.on(event, fn); }
  _emit(event, payload) { this.emitter.emit(event, payload); }

  async requestAndConnect() {
    this._intentionalDisconnect = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    await this._connect();
  }

  async _connect() {
    this._emit('state', 'connecting');
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    this.charCmd   = await service.getCharacteristic(CHAR_COMMAND_UUID);
    this.charData  = await service.getCharacteristic(CHAR_DATA_UUID);
    this.charEvent = await service.getCharacteristic(CHAR_EVENT_UUID);

    this.charData.addEventListener('characteristicvaluechanged', (e) => {
      const v = new Uint8Array(e.target.value.buffer);
      if (v.length !== REALTIME_PACKET_SIZE) return;
      try {
        const pkt = parseRealtimePacket(v);
        this._emit('sample', pkt);
      } catch (err) {
        this._emit('error', err);
      }
    });
    await this.charData.startNotifications();

    this.charEvent.addEventListener('characteristicvaluechanged', (e) => {
      const v = new Uint8Array(e.target.value.buffer);
      try {
        const { code, payload } = parseResponseHeader(v);
        this._emit('event', { code, payload });
      } catch (err) {
        /* swallow malformed event frames */
      }
    });
    await this.charEvent.startNotifications();

    // Tell the band to start streaming real-time data.
    await this.charCmd.writeValue(buildCommand(CMD_START_REALTIME));

    this.connected = true;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._emit('state', 'connected');
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    if (this.charCmd) {
      try { await this.charCmd.writeValue(buildCommand(CMD_STOP_REALTIME)); } catch {}
    }
    if (this.server && this.server.connected) this.server.disconnect();
    this.connected = false;
    this._emit('state', 'disconnected');
  }

  _onDisconnected() {
    this.connected = false;
    if (this._intentionalDisconnect) return;
    this._emit('state', 'reconnecting');
    setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
    this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
  }

  async _tryReconnect() {
    try { await this._connect(); }
    catch (err) {
      this._emit('error', err);
      setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
      this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
    }
  }
}
```

- [ ] **Step 2: Lint check**

```bash
node --check web/js/ble/client.js
```

Expected: no syntax errors.

---

### Task 1.8: Time utilities

**Files:**
- Create: `web/js/util/time.js`
- Create: `tests/js/util/time.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect } from 'vitest';
import { localDateKey, isoUtcNow } from '../../../web/js/util/time.js';

describe('localDateKey', () => {
  it('returns YYYY-MM-DD for a Date', () => {
    const d = new Date('2026-05-20T14:30:00Z');
    expect(localDateKey(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isoUtcNow', () => {
  it('returns parseable ISO string ending in Z', () => {
    const s = isoUtcNow();
    expect(s.endsWith('Z')).toBe(true);
    expect(Number.isFinite(Date.parse(s))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `web/js/util/time.js`**

```js
export function isoUtcNow() {
  return new Date().toISOString();
}

export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(d = new Date()) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfLocalDay(d = new Date()) {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
```

- [ ] **Step 4: Run, expect pass.**

---

### Task 1.9: Minimal HTML wiring — Connect button + live HR card

**Files:**
- Modify: `web/index.html` (add a top-of-page Connect button + status pill + live HR card; gate the existing tabbed UI behind a feature flag for now or hide it)
- Create: `web/js/app-mvp.js` (minimal app entry point — won't replace `app.js` yet; let v0.2 dashboard keep working with mock data)

The Phase 1 goal is to prove the BLE pipeline writes samples to IndexedDB. We don't refactor the full v0.2 dashboard yet — that's Phase 3. Add a separate minimal entry point that runs alongside.

- [ ] **Step 1: Append a hidden MVP panel to `web/index.html`** (before the existing `<script>` that loads `app.js`)

```html
<!-- Phase 1 MVP panel — remove or hide once Phase 3 lands -->
<section id="mvp-panel" style="position:fixed;top:8px;right:8px;z-index:1000;background:#111;border:1px solid #333;padding:12px;border-radius:8px;color:#eee;font:14px system-ui;min-width:260px">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <strong>BLE MVP</strong>
    <span id="mvp-status" style="font-size:12px;color:#888">disconnected</span>
  </div>
  <button id="mvp-connect" style="margin-top:8px;width:100%;padding:8px;background:#2a8;color:#fff;border:none;border-radius:4px;cursor:pointer">Connect Whoop</button>
  <button id="mvp-disconnect" style="margin-top:4px;width:100%;padding:8px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;display:none">Disconnect</button>
  <div style="margin-top:10px;font-size:32px;font-weight:600">
    <span id="mvp-hr">—</span>
    <span style="font-size:14px;color:#888"> bpm</span>
  </div>
  <div style="font-size:12px;color:#888;margin-top:4px">
    Samples this session: <span id="mvp-count">0</span>
  </div>
</section>
<script type="module" src="/js/app-mvp.js"></script>
```

- [ ] **Step 2: Implement `web/js/app-mvp.js`**

```js
import { WhoopClient } from './ble/client.js';
import { openDb } from './data/db.js';
import { insertSamplesBatch, startSession, endSession, logEvent } from './data/queries.js';
import { isoUtcNow } from './util/time.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('mvp-status');
const hrEl = $('mvp-hr');
const countEl = $('mvp-count');
const connectBtn = $('mvp-connect');
const disconnectBtn = $('mvp-disconnect');

let db;
let client;
let currentSession = null;
let sampleCount = 0;
let buffer = [];
const FLUSH_INTERVAL_MS = 1000;

async function flushLoop() {
  if (!db || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await insertSamplesBatch(db, batch);
  } catch (err) {
    console.error('flush failed', err);
    buffer.unshift(...batch); // requeue (cheap: foreground only)
  }
}

setInterval(flushLoop, FLUSH_INTERVAL_MS);

connectBtn.addEventListener('click', async () => {
  if (!db) db = await openDb();
  client = new WhoopClient();

  client.on('state', (s) => {
    statusEl.textContent = s;
    statusEl.style.color = s === 'connected' ? '#2a8' : s === 'reconnecting' ? '#fa3' : '#888';
    connectBtn.style.display = (s === 'connected' || s === 'connecting' || s === 'reconnecting') ? 'none' : 'block';
    disconnectBtn.style.display = (s === 'connected') ? 'block' : 'none';
  });

  client.on('sample', (pkt) => {
    if (pkt.heartRateBpm != null) hrEl.textContent = pkt.heartRateBpm.toFixed(0);
    sampleCount += 1;
    countEl.textContent = sampleCount.toString();
    buffer.push({
      ts_utc: isoUtcNow(),
      session_id: currentSession,
      sequence: pkt.sequence,
      heart_rate_bpm: pkt.heartRateBpm,
      rr_interval_ms: pkt.rrIntervalMs,
      spo2_pct: pkt.spo2Pct,
      skin_temp_c: pkt.skinTempC,
      accel_x: pkt.accelX, accel_y: pkt.accelY, accel_z: pkt.accelZ,
      motion: pkt.motion, ppg_amp: pkt.ppgAmp,
      ambient_light: pkt.ambientLight, ppg_quality: pkt.ppgQuality,
      crc_ok: pkt.crcValid ? 1 : 0,
    });
  });

  client.on('error', (e) => console.error('[ble error]', e));

  try {
    await client.requestAndConnect();
    currentSession = await startSession(db, 'mvp-session');
    await logEvent(db, 'connect', client.device?.id ?? 'unknown');
  } catch (err) {
    statusEl.textContent = 'error: ' + err.message;
    statusEl.style.color = '#f55';
    console.error(err);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await client?.disconnect();
  await flushLoop();
  if (currentSession && db) {
    await endSession(db, currentSession, sampleCount);
    await logEvent(db, 'disconnect', `samples=${sampleCount}`);
  }
});
```

- [ ] **Step 3: Confirm the static server still serves the new files**

```bash
./run.sh --db /tmp/whoop-demo.db dash --port 8765 &
sleep 1
for p in /js/app-mvp.js /js/ble/client.js /js/ble/parser.js /js/data/db.js /js/data/queries.js; do
  echo -n "$p → "
  curl -sf -o /dev/null -w "%{http_code}\n" "http://localhost:8765$p"
done
kill %1
```

Expected: all paths return `200`.

If any 404: open `whoof/dashboard.py`, check the static-file route handler — the existing one may serve only top-level files in `web/`. May need to extend to serve nested `web/js/...`. Fix before proceeding.

---

### Task 1.10: Manual end-to-end with a real Whoop

This task requires the physical band. No automated test. Capture results in a note.

- [ ] **Step 1: Start dev server**

```bash
./run.sh dash --port 8765
```

- [ ] **Step 2: In Mac Chrome, open `http://localhost:8765/`**

- [ ] **Step 3: Wake the band (tap it), click *Connect Whoop* in the MVP panel**

A native device picker should appear. Select your Whoop.

- [ ] **Step 4: Verify**

- *Status* pill turns green (`connected`)
- *HR* number updates within a few seconds
- *Samples this session* counter increments at ~1 Hz
- Chrome DevTools → Application → IndexedDB → `whoof` → `samples` shows rows accumulating

- [ ] **Step 5: Simulate a drop**

Briefly walk out of BLE range or toggle the band's BLE. Status should change to *reconnecting* and then back to *connected*.

- [ ] **Step 6: Disconnect cleanly**

Click *Disconnect*. The session row in IndexedDB should now have `ended_at` set and `sample_count` matching.

**Acceptance:** ≥ 60 seconds of continuous samples appear in IndexedDB with `heart_rate_bpm` matching what your wrist actually feels. If `heart_rate_bpm` is consistently `null`, suspect a packet-decode bug — re-examine `parser.js` against `parser.py:178-205` byte-for-byte.

---

## Phase 2 — Metrics port

Each task here ports a single Python module to JS. The existing Python tests in `tests/test_*.py` are the porting spec — port the test, port the implementation, run, verify.

Pattern (apply to every task in this phase):
1. Read the Python module and its tests.
2. Port the tests to vitest (translate `assert` to `expect`, `math.isclose` to `toBeCloseTo`, etc.).
3. Port the implementation. Use plain JS — no fancy libs.
4. Run `npm test -- <module>`, verify all pass.

### Task 2.1: HRV (`hrv.js`)

**Files:**
- Create: `web/js/metrics/hrv.js`
- Create: `tests/js/metrics/hrv.test.js`

**Port from:** `whoof/metrics.py:41-110` (`filter_rr`, `rmssd`, `sdnn`, `pnn50`). **Test reference:** `tests/test_metrics.py:12-60`.

- [ ] **Step 1: Read source module + tests**
- [ ] **Step 2: Port the 7 HRV tests to `tests/js/metrics/hrv.test.js`**
- [ ] **Step 3: Run, expect 7 failures**
- [ ] **Step 4: Port `filter_rr`, `rmssd`, `sdnn`, `pnn50` to `web/js/metrics/hrv.js`** as named exports
- [ ] **Step 5: Run, expect 7 passes**

### Task 2.2: Strain (`strain.js`)

**Files:**
- Create: `web/js/metrics/strain.js`
- Create: `tests/js/metrics/strain.test.js`

**Port from:** `whoof/metrics.py` (the `strain_score` family). **Test reference:** `tests/test_metrics.py:63-90` (strain tests).

- [ ] **Step 1-5:** Same pattern.

### Task 2.3: HR zones + calories (`zones.js`)

**Files:**
- Create: `web/js/metrics/zones.js`
- Create: `tests/js/metrics/zones.test.js`

**Port from:** `whoof/zones.py`. **Test reference:** `tests/test_zones.py`.

### Task 2.4: Sleep (`sleep.js`)

**Files:**
- Create: `web/js/metrics/sleep.js`
- Create: `tests/js/metrics/sleep.test.js`

**Port from:** `whoof/sleep.py`. **Test reference:** `tests/test_sleep.py`.

This is the largest port (475 lines of Python). Take it in three sub-steps within the same task:
- Stage classifier first (`classify_stages`), with its tests
- Then need/debt/consistency
- Then respiratory rate

### Task 2.5: Recovery (`recovery.js`)

**Files:**
- Create: `web/js/metrics/recovery.js`
- Create: `tests/js/metrics/recovery.test.js`

**Port from:** `whoof/metrics.py` (recovery z-score + 4-component breakdown). Depends on hrv + sleep + strain (for prior-strain component).

### Task 2.6: Workouts (`workouts.js`)

**Files:**
- Create: `web/js/metrics/workouts.js`
- Create: `tests/js/metrics/workouts.test.js`

**Port from:** `whoof/workouts.py`. **Test reference:** `tests/test_workouts.py`.

### Task 2.7: Rollup orchestrator (`rollup.js`)

**Files:**
- Create: `web/js/metrics/rollup.js`
- Create: `tests/js/metrics/rollup.test.js`

Wires the per-module metrics together to compute one full `daily_metrics` row for a given date, given the relevant sample range.

- [ ] **Step 1: Write a single integration test**

```js
// Seed a day's worth of synthetic samples, call rollupDay(db, '2026-05-20'),
// verify the resulting daily_metrics row has expected shape (non-null avg_hr,
// rmssd_ms, recovery_score, strain_score, etc.).
```

- [ ] **Step 2-4:** Implement, run, verify.

---

## Phase 3 — UI rewire (use real data from IndexedDB)

The v0.2 `web/app.js` (≈29 KB) is currently structured as: tab routing + render functions that `fetch('/api/...')` and write to the DOM. We keep the rendering, swap the data source.

### Task 3.1: Inventory v0.2's fetch calls

- [ ] **Step 1:** `grep -n "fetch(" web/app.js > /tmp/v02-fetches.txt`

Read the list. For each endpoint (e.g. `/api/today`, `/api/sleep`, `/api/recovery`), note the shape of the JSON it returns (read `whoof/dashboard.py` to confirm).

- [ ] **Step 2:** Produce a mapping table in your notes:

```
/api/today      → queries.todayMetrics(db, today)
/api/sleep      → queries.sleepForDate(db, date)
/api/recovery   → queries.recoveryForDate(db, date)
/api/strain     → queries.strainForDate(db, date)
/api/trends     → queries.trendsForMetric(db, metric, days)
/api/overview   → composite of above
/api/profile    → queries.getProfile(db) / putProfile(db, p)
/api/live       → queries.samplesInRange(db, now-5min, now)
/api/workouts   → queries.workoutsRecent(db, days)
/api/status     → derived in-browser from BLE client state + last sample
```

### Task 3.2: Add the missing query helpers

Extend `web/js/data/queries.js` with any helpers the table from 3.1 needs that don't exist yet. TDD each.

### Task 3.3: Refactor `app.js` one tab at a time

Order: Live → Overview → Recovery → Sleep → Strain → Trends. (Live is the smallest and gives immediate visual feedback once Phase 1 BLE works.)

For each tab:
- [ ] **Step 1:** Replace `fetch('/api/X')` with the corresponding query helper.
- [ ] **Step 2:** Adjust field names if the IndexedDB shape differs from the old JSON.
- [ ] **Step 3:** Manual smoke: load `http://localhost:8765/?demo=1`, switch to that tab, confirm it renders.

### Task 3.4: Settings panel — profile form

- [ ] **Step 1:** Add a `<dialog>` or modal in `index.html` for Settings (likely already partially built; look for `#open-settings` handler in `app.js`).
- [ ] **Step 2:** On open: read profile via `getProfile(db)` and populate inputs.
- [ ] **Step 3:** On save: `putProfile(db, fields)` and close.

### Task 3.5: Settings panel — Export / Import JSON

- [ ] **Step 1:** Export — read all stores, serialize as `{ version: 1, samples: [...], sessions: [...], ... }`, trigger download with a Blob link.
- [ ] **Step 2:** Import — file input, parse JSON, validate `version`, clear stores, re-insert.
- [ ] **Step 3:** Round-trip test: vitest test that exports a seeded DB, clears, imports, and verifies counts.

### Task 3.6: Remove MVP panel from `index.html`

The MVP panel from Task 1.9 was a development scaffold. Once the v0.2 Live tab works against IndexedDB, delete the `#mvp-panel` block and the `<script type="module" src="/js/app-mvp.js">` tag. Move the Connect/Disconnect controls into the Live tab.

---

## Phase 4 — Polish

### Task 4.1: Reconnect status pill in Settings or Live tab

Wire the WhoopClient's `state` events to a persistent UI indicator in the sidebar.

### Task 4.2: Port `seed-demo` to JS

**Files:**
- Create: `web/js/dev/seed.js`
- Modify: `web/js/app.js` (detect `?demo=1` query string → call seed before rendering)

Port the synthetic-data generator from `whoof/cli.py` (`cmd_seed_demo`). Hide behind a query string so it isn't accessible in normal flow.

### Task 4.3: Strip Python API + rename

- [ ] **Step 1:** Rename `whoof/dashboard.py` → `whoof/static_server.py`.
- [ ] **Step 2:** Delete every `_handle_api_*` method; keep only the static-file serving (`SimpleHTTPRequestHandler`-like behavior over `web/`).
- [ ] **Step 3:** Update `whoof/cli.py`'s `dash` command to point at the renamed module.
- [ ] **Step 4:** Delete `record`, `rollup`, `scan`, `info`, `battery`, `status`, `seed-demo` commands from `cli.py`.
- [ ] **Step 5:** Verify: `./run.sh dash` still serves the app on `:8765`; no other CLI commands listed in `--help`.

### Task 4.4: README

Rewrite `README.md`:
- Replace "macOS Quick start" with "Mac Chrome quick start" — no `record`, no `rollup` command.
- Explain BLE-in-browser: Chrome (`chrome://flags/#enable-experimental-web-platform-features` if needed), permissions prompt.
- Phone section: install Bluefy, open hosted URL (note hosting is deferred).
- Drop the launchd plist section.
- Keep the BLE protocol section (still accurate).
- Add "Where's the data?" → DevTools → Application → IndexedDB → `whoof`.

### Task 4.5: Final smoke

- [ ] **Step 1:** Fresh Chrome profile, open `http://localhost:8765/`.
- [ ] **Step 2:** Click Connect, record 5 minutes.
- [ ] **Step 3:** Reload page. All historical samples still present.
- [ ] **Step 4:** Manually trigger rollup for today; recovery + strain compute.
- [ ] **Step 5:** Export JSON, clear IndexedDB, import JSON, verify counts match.

---

## Phase 5 — Deferred (not in this plan)

- PWA manifest + service worker (`web/manifest.json`, `web/sw.js`).
- Phone hosting decision + deploy (GitHub Pages / Cloudflare Pages / Vercel).
- Historical sync from band's onboard storage (port the routine in `vendor/whoomp`).
- One-shot importer for existing `data/whoop.db` via SQL.js.

---

## Notes for executing agents

- **No git.** This repo is not initialized. Don't run `git commit` or `git add`. Use `npm test` to verify each step.
- **Pure ES modules.** No bundler. All imports are relative paths ending in `.js`. The browser loads via `<script type="module">`, tests via vitest's native ESM support.
- **Python tests stay.** Don't delete `tests/test_*.py` until the JS equivalents pass and the Phase 4 cleanup happens.
- **Parallelizable.** Tasks 2.1, 2.2, 2.3, 2.6 (HRV, strain, zones, workouts) have no shared state — can be dispatched in parallel with `superpowers:dispatching-parallel-agents`. Tasks 2.4 (sleep), 2.5 (recovery), and 2.7 (rollup) have dependencies, do sequentially.
- **The Whoop "start streaming" command is `CMD_START_REALTIME = 0x03` written as a no-payload framed command** to CHAR_COMMAND. The band then begins emitting 96-byte packets on CHAR_DATA. Confirmed by inspection of `vendor/whoop-reader/whoop_reader/protocol.py:61` and the existing recorder's behavior.
