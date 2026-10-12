import type { Outbox, PendingPayload, StoredDraft } from './types.js';

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
