import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimitPlugin from '@fastify/rate-limit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type Pool } from 'pg';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import {
  PostgresRateLimitStore,
  rateLimitKey,
  rateLimitSubjectHash,
  registerDurableLimit,
  type RateLimitCount,
} from '../src/lib/rate-limit.js';
import { createOrgFor, createPublishedForm, signInPlatform, uniqueEmail } from './helpers/fixtures.js';

/**
 * The durable rate limiter (SR-7).
 *
 * The property under test is not "requests are counted" — the plugin's own in-memory
 * store does that, and does it correctly. It is that the count survives: across two
 * store objects, across two app instances, and therefore across a rolling restart or a
 * serverless process recycling between requests. A test that only drove one app instance
 * would pass just as happily against the store this replaced, so every durability claim
 * below is made against a *second* instance reading the same database.
 *
 * The other two claims here are the ones a rate limiter gets wrong quietly: the table
 * holds no address or token (only a salted hash of one), and a database that cannot
 * answer fails open with a loud line rather than taking the API down.
 */

const definition: FormDefinition = {
  title: 'Rate limited form',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [{ id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true }],
  choiceLists: {},
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** The suite shares one database, so each test starts from an empty counter table. */
afterEach(async () => {
  await adminQuery('DELETE FROM rate_limit_counter', []);
});

/** Reads and writes the table the API would never expose, to assert what it holds. */
async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

type CounterRow = {
  namespace: string;
  key_hash: string;
  count: number;
  window_ms: string;
  reset_at: Date;
};

function counters(): Promise<CounterRow[]> {
  return adminQuery<CounterRow>(
    `SELECT namespace, key_hash, count, window_ms, reset_at FROM rate_limit_counter ORDER BY namespace, key_hash`,
    [],
  );
}

/** The store's `incr` is a callback API (that is what the plugin calls). */
function incr(store: PostgresRateLimitStore, key: string, windowMs = 60_000): Promise<RateLimitCount> {
  return new Promise((resolve, reject) => {
    store.incr(
      key,
      (error, result) => {
        if (error) reject(error);
        else if (!result) reject(new Error('the store reported no count'));
        else resolve(result);
      },
      windowMs,
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the durable rate limiter', () => {
  it('counts in the database, so a second store sees the requests the first one counted', async () => {
    const first = new PostgresRateLimitStore({});
    const second = new PostgresRateLimitStore({});
    const key = rateLimitKey('ip', '198.51.100.9');

    expect((await incr(first, key)).current).toBe(1);
    expect((await incr(first, key)).current).toBe(2);
    // A different object, in the same process here but in another process in production:
    // it has no memory of the two requests above, and still counts the third.
    expect((await incr(second, key)).current).toBe(3);

    const rows = await counters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });

  it('counts concurrent requests once each', async () => {
    const store = new PostgresRateLimitStore({});
    const key = rateLimitKey('ip', '198.51.100.10');

    const counts = await Promise.all(Array.from({ length: 10 }, () => incr(store, key)));
    // Every one of the ten increments landed: no lost update from the read-then-write
    // shape a limiter tempts you into.
    expect(Math.max(...counts.map((c) => c.current))).toBe(10);
    const rows = await counters();
    expect(rows[0]!.count).toBe(10);
  });

  it('reuses a window instead of opening a new one, and reports the time left', async () => {
    const store = new PostgresRateLimitStore({});
    const key = rateLimitKey('ip', '198.51.100.11');

    const first = await incr(store, key, 40);
    expect(first.current).toBe(1);
    expect(first.ttl).toBeGreaterThan(0);
    expect(first.ttl).toBeLessThanOrEqual(40);

    expect((await incr(store, key, 40)).current).toBe(2);

    await sleep(80);
    const reopened = await incr(store, key, 40);
    expect(reopened.current).toBe(1);
    // One row for the bucket, not one per window: an expired window is taken over where
    // it lies rather than accumulating rows for every minute of every address.
    const rows = await counters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.window_ms).toBe('40');
  });

  it('stores a salted hash, never the address or the token', async () => {
    const store = new PostgresRateLimitStore({});
    const token = 'tok_do_not_store_me_4d2f';
    await incr(store, rateLimitKey('link', token));

    const rows = await counters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.namespace).toBe('link');
    expect(rows[0]!.key_hash).toBe(rateLimitSubjectHash(token));
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    // Salted, so the subject cannot be recognised out of the table by hashing it by
    // hand the way an unsalted digest would let anyone do.
    const unsalted = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(rows[0]!.key_hash).not.toBe(unsalted);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('holds a ceiling across a restart, and keeps one link out of another', async () => {
    /* Two app instances over one database: the second is what a restarted process (or a
       different serverless function) looks like. */
    const instance = async (): Promise<FastifyInstance> => {
      const server = Fastify({ trustProxy: true });
      await registerDurableLimit(server, {
        max: 3,
        namespace: 'link',
        subject: (req) => (req.params as { token?: string }).token ?? 'unknown',
      });
      server.get('/collect/:token', async () => ({ ok: true }));
      await server.ready();
      return server;
    };

    const before = await instance();
    for (const expected of [200, 200, 200]) {
      const res = await before.inject({ method: 'GET', url: '/collect/tok-a' });
      expect(res.statusCode, res.body).toBe(expected);
    }
    const refused = await before.inject({ method: 'GET', url: '/collect/tok-a' });
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another link is untouched by the first one's flood.
    expect((await before.inject({ method: 'GET', url: '/collect/tok-b' })).statusCode).toBe(200);

    const after = await instance();
    // The restarted instance has counted nothing itself, and refuses anyway. This is the
    // acceptance criterion: the ceiling survives a rolling restart.
    const stillRefused = await after.inject({ method: 'GET', url: '/collect/tok-a' });
    expect(stillRefused.statusCode).toBe(429);
    // ... and a link that was never used is still welcome on the new instance.
    expect((await after.inject({ method: 'GET', url: '/collect/tok-c' })).statusCode).toBe(200);

    const rows = await counters();
    expect(rows.map((r) => r.namespace)).toEqual(['link', 'link', 'link']);
    // Five requests reached the counter: three allowed, one refused, and one more
    // refused on the restarted instance. A refusal is counted too, which is what keeps
    // a flooder's window rolling rather than letting it slide out of the limit.
    expect(rows.find((r) => r.key_hash === rateLimitSubjectHash('tok-a'))?.count).toBe(5);

    await before.close();
    await after.close();
  });

  it('fails open, and says so, when the counter cannot be read', async () => {
    class UnreachableStore extends PostgresRateLimitStore {
      constructor(params: unknown) {
        super(params, {
          db: {
            query: () => Promise.reject(new Error('connection terminated unexpectedly')),
          } as unknown as Pick<Pool, 'query'>,
        });
      }
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = Fastify({ trustProxy: true });
      await server.register(rateLimitPlugin, {
        max: 1,
        timeWindow: '1 minute',
        store: UnreachableStore,
        skipOnError: true,
      });
      server.get('/thing', async () => ({ ok: true }));
      await server.ready();

      // The ceiling is 1 and nothing is being counted: that is the intended trade. A
      // database that cannot answer must not become a total outage, so the requests are
      // allowed rather than refused.
      expect((await server.inject({ method: 'GET', url: '/thing' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/thing' })).statusCode).toBe(200);

      // Failing open is silent in the plugin, so the store logs it. Without this line
      // a broken limiter looks exactly like a working one.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('the durable counter could not be read');
      expect(warn.mock.calls[0]?.[0]).toContain('connection terminated unexpectedly');
      expect(await counters()).toHaveLength(0);

      await server.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('sweeps windows that are over and leaves the live ones alone', async () => {
    await adminQuery(
      `INSERT INTO rate_limit_counter (namespace, key_hash, window_ms, count, reset_at)
       VALUES ('ip', 'over', 60000, 1, clock_timestamp() - interval '2 hours'),
              ('ip', 'live', 60000, 1, clock_timestamp() + interval '1 minute')`,
      [],
    );

    const store = new PostgresRateLimitStore({});
    expect(await store.purgeExpired(60 * 60 * 1000)).toBe(1);

    const rows = await counters();
    expect(rows.map((r) => r.key_hash)).toEqual(['live']);
  });
});

describe('the public collection routes', () => {
  it('count per distribution link, and not anywhere else', async () => {
    await adminQuery('DELETE FROM rate_limit_counter', []);

    // Anything outside the collection plugin must not touch the link namespace: the
    // registration is encapsulated by Fastify, and this is the assertion that keeps it
    // that way rather than trusting a probe run once by hand.
    await app.inject({ method: 'GET', url: '/health' });
    expect((await counters()).filter((r) => r.namespace === 'link')).toHaveLength(0);

    const session = await signInPlatform(app, uniqueEmail('ratelimit'));
    const orgId = await createOrgFor(app, session, 'Rate limit org');
    const { formId } = await createPublishedForm(app, session, orgId, 'Rate limited form', definition);
    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: session.cookie },
      payload: { kind: 'anonymous' },
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = (link.json() as { token: string }).token;

    const opened = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(opened.statusCode, opened.body).toBe(200);

    const rows = (await counters()).filter((r) => r.namespace === 'link');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toBe(rateLimitSubjectHash(token));
    expect(rows[0]!.count).toBe(1);
    // The token travelled into the counter and did not land in it.
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.key_hash).not.toContain(token);

    // A responding device streams a handful of these; the ceiling is two orders of
    // magnitude above one interview, so nothing legitimate is refused here.
    const again = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(again.statusCode, again.body).toBe(200);
    expect((await counters()).filter((r) => r.namespace === 'link')[0]!.count).toBe(2);
  });
});
