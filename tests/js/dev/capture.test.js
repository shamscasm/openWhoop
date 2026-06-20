import { describe, it, expect, beforeEach } from 'vitest';
import { createEmitter } from '../../../web/js/util/events.js';
import {
  startCapture, stopCapture, isCapturing, captureStats,
} from '../../../web/js/dev/capture.js';

// A tiny fake client that only exposes `on()`.
function fakeClient() {
  const e = createEmitter();
  return {
    on: (event, fn) => e.on(event, fn),
    emit: (event, payload) => e.emit(event, payload),
  };
}

beforeEach(async () => {
  // Reset any leftover capture from a prior test.
  if (isCapturing()) await stopCapture();
});

describe('packet capture', () => {
  it('records realtime + event + log rows', async () => {
    const c = fakeClient();
    startCapture(c, { label: 'unit-test' });

    c.emit('sample', { heartRateBpm: 72, rrIntervalsMs: [800], raw: new Uint8Array([1, 2, 3]) });
    c.emit('event', { name: 'WRIST_ON', semantic: 'wristOn', cmd: 9 });
    c.emit('log', 'hello strap');

    const result = await stopCapture();
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.rowCount).toBe(3);
    const lines = result.text.split('\n');
    // 1 meta line + 3 data lines
    expect(lines.length).toBe(4);
    const meta = JSON.parse(lines[0]);
    expect(meta._meta.label).toBe('unit-test');
    expect(meta._meta.rowCount).toBe(3);

    const rows = lines.slice(1).map((l) => JSON.parse(l));
    expect(rows[0].kind).toBe('realtime');
    expect(rows[0].hex).toBe('010203');
    expect(rows[0].decoded.heartRateBpm).toBe(72);
    expect(rows[1].kind).toBe('event');
    expect(rows[1].decoded.semantic).toBe('wristOn');
    expect(rows[2].kind).toBe('log');
    expect(rows[2].decoded.text).toBe('hello strap');
  });

  it('drops Uint8Array fields from decoded JSON (hex carries them)', async () => {
    const c = fakeClient();
    startCapture(c);
    c.emit('sample', { heartRateBpm: 60, raw: new Uint8Array([0xff, 0xee]) });
    const result = await stopCapture();
    const row = JSON.parse(result.text.split('\n')[1]);
    expect(row.decoded.raw).toBeUndefined();
    expect(row.hex).toBe('ffee');
  });

  it('refuses to start a second capture without stopping the first', () => {
    const c = fakeClient();
    startCapture(c);
    expect(() => startCapture(c)).toThrow();
  });

  it('captureStats reports progress mid-capture', () => {
    const c = fakeClient();
    startCapture(c, { label: 'progress' });
    c.emit('sample', { heartRateBpm: 70, raw: new Uint8Array(0) });
    const s = captureStats();
    expect(s.label).toBe('progress');
    expect(s.rows).toBe(1);
  });

  it('stopCapture() returns null when nothing is in flight', async () => {
    expect(await stopCapture()).toBeNull();
  });
});
