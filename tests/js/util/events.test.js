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

  it('off (returned disposer) unsubscribes', () => {
    const e = createEmitter();
    const fn = vi.fn();
    const dispose = e.on('x', fn);
    dispose();
    e.emit('x', 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates events by name', () => {
    const e = createEmitter();
    const a = vi.fn(); const b = vi.fn();
    e.on('a', a); e.on('b', b);
    e.emit('a', 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('catches listener errors instead of breaking emit loop', () => {
    const e = createEmitter();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    e.on('x', bad); e.on('x', good);
    expect(() => e.emit('x', 1)).not.toThrow();
    expect(good).toHaveBeenCalledWith(1);
  });
});
