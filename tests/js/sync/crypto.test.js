// @vitest-environment node
// Runs under node (not jsdom) so globalThis.crypto.subtle is the real WebCrypto.
import { describe, it, expect } from 'vitest';
import {
  generateSyncId, bytesToHex, hexToBytes,
  deriveKey, encryptBytes, decryptBytes, encryptJSON, decryptJSON,
} from '../../../web/js/sync/crypto.js';

const PASS = 'correct horse battery staple';
const OTHER = 'Tr0ubador&3';

describe('syncId', () => {
  it('is 64 lowercase hex chars', () => {
    expect(generateSyncId()).toMatch(/^[a-f0-9]{64}$/);
  });
  it('is unique per call', () => {
    expect(generateSyncId()).not.toBe(generateSyncId());
  });
});

describe('hex codec', () => {
  it('round-trips arbitrary bytes', () => {
    const b = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    expect(Array.from(hexToBytes(bytesToHex(b)))).toEqual(Array.from(b));
  });
  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });
});

describe('deriveKey', () => {
  it('rejects empty passphrase', async () => {
    await expect(deriveKey('', generateSyncId())).rejects.toThrow(/passphrase/);
  });
  it('rejects malformed syncId', async () => {
    await expect(deriveKey(PASS, 'not-hex')).rejects.toThrow(/syncId/);
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('recovers exact bytes', async () => {
    const id = generateSyncId();
    const key = await deriveKey(PASS, id);
    const pt = new TextEncoder().encode('heart rate variability 42ms');
    const back = await decryptBytes(key, await encryptBytes(key, pt));
    expect(new TextDecoder().decode(back)).toBe('heart rate variability 42ms');
  });

  it('round-trips a JSON snapshot', async () => {
    const id = generateSyncId();
    const key = await deriveKey(PASS, id);
    const snap = { v: 1, samples: [{ ts: 1, hr: 60 }], profile: { age: 30 } };
    expect(await decryptJSON(key, await encryptJSON(key, snap))).toEqual(snap);
  });

  it('uses a fresh IV each call (ciphertext differs for same input)', async () => {
    const id = generateSyncId();
    const key = await deriveKey(PASS, id);
    const pt = new TextEncoder().encode('same plaintext');
    const a = await encryptBytes(key, pt);
    const b = await encryptBytes(key, pt);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b)); // IV (first 12 bytes) differs
  });
});

describe('confidentiality (load-bearing — a no-op cipher would fail these)', () => {
  it('wrong passphrase cannot decrypt', async () => {
    const id = generateSyncId();
    const blob = await encryptBytes(await deriveKey(PASS, id), new Uint8Array([1, 2, 3]));
    const wrong = await deriveKey(OTHER, id);
    await expect(decryptBytes(wrong, blob)).rejects.toThrow();
  });

  it('wrong syncId (salt) cannot decrypt', async () => {
    const blob = await encryptBytes(await deriveKey(PASS, generateSyncId()), new Uint8Array([1, 2, 3]));
    const wrong = await deriveKey(PASS, generateSyncId());
    await expect(decryptBytes(wrong, blob)).rejects.toThrow();
  });

  it('tampered ciphertext is rejected (GCM auth)', async () => {
    const id = generateSyncId();
    const key = await deriveKey(PASS, id);
    const blob = await encryptBytes(key, new Uint8Array([9, 9, 9, 9]));
    blob[blob.length - 1] ^= 0x01; // flip a tag bit
    await expect(decryptBytes(key, blob)).rejects.toThrow();
  });

  it('rejects a too-short blob', async () => {
    const key = await deriveKey(PASS, generateSyncId());
    await expect(decryptBytes(key, new Uint8Array(5))).rejects.toThrow(/short/);
  });
});
