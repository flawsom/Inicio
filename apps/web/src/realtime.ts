import { useEffect, useRef, useState } from 'react';

/**
 * The browser side of the push channel.
 *
 * One `EventSource` per form, shared by every component that cares about that
 * form, so having the responses tab and the exports panel open on one form does
 * not open two streams. The server sends *which* aggregates changed rather than
 * the data, so a subscriber refetches with the query it already had: this file
 * moves a signal, never a payload.
 *
 * Three rules that matter:
 *
 *  1. Events that arrive inside one frame are coalesced into one notification, so
 *     a burst cannot turn into a burst of fetches.
 *  2. The stream is allowed to fail. `EventSource` reconnects by itself, and after
 *     repeated failures this gives up and reports `offline`, which is what makes
 *     the caller's fallback timer start. "Live" is therefore a claim about the
 *     connection, not a style.
 *  3. `prefers-reduced-motion` and a hidden tab change nothing here: this is data,
 *     not decoration. A background tab keeps its stream, because a throttled timer
 *     in a background tab was half the reason the old poll showed stale numbers.
 */

export const AGGREGATES = ['responses', 'analytics', 'links', 'versions'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export type StreamStatus = 'connecting' | 'live' | 'offline';

type EventListener = (aggregates: Aggregate[]) => void;
type StatusListener = (status: StreamStatus) => void;

/** How long to wait before reopening after the nth consecutive failure. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  // Deterministic, because a jittered delay is untestable and this is not a
  // thundering-herd problem: one browser holds at most one stream per form.
  return Math.min(capMs, exponential);
}

/**
 * Narrow an incoming event to the aggregates this client understands.
 *
 * The server is allowed to add an aggregate before the client knows about it, so
 * an unknown name is dropped rather than forwarded as a string that would make a
 * subscriber miss its own event.
 */
export function parseAggregates(raw: string): Aggregate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { aggregates?: unknown }).aggregates;
  if (!Array.isArray(list)) return [];
  return AGGREGATES.filter((name) => list.includes(name));
}

/** Coalesce a pending set into a stable, ordered list of aggregates to notify. */
export function coalesce(pending: Set<Aggregate>): Aggregate[] {
  return AGGREGATES.filter((name) => pending.has(name));
}

interface Subscriber {
  onEvent: EventListener;
  onStatus: StatusListener;
}

export interface ChannelOptions {
  /** Injected in tests; the real client uses the browser's EventSource. */
  createSource?: (url: string) => EventSource;
  maxFailures?: number;
}

class RealtimeChannel {
  private source: EventSource | null = null;
  private subscribers = new Set<Subscriber>();
  private pending = new Set<Aggregate>();
  private flushHandle: number | null = null;
  private failures = 0;
  private status: StreamStatus = 'connecting';
  private timer: number | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly options: ChannelOptions = {},
  ) {}

  get currentStatus(): StreamStatus {
    return this.status;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber.onStatus(this.status);
    if (!this.source && this.timer === null) this.open();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.close();
    };
  }

  private setStatus(status: StreamStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const subscriber of this.subscribers) subscriber.onStatus(status);
  }

  private open(): void {
    if (this.closed || this.subscribers.size === 0) return;
    const create =
      this.options.createSource ??
      ((url: string) => new EventSource(url, { withCredentials: true }));

    let source: EventSource;
    try {
      source = create(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.source = source;
    this.setStatus('connecting');

    source.addEventListener('ready', () => {
      // The server only sends `ready` once it has read a revision vector, which
      // means the session was accepted and the stream is actually working.
      this.failures = 0;
      this.setStatus('live');
    });

    source.addEventListener('change', (event: MessageEvent<string>) => {
      const aggregates = parseAggregates(event.data);
      if (aggregates.length === 0) return;
      aggregates.forEach((name) => this.pending.add(name));
      this.scheduleFlush();
    });

    // The server ends the stream on its own lifetime boundary so a serverless
    // function is not killed mid-write. That is expected, not a failure.
    source.addEventListener('recycle', () => {
      this.closeSource();
      this.setStatus('connecting');
      this.scheduleRetry(0);
    });

    source.onerror = () => {
      this.closeSource();
      this.failures += 1;
      const max = this.options.maxFailures ?? 5;
      if (this.failures >= max) {
        this.setStatus('offline');
        this.scheduleRetry();
        return;
      }
      this.setStatus('connecting');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(delayMs?: number): void {
    if (this.closed || this.timer !== null || this.subscribers.size === 0) return;
    const delay = delayMs ?? backoffDelay(this.failures);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    // One frame: enough to merge a burst that arrived in the same tick, short
    // enough that the change is on screen before the reader could notice.
    this.flushHandle = window.requestAnimationFrame(() => {
      this.flushHandle = null;
      const aggregates = coalesce(this.pending);
      this.pending.clear();
      if (aggregates.length === 0) return;
      for (const subscriber of this.subscribers) subscriber.onEvent(aggregates);
    });
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.close();
    this.source = null;
  }

  private close(): void {
    this.closed = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushHandle !== null) {
      window.cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    this.closeSource();
  }
}

const channels = new Map<string, RealtimeChannel>();

function channelFor(formId: string, options?: ChannelOptions): RealtimeChannel {
  const url = `/api/v1/forms/${encodeURIComponent(formId)}/events`;
  const existing = channels.get(url);
  if (existing) return existing;
  const created = new RealtimeChannel(url, options);
  channels.set(url, created);
  return created;
}

/**
 * Subscribe to one form's changes. Returns the unsubscribe function.
 *
 * Shared by every caller for the same form, and the underlying stream is closed
 * when the last subscriber leaves, so navigating away from a form really does
 * stop the traffic rather than leaving a stream open behind the console.
 */
export function subscribeToForm(
  formId: string,
  onEvent: EventListener,
  onStatus: StatusListener = () => {},
  options?: ChannelOptions,
): () => void {
  return channelFor(formId, options).subscribe({ onEvent, onStatus });
}

/**
 * Declarative wrapper.
 *
 * `onEvent` is read from a ref so a caller that re-renders on every keystroke does
 * not tear down and reopen the stream: the subscription's identity is the form,
 * not the callback.
 */
export function useFormStream(
  formId: string | null,
  onEvent: (aggregates: Aggregate[]) => void,
): StreamStatus {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!formId) {
      setStatus('offline');
      return;
    }
    setStatus('connecting');
    return subscribeToForm(
      formId,
      (aggregates) => handler.current(aggregates),
      setStatus,
    );
  }, [formId]);

  return status;
}
