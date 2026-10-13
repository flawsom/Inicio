import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { FormDefinition } from '@inicio/engine';
import { pool } from '../db/pool.js';
import { TEMPLATES } from './templates.js';

/**
 * The public surface.
 *
 * There is exactly one route here, and the reason it exists is the landing page:
 * it needs numbers that are true rather than decorative. So the rule for this file
 * is strict, and it is the rule the whole project is built on (SPEC 0.2: nothing
 * is ever mock):
 *
 *   - every value is read from the live database or derived from real content in
 *     this repository, in the request that serves it;
 *   - nothing here is tenant data. No form, no response, no organisation, no
 *     count of any of them, and no identifier that could be probed. A visitor
 *     learns what the software is and that it is answering, and nothing about
 *     who is using it.
 *
 * The template library is the one piece of content, and it is public by design:
 * templates ship with the source and go through the same publish-time analyser
 * as a form an author writes by hand. The engine facts are *derived by walking
 * those real definitions*, not from a hand-maintained list of capabilities that
 * would drift the first time a type was added.
 */

export interface TemplateSummary {
  id: string;
  title: string;
  description: string;
  questionCount: number;
  groupCount: number;
  languages: string[];
  /** Question types this template actually uses, in first-appearance order. */
  questionTypes: string[];
}

interface DatabaseFacts {
  /** Round trip of a real query, measured by this request. */
  latencyMs: number;
  serverTime: string;
  version: string;
  startedAt: string;
  /** `schema_migrations` is the ledger the migration runner writes. */
  migrationsApplied: number;
  latestMigration: string | null;
  listening: boolean;
}

function summarizeTemplate(definition: FormDefinition, id: string, title: string, description: string): TemplateSummary {
  const types: string[] = [];
  for (const question of definition.questions) {
    if (!types.includes(question.type)) types.push(question.type);
  }
  return {
    id,
    title,
    description,
    questionCount: definition.questions.length,
    groupCount: definition.groups.length,
    languages: definition.languages,
    questionTypes: types,
  };
}

/**
 * Why one query and not four: this endpoint is public and therefore the easiest
 * thing in the service to hammer, so the cost of answering it is one round trip.
 * The latency reported is the duration of the round trip that produced the
 * numbers, which is the only honest way to report it.
 */
async function readDatabaseFacts(): Promise<DatabaseFacts> {
  const started = process.hrtime.bigint();
  const { rows } = await pool.query<{
    server_time: Date;
    version: string;
    started_at: Date;
    migrations: number;
    latest: string | null;
  }>(
    `SELECT now()                                   AS server_time,
            current_setting('server_version')       AS version,
            pg_postmaster_start_time()              AS started_at,
            (SELECT count(*)::int FROM schema_migrations)      AS migrations,
            (SELECT max(name) FROM schema_migrations)          AS latest`,
  );
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
  const row = rows[0];
  if (!row) throw new Error('database returned no rows');
  return {
    latencyMs: Math.round(latencyMs * 100) / 100,
    serverTime: row.server_time.toISOString(),
    version: row.version,
    startedAt: row.started_at.toISOString(),
    migrationsApplied: row.migrations,
    latestMigration: row.latest,
    listening: true,
  };
}

export const platformPublicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/public/summary', async (_req: FastifyRequest, reply: FastifyReply) => {
    const templates = TEMPLATES.map((t) =>
      summarizeTemplate(t.definition, t.id, t.title, t.description),
    );

    // The engine facts are counted across the real templates rather than declared.
    const usedTypes = new Set<string>();
    let questions = 0;
    let groups = 0;
    for (const t of templates) {
      t.questionTypes.forEach((type) => usedTypes.add(type));
      questions += t.questionCount;
      groups += t.groupCount;
    }

    const database = await readDatabaseFacts();

    // A landing page that shows a live query time is only honest if it cannot be
    // cached into a fixed number, so this is explicitly never stored.
    reply.header('cache-control', 'no-store');
    return reply.send({
      generatedAt: new Date().toISOString(),
      database,
      templates,
      engine: {
        questionTypesInUse: [...usedTypes].sort(),
        templateQuestions: questions,
        templateGroups: groups,
      },
    });
  });
};
