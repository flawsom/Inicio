// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveLabel, useLive } from '../src/App';

/**
 * The console's live read, which is where the poll was removed.
 *
 * The claim in the README is specific and falsifiable: a screen refetches when the
 * server says its aggregate moved, and the interval *does not run at all* while the
 * stream is up. Both halves need proving. A test that only asserted "a push causes
 * a refetch" would pass against code that also kept polling every five seconds,
 * which is the exact waste this replaced, so the timer is asserted to be silent by
 * advancing the clock past several intervals and watching the request count not move.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface FakeEvent {
  data: string;
}

class FakeSource {
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  static latest: FakeSource | null = null;

  constructor(readonly url: string) {
    FakeSource.latest = this;
  }

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  emit(name: string, payload: unknown): void {
    const event: FakeEvent = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

let counter = 0;
const nextFormId = (): string => `console-form-${(counter += 1)}`;

let container: HTMLDivElement;
let root: Root;
let requests: number;

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeSource.latest = null;
  vi.stubGlobal('EventSource', FakeSource as unknown as typeof EventSource);
  requests = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A component whose only job is to exercise the hook. */
function Harness({ formId, fallbackMs }: { formId: string | null; fallbackMs: number }): JSX.Element {
  const read = useLive(
    async () => {
      requests += 1;
      return { ok: true };
    },
    { formId, aggregate: 'responses', fallbackMs, deps: [] },
  );
  return <span>{liveLabel(read.status, read.live, fallbackMs)}</span>;
}

async function mount(formId: string | null, fallbackMs = 5_000): Promise<void> {
  await act(async () => {
    root.render(<Harness formId={formId} fallbackMs={fallbackMs} />);
    await Promise.resolve();
  });
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

describe('the console live read', () => {
  it('refetches when the server says its aggregate moved, and not when another one did', async () => {
    await mount(nextFormId());
    expect(requests).toBe(1);

    const source = FakeSource.latest;
    expect(source).not.toBeNull();
    await act(async () => {
      source?.emit('ready', {});
    });

    // One frame is what the client waits before it coalesces a burst.
    await advance(32);
    expect(requests).toBe(1);

    await act(async () => {
      source?.emit('change', { aggregates: ['responses'] });
    });
    await advance(32);
    expect(requests).toBe(2);

    // `links` moving does not invalidate the responses table, so it must not read.
    await act(async () => {
      source?.emit('change', { aggregates: ['links', 'versions'] });
    });
    await advance(32);
    expect(requests).toBe(2);

    // Two events naming the same aggregate inside one frame are one read.
    await act(async () => {
      source?.emit('change', { aggregates: ['responses'] });
      source?.emit('change', { aggregates: ['responses'] });
    });
    await advance(32);
    expect(requests).toBe(3);
  });

  it('does not poll while the stream is live', async () => {
    await mount(nextFormId(), 5_000);
    const source = FakeSource.latest;
    await act(async () => {
      source?.emit('ready', {});
    });
    expect(container.textContent).toContain('pushed by the server');

    // A minute of clock: twelve intervals that the old code would have spent
    // querying a form that had not changed.
    await advance(60_000);
    expect(requests).toBe(1);
  });

  it('falls back to the timer when the stream has not opened, and says so', async () => {
    await mount(nextFormId(), 5_000);
    // The stream exists but has not said `ready`, which is the honest
    // "connecting" state rather than a claim that the screen is live.
    expect(container.textContent).toContain('connecting');

    await advance(5_000);
    expect(requests).toBe(2);
    await advance(5_000);
    expect(requests).toBe(3);
    expect(container.textContent).toContain('refreshing every 5s');
  });

  it('says in words what the connection is, in each of its three states', () => {
    expect(liveLabel('live', true, 5_000)).toContain('pushed by the server');
    expect(liveLabel('connecting', false, 5_000)).toContain('connecting');
    expect(liveLabel('offline', false, 10_000)).toContain('stream down');
    expect(liveLabel('offline', false, 10_000)).toContain('10s');
  });

  it('has no push channel at all for a read that spans every form', async () => {
    await mount(null, 5_000);
    // No aggregate, so nothing subscribed and no stream was opened; the timer is
    // the only mechanism, and it is honest about that.
    expect(FakeSource.latest).toBeNull();
    await advance(5_000);
    expect(requests).toBe(2);
  });
});
