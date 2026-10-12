import { describe, expect, it, vi } from 'vitest';
import {
  emptyOutbox,
  enqueueSave,
  enqueueSubmit,
  isDrained,
  newClientId,
  nextDelayMs,
  outboxForNewDraft,
  pendingCount,
  resolveResume,
  syncLabel,
} from '../src/offline/core.js';
import {
  CollectorSync,
  defaultContext,
  ensureDraft,
  recordAnswers,
  requestSubmit,
  runSync,
  type SyncContext,
  type Transport,
} from '../src/offline/sync.js';
import { memoryStore } from '../src/offline/store.js';
import type { StoredDraft } from '../src/offline/types.js';

/**
 * The offline queue, without a browser.
 *
 * IndexedDB, the clock and the network are all injected, so these tests exercise
 * the actual rules that decide whether field data survives: what supersedes what,
 * how long to wait before retrying, and which copy of the answers to keep when a
 * device and the server disagree.
 */

const TOKEN = 'link-token-abc';

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return defaultContext({ online: () => true, now: () => 1_000_000, jitter: () => 0, ...overrides });
}

function transport(overrides: Partial<Transport> = {}): Transport {
  return {
    start: async () => ({ responseId: 'srv-1', status: 'in_progress' }),
    save: async (_t, _id, payload) => ({ answers: payload.answers, missing: [], invalid: [], conflicts: 0 }),
    submit: async () => ({ status: 'submitted' }),
    ...overrides,
  };
}

describe('the durable queue', () => {
  it('lets a newer save supersede an older one instead of growing the queue', () => {
    let box = outboxForNewDraft();
    box = enqueueSave(box, { answers: { a: 1 }, base: {} });
    box = enqueueSave(box, { answers: { a: 2 }, base: {} });
    expect(box.save?.answers).toEqual({ a: 2 });
    expect(pendingCount(box)).toBe(2); // one create, one save
  });

  it('lets a submit carry the answers, dropping the redundant save', () => {
    let box = emptyOutbox();
    box = enqueueSave(box, { answers: { a: 1 }, base: {} });
    box = enqueueSubmit(box, { answers: { a: 2 }, base: {} });
    expect(box.save).toBeNull();
    expect(box.submit?.answers).toEqual({ a: 2 });
    expect(pendingCount(box)).toBe(1);
  });

  it('backs off with a cap, and jitter so a fleet does not retry in lockstep', () => {
    // base doubles each attempt and caps at a minute; jitter spans half to all of it.
    expect(nextDelayMs(0, 0)).toBe(500);
    expect(nextDelayMs(1, 0)).toBe(1000);
    expect(nextDelayMs(5, 0)).toBe(16_000);
    expect(nextDelayMs(5, 1)).toBe(32_000);
    expect(nextDelayMs(20, 0)).toBe(30_000);
    expect(nextDelayMs(20, 1)).toBe(60_000);
    expect(nextDelayMs(3, 1)).toBe(8000);
  });

  it('issues distinct UUIDv4 client ids', () => {
    const a = newClientId();
    const b = newClientId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('keeps the device copy while anything is pending, and adopts the server copy once nothing is', () => {
    const pending: StoredDraft = {
      token: TOKEN, clientId: 'c1', responseId: null, answers: { a: 'device', b: 'device' },
      base: {}, dirty: ['a'], status: 'in_progress', updatedAt: 'x', syncedAt: null, outbox: outboxForNewDraft(),
    };
    expect(resolveResume(pending, { answers: { a: 'server' }, status: 'in_progress' }).answers).toEqual({ a: 'device', b: 'device' });

    const clean: StoredDraft = { ...pending, answers: { a: 'device' }, outbox: emptyOutbox() };
    expect(resolveResume(clean, { answers: { a: 'server' }, status: 'in_progress' }).answers).toEqual({ a: 'server' });
  });

  it('describes the state without leaking developer words to a respondent', () => {
    const draft: StoredDraft = {
      token: TOKEN, clientId: 'c1', responseId: 'r1', answers: {}, base: {}, dirty: [],
      status: 'in_progress', updatedAt: 'x', syncedAt: null, outbox: outboxForNewDraft(),
    };
    const offline = syncLabel(draft, false, false);
    expect(offline).toContain('saved on this device');
    expect(offline).not.toMatch(/queue|sync|404|500|error code/i);
    expect(syncLabel(draft, true, false)).not.toMatch(/queue|sync|404|500/i);
  });
});

describe('the sync runner', () => {
  it('sends nothing while there is no connection, and keeps every answer', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { score: 5 }, ['score']);
    const start = vi.fn(transport().start);
    const out = await runSync(store, TOKEN, transport({ start }), ctx({ online: () => false }));
    expect(out.phase).toBe('offline');
    expect(start).not.toHaveBeenCalled();
    const draft = await store.getDraft(TOKEN);
    expect(draft?.answers).toEqual({ score: 5 });
    expect(isDrained(draft!.outbox)).toBe(false);
  });

  it('creates the response once and then saves, in a single pass', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { score: 5 }, ['score']);
    const calls: string[] = [];
    const send = transport({
      start: async (_t, clientId) => {
        calls.push(`start:${clientId}`);
        return { responseId: 'srv-1', status: 'in_progress' };
      },
      save: async () => {
        calls.push('save');
        return { answers: { score: 5, hidden: null }, missing: [], invalid: [], conflicts: 0 };
      },
    });

    const out = await runSync(store, TOKEN, send, ctx());
    expect(calls).toEqual(['start:' + (await store.getDraft(TOKEN))!.clientId, 'save']);
    expect(out.phase).toBe('synced');
    const draft = await store.getDraft(TOKEN);
    expect(draft?.responseId).toBe('srv-1');
    expect(isDrained(draft!.outbox)).toBe(true);
    // The server's canonical answers became the baseline, including the null the
    // device never sent — so the next comparison is against reality.
    expect(draft?.base).toEqual({ score: 5, hidden: null });
  });

  it('does not start a second response when the same draft is flushed twice', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { score: 1 }, ['score']);
    const start = vi.fn(async () => ({ responseId: 'srv-1', status: 'in_progress' as const }));
    const send = transport({ start });

    await runSync(store, TOKEN, send, ctx());
    const second = await runSync(store, TOKEN, send, ctx());
    expect(start).toHaveBeenCalledTimes(1);
    expect(second.phase).toBe('synced');
  });

  it('keeps the answers when a submission is refused for missing input, and says what to fix', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { consent: 'yes' }, ['consent']);
    await runSync(store, TOKEN, transport(), ctx());
    await requestSubmit(store, TOKEN, { consent: 'yes' }, ['consent']);

    const detail = JSON.stringify({ missing: ['score'], invalid: [] });
    const send = transport({
      submit: async () => {
        throw Object.assign(new Error(detail), { status: 422, code: 'incomplete' });
      },
    });
    const out = await runSync(store, TOKEN, send, ctx());
    expect(out.missing).toEqual(['score']);
    expect(out.status).toBe('in_progress');

    const draft = await store.getDraft(TOKEN);
    // The submit intent became an ordinary save: retrying cannot help, and the
    // answers must still reach the server.
    expect(draft!.outbox.submit).toBeNull();
    expect(draft!.outbox.save).not.toBeNull();
    expect(draft!.status).toBe('in_progress');
  });

  it('treats a rejected retry after a successful submit as success, not as data loss', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await requestSubmit(store, TOKEN, { score: 3 }, ['score']);
    const send = transport({
      submit: async () => {
        throw Object.assign(new Error('already submitted'), { status: 409, code: 'already_submitted' });
      },
    });
    const out = await runSync(store, TOKEN, send, ctx());
    expect(out.phase).toBe('done');
    expect(out.status).toBe('submitted');
    expect(isDrained((await store.getDraft(TOKEN))!.outbox)).toBe(true);
  });

  it('backs off after a server error without discarding anything', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { score: 3 }, ['score']);
    const send = transport({
      start: async () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
    });
    const out = await runSync(store, TOKEN, send, ctx());
    expect(out.phase).toBe('error');
    const draft = await store.getDraft(TOKEN);
    expect(draft!.outbox.attempts).toBe(1);
    expect(draft!.outbox.nextAttemptAt).toBeGreaterThan(1_000_000);
    expect(draft!.answers).toEqual({ score: 3 });

    // Not due yet: a flush right now must not even try.
    const start = vi.fn(async () => ({ responseId: 'srv-1', status: 'in_progress' as const }));
    const again = await runSync(store, TOKEN, transport({ start }), ctx({ now: () => 1_000_100 }));
    expect(start).not.toHaveBeenCalled();
    expect(['queued', 'error']).toContain(again.phase);
  });

  it('serialises concurrent flushes so one response is never submitted twice', async () => {
    const store = memoryStore();
    await ensureDraft(store, TOKEN);
    await recordAnswers(store, TOKEN, { a: 1 }, ['a']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredSave = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = vi.fn(async (_t: string, _i: string, payload: { answers: Record<string, unknown> }) => {
      entered();
      await gate;
      return { answers: payload.answers, missing: [], invalid: [], conflicts: 0 };
    });
    const sync = new CollectorSync(store, TOKEN, transport({ save }), ctx());

    const first = sync.flush();
    const second = sync.flush();
    await enteredSave;
    release();
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
