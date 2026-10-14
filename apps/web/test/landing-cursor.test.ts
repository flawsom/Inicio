// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCursorTrail, shouldDrawCursorTrail } from '../src/landing-cursor';

/**
 * The pointer trail, and the four things it must not do.
 *
 * The effect this descends from is a well-known snippet, and every claim here is a
 * defect in it rather than a happy path:
 *
 *   1. it keeps `ctx`, `pos` and its trail list in module scope, so two mounts share
 *      one simulation and a second mount draws into a canvas nobody owns;
 *   2. it removes listeners by passing *freshly built* handlers, so nothing is ever
 *      actually removed and the trail survives the page;
 *   3. it re-arms its animation frame unconditionally, so a page being read holds a
 *      core awake for a pointer that is not moving;
 *   4. it sizes its canvas to `window.innerWidth - 20`, which is wrong on a phone,
 *      wrong on a retina screen and leaves a stripe down the right-hand side.
 *
 * A trail that is not mounted is also not drawn, which is the state most of these
 * tests have to reach around: jsdom has no canvas, so the recorder below stands in
 * for the 2D context and jsdom's own `getContext` (which returns null) is the
 * subject of its own case.
 */

interface Recording {
  calls: string[];
  strokeStyle: string;
  lineWidth: number;
  globalCompositeOperation: string;
}

/** A 2D context that records what it was asked to do, and in what state. */
function fakeContext(): Recording & Record<string, unknown> {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    strokeStyle: '',
    lineWidth: 0,
    globalCompositeOperation: '',
    clearRect: record('clearRect'),
    setTransform: record('setTransform'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    stroke: record('stroke'),
    closePath: record('closePath'),
  };
}

/** A canvas with a working context and a real box, which jsdom does not provide. */
function fakeCanvas(context: Recording): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'getContext', { configurable: true, value: () => context });
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  return canvas;
}

function stubMatchMedia(matches: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
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

/** The two queries the effect asks. A pointer device without reduced motion. */
const POINTER_DEVICE = (query: string): boolean => query.includes('any-pointer');

let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];
let observed: Element[] = [];
let disconnected = 0;
let nextFrame = 1;
/**
 * Which id belongs to which queued callback. Without this, `cancelAnimationFrame`
 * can only be *recorded*, and a cancelled frame would sit in `frames` forever - so
 * an assertion about the queue would be measuring this stub rather than the hook.
 */
const liveFrames = new Map<number, FrameRequestCallback>();

class StubResizeObserver {
  observe(element: Element): void {
    observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnected += 1;
  }
}

/** Run every frame that is currently queued, as one tick would. */
function flush(): void {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame(0);
}

function move(clientX: number, clientY: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }));
}

beforeEach(() => {
  frames = [];
  cancelled = [];
  observed = [];
  disconnected = 0;
  nextFrame = 1;
  liveFrames.clear();
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    const id = nextFrame++;
    liveFrames.set(id, frame);
    frames.push(frame);
    return id;
  });
  // Cancellation has to actually take the frame out of the queue: whether a frame
  // is still pending is the whole question the teardown assertions ask.
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.push(id);
    const frame = liveFrames.get(id);
    if (!frame) return;
    liveFrames.delete(id);
    const at = frames.lastIndexOf(frame);
    if (at >= 0) frames.splice(at, 1);
  });
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  stubMatchMedia(POINTER_DEVICE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the pointer trail', () => {
  it('declines to draw at all when the reader asked for less motion', () => {
    stubMatchMedia((query) => query.includes('prefers-reduced-motion'));
    const context = fakeContext();
    const added = vi.spyOn(window, 'addEventListener');

    const trail = mountCursorTrail(fakeCanvas(context));
    move(40, 40);

    expect(shouldDrawCursorTrail()).toBe(false);
    expect(added).not.toHaveBeenCalled();
    expect(context.calls).toEqual([]);
    expect(frames).toEqual([]);
    trail.dispose();
  });

  it('declines on a device with no fine pointer, so a phone wastes nothing on it', () => {
    stubMatchMedia(() => false);
    const context = fakeContext();
    const added = vi.spyOn(window, 'addEventListener');

    const trail = mountCursorTrail(fakeCanvas(context));
    move(40, 40);

    expect(added).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    trail.dispose();
  });

  it('does nothing at all when the canvas has no 2D context', () => {
    // jsdom's own `getContext` returns null, which is also what a browser without
    // canvas support looks like: the page must survive it silently.
    const added = vi.spyOn(window, 'addEventListener');
    const trail = mountCursorTrail(document.createElement('canvas'));
    move(10, 10);

    expect(added).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    trail.dispose();
  });

  it('starts from where the pointer actually is, and paints one warm stroke', () => {
    const context = fakeContext();
    const canvas = fakeCanvas(context);
    const trail = mountCursorTrail(canvas);

    // Springs can only be piled on a pointer that has been seen: no burst at the
    // origin, which is what the original draws before the first move.
    expect(frames).toEqual([]);
    expect(observed).toContain(canvas);

    move(120, 90);
    expect(frames.length).toBeGreaterThan(0);
    flush();

    expect(context.calls).toContain('clearRect');
    expect(context.calls).toContain('quadraticCurveTo');
    expect(context.calls).toContain('stroke');
    /*
     * Normal compositing, deliberately, and this is the assertion that holds it: the
     * page is a dark stage over white sheets, so an additive stroke (`lighter`) is
     * invisible on every sheet below the stage. The trail painted nothing at all
     * across most of the page under the old operation.
     */
    expect(context.globalCompositeOperation).toBe('source-over');
    // And the colour walks within the brand's band rather than through the spectrum.
    const stroke = /^hsla\((\d+), (\d+)%, (\d+)%, ([\d.]+)\)$/.exec(context.strokeStyle);
    expect(stroke, `unexpected strokeStyle ${context.strokeStyle}`).not.toBeNull();
    expect(Number(stroke?.[1])).toBeGreaterThanOrEqual(14);
    expect(Number(stroke?.[1])).toBeLessThanOrEqual(42);
    expect(stroke?.[2]).toBe('86');
    expect(stroke?.[3]).toBe('57');
    expect(stroke?.[4]).toBe('0.34');
    trail.dispose();
  });

  it('thickens over something interactive instead of carrying a label', () => {
    const context = fakeContext();
    const trail = mountCursorTrail(fakeCanvas(context));

    const link = document.createElement('a');
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 60, bubbles: true }));
    flush();
    expect(context.lineWidth).toBe(1.8);
    // Thicker *and* stronger, rather than a label: the hover has to read as a change
    // in the mark itself.
    expect(context.strokeStyle).toMatch(/^hsla\(\d+, 86%, 52%, 0\.5\)$/);

    link.remove();
    trail.dispose();
  });

  it('comes to rest rather than holding a frame open on an idle page', () => {
    const context = fakeContext();
    const trail = mountCursorTrail(fakeCanvas(context));
    move(200, 150);

    let ticks = 0;
    while (frames.length > 0 && ticks < 500) {
      flush();
      ticks += 1;
    }

    expect(frames).toHaveLength(0);
    expect(ticks).toBeLessThan(500);

    // And a moving pointer starts it again, up to the moment it settles once more.
    move(400, 300);
    expect(frames.length).toBeGreaterThan(0);
    trail.dispose();
  });

  it('stops drawing while the tab is hidden, and resumes when it is back', () => {
    const context = fakeContext();
    const trail = mountCursorTrail(fakeCanvas(context));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    move(100, 100);
    expect(frames).toEqual([]);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.length).toBeGreaterThan(0);
    trail.dispose();
  });

  it('removes exactly the listeners it added, by reference, and cancels its frame', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removedWindow = vi.spyOn(window, 'removeEventListener');
    const removedDocument = vi.spyOn(document, 'removeEventListener');

    const trail = mountCursorTrail(fakeCanvas(fakeContext()));
    move(140, 120);
    trail.dispose();

    const pointerAdded = added.mock.calls.filter(([type]) => type === 'pointermove');
    const pointerRemoved = removedWindow.mock.calls.filter(([type]) => type === 'pointermove');
    expect(pointerAdded).toHaveLength(1);
    expect(pointerRemoved).toHaveLength(1);
    // The exact function, not a second one that looks like it: the original passes a
    // freshly built handler and therefore never removes anything.
    expect(pointerRemoved[0]![1]).toBe(pointerAdded[0]![1]);
    expect(removedWindow.mock.calls.some(([type]) => type === 'resize')).toBe(true);
    expect(removedDocument.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(disconnected).toBe(1);

    // A pointer moving after teardown schedules nothing.
    const before = frames.length;
    move(10, 10);
    expect(frames).toHaveLength(before);
  });

  it('leaves nothing running when it is mounted and torn down twice, as StrictMode does', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removedWindow = vi.spyOn(window, 'removeEventListener');

    const first = mountCursorTrail(fakeCanvas(fakeContext()));
    const second = mountCursorTrail(fakeCanvas(fakeContext()));
    move(80, 60);
    first.dispose();
    second.dispose();

    const addedCount = added.mock.calls.filter(([type]) => type === 'pointermove').length;
    const removedCount = removedWindow.mock.calls.filter(([type]) => type === 'pointermove').length;
    expect(addedCount).toBe(2);
    expect(removedCount).toBe(2);
    expect(frames).toHaveLength(0);
  });
});
