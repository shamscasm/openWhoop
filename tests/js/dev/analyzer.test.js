import { describe, it, expect } from 'vitest';
import {
  parseCaptureFile, byteStats, compareCaptures, findCounters,
  hexToBytes, summarize,
} from '../../../web/js/dev/analyzer.js';

function makeCaptureText(meta, rows) {
  return [JSON.stringify({ _meta: meta }), ...rows.map(r => JSON.stringify(r))].join('\n');
}

describe('parseCaptureFile', () => {
  it('separates meta from rows', () => {
    const text = makeCaptureText(
      { label: 'walking', durationMs: 1000 },
      [
        { tsMs: 0, kind: 'realtime', hex: 'aa00' },
        { tsMs: 30, kind: 'event', hex: null, decoded: { semantic: 'wristOn' } },
      ]
    );
    const out = parseCaptureFile(text);
    expect(out.meta.label).toBe('walking');
    expect(out.rows).toHaveLength(2);
  });

  it('skips malformed lines silently', () => {
    const text = 'not json\n' + JSON.stringify({ _meta: { label: 'x' } }) + '\n' + JSON.stringify({ kind: 'realtime', hex: 'aa' });
    const out = parseCaptureFile(text);
    expect(out.meta.label).toBe('x');
    expect(out.rows).toHaveLength(1);
  });
});

describe('hexToBytes', () => {
  it('decodes basic hex', () => {
    expect(Array.from(hexToBytes('00ff10'))).toEqual([0, 255, 16]);
  });
});

describe('byteStats', () => {
  it('flags constant bytes vs varying bytes', () => {
    // 4 packets, byte 0 always 0xAA, byte 1 varies, byte 2 always 0x40
    const rows = [
      { kind: 'realtime', hex: 'aa1040' },
      { kind: 'realtime', hex: 'aa2040' },
      { kind: 'realtime', hex: 'aa3040' },
      { kind: 'realtime', hex: 'aa4040' },
    ];
    const stats = byteStats(rows, 'realtime');
    expect(stats[0].unique).toBe(1);    // constant 0xAA
    expect(stats[0].stddev).toBe(0);
    expect(stats[1].unique).toBe(4);    // 4 distinct values
    expect(stats[1].stddev).toBeGreaterThan(0);
    expect(stats[2].unique).toBe(1);    // constant 0x40
  });

  it('ignores non-matching kinds', () => {
    const rows = [
      { kind: 'realtime', hex: 'aa' },
      { kind: 'event', hex: 'bb' },
    ];
    const realtimeStats = byteStats(rows, 'realtime');
    expect(realtimeStats).toHaveLength(1);
    expect(realtimeStats[0].min).toBe(0xaa);
  });
});

describe('compareCaptures', () => {
  it('identifies offsets that differ between two captures', () => {
    // Capture A: byte 5 = 60 (rest HR)
    // Capture B: byte 5 = 150 (workout HR)
    const a = byteStats(Array.from({ length: 4 }).map(() => ({ kind: 'realtime', hex: '00000000003c00' })), 'realtime');
    const b = byteStats(Array.from({ length: 4 }).map(() => ({ kind: 'realtime', hex: '00000000009600' })), 'realtime');
    const diffs = compareCaptures(a, b);
    const offset5 = diffs.find(d => d.offset === 5);
    expect(offset5).toBeDefined();
    expect(offset5.deltaMean).toBeCloseTo(150 - 60, 0);
  });
});

describe('findCounters', () => {
  it('detects a monotonic sequence byte', () => {
    const rows = [
      { kind: 'realtime', hex: '00ff00' },
      { kind: 'realtime', hex: '01ff00' },
      { kind: 'realtime', hex: '02ff00' },
      { kind: 'realtime', hex: '03ff00' },
    ];
    const counters = findCounters(rows, 'realtime');
    const c0 = counters.find(c => c.offset === 0);
    expect(c0).toBeDefined();
    expect(c0.avgDelta).toBeCloseTo(1, 1);
  });

  it('detects counter wraparound 255 → 0', () => {
    const rows = [
      { kind: 'realtime', hex: 'fe' },
      { kind: 'realtime', hex: 'ff' },
      { kind: 'realtime', hex: '00' },
      { kind: 'realtime', hex: '01' },
    ];
    const counters = findCounters(rows, 'realtime');
    expect(counters.find(c => c.offset === 0)).toBeDefined();
  });
});

describe('summarize', () => {
  it('counts rows per kind', () => {
    const text = makeCaptureText(
      { label: 'test', durationMs: 5000 },
      [
        { kind: 'realtime', hex: 'aabb' },
        { kind: 'realtime', hex: 'ccdd' },
        { kind: 'event', hex: null },
      ]
    );
    const out = summarize(parseCaptureFile(text));
    expect(out.label).toBe('test');
    expect(out.byKind.realtime).toBe(2);
    expect(out.byKind.event).toBe(1);
    expect(out.totalBytes).toBe(4);
  });
});
