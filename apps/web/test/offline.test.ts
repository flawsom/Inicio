import { describe, expect, it, vi } from 'vitest';
import {
  attachmentOutcome,
  deviceState,
  emptyOutbox,
  enqueueSave,
  enqueueSubmit,
  isDrained,
  markFailed,
  newClientId,
  nextDelayMs,
  outboxForNewDraft,
  pendingCount,
  resolveResume,
  retryText,
  storageHealth,
  syncLabel,
} from '../src/offline/core.js';
import { buildBackup, fileNameFor, parseBackup, restoreBackup, validateBackup } from '../src/offline/backup.js';
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

/** A draft built by hand, so each rule below is read against one field at a time. */
function draftWith(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return {
    token: TOKEN,
    clientId: 'c1',
    responseId: 'r1',
    answers: { score: 5 },
    base: {},
    dirty: [],
    status: 'in_progress',
    updatedAt: '2026-10-14T09:00:00.000Z',
    syncedAt: null,
    outbox: emptyOutbox(),
    ...overrides,
  };
}

describe('what the device says about its own queue', () => {
  it('says the server holds everything once a save has been acknowledged', () => {
    const draft = draftWith({ syncedAt: '2026-10-14T09:00:01.000Z' });
    const state = deviceState(draft, { online: true, syncing: false, now: 1_000_000 });
    expect(state.phase).toBe('synced');
    expect(state.serverHasEverything).toBe(true);
    expect(state.waiting).toBe(0);
    expect(state.lastError).toBeNull();
    expect(state.retryAt).toBeNull();
    expect(state.headline).toBe('All answers saved.');
  });

  it('counts what is waiting and does not claim the server has it', () => {
    let outbox = outboxForNewDraft();
    outbox = enqueueSave(outbox, { answers: { score: 5 }, base: {} });
    // A draft that has never been acknowledged, however much of it is queued.
    const state = deviceState(draftWith({ outbox }), { online: true, syncing: false, now: 1_000_000 });
    expect(state.phase).toBe('queued');
    expect(state.waiting).toBe(2);
    expect(state.serverHasEverything).toBe(false);
  });

  it('reports a failure with its attempt count, and only a wait that is still ahead', () => {
    const outbox = markFailed(outboxForNewDraft(), 'the server did not answer', 1_000_000, 0);
    const draft = draftWith({ outbox });

    const waiting = deviceState(draft, { online: true, syncing: false, now: 1_000_100 });
    expect(waiting.phase).toBe('error');
    expect(waiting.attempts).toBe(1);
    expect(waiting.lastError).toBe('the server did not answer');
    expect(waiting.retryAt).toBe(outbox.nextAttemptAt);
    expect(retryText(waiting)).toMatch(/^next try at /);

    // Once the wait is over there is no instant to name: the next attempt happens on the
    // next trigger, so a screen that printed a past time would be reading a stale one.
    const due = deviceState(draft, { online: true, syncing: false, now: outbox.nextAttemptAt });
    expect(due.retryAt).toBeNull();
    expect(retryText(due)).toBeNull();
  });

  it('calls a device with no connection offline rather than failed', () => {
    const outbox = markFailed(outboxForNewDraft(), 'the server did not answer', 1_000_000, 0);
    const state = deviceState(draftWith({ outbox }), { online: false, syncing: false, now: 1_000_100 });
    // The network is the reason, so that is what the pill says: the failure underneath
    // is not a verdict about the answers, and it is still reported as an attempt count.
    expect(state.phase).toBe('offline');
    expect(state.attempts).toBe(1);
    expect(state.lastError).toBe('the server did not answer');
    expect(state.headline).toContain('saved on this device');
  });

  it('is finished once the status leaves in progress, whatever the queue holds', () => {
    let outbox = outboxForNewDraft();
    outbox = enqueueSubmit(outbox, { answers: { score: 5 }, base: {} });
    const state = deviceState(draftWith({ status: 'submitted', outbox }), {
      online: true,
      syncing: false,
      now: 1_000_000,
    });
    expect(state.phase).toBe('done');
    expect(state.serverHasEverything).toBe(true);
    expect(state.headline).toBe('Submitted');
  });
});

describe('the storage the browser will admit to', () => {
  it('says nothing when the browser will not answer, rather than guessing at zero', () => {
    const unknown = storageHealth(null);
    expect(unknown.verdict).toBe('unknown');
    expect(unknown.warning).toBeNull();
    expect(unknown.fraction).toBeNull();
    expect(unknown.supported).toBe(false);
  });

  it('treats an answer with no quota as unknown, and never divides by it', () => {
    const noQuota = storageHealth({ usage: 10 });
    expect(noQuota.verdict).toBe('unknown');
    expect(noQuota.fraction).toBeNull();
    const zeroQuota = storageHealth({ usage: 10, quota: 0 });
    expect(zeroQuota.verdict).toBe('unknown');
    expect(zeroQuota.fraction).toBeNull();
  });

  it('stays quiet while there is room, and speaks up before there is not', () => {
    expect(storageHealth({ usage: 40, quota: 100 }).verdict).toBe('ok');
    expect(storageHealth({ usage: 40, quota: 100 }).warning).toBeNull();

    const low = storageHealth({ usage: 82, quota: 100 });
    expect(low.verdict).toBe('low');
    expect(low.fraction).toBeCloseTo(0.82);
    expect(low.warning).toContain('running low on storage space');

    const full = storageHealth({ usage: 96, quota: 100 });
    expect(full.verdict).toBe('full');
    expect(full.warning).toContain('nearly out of storage space');
    // Both warnings say the same thing about the answers, because at either level the
    // device is still saving them: a warning is not a reason to stop collecting.
    expect(full.warning).toContain('may stop being saved');
  });
});

describe('whether a file that failed should be tried again', () => {
  it('reads a status as the server’s verdict and its absence as the network’s', () => {
    expect(attachmentOutcome({ status: 422 })).toBe('verdict');
    expect(attachmentOutcome({ status: 403 })).toBe('verdict');
    // A dropped connection and an unanswered request are the same fact to the device.
    expect(attachmentOutcome(new TypeError('Failed to fetch'))).toBe('retry');
    expect(attachmentOutcome(null)).toBe('retry');
  });
});

describe('a copy of what is on this device', () => {
  it('names itself after the survey it came from, safely enough to be a filename', () => {
    const backup = buildBackup(draftWith({ clientId: '9f1c2b3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' }), {
      title: 'School Ranking 2026: a survey',
      version: 3,
    });
    expect(fileNameFor(backup)).toBe('inicio-school-ranking-2026-a-survey-9f1c2b3d.json');
    expect(fileNameFor(buildBackup(draftWith({}), { title: null }))).toBe('inicio-answers-c1.json');
    expect(backup.version).toBe(1);
  });

  it('refuses a file that is not a copy, in a sentence rather than a code', () => {
    const notJson = parseBackup('this is not JSON');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toContain('could not be read');

    const wrongShape = parseBackup(JSON.stringify({ hello: 'world' }));
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.reason).toContain('not a copy of saved answers');

    // A copy whose inner draft names a different link from the file around it is corrupt,
    // and is refused as such rather than half-read.
    const backup = buildBackup(draftWith());
    const tampered = validateBackup({ ...backup, token: 'other-link' });
    expect(tampered.ok).toBe(false);
  });

  it('refuses a copy written by a newer app instead of reading it halfway', () => {
    const result = validateBackup({ ...buildBackup(draftWith()), version: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('newer version');
  });

  it('refuses a copy belonging to another survey', async () => {
    const store = memoryStore();
    const result = await restoreBackup(store, JSON.stringify(buildBackup(draftWith({ token: 'other-link' }))), TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('different survey link');
    expect(await store.getDraft(TOKEN)).toBeNull();
  });

  it('restores into a device that has nothing, queue and all, and carries on sending', async () => {
    // The device the answers were on, with a submission that never got out.
    const old = memoryStore();
    await ensureDraft(old, TOKEN);
    await recordAnswers(old, TOKEN, { score: 7 }, ['score']);
    await requestSubmit(old, TOKEN, { score: 7 }, ['score']);
    const was = (await old.getDraft(TOKEN))!;
    const file = JSON.stringify(buildBackup(was, { title: 'A survey', version: 2 }), null, 2);

    // The replacement phone: a fresh store, the same link open, the copy chosen.
    const fresh = memoryStore();
    const result = await restoreBackup(fresh, file, TOKEN);
    expect(result.ok).toBe(true);
    const now = (await fresh.getDraft(TOKEN))!;
    expect(now).toEqual(was);
    // The queue came with it, so the work continues rather than starting again: one
    // submit for the response the device had already created, and the same client id.
    expect(now.outbox.submit).not.toBeNull();
    const calls: string[] = [];
    await runSync(
      fresh,
      TOKEN,
      transport({
        start: async (_t, clientId) => {
          calls.push(`start:${clientId}`);
          return { responseId: 'srv-1', status: 'in_progress' };
        },
        submit: async () => {
          calls.push('submit');
          return { status: 'submitted' };
        },
      }),
      ctx(),
    );
    expect(calls).toEqual([`start:${was.clientId}`, 'submit']);
    expect((await fresh.getDraft(TOKEN))!.status).toBe('submitted');
  });

  it('never replaces newer answers with an older copy', async () => {
    const store = memoryStore();
    const current = draftWith({ answers: { score: 99 }, updatedAt: '2026-10-14T10:00:00.000Z' });
    await store.putDraft(current);
    const older = buildBackup(draftWith({ answers: { score: 1 }, updatedAt: '2026-10-14T09:00:00.000Z' }));

    const result = await restoreBackup(store, JSON.stringify(older), TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('already holds answers newer');
    expect((await store.getDraft(TOKEN))!.answers).toEqual({ score: 99 });
  });
});
