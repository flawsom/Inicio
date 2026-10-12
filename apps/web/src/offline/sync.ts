import {
  enqueueCreate,
  enqueueSave,
  enqueueSubmit,
  isDrained,
  isDue,
  markFailed,
  markSynced,
  newClientId,
  outboxForNewDraft,
} from './core.js';
import type { OfflineStore } from './store.js';
import type { PendingPayload, StoredDraft, SyncOutcome } from './types.js';

/**
 * The sync runner.
 *
 * Everything it needs from the outside world is injected, so the whole thing is
 * exercised in tests without a browser, a network, or a clock.
 */

export interface Transport {
  start(token: string, clientId: string, payload: PendingPayload): Promise<{ responseId: string; status: StoredDraft['status'] }>;
  save(token: string, responseId: string, payload: PendingPayload): Promise<{ answers?: Record<string, unknown>; missing: string[]; invalid: string[]; conflicts: number }>;
  submit(token: string, responseId: string, payload: PendingPayload): Promise<{ status: StoredDraft['status'] }>;
}

export type FailureKind = 'offline' | 'incomplete' | 'already' | 'permanent' | 'transient';

export interface Failure {
  kind: FailureKind;
  message: string;
  missing?: string[];
  invalid?: string[];
}

export interface SyncContext {
  online: () => boolean;
  now: () => number;
  classify: (err: unknown) => Failure;
  jitter?: () => number;
}

const PENDING: PendingPayload = { answers: {}, base: {} };

export function defaultContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    now: () => Date.now(),
    classify: (err: unknown): Failure => {
      const status = (err as { status?: number } | null)?.status;
      const code = (err as { code?: string } | null)?.code;
      const message = (err as { message?: string } | null)?.message ?? 'could not reach the server';
      if (typeof status !== 'number') return { kind: 'offline', message: 'no connection' };
      if (status === 409 && code === 'already_submitted') return { kind: 'already', message };
      if (status === 422) {
        let missing: string[] = [];
        let invalid: string[] = [];
        try {
          const detail = JSON.parse(message) as { missing?: string[]; invalid?: string[] };
          missing = detail.missing ?? [];
          invalid = detail.invalid ?? [];
        } catch {
          /* the server always sends JSON here; a parse failure just means no detail */
        }
        return { kind: 'incomplete', message, missing, invalid };
      }
      if (status >= 500) return { kind: 'transient', message };
      return { kind: 'permanent', message };
    },
    jitter: Math.random,
    ...overrides,
  };
}

function outcome(draft: StoredDraft, phase: SyncOutcome['phase'], extra: Partial<SyncOutcome> = {}): SyncOutcome {
  return {
    phase,
    missing: [],
    invalid: [],
    conflicts: 0,
    status: draft.status,
    error: draft.outbox.lastError,
    ...extra,
  };
}

/** Reads the draft, applies `fn`, writes it back. The only writer of a draft. */
export async function mutateDraft(
  store: OfflineStore,
  token: string,
  fn: (draft: StoredDraft) => StoredDraft,
): Promise<StoredDraft> {
  const draft = await store.getDraft(token);
  if (!draft) throw new Error(`no draft for ${token}`);
  const next = fn(draft);
  await store.putDraft(next);
  return next;
}

/**
 * Creates (or adopts) the device-side draft. `existingResponseId` carries over a
 * response started before this device kept a local copy, so an upgrade does not
 * abandon work in progress.
 */
export async function ensureDraft(store: OfflineStore, token: string, existingResponseId: string | null = null): Promise<StoredDraft> {
  const found = await store.getDraft(token);
  if (found) return found;
  const draft: StoredDraft = {
    token,
    clientId: existingResponseId ?? newClientId(),
    responseId: existingResponseId,
    answers: {},
    base: {},
    dirty: [],
    status: 'in_progress',
    updatedAt: new Date().toISOString(),
    syncedAt: null,
    outbox: outboxForNewDraft(),
  };
  await store.putDraft(draft);
  return draft;
}

/** Every keystroke lands here, synchronously with respect to the store. */
export async function recordAnswers(
  store: OfflineStore,
  token: string,
  answers: Record<string, unknown>,
  dirty: string[],
): Promise<StoredDraft> {
  return mutateDraft(store, token, (draft) => ({
    ...draft,
    answers,
    dirty: [...new Set([...draft.dirty, ...dirty])],
    updatedAt: new Date().toISOString(),
    outbox: enqueueSave(draft.outbox, { answers, base: draft.base }),
  }));
}

export async function requestSubmit(
  store: OfflineStore,
  token: string,
  answers: Record<string, unknown>,
  dirty: string[],
): Promise<StoredDraft> {
  return mutateDraft(store, token, (draft) => ({
    ...draft,
    answers,
    dirty: [...new Set([...draft.dirty, ...dirty])],
    updatedAt: new Date().toISOString(),
    outbox: enqueueSubmit(draft.outbox, { answers, base: draft.base }),
  }));
}

export async function adoptDefinition(store: OfflineStore, token: string, form: { title: string; version: number; definition: unknown; linkKind?: string }): Promise<void> {
  await store.putCachedForm({
    token,
    title: form.title,
    version: form.version,
    definition: form.definition,
    linkKind: form.linkKind ?? 'anonymous',
    cachedAt: new Date().toISOString(),
  });
}

async function fail(store: OfflineStore, draft: StoredDraft, err: unknown, ctx: SyncContext): Promise<SyncOutcome> {
  const failure = ctx.classify(err);
  if (failure.kind === 'offline') {
    // Not a failure of the request: there was no request. Keep the answers and
    // the schedule untouched; the next online event will try again.
    return outcome(draft, 'offline', { error: null });
  }
  if (failure.kind === 'already') {
    const next = { ...draft, status: 'submitted' as const, outbox: markSynced(draft.outbox, 'submit') };
    await store.putDraft(next);
    return outcome(next, 'done');
  }
  if (failure.kind === 'incomplete') {
    // The server refused the submission because answers are missing or invalid:
    // retrying cannot help, and the answers must still be saved. So the submit
    // intent becomes an ordinary save, and the person is told what to fix.
    const payload = draft.outbox.submit ?? draft.outbox.save ?? PENDING;
    const next = { ...draft, outbox: { ...markSynced(draft.outbox, 'submit'), save: draft.outbox.submit ? payload : draft.outbox.save } };
    await store.putDraft(next);
    return outcome(next, 'queued', { missing: failure.missing ?? [], invalid: failure.invalid ?? [] });
  }
  const next = { ...draft, outbox: markFailed(draft.outbox, failure.message, ctx.now(), ctx.jitter?.()) };
  if (failure.kind === 'permanent') next.outbox = { ...next.outbox, nextAttemptAt: ctx.now() + 300_000 };
  await store.putDraft(next);
  return outcome(next, 'error');
}

/**
 * One pass of the queue. Safe to call as often as you like: it is a no-op when
 * there is nothing due, which is what makes it fine to call on every focus,
 * keystroke and reconnect.
 */
export async function runSync(store: OfflineStore, token: string, transport: Transport, ctx: SyncContext): Promise<SyncOutcome> {
  const draft = await store.getDraft(token);
  if (!draft) return { phase: 'local', missing: [], invalid: [], conflicts: 0, status: 'in_progress', error: null };
  if (isDrained(draft.outbox)) return outcome(draft, draft.status === 'in_progress' ? 'synced' : 'done');
  if (!ctx.online()) return outcome(draft, 'offline', { error: null });
  if (!isDue(draft.outbox, ctx.now())) return outcome(draft, draft.outbox.lastError ? 'error' : 'queued');

  let working = draft;

  if (working.outbox.create || !working.responseId) {
    try {
      const started = await transport.start(token, working.clientId, { answers: working.answers, base: working.base });
      working = { ...working, responseId: started.responseId, status: started.status, outbox: markSynced(working.outbox, 'create') };
      await store.putDraft(working);
    } catch (err) {
      return fail(store, working, err, ctx);
    }
  }

  const payload = working.outbox.submit ?? working.outbox.save;
  if (payload) {
    const kind: 'submit' | 'save' = working.outbox.submit ? 'submit' : 'save';
    try {
      if (kind === 'submit') {
        const res = await transport.submit(token, working.responseId!, payload);
        working = { ...working, status: res.status, syncedAt: new Date(ctx.now()).toISOString(), dirty: [], outbox: markSynced(working.outbox, 'submit') };
      } else {
        const res = await transport.save(token, working.responseId!, payload);
        working = {
          ...working,
          // The server's canonical answers become the new baseline, so the next
          // comparison is against what the database actually holds.
          base: { ...working.base, ...(res.answers ?? payload.answers) },
          syncedAt: new Date(ctx.now()).toISOString(),
          dirty: [],
          outbox: markSynced(working.outbox, 'save'),
        };
        await store.putDraft(working);
        return outcome(working, 'synced', { missing: res.missing, invalid: res.invalid, conflicts: res.conflicts });
      }
      await store.putDraft(working);
      return outcome(working, 'done');
    } catch (err) {
      return fail(store, working, err, ctx);
    }
  }

  return outcome(working, 'synced');
}

/**
 * Serialises flushes: a keystroke, a focus event and a reconnect can all ask at
 * once, and three concurrent submits of the same response is exactly the shape
 * of bug this phase exists to remove.
 */
export class CollectorSync {
  private inflight: Promise<SyncOutcome> | null = null;

  constructor(
    private readonly store: OfflineStore,
    private readonly token: string,
    private readonly transport: Transport,
    private readonly ctx: SyncContext,
  ) {}

  flush(): Promise<SyncOutcome> {
    if (!this.inflight) {
      this.inflight = runSync(this.store, this.token, this.transport, this.ctx).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
}

export { enqueueCreate, enqueueSave, enqueueSubmit };
