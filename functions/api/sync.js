// Pages Function backing E2E-encrypted cross-device sync.
//
// The browser derives an AES-GCM key from the user's passphrase and encrypts
// the whole snapshot BEFORE upload, so this endpoint only ever stores and
// serves opaque ciphertext — Cloudflare (and this code) cannot read the data.
//
// Auth is capability-based: the bearer token IS the syncId (256-bit random,
// hex). It also namespaces the object key, so it doubles as the tenant id.
// The app calls `/api/sync` relative to its own origin, so every request is
// same-origin — no CORS, no wildcard Allow-Origin (avoids the open-data class
// of bug). Cross-origin callers are blocked by the browser by default.
//
// Concurrency: clients pull-before-push and send the prior ETag as If-Match.
// A stale push gets 412 and the client re-pulls/re-merges. head()+compare has
// a tiny TOCTOU window, acceptable for a personal 1–few-device tool.

const SYNC_ID_RE = /^[a-f0-9]{64}$/;
const MAX_BODY = 25 * 1024 * 1024; // 25 MB ciphertext cap

function syncIdFrom(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}

const keyFor = (syncId) => `sync/${syncId}/snapshot`;

export async function onRequestGet({ request, env }) {
  const syncId = syncIdFrom(request);
  if (!syncId) return new Response('unauthorized', { status: 401 });

  const obj = await env.SYNC.get(keyFor(syncId));
  if (!obj) return new Response(null, { status: 404 });

  const headers = new Headers();
  headers.set('ETag', obj.httpEtag);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Cache-Control', 'no-store');
  return new Response(obj.body, { status: 200, headers });
}

export async function onRequestPut({ request, env }) {
  const syncId = syncIdFrom(request);
  if (!syncId) return new Response('unauthorized', { status: 401 });

  const key = keyFor(syncId);
  const ifMatch = request.headers.get('If-Match');         // prior ETag (update)
  const ifNoneMatch = request.headers.get('If-None-Match'); // '*' = create-only
  const current = await env.SYNC.head(key);

  if (ifNoneMatch === '*' && current) {
    return new Response('exists', { status: 412 });
  }
  if (ifMatch && (!current || current.httpEtag !== ifMatch)) {
    return new Response('etag mismatch', { status: 412 });
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return new Response('empty', { status: 400 });
  if (buf.byteLength > MAX_BODY) return new Response('too large', { status: 413 });

  const put = await env.SYNC.put(key, buf, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  const headers = new Headers();
  headers.set('ETag', put.httpEtag);
  return new Response(null, { status: 204, headers });
}

export async function onRequestDelete({ request, env }) {
  const syncId = syncIdFrom(request);
  if (!syncId) return new Response('unauthorized', { status: 401 });
  await env.SYNC.delete(keyFor(syncId));
  return new Response(null, { status: 204 });
}
