import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The service worker, exercised for real.
 *
 * `public/sw.js` is plain JavaScript talking to the service-worker globals, so it
 * is loaded into a fresh VM context with a stub `self`, a stub Cache Storage and
 * a controllable `fetch`. That means the routing decisions — which requests are
 * cached, which are passed straight through — are tested rather than asserted in
 * a comment. The one that matters most: an API response must never be served
 * from a cache, because a cached survey count is a lie.
 */

const SHELL_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/app-abc.js"></script>' +
  '<link rel="stylesheet" href="/assets/app-abc.css"></head><body></body></html>';

const ORIGIN = 'https://app.test';
const ASSET_URLS = ['/assets/app-abc.js', '/assets/app-abc.css'];

interface Worker {
  fire: (type: string, event: Record<string, unknown>) => Promise<void>;
  dispatchFetch: (url: string, mode?: string, method?: string) => Promise<Response | null>;
  cached: Map<string, Response>;
  calls: string[];
}

function loadWorker(handler: (url: string) => Response): Worker {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const cached = new Map<string, Response>();
  const cacheNames = new Set<string>();
  const calls: string[] = [];

  const rawUrl = (input: string | { url: string }): string => (typeof input === 'string' ? input : input.url);
  // The real Cache Storage resolves a request URL against the worker's origin, so
  // a relative '/assets/x.js' and an absolute one are the same entry. This stub
  // does the same, or it would report misses the browser never has.
  const key = (input: string | { url: string }): string => {
    const raw = rawUrl(input);
    return raw.startsWith('http') ? raw : `${ORIGIN}${raw}`;
  };

  const caches = {
    open: async (name: string) => {
      cacheNames.add(name);
      return {
        put: async (input: string | { url: string }, value: Response) => {
          cached.set(key(input), value);
        },
        match: async (input: string | { url: string }) => cached.get(key(input)),
      };
    },
    match: async (input: string | { url: string }) => cached.get(key(input)),
    keys: async () => [...cacheNames],
    delete: async (name: string) => {
      cacheNames.delete(name);
      return true;
    },
  };

  const self = {
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      listeners.set(type, fn);
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    location: { origin: 'https://app.test' },
  };

  const fetchImpl = async (input: string | { url: string }): Promise<Response> => {
    const url = rawUrl(input);
    calls.push(url);
    // Handlers think in paths; the worker asks for both relative and absolute URLs.
    return handler(url.startsWith('http') ? new URL(url).pathname : url);
  };

  runInNewContext(source, { self, caches, fetch: fetchImpl, Response, URL, console, Promise, JSON, Error });

  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const listener = listeners.get(type);
    if (!listener) throw new Error(`no ${type} listener registered`);
    const held: { promise: Promise<unknown> | null } = { promise: null };
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => (held.promise = promise) });
    if (held.promise) await held.promise;
  };

  const dispatchFetch = async (url: string, mode = 'cors', method = 'GET'): Promise<Response | null> => {
    const listener = listeners.get('fetch');
    if (!listener) throw new Error('no fetch listener registered');
    const held: { promise: Promise<Response> | null } = { promise: null };
    listener({
      request: { method, url, mode },
      respondWith: (promise: Promise<Response>) => (held.promise = promise),
    });
    return held.promise ? held.promise : null;
  };

  return { fire, dispatchFetch, cached, calls };
}

function online(): Worker {
  return loadWorker((url) => {
    if (url === '/') return new Response(SHELL_HTML, { status: 200 });
    if (url.startsWith('/assets/')) return new Response('// asset', { status: 200 });
    return new Response('missing', { status: 404 });
  });
}

describe('service worker routing', () => {
  it('precaches the shell and the assets it references at install time', async () => {
    const worker = online();
    await worker.fire('install', {});
    expect([...worker.cached.keys()].sort()).toEqual([`${ORIGIN}/`, ...ASSET_URLS.map((a) => `${ORIGIN}${a}`)].sort());
  });

  it('never intercepts a data request, whatever the method', async () => {
    const worker = online();
    await worker.fire('install', {});
    const before = worker.calls.length;
    for (const url of [
      'https://app.test/api/v1/collect/token',
      'https://app.test/api/v1/forms/1/analytics',
      'https://app.test/auth/me',
      'https://app.test/health',
    ]) {
      expect(await worker.dispatchFetch(url), url).toBeNull();
    }
    expect(await worker.dispatchFetch('https://app.test/api/v1/collect/token', 'cors', 'POST')).toBeNull();
    // …and the worker did not even fetch them itself: the browser goes direct,
    // so nothing there can ever be served stale.
    expect(worker.calls.length).toBe(before);
  });

  it('serves a navigation from the network, and keeps the shell fresh for next time', async () => {
    const fresh = '<!doctype html><html><body>new deploy</body></html>';
    const worker = loadWorker((url) => {
      if (url === '/') return new Response(SHELL_HTML, { status: 200 });
      if (url === '/collect/token') return new Response(fresh, { status: 200 });
      return new Response('// asset', { status: 200 });
    });
    await worker.fire('install', {});
    const response = await worker.dispatchFetch('https://app.test/collect/token', 'navigate');
    expect(await response!.text()).toBe(fresh);
    expect(await worker.cached.get(`${ORIGIN}/`)!.text()).toBe(fresh);
  });

  it('serves the cached shell when a navigation cannot reach the server', async () => {
    const worker = loadWorker((url) => {
      if (url === '/') return new Response(SHELL_HTML, { status: 200 });
      if (url.startsWith('/assets/')) return new Response('// asset', { status: 200 });
      throw new Error('offline');
    });
    await worker.fire('install', {});
    const response = await worker.dispatchFetch('https://app.test/collect/token', 'navigate');
    expect(await response!.text()).toBe(SHELL_HTML);
  });

  it('serves a hashed asset from the cache without touching the network', async () => {
    const worker = loadWorker((url) => {
      if (url === '/') return new Response(SHELL_HTML, { status: 200 });
      if (url.startsWith('/assets/')) return new Response('// asset', { status: 200 });
      throw new Error('offline');
    });
    await worker.fire('install', {});
    const before = worker.calls.length;
    const response = await worker.dispatchFetch('https://app.test/assets/app-abc.js');
    expect(response).not.toBeNull();
    expect(worker.calls.length).toBe(before);
  });

  it('ignores another origin entirely', async () => {
    const worker = online();
    await worker.fire('install', {});
    expect(await worker.dispatchFetch('https://someone-else.test/api/v1/x', 'navigate')).toBeNull();
  });
});
