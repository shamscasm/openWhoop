import { describe, it, expect, beforeEach } from 'vitest';
import {
  announceConnected, announceDisconnected, isAnotherTabConnected, onConflict,
} from '../../../web/js/util/multitab.js';

beforeEach(() => {
  announceDisconnected();
});

describe('multitab coordinator', () => {
  it('returns false when no other tab responds (jsdom has no BroadcastChannel)', async () => {
    // jsdom typically doesn't ship BroadcastChannel — that's a feature for
    // this test. The module must gracefully degrade.
    const out = await isAnotherTabConnected(50);
    expect(out).toBe(false);
  });

  it('announce/disconnect functions never throw', () => {
    expect(() => announceConnected()).not.toThrow();
    expect(() => announceDisconnected()).not.toThrow();
  });

  it('onConflict returns an unsubscribe function', () => {
    const off = onConflict(() => {});
    expect(typeof off).toBe('function');
    off();
  });
});
