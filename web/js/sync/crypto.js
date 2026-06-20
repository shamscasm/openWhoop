// End-to-end sync crypto. Browser-side only, WebCrypto, zero deps.
//
// The whole point: the snapshot is encrypted here, in the browser, BEFORE it
// ever reaches the network. The server (functions/api/sync.js) stores only
// opaque ciphertext, so Cloudflare cannot read the user's biometrics.
//
//   syncId — 256-bit capability id (hex). Doubles as the KDF salt, the R2
//            tenant key, and the bearer token. NOT what protects the data —
//            the passphrase is. Treat it as a low-secrecy address.
//   encKey — AES-GCM-256, derived from passphrase + syncId via PBKDF2-SHA-256.
//   blob   — iv(12) ‖ ciphertext+tag. Self-describing; decrypt needs only key.
//
// Lose the passphrase = lose the data. There is no recovery path by design.

const KDF_ITERATIONS = 600_000;
const IV_BYTES = 12;
const SYNC_ID_RE = /^[a-f0-9]{64}$/;

const subtle = () => globalThis.crypto.subtle;

export function generateSyncId() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// passphrase + syncId → non-extractable AES-GCM-256 key.
export async function deriveKey(passphrase, syncId) {
  if (!passphrase) throw new Error('passphrase required');
  if (!SYNC_ID_RE.test(syncId)) throw new Error('invalid syncId');
  const baseKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(syncId), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Uint8Array plaintext → Uint8Array(iv ‖ ciphertext+tag).
export async function encryptBytes(key, plaintext) {
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const blob = new Uint8Array(IV_BYTES + ct.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ct), IV_BYTES);
  return blob;
}

// Uint8Array|ArrayBuffer(iv ‖ ciphertext) → Uint8Array plaintext.
// Throws on wrong key, wrong syncId, or tampered bytes (GCM auth failure).
export async function decryptBytes(key, blob) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (b.byteLength <= IV_BYTES) throw new Error('blob too short');
  const iv = b.subarray(0, IV_BYTES);
  const ct = b.subarray(IV_BYTES);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

export async function encryptJSON(key, obj) {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(obj)));
}

export async function decryptJSON(key, blob) {
  const pt = await decryptBytes(key, blob);
  return JSON.parse(new TextDecoder().decode(pt));
}
