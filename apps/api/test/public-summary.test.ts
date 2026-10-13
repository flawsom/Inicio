import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * The one unauthenticated route.
 *
 * Two things about it are worth a test, and neither is "it returns 200".
 *
 *   1. It is live. The landing page prints the round trip and the server's clock,
 *      and both are only worth printing if they are read in the request that serves
 *      them. A cached or hard-coded answer would still look plausible on screen, so
 *      the assertion here is that two calls disagree in the ways a real read does.
 *
 *   2. It is not tenant data. The shape is asserted exactly, key by key, because the
 *      failure mode is not a wrong number: it is a form, an organisation or a count
 *      of either leaking onto a public page. A visitor learns what the software is
 *      and that it is answering, and nothing about who is using it.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface Summary {
  generatedAt: string;
  database: {
    latencyMs: number;
    serverTime: string;
    version: string;
    startedAt: string;
    migrationsApplied: number;
    latestMigration: string | null;
    listening: boolean;
  };
  templates: Array<{
    id: string;
    title: string;
    description: string;
    questionCount: number;
    groupCount: number;
    languages: string[];
    questionTypes: string[];
  }>;
  engine: {
    questionTypesInUse: string[];
    templateQuestions: number;
    templateGroups: number;
  };
}

async function readSummary(): Promise<Summary> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/public/summary' });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Summary;
}

describe('the public summary', () => {
  it('answers without a session, and refuses to be stored', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/summary' });
    expect(response.statusCode, response.body).toBe(200);
    // The whole point of the figure is that it was measured now, so a cached copy
    // would be a lie with a timestamp on it.
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('reports a real round trip and the database it actually reached', async () => {
    const summary = await readSummary();

    expect(Number.isFinite(summary.database.latencyMs)).toBe(true);
    expect(summary.database.latencyMs).toBeGreaterThan(0);
    expect(summary.database.migrationsApplied).toBeGreaterThanOrEqual(9);
    expect(summary.database.latestMigration).toMatch(/^\d{4}_/);
    expect(summary.database.listening).toBe(true);

    const serverTime = new Date(summary.database.serverTime).getTime();
    expect(Number.isNaN(serverTime)).toBe(false);
    // Read in this request, not baked in at build time: the database's clock is
    // within a minute of the clock of the machine running the test.
    expect(Math.abs(Date.now() - serverTime)).toBeLessThan(60_000);

    const uptimeMs = Date.now() - new Date(summary.database.startedAt).getTime();
    expect(uptimeMs).toBeGreaterThan(0);
  });

  it('says something different on the second read, which is what makes it live', async () => {
    const first = await readSummary();
    // Far enough apart that the database's own clock — `now()`, read in the request
    // that serves the response, with millisecond resolution in the JSON — must have
    // moved. A remembered answer would repeat that instant exactly.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await readSummary();

    expect(new Date(second.database.serverTime).getTime()).toBeGreaterThan(
      new Date(first.database.serverTime).getTime(),
    );
    expect(new Date(second.generatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.generatedAt).getTime());

    // The round trip is measured per request, not remembered. It is deliberately
    // rounded to 1/100 ms, so two quick reads *may* report the same figure — that is a
    // property of the rounding rather than evidence of a cache, which is why the clock
    // above carries this assertion and the latency only has to be a real measurement.
    // The first version of this test compared the two latency figures for inequality
    // and failed on CI the first time both reads happened to take 0.51 ms.
    expect(first.database.latencyMs).toBeGreaterThan(0);
    expect(second.database.latencyMs).toBeGreaterThan(0);
  });

  it('derives the engine facts by walking the real templates', async () => {
    const summary = await readSummary();

    expect(summary.templates.length).toBeGreaterThan(0);
    for (const template of summary.templates) {
      expect(template.questionCount).toBeGreaterThan(0);
      expect(template.questionTypes.length).toBeGreaterThan(0);
      expect(template.languages.length).toBeGreaterThan(0);
      // A summary that claimed more types than the definition contains would be the
      // kind of capability list that drifts the first time a type is added.
      expect(template.questionCount).toBeLessThanOrEqual(summary.engine.templateQuestions);
    }

    const questions = summary.templates.reduce((total, t) => total + t.questionCount, 0);
    const groups = summary.templates.reduce((total, t) => total + t.groupCount, 0);
    expect(summary.engine.templateQuestions).toBe(questions);
    expect(summary.engine.templateGroups).toBe(groups);

    const declared = [...summary.engine.questionTypesInUse].sort();
    const used = new Set(summary.templates.flatMap((t) => t.questionTypes));
    expect(declared).toEqual([...used].sort());
  });

  it('carries no tenant data at all', async () => {
    const summary = await readSummary();

    // The exact shape, so a field cannot be added to a public page by accident.
    expect(Object.keys(summary).sort()).toEqual(['database', 'engine', 'generatedAt', 'templates']);
    expect(Object.keys(summary.database).sort()).toEqual([
      'latencyMs',
      'latestMigration',
      'listening',
      'migrationsApplied',
      'serverTime',
      'startedAt',
      'version',
    ]);
    expect(Object.keys(summary.engine).sort()).toEqual(['questionTypesInUse', 'templateGroups', 'templateQuestions']);
    for (const template of summary.templates) {
      expect(Object.keys(template).sort()).toEqual([
        'description',
        'groupCount',
        'id',
        'languages',
        'questionCount',
        'questionTypes',
        'title',
      ]);
    }

    // The one thing a visitor must not learn: how many forms, responses or
    // organisations exist, or that any of them do.
    const serialised = JSON.stringify(summary).toLowerCase();
    for (const forbidden of ['org_id', 'organisation_id', 'response_id', 'form_id', 'submitted', 'member']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
