import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { useFormStream, type Aggregate, type StreamStatus } from './realtime';

/**
 * A live read: the server pushes, the timer is the fallback.
 *
 * This used to live inside the workspace shell. The monitoring screen is its own
 * lazy chunk and needs the same contract, and duplicating the hook would make it
 * possible for one screen to keep polling while the other was genuinely live. It
 * lives here so every reader of a form aggregate shares one implementation.
 *
 * The interval is only armed once the stream has actually failed. While the
 * server is pushing, a quiet form costs no queries at all.
 */

export interface LiveOptions {
  /**
   * The form whose stream drives this read. When the value is null the read has
   * no push channel and the fallback timer is the only mechanism.
   */
  formId?: string | null;
  /** Which aggregate on that stream invalidates this read. */
  aggregate?: Aggregate;
  /**
   * Interval used *only* while the push channel is not live for this aggregate.
   * It is a safety net, not the mechanism: the point of the channel is that this
   * timer does not run at all when the stream is up.
   */
  fallbackMs: number;
  deps: unknown[];
}

export interface LiveResult<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
  status: StreamStatus;
  /** True when the server is pushing this aggregate, so nothing is being timed. */
  live: boolean;
}

export function useLive<T>(load: () => Promise<T>, options: LiveOptions): LiveResult<T> {
  const { formId = null, aggregate, fallbackMs, deps } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async (): Promise<void> => {
    try {
      const result = await loadRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'request failed');
    }
  }, []);

  // The first read, every deps change, and a manual refresh. Always exactly one
  // request per reason, never a loop.
  useEffect(() => {
    void run();
    // The caller passes the identity of what it read; `tick` is the manual refresh.
  }, [run, tick, ...deps]);

  // The push channel. Only subscribed when this read names an aggregate: a read
  // with no aggregate has no event that invalidates it.
  const onStreamEvent = useCallback(
    (changed: Aggregate[]) => {
      if (aggregate && changed.includes(aggregate)) void run();
    },
    [aggregate, run],
  );
  const status = useFormStream(aggregate ? formId : null, onStreamEvent);

  const live = Boolean(aggregate && formId && status === 'live');

  useEffect(() => {
    if (live) return;
    const timer = window.setInterval(() => void run(), fallbackMs);
    // A background tab has its timers throttled (or frozen), so the first thing a
    // returning reader saw could be a snapshot from minutes ago. Refresh the
    // moment the tab becomes visible again, and again if the window is refocused.
    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('focus', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('focus', refreshIfVisible);
    };
  }, [live, fallbackMs, run]);

  return { data, error, reload: () => setTick((n) => n + 1), status, live };
}

/** The one line the header shows about the connection, in plain words. */
export function liveLabel(status: StreamStatus, live: boolean, fallbackMs: number): string {
  if (live) return 'live: pushed by the server the moment it changes';
  if (status === 'connecting') return `live: connecting, refreshing every ${Math.round(fallbackMs / 1000)}s until it opens`;
  return `live: stream down, refreshing every ${Math.round(fallbackMs / 1000)}s`;
}
