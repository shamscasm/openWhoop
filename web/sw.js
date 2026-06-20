// Service worker for whoof PWA.
// Strategy: network-first for HTML and same-origin JS/CSS (so updates land
// immediately on refresh), cache-first only for static immutable assets
// (fonts, vendor bundles). IndexedDB is always local — no SW handling.

// Bump this version any time the caching strategy or precache list changes
// so old caches are pruned on activate.
const CACHE_NAME = 'whoof-v8';

// Assets to pre-cache on install. Paths are relative to SW scope (/)
const PRECACHE = [
  '/',
  '/styles.css',
  '/vendor/chart.umd.min.js',
  '/vendor/idb.min.js',
];

// ---- Install: pre-cache core assets ----------------------------------------

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE).catch(() => {
      // Non-fatal: some assets may 404 in dev; don't break install.
    })),
  );
});

// ---- Activate: prune old caches --------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ---- Message: support skip-waiting from client ------------------------------

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---- Fetch: network-first for HTML and app code, cache-first for vendor ----

// Paths that are safe to cache-first (immutable vendor bundles, fonts).
const IMMUTABLE_PATHS = [
  '/vendor/',
  '/icons/',
];

function isImmutable(url) {
  return IMMUTABLE_PATHS.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin GETs.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip BLE / WebSocket / API traffic.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML and app code (so design changes land immediately).
  // Falls back to cached copy when offline.
  if (request.destination === 'document' || !isImmutable(url)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Cache-first for immutable vendor assets (fonts, vendor bundles).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        return res;
      });
    }),
  );
});
