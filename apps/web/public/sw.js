/*
 * Inicio service worker — the app shell, and nothing else.
 *
 * The one rule that matters: this worker never stores a response from the API.
 * Survey data is stateful and must be live (SPEC §0.2: nothing is ever mock or
 * stale), so `/api`, `/auth` and `/health` are always passed straight to the
 * network. Offline *answers* are handled by the collection renderer in
 * IndexedDB, where they can be queued and reconciled; a cache here would serve
 * a stale count or, worse, a stale response body.
 *
 * What is cached is the shell: the HTML document and the hashed assets it
 * references. That is what lets a respondent open a survey they visited once and
 * keep filling it in with no signal at all.
 */
const VERSION = 'inicio-shell-v1';
const SHELL = '/';
const DATA_PREFIXES = ['/api', '/auth', '/health'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      const response = await fetch(SHELL, { cache: 'reload' });
      await cache.put(SHELL, response.clone());
      const html = await response.text();
      // Precache the hashed bundles the shell references, so the very first
      // offline visit works rather than only the second.
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await Promise.all(
        assets.map(async (url) => {
          try {
            const asset = await fetch(url, { cache: 'reload' });
            if (asset.ok) await cache.put(url, asset);
          } catch {
            /* a missing asset must not fail the install */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

function isData(url) {
  // Exact, or a real sub-path: `/apiary` is not `/api`.
  return DATA_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept data. A cached API response is a lie about the live data.
  if (isData(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(VERSION);
          await cache.put(SHELL, fresh.clone());
          return fresh;
        } catch {
          // Offline: serve the shell. The renderer reads the cached definition
          // from IndexedDB and keeps working.
          const cached = await caches.match(SHELL);
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(VERSION);
          await cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
  }
});
