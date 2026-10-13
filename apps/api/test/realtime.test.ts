import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import { diffRevisions, type Revision } from '../src/platform/events.js';
import { createOrgFor, createPublishedForm, signInPlatform, uniqueEmail, type PlatformSession } from './helpers/fixtures.js';

/**
 * The push channel, over a real socket and a real database.
 *
 * The claim being tested is not "an endpoint exists". It is the three things the
 * console now depends on:
 *
 *   1. a quiet form sends nothing, which is what makes the poll removable;
 *   2. a write produces exactly one event naming the aggregate that moved, so the
 *      client refetches one thing rather than four;
 *   3. a form the caller cannot see is closed with a 404, because a stream is a
 *      read and tenancy applies to it the same way it applies to the REST route.
 *
 * The server is actually listening here rather than injected, because the whole
 * point is that bytes arrive over time; `inject` returns one complete response.
 */

const definition: FormDefinition = {
  title: 'Realtime contract',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_name', name: 'name', type: 'text', label: { en: 'Name' }, required: true },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
  ],
  choiceLists: {},
};

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

interface ParsedEvent {
  event: string;
  data: unknown;
}

/**
 * A live SSE connection held open across assertions.
 *
 * One reader for the whole test, deliberately: a stream is a single sequence of
 * bytes over time, and reading it in separate passes either loses frames between
 * them or tries to lock a stream that is still open. `waitFor` reads until the
 * predicate is satisfied or the deadline passes, and a timeout is an answer rather
 * than a failure, which is what lets the test assert that *nothing* arrived.
 */
class EventStream {
  readonly events: ParsedEvent[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly pump: Promise<void>;
  private buffer = '';
  private ended = false;

  constructor(response: Response) {
    if (!response.body) throw new Error('stream had no body');
    this.reader = response.body.getReader();
    // One continuous read loop, started once and never interrupted. Racing a read
    // against a timeout leaves that read pending, and the still-pending read is
    // what consumes the next frame, which silently throws frames away. A real
    // EventSource reads continuously; so does this.
    this.pump = this.read().catch(() => undefined);
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      this.drain();
    }
  }

  private drain(): void {
    let split = this.buffer.indexOf('\n\n');
    if (split === -1 && this.buffer.length > 0 && this.buffer.trim().length === 0) this.buffer = '';
    while (split !== -1) {
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      let name = 'message';
      let data = '';
      let isComment = false;
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) isComment = true;
        else if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      // A comment is a heartbeat: it keeps a connection alive and asserts nothing.
      if (!isComment) this.events.push({ event: name, data: data ? JSON.parse(data) : null });
      split = this.buffer.indexOf('\n\n');
    }
  }

  /** Poll the accumulated frames until the predicate holds or time runs out. */
  async waitFor(predicate: (events: ParsedEvent[]) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.events)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate(this.events);
  }

  get streamEnded(): boolean {
    return this.ended;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
    await this.pump;
  }
}

describe('realtime: the coalescing rule', () => {
  const revision: Revision = {
    responses: '1|2026-01-01',
    analytics: '1|2026-01-01|2026-01-01|0',
    links: '1|0|2026-01-01',
    versions: '1|2026-01-01|2026-01-01',
  };

  it('reports every aggregate on the first read, so a fresh client is never behind', () => {
    expect(diffRevisions(null, revision).sort()).toEqual(['analytics', 'links', 'responses', 'versions']);
  });

  it('reports nothing when nothing moved, which is why a quiet form is free', () => {
    expect(diffRevisions(revision, { ...revision })).toEqual([]);
  });

  it('names only the aggregate that changed, and names all of them when several did', () => {
    expect(diffRevisions(revision, { ...revision, responses: '2|2026-01-02' })).toEqual(['responses']);
    expect(
      diffRevisions(revision, { ...revision, responses: '2|2026-01-02', links: '2|0|2026-01-02' }).sort(),
    ).toEqual(['links', 'responses']);
  });

  it('notices an edit that changes no count at all, which a counter comparison would miss', () => {
    // Same number of responses, same number of answers: only the edit time moved.
    const edited: Revision = { ...revision, analytics: '1|2026-01-01|2026-01-02|0' };
    expect(diffRevisions(revision, edited)).toEqual(['analytics']);
  });
});

describe('realtime: the stream over HTTP', () => {
  let owner: PlatformSession;
  let formId: string;
  let token: string;

  beforeAll(async () => {
    owner = await signInPlatform(app, uniqueEmail('realtime-owner'));
    const orgId = await createOrgFor(app, owner, 'Realtime Org');
    const created = await createPublishedForm(app, owner, orgId, 'Stream contract', definition);
    formId = created.formId;

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'anonymous' },
    });
    expect(link.statusCode, link.body).toBe(201);
    token = (link.json() as { token: string }).token;
  }, 60_000);

  it('opens with ready, stays silent while nothing changes, then names the aggregate that moved', async () => {
    const response = await fetch(`${base}/api/v1/forms/${formId}/events`, {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = new EventStream(response);

    try {
      // 1. It says it is live, and it says so only after it has read a revision.
      expect(await stream.waitFor((events) => events.some((e) => e.event === 'ready'), 6000)).toBe(true);
      expect(stream.events.some((e) => e.event === 'change')).toBe(false);

      // 2. A quiet form pushes nothing. Three ticks is enough to prove the point:
      //    if the server were still polling on the client's behalf it would have
      //    "found" the same revision three times over, and an unconditional
      //    "something may have changed" event would have arrived by now.
      await stream.waitFor((events) => events.some((e) => e.event === 'change'), 4200);
      expect(stream.events.filter((e) => e.event === 'change')).toEqual([]);
      expect(stream.streamEnded).toBe(false);

      // 3. A write. This is the exact call the collection app makes to start a
      //    response, so the event proves the real write path reaches the stream.
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/collect/${token}/responses`,
        payload: { clientId: '3f1d9c62-6a1b-4f5a-9d2e-8c7b6a5f4e3d' },
      });
      expect(started.statusCode, started.body).toBe(201);

      const saw = await stream.waitFor((events) => events.some((e) => e.event === 'change'), 8000);
      expect(saw, `stream events: ${JSON.stringify(stream.events)}`).toBe(true);
      const event = stream.events.find((e) => e.event === 'change');
      // The event carries the aggregate names and nothing else: it is a signal to
      // refetch, not a payload assembled somewhere it could go stale.
      expect((event?.data as { aggregates: string[] }).aggregates).toContain('responses');
      expect((event?.data as { aggregates: string[] }).aggregates).toContain('analytics');
      expect(Object.keys(event?.data as object).sort()).toEqual(['aggregates', 'at']);
    } finally {
      await stream.close();
    }
  }, 40_000);

  it('refuses the stream for a form the caller cannot see, with a 404 and no stream at all', async () => {
    const stranger = await signInPlatform(app, uniqueEmail('realtime-stranger'));
    const response = await fetch(`${base}/api/v1/forms/${formId}/events`, {
      headers: { cookie: stranger.cookie },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    const body = (await response.json()) as { error: string };
    // Not a 403: whether somebody else's organisation exists is not this caller's
    // business to probe.
    expect(body.error).toBe('not_found');
  }, 30_000);

  it('refuses an unauthenticated stream', async () => {
    const response = await fetch(`${base}/api/v1/forms/${formId}/events`);
    expect(response.status).toBe(401);
  }, 30_000);
});
