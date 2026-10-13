// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  AGGREGATES,
  backoffDelay,
  coalesce,
  parseAggregates,
  subscribeToForm,
  type Aggregate,
  type StreamStatus,
} from '../src/realtime';

/**
 * The browser end of the push channel, with no real network in it.
 *
 * Injecting the source is what makes the parts that are invisible in a browser
 * testable: that a burst arriving inside one frame becomes one notification rather
 * than a burst of refetches, that an aggregate this build does not know about is
 * dropped instead of forwarded, and that a stream which keeps failing eventually
 * says `offline` rather than continuing to claim it is live.
 */

interface FakeEvent {
  data: string;
}

class FakeSource {
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  emit(name: string, payload: unknown): void {
    const event: FakeEvent = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
  }
}

/** One record of every stream opened, so a test can look at the latest. */
function carrier(): { opened: FakeSource[]; create: (url: string) => EventSource; latest: () => FakeSource } {
  const opened: FakeSource[] = [];
  const latest = (): FakeSource => {
    const source = opened[opened.length - 1];
    if (!source) throw new Error('no stream was opened');
    return source;
  };
  return {
    opened,
    latest,
    create: (url) => {
      const source = new FakeSource(url);
      opened.push(source);
      return source as unknown as EventSource;
    },
  };
}

// Each test gets its own form id: channels are cached per form for the life of the
// module, which is the point of them, so sharing an id across tests would share a
// stream across tests.
let counter = 0;
const nextFormId = (): string => `form-${(counter += 1)}`;

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const noop = (): void => {};

describe('backoffDelay', () => {
  it('doubles per consecutive failure and stops at the cap', () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(1_000);
    expect(backoffDelay(2)).toBe(2_000);
    expect(backoffDelay(3)).toBe(4_000);
    expect(backoffDelay(99)).toBe(30_000);
  });
});

describe('parseAggregates', () => {
  it('keeps the names this build knows and drops the rest', () => {
    expect(parseAggregates(JSON.stringify({ aggregates: ['responses', 'links', 'channels'] }))).toEqual([
      'responses',
      'links',
    ]);
  });

  it('answers nothing when the body cannot be understood', () => {
    expect(parseAggregates('not json at all')).toEqual([]);
    expect(parseAggregates(JSON.stringify({ aggregates: 'responses' }))).toEqual([]);
    expect(parseAggregates('{}')).toEqual([]);
  });
});

describe('coalesce', () => {
  it('follows the declared order, not the order the events arrived in', () => {
    expect(coalesce(new Set<Aggregate>(['versions', 'responses']))).toEqual(['responses', 'versions']);
    expect(AGGREGATES[0]).toBe('responses');
  });
});

describe('a stream', () => {
  it('only says live once the server has said ready', () => {
    const stream = carrier();
    const statuses: StreamStatus[] = [];
    const unsubscribe = subscribeToForm(nextFormId(), noop, (status) => statuses.push(status), {
      createSource: stream.create,
    });

    expect(statuses).toEqual(['connecting']);
    stream.latest().emit('ready', {});
    expect(statuses).toEqual(['connecting', 'live']);
    unsubscribe();
  });

  it('turns a burst inside one frame into one notification', async () => {
    const stream = carrier();
    const events: Aggregate[][] = [];
    const unsubscribe = subscribeToForm(nextFormId(), (aggregates) => events.push(aggregates), noop, {
      createSource: stream.create,
    });

    stream.latest().emit('change', { aggregates: ['responses'] });
    stream.latest().emit('change', { aggregates: ['links', 'responses'] });
    stream.latest().emit('change', { aggregates: ['analytics'] });
    // Nothing is delivered during the tick: the whole point is that three events
    // do not become three refetches.
    expect(events).toEqual([]);

    await frame();
    expect(events).toEqual([['responses', 'analytics', 'links']]);
    unsubscribe();
  });

  it('ignores an event that names nothing it understands', async () => {
    const stream = carrier();
    const events: Aggregate[][] = [];
    const unsubscribe = subscribeToForm(nextFormId(), (aggregates) => events.push(aggregates), noop, {
      createSource: stream.create,
    });

    stream.latest().emit('change', { aggregates: ['channels'] });
    await frame();
    expect(events).toEqual([]);
    unsubscribe();
  });

  it('recycles on request, which is a reconnect rather than a failure', async () => {
    const stream = carrier();
    const statuses: StreamStatus[] = [];
    const unsubscribe = subscribeToForm(nextFormId(), noop, (status) => statuses.push(status), {
      createSource: stream.create,
    });

    const first = stream.latest();
    first.emit('ready', {});
    first.emit('recycle', {});

    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toBe('connecting');
    await tick();
    expect(stream.opened).toHaveLength(2);
    unsubscribe();
  });

  it('admits it is offline after repeated failures, and reopens in between', () => {
    const stream = carrier();
    const statuses: StreamStatus[] = [];
    const unsubscribe = subscribeToForm(nextFormId(), noop, (status) => statuses.push(status), {
      createSource: stream.create,
      maxFailures: 2,
    });

    stream.latest().emit('ready', {});
    stream.latest().fail();
    expect(statuses).toEqual(['connecting', 'live', 'connecting']);

    // The second failure crosses the threshold: the caller's fallback timer is
    // now the thing keeping the screen current, and the UI is allowed to say so.
    stream.latest().fail();
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'offline']);
    unsubscribe();
  });

  it('shares one stream between two subscribers and closes it when the last one leaves', () => {
    const stream = carrier();
    const formId = nextFormId();
    const first = subscribeToForm(formId, noop, noop, { createSource: stream.create });
    const second = subscribeToForm(formId, noop, noop, { createSource: stream.create });

    expect(stream.opened).toHaveLength(1);
    const source = stream.latest();

    first();
    expect(source.closed).toBe(false);
    expect(stream.opened).toHaveLength(1);

    second();
    expect(source.closed).toBe(true);
  });
});
