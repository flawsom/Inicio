import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { APP_VERSION } from '../src/version.js';

/**
 * The version a deployment reports about itself.
 *
 * `/health` used to answer only that the process was up and the database answered. That
 * leaves the first question of any incident unanswered ("is the fix deployed?"), and it
 * is the one question a running service is in the best position to answer. Two things
 * are worth holding down, and neither is "the string exists":
 *
 *   1. the reported version is the version this package publishes. `APP_VERSION` is a
 *      literal because the serverless bundle cannot read `package.json` under its
 *      `rootDir`, so the duplication is the design, and this is what keeps the two
 *      copies from drifting apart unnoticed.
 *   2. a database that does not answer is a **503** carrying the version and the
 *      reason, never a 200 with the bad news in the body: a probe that cannot fail is
 *      not a health check, and a failing one should still say which build is failing.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const published = (): string =>
  (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string })
    .version;

describe('the application version', () => {
  it('is the version this package publishes, so the two copies cannot drift', () => {
    expect(APP_VERSION).toBe(published());
    // A version is only useful if it is unambiguous; `0.1.0` and not `v0.1.0` or a commit
    // hash, because this is the number npm and every release page already use.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('is reported by /health, beside a real database round trip', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { status: string; dbTime: string | null; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe(APP_VERSION);
    // The round trip is still real: a health check that does not touch the database
    // reports the process, not the product.
    expect(typeof body.dbTime).toBe('string');
    expect(Number.isNaN(Date.parse(body.dbTime!))).toBe(false);
  });

  it('is reported even when the database does not answer, and the answer is a failure', async () => {
    // The query is made to reject rather than a dead database being manufactured: the pool
    // holds idle connections, so repointing it at a closed port proves nothing — the query
    // is served by a client that is already connected. The branch under test is the route's
    // own answer when the round trip fails, which is what a probe sees.
    //
    // It rejects *that* statement rather than the next call on the pool, because there is
    // now work of the limiter's own on this path: the durable rate limiter counts every
    // request in PostgreSQL before a route runs (SR-7), so a stub written as "the next pool
    // query fails" is eaten by the counter and this asserts against a healthy database
    // instead of a broken one.
    const { pool } = await import('../src/db/pool.js');
    const answers = pool.query.bind(pool) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    const failing = vi.spyOn(pool, 'query') as unknown as {
      mockImplementation: (implementation: (sql: string, params?: unknown[]) => Promise<unknown>) => void;
      mockRestore: () => void;
    };
    failing.mockImplementation((sql, params) => {
      const statement = typeof sql === 'string' ? sql : String(sql);
      if (statement.includes('SELECT now() AS now')) {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'));
      }
      return answers(statement, params);
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode, response.body).toBe(503);
      const body = response.json() as { status: string; dbTime: null; reason: string; version: string };
      expect(body.status).toBe('degraded');
      expect(body.dbTime).toBeNull();
      // The version is the point: a probe asking "is the fix deployed?" of a deployment
      // whose database is down still gets an answer it can act on.
      expect(body.version).toBe(APP_VERSION);
      expect(body.reason.length).toBeGreaterThan(0);
    } finally {
      failing.mockRestore();
    }
  });
});
