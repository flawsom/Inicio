// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

/**
 * The pointer trail is on every route, and there is exactly one of it.
 *
 * "Every section and every page" is a claim about routing, and the state this file was
 * written in is the failure it guards: the trail was mounted by the landing page, so a
 * visitor following the sign-in link watched the cursor change behaviour halfway through
 * arriving, and the console — the part of the product somebody looks at all day — had a
 * different pointer treatment entirely, a labelled ring.
 *
 * The real effect is used, not a mock: jsdom has no canvas, so the test gives the canvas
 * element a context that records what it was asked to draw, which is the same trick
 * `cursor-trail.test.ts` uses. That makes the mount observable from the outside — the trail
 * is the one thing in the app that listens for `pointermove` on `window` (the ambient
 * field's own listener is switched off by the `matchMedia` stub below), so counting those
 * listeners counts trails. One route, one trail, and StrictMode's second mount must not
 * become a second one.
 *
 * Two things this file cannot do, both covered elsewhere. `/` is not mounted here because
 * the landing page is a lazily imported chunk carrying a WebGL scene; `landing.test.tsx`
 * renders it with the renderer mocked to resolve to null, exactly as on a device without
 * WebGL, and the browser pass over the deployment checks it on the real thing. And jsdom
 * applies no stylesheet, so that this canvas is *positioned* as a fixed, click-through
 * layer is asserted against `styles.css` in `shell.test.ts`.
 */
vi.mock('../src/immersive/instrument', () => ({
  createInstrument: async () => null,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * A 2D context that accepts everything and paints nothing.
 *
 * Two things draw into it on these routes — the trail and the ambient light field — and
 * jsdom has neither, so the context answers any method call with a no-op and any property
 * assignment with silence. The gradient objects it hands back are the one shape a caller
 * does more with than call: `addColorStop` has to exist on the returned value.
 */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined };
  const target = {
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    measureText: () => ({ width: 0 }),
  } as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get: (object, property) => (property in object ? object[property] : () => undefined),
    set: (object, property, value) => {
      object[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class StubObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * `(any-pointer: fine)` only. A stylus or a mouse gets the trail; `hover: hover` is false,
 * which is what keeps the ambient field's own pointer listener out of the count — the
 * trail is then the only thing on the page listening for a pointer.
 */
function stubMatchMedia(query: string): boolean {
  return query === '(any-pointer: fine)';
}

let container: HTMLDivElement;
let root: Root;
let added: Array<[string, unknown]>;
let removed: Array<[string, unknown]>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: stubMatchMedia(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  // The trail rests instead of spinning when nothing moves, and "nothing moves" is the
  // state a freshly mounted route is in — but a frame that is queued and never run would
  // leave the assertion about resting measuring this stub. So frames are real, small and
  // synchronous-free: they are queued and run only when a test flushes them.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  added = [];
  removed = [];
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    added.push([type, listener]);
    add(type, listener, options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    removed.push([type, listener]);
    remove(type, listener, options);
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
  // Every read answers 401: that is what a signed-out visitor's session probe gets, and it
  // leaves each route on its signed-out path — the sign-in sheet, the documents, a link
  // that is not usable. The trail is not allowed to depend on any of that being different.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.pushState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pointerListeners = (calls: Array<[string, unknown]>): number =>
  calls.filter(([type]) => type === 'pointermove').length;

/** Mount the app at `path` and let its lazy chunks and their effects settle. */
async function mountAt(path: string): Promise<void> {
  window.history.pushState({}, '', path);
  await act(async () => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
  // A lazy chunk resolves on a microtask and then mounts its own effects, so "settled" is
  // a microtask flush followed by a macrotask one.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every route the router resolves, including the two that carry a token. `/` is absent. */
const ROUTES = [
  '/login',
  '/console',
  '/terms',
  '/privacy',
  '/invite/11111111-1111-1111-1111-111111111111',
  '/collect/11111111-1111-1111-1111-111111111111',
];

describe('the pointer trail, on every route', () => {
  for (const route of ROUTES) {
    it(`is drawn on ${route}, exactly once`, async () => {
      await mountAt(route);
      const canvases = document.querySelectorAll('canvas.cursor-trail');
      expect(canvases.length, `${route} has ${canvases.length} trail canvas(es)`).toBe(1);
      // Decoration, and it says so: nothing to a screen reader, nothing to a click.
      expect(canvases[0]!.getAttribute('aria-hidden')).toBe('true');
      // And it is mounted, not merely rendered: one trail following the pointer, which is
      // what a second StrictMode mount would silently become.
      expect(pointerListeners(added), `${route} mounted ${pointerListeners(added)} trails`).toBe(1);
    });
  }

  it('stops following the pointer when the route goes away', async () => {
    await mountAt('/console');
    expect(pointerListeners(added)).toBe(1);

    // The trail's own listener, by reference. `removeEventListener` is called with other
    // types on these routes too (the shell's cleanup removes a `pointermove` listener it
    // never added when the device has no fine pointer), so counting removals of the type
    // would count somebody else's tidy-up.
    const trail = added.find(([type]) => type === 'pointermove')?.[1];
    const removedTrail = (): number =>
      removed.filter(([type, listener]) => type === 'pointermove' && listener === trail).length;
    expect(removedTrail()).toBe(0);

    const before = pointerListeners(added);
    act(() => root.unmount());
    // Removed by reference, which is the whole reason the effect keeps a named closure: a
    // listener removed by a freshly built handler is a listener that is still there.
    expect(removedTrail()).toBe(1);

    // And a late dynamic import finds a disposed component rather than a canvas nobody
    // owns: nothing new is mounted after the route is gone.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pointerListeners(added)).toBe(before);
  });
});
