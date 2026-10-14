// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorTrail, wantsCursorTrail } from '../src/App';

/**
 * The trail is not downloaded by a device that is never going to see it.
 *
 * The claim is in the component's own comment and in the README's budget table — the
 * decoration on every route is a lazy chunk precisely so the phone, which has no fine
 * pointer and is the device least able to afford the frames, pays nothing for it. A
 * browser pass over the deployment found that claim to be false in the least visible way:
 * `import()` ran wherever the canvas was rendered, the module was fetched and evaluated,
 * and then `mountCursorTrail` returned a no-op handle because the pointer is a finger.
 * The gate is now before the fetch, and this file holds it there.
 *
 * The instrument is the module itself. `vi.mock` replaces `./cursor-trail` with a factory
 * that counts its own evaluation — a dynamic `import()` of a mocked module runs the
 * factory, and nothing else does — so "was it downloaded?" is an integer rather than a
 * claim about bundling. `mountCursorTrail` is counted separately, so a factory that ran
 * cannot be mistaken for a trail that mounted.
 *
 * `/` is absent for the reason it is absent from `cursor-trail-everywhere.test.tsx`: the
 * route is what mounts it, not the chunk, and the browser pass covers the landing page.
 */

const trail = vi.hoisted(() => ({ downloaded: 0, mounted: 0 }));

vi.mock('../src/cursor-trail', () => {
  trail.downloaded += 1;
  return {
    shouldDrawCursorTrail: () => true,
    mountCursorTrail: () => {
      trail.mounted += 1;
      return { dispose: () => undefined };
    },
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** `(any-pointer: fine)` and `(prefers-reduced-motion: reduce)`, and nothing else. */
function stubMedia({ fine, reduce }: { fine: boolean; reduce: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(any-pointer: fine)' ? fine : query === '(prefers-reduced-motion: reduce)' ? reduce : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  trail.downloaded = 0;
  trail.mounted = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mount the canvas at `path` and let a dynamic import resolve, which is a microtask. */
async function mountTheCanvas(): Promise<void> {
  await act(async () => {
    root.render(<CursorTrail />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('the trail, on a device that will draw it', () => {
  beforeEach(() => stubMedia({ fine: true, reduce: false }));

  it('downloads the chunk once, and mounts it once', async () => {
    // A canvas is in the document either way: the point is which of the two happens next.
    expect(document.querySelectorAll('canvas.cursor-trail').length).toBe(0);
    await mountTheCanvas();
    expect(document.querySelectorAll('canvas.cursor-trail').length).toBe(1);
    expect(trail.downloaded).toBe(1);
    expect(trail.mounted).toBe(1);
  });

  it('says yes to the same two questions the chunk asks itself', () => {
    expect(wantsCursorTrail()).toBe(true);
  });
});

describe('the trail, on a device that would not', () => {
  it('is not downloaded by a finger', async () => {
    stubMedia({ fine: false, reduce: false });
    expect(wantsCursorTrail()).toBe(false);
    await mountTheCanvas();
    // The canvas is still in the DOM — it is the styled, click-through, hidden layer —
    // and nothing fetched a module to put pixels in it.
    expect(document.querySelectorAll('canvas.cursor-trail').length).toBe(1);
    expect(trail.downloaded, 'the chunk was fetched on a device with no fine pointer').toBe(0);
    expect(trail.mounted).toBe(0);
  });

  it('is not downloaded by a reader who asked for less motion', async () => {
    stubMedia({ fine: true, reduce: true });
    expect(wantsCursorTrail()).toBe(false);
    await mountTheCanvas();
    expect(trail.downloaded, 'the chunk was fetched under prefers-reduced-motion').toBe(0);
    expect(trail.mounted).toBe(0);
  });

  it('is not downloaded by a browser that cannot answer the question at all', () => {
    // No `matchMedia` is not a hypothetical: it is a very old browser and every
    // non-browser renderer, and the answer to "should this animate?" is no.
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
    expect(wantsCursorTrail()).toBe(false);
  });
});
