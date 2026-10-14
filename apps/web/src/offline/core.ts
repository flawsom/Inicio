import type { Outbox, PendingPayload, StoredDraft, SyncPhase } from './types.js';

/**
 * The pure part of the offline machinery: queue transitions, backoff and resume
 * decisions. No browser APIs live here, so every rule below is unit-tested
 * rather than hoped for.
 */

/** 32 random bytes, hex — the same shape a browser UUID has, plus room to spare. */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function emptyOutbox(): Outbox {
  return { create: false, save: null, submit: null, attempts: 0, nextAttemptAt: 0, lastError: null };
}

export function outboxForNewDraft(): Outbox {
  return { ...emptyOutbox(), create: true };
}

export function isDrained(outbox: Outbox): boolean {
  return !outbox.create && outbox.save === null && outbox.submit === null;
}

/** How many distinct things are waiting to reach the server. */
export function pendingCount(outbox: Outbox): number {
  return (outbox.create ? 1 : 0) + (outbox.save ? 1 : 0) + (outbox.submit ? 1 : 0);
}

/**
 * A save replaces any pending save: each one carries the whole answer set, so the
 * newest is strictly better and the queue cannot grow without bound.
 *
 * A submit supersedes a pending save for the same reason — it carries the same
 * answers plus the intent to finish.
 */
export function enqueueSave(outbox: Outbox, payload: PendingPayload): Outbox {
  if (outbox.submit) return { ...outbox, submit: payload, attempts: 0, nextAttemptAt: 0, lastError: null };
  return { ...outbox, save: payload, attempts: 0, nextAttemptAt: 0, lastError: null };
}

export function enqueueSubmit(outbox: Outbox, payload: PendingPayload): Outbox {
  return { ...outbox, submit: payload, save: null, attempts: 0, nextAttemptAt: 0, lastError: null };
}

export function enqueueCreate(outbox: Outbox): Outbox {
  return { ...outbox, create: true };
}

/** Called after an operation the server acknowledged. */
export function markSynced(outbox: Outbox, kind: 'create' | 'save' | 'submit'): Outbox {
  const next = { ...outbox, attempts: 0, nextAttemptAt: 0, lastError: null };
  if (kind === 'create') next.create = false;
  if (kind === 'save') next.save = null;
  if (kind === 'submit') next.submit = null;
  return next;
}

/**
 * Exponential backoff, capped and jittered so a fleet of devices that lost the
 * same cell tower does not retry in lockstep. `jitter` is injected so the
 * schedule is testable.
 */
export function nextDelayMs(attempts: number, jitter = Math.random()): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts));
  return Math.round(base * (0.5 + 0.5 * jitter));
}

export function markFailed(outbox: Outbox, error: string, now: number, jitter?: number): Outbox {
  const attempts = outbox.attempts + 1;
  return { ...outbox, attempts, nextAttemptAt: now + nextDelayMs(attempts - 1, jitter), lastError: error };
}

export function isDue(outbox: Outbox, now: number): boolean {
  return outbox.nextAttemptAt <= now;
}

/**
 * Which copy of the answers to show when a device reopens a form.
 *
 * If nothing is pending, the server is the source of truth (SPEC §1: the server
 * is authoritative, the client is untrusted). If something is pending, the
 * device's copy is kept whole — it may hold hours of field work — and the
 * server-side merge reconciles it on the next sync instead of a browser guessing.
 */
export function resolveResume(local: StoredDraft, server: { answers: Record<string, unknown>; status: StoredDraft['status'] }): StoredDraft {
  const pending = !isDrained(local.outbox);
  return {
    ...local,
    answers: pending ? local.answers : { ...local.answers, ...server.answers },
    base: pending ? local.base : { ...local.base, ...server.answers },
    status: server.status !== 'in_progress' ? server.status : local.status,
  };
}

/**
 * One line a respondent can act on. Deliberately free of developer words: it
 * never says "offline queue", "sync", "error code" or "response".
 */
export function syncLabel(draft: StoredDraft, online: boolean, syncing: boolean): string {
  if (draft.status !== 'in_progress') return 'Submitted';
  if (syncing) return 'Sending your answers…';
  if (!online) return 'No connection. Your answers are saved on this device and will be sent automatically.';
  if (draft.outbox.submit) return 'Waiting to send your answers…';
  if (draft.outbox.lastError) return `Your answers are saved on this device. Last attempt failed: ${draft.outbox.lastError}`;
  if (!isDrained(draft.outbox)) return 'Saved on this device. Sending…';
  return 'All answers saved.';
}

/** A time string for the header, from an ISO instant, without throwing on junk. */
export function timeOf(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString();
}

/**
 * Everything the device knows about its own queue, as one structure.
 *
 * The point of this shape is that "is my work safe?" is answerable from the device
 * alone, with no network: how much is waiting, whether the server has the rest, how
 * many times the last send was tried, what went wrong and when the next attempt is
 * due. A single sentence was enough while the queue was invisible; it is not enough
 * when somebody is deciding whether to keep working on a phone that has been failing
 * to send for ten minutes.
 *
 * Pure on purpose: no clock is read and nothing is fetched, so every rule below is a
 * unit test rather than a hope.
 */
export interface DeviceState {
  phase: SyncPhase;
  /** True when the server holds every answer this device has. */
  serverHasEverything: boolean;
  /** How many distinct things are waiting to reach the server. */
  waiting: number;
  /** Failed attempts since the last send the server acknowledged. */
  attempts: number;
  /** The last failure, in words a person can act on, or null. */
  lastError: string | null;
  /** When the next attempt becomes due, in epoch ms, or null when none is scheduled. */
  retryAt: number | null;
  /** One line a respondent can act on (the same sentence the header has always shown). */
  headline: string;
}

export function deviceState(
  draft: StoredDraft,
  context: { online: boolean; syncing: boolean; now: number },
): DeviceState {
  const waiting = pendingCount(draft.outbox);
  const drained = isDrained(draft.outbox);
  const finished = draft.status !== 'in_progress';
  // A wait that is already over is not a wait: the next flush attempt simply happens on
  // the next trigger (a keystroke, a focus, a reconnect), so there is no instant to show.
  const retryAt =
    !drained && draft.outbox.lastError !== null && draft.outbox.nextAttemptAt > context.now
      ? draft.outbox.nextAttemptAt
      : null;
  const phase: SyncPhase = finished
    ? 'done'
    : context.syncing
      ? 'syncing'
      : !context.online
        ? 'offline'
        : draft.outbox.lastError !== null
          ? 'error'
          : drained
            ? 'synced'
            : 'queued';
  return {
    phase,
    // A submitted response is on the server by definition; otherwise it is the queue
    // being empty *and* the server having acknowledged at least once that settles it.
    serverHasEverything: finished ? true : drained && draft.syncedAt !== null,
    waiting,
    attempts: draft.outbox.attempts,
    lastError: draft.outbox.lastError,
    retryAt,
    headline: syncLabel(draft, context.online, context.syncing),
  };
}

/**
 * The retry sentence, or null when nothing is waiting on the clock.
 *
 * Deliberately says "next try", not "next retry" and never "backoff": this is read by
 * whoever is holding the phone, and a schedule is only useful to them as a time.
 */
export function retryText(state: DeviceState): string | null {
  if (state.retryAt === null) return null;
  return `next try at ${timeOf(new Date(state.retryAt).toISOString())}`;
}

/**
 * What the browser will say about the device's own storage, in a shape a screen can
 * use.
 *
 * `navigator.storage.estimate()` is the only way to learn how much room is left, and
 * it is absent in enough browsers (Safari reports it late, some report nothing) that
 * "unknown" has to be a real answer rather than a zero. Nothing here decides anything:
 * an answer is always saved first and asked about afterwards, because a full disk is a
 * reason to warn somebody, never a reason to drop what they typed.
 */
export interface StorageHealth {
  supported: boolean;
  usedBytes: number;
  quotaBytes: number;
  /** Share of the quota already used, 0 to 1, or null when the browser will not say. */
  fraction: number | null;
  verdict: 'unknown' | 'ok' | 'low' | 'full';
  /** A sentence for the person holding the device, when there is something to say. */
  warning: string | null;
}

const lowStorageWarning =
  'This device is running low on storage space. Answers are still being saved; free up space when you can.';
const fullStorageWarning =
  'This device is nearly out of storage space, so answers may stop being saved. Send your answers, or save a copy of them, and free up space before collecting more.';

export function storageHealth(estimate: { usage?: number; quota?: number } | null): StorageHealth {
  const used = typeof estimate?.usage === 'number' && Number.isFinite(estimate.usage) ? Math.max(0, estimate.usage) : null;
  const quota = typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota) ? estimate.quota : 0;
  if (used === null || quota <= 0) {
    return { supported: estimate !== null, usedBytes: used ?? 0, quotaBytes: quota, fraction: null, verdict: 'unknown', warning: null };
  }
  const fraction = Math.min(1, used / quota);
  if (fraction >= 0.95) return { supported: true, usedBytes: used, quotaBytes: quota, fraction, verdict: 'full', warning: fullStorageWarning };
  if (fraction >= 0.8) return { supported: true, usedBytes: used, quotaBytes: quota, fraction, verdict: 'low', warning: lowStorageWarning };
  return { supported: true, usedBytes: used, quotaBytes: quota, fraction, verdict: 'ok', warning: null };
}

/**
 * Whether a question's file is still waiting for a connection.
 *
 * A file that failed because nobody was listening is not a refused file, and the two
 * must not be treated alike: the first is retried by itself when the network comes
 * back, the second is the server's verdict and retrying it unchanged would fail the
 * same way. Only the first is ever remembered here.
 */
export function attachmentOutcome(err: unknown): 'retry' | 'verdict' {
  // Anything can be thrown, so this reads a status out of whatever arrived rather than
  // requiring a shape: a `TypeError` from a dropped connection and an `ApiError` from a
  // refusal must land on different sides of this line, and that is the whole decision.
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? 'verdict' : 'retry';
}
