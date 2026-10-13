// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAmbientField } from '../src/immersive/ambient';

/**
 * The ambient field, with a canvas that records what it was asked to draw.
 *
 * This is the part of the immersive shell that cannot be seen in a test and cannot
 * be seen by whoever wrote it either, so the recording is the verification: that a
 * frame really is painted, that the nothing-under-WebGL path returns nothing rather
 * than throwing, that a hidden tab stops drawing, and that scrolling genuinely
 * rearranges the structure instead of only changing a number. A test that asserted
 * "it returned an object" would pass against a module that never drew a pixel.
 */

interface Call {
  name: string;
  args: number[];
}

class RecordingContext {
  readonly calls: Call[] = [];
  lineWidth = 1;
  strokeStyle: unknown = '';
  fillStyle: unknown = '';
  private gradient = { addColorStop: (): void => undefined };

  private record(name: string, args: number[]): void {
    this.calls.push({ name, args });
  }

  clearRect(...args: number[]): void { this.record('clearRect', args); }
  fillRect(...args: number[]): void { this.record('fillRect', args); }
  beginPath(): void { this.record('beginPath', []); }
  moveTo(...args: number[]): void { this.record('moveTo', args); }
  lineTo(...args: number[]): void { this.record('lineTo', args); }
  arc(...args: number[]): void { this.record('arc', args); }
  stroke(): void { this.record('stroke', []); }
  fill(): void { this.record('fill', []); }
  setTransform(...args: number[]): void { this.record('setTransform', args); }
  createRadialGradient(): { addColorStop: () => void } { return this.gradient; }

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  /** Every arc's centre, so two frames can be compared for structure. */
  nodePositions(): string {
    return this.calls
      .filter((call) => call.name === 'arc')
      .map((call) => `${call.args[0].toFixed(2)},${call.args[1].toFixed(2)}`)
      .join(' ');
  }

  reset(): void {
    this.calls.length = 0;
  }
}

let context: RecordingContext;

function sizedCanvas(width = 1280, height = 800): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
  return canvas;
}

/** Let `n` animation frames pass, so a scheduled loop actually runs. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    const step = (): void => {
      seen += 1;
      if (seen >= n) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

beforeEach(() => {
  context = new RecordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the ambient field', () => {
  it('paints a frame rather than only reporting that it exists', () => {
    const field = createAmbientField(sizedCanvas(), { quality: 'high', reducedMotion: false });
    expect(field).not.toBeNull();

    // One synchronous frame at construction: the first paint must not be an empty
    // screen waiting for a callback.
    expect(context.count('clearRect')).toBeGreaterThan(0);
    expect(context.count('fillRect')).toBeGreaterThan(0);
    expect(context.count('arc')).toBeGreaterThan(50);
    expect(context.count('stroke')).toBeGreaterThan(0);
    field?.dispose();
  });

  it('is complete when there is no 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(createAmbientField(sizedCanvas(), { quality: 'high', reducedMotion: false })).toBeNull();
  });

  it('keeps drawing while active and stops the moment it is not', async () => {
    const field = createAmbientField(sizedCanvas(), { quality: 'high', reducedMotion: false });
    expect(field).not.toBeNull();

    await frames(2);
    const running = context.count('clearRect');
    expect(running).toBeGreaterThan(1);

    field?.setActive(false);
    const stopped = context.count('clearRect');
    await frames(4);
    expect(context.count('clearRect')).toBe(stopped);

    field?.setActive(true);
    await frames(2);
    expect(context.count('clearRect')).toBeGreaterThan(stopped);
    field?.dispose();
  });

  it('stops touching the canvas after dispose', async () => {
    const field = createAmbientField(sizedCanvas(), { quality: 'high', reducedMotion: false });
    await frames(2);
    field?.dispose();

    const afterDispose = context.calls.length;
    field?.setActive(true);
    field?.setProgress(0.5);
    field?.setPointer(0.4, 0.2);
    field?.resize();
    await frames(4);
    expect(context.calls.length).toBe(afterDispose);
  });

  it('rearranges the structure as the page is scrolled', () => {
    const folded = createAmbientField(sizedCanvas(), { quality: 'low', reducedMotion: true });
    folded?.setProgress(0);
    const atTop = context.nodePositions();

    // Reduced motion draws one frame per progress change and never starts a loop,
    // which is also what makes the two arrangements comparable in a test.
    context.reset();
    folded?.setProgress(1);
    const atBottom = context.nodePositions();

    expect(atTop.length).toBeGreaterThan(0);
    expect(atBottom.length).toBeGreaterThan(0);
    expect(atBottom).not.toBe(atTop);
    folded?.dispose();
  });

  it('does not start a loop under reduced motion', async () => {
    const field = createAmbientField(sizedCanvas(), { quality: 'low', reducedMotion: true });
    const painted = context.count('clearRect');
    await frames(3);
    expect(context.count('clearRect')).toBe(painted);
    field?.dispose();
  });

  it('draws fewer nodes on the cheap tier', () => {
    const full = createAmbientField(sizedCanvas(), { quality: 'high', reducedMotion: true });
    const high = context.count('arc');
    full?.dispose();
    context.reset();

    const cheap = createAmbientField(sizedCanvas(), { quality: 'low', reducedMotion: true });
    const low = context.count('arc');
    cheap?.dispose();

    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
  });
});
