import { describe, it, expect } from 'vitest';
import { localDateKey, isoUtcNow, startOfLocalDay, endOfLocalDay } from '../../../web/js/util/time.js';

describe('localDateKey', () => {
  it('returns YYYY-MM-DD for a Date', () => {
    expect(localDateKey(new Date('2026-05-20T14:30:00'))).toBe('2026-05-20');
  });
  it('pads month and day with zeros', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('isoUtcNow', () => {
  it('returns parseable ISO string ending in Z', () => {
    const s = isoUtcNow();
    expect(s.endsWith('Z')).toBe(true);
    expect(Number.isFinite(Date.parse(s))).toBe(true);
  });
});

describe('startOfLocalDay / endOfLocalDay', () => {
  it('startOfLocalDay zeroes the time portion', () => {
    const d = startOfLocalDay(new Date(2026, 4, 20, 14, 30));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
  it('endOfLocalDay returns last millisecond', () => {
    const d = endOfLocalDay(new Date(2026, 4, 20, 8, 0));
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });
});
