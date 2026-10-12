import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { evaluateForm, runExpression, truthy, type FormDefinition } from '@inicio/engine';
import { pool } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError, withCollector, type ResolvedLink } from './db.js';

/**
 * Public collection. Nothing here requires a session — the bearer token *is* the
 * authorisation, which is why only its hash is stored and why every query below is
 * confined by the collector policies to one response in one organisation.
 *
 * The server is the authority for logic: answers are re-evaluated here with the same
 * engine the browser uses, required-but-unanswered questions block submission, hidden
 * questions are stored as null rather than silently kept, and calculated values are
 * stored so an export never depends on a client having computed them.
 */

const answersSchema = z.record(z.string(), z.unknown());
const saveSchema = z.object({
  answers: answersSchema.default({}),
  /** Panel links carry an opaque id/ticket from the query string. */
  embedded: z.record(z.string(), z.unknown()).optional(),
});

function resolveToken(token: string): Promise<ResolvedLink | null> {
  return pool
    .query<ResolvedLink>(`SELECT * FROM app_resolve_dist_link($1)`, [sha256Hex(token)])
    .then(({ rows }) => rows[0] ?? null);
}

async function requireLink(token: string): Promise<ResolvedLink> {
  const link = await resolveToken(token);
  // Unknown and malformed tokens are indistinguishable to the caller.
  //
  // The messages here reach a *respondent*, not a developer: no codes, no
  // technical nouns, and each one tells the person holding the link what to do
  // next. The machine-readable `code` is unchanged, so the browser can still
  // branch on it.
  if (!link) throw new HttpError(404, 'link_not_found', 'This survey link is not valid. Please check you copied it in full.');
  if (!link.active) throw new HttpError(410, 'link_inactive', 'This survey link has been closed. Please contact the person who shared it.');
  if (link.expires_at && link.expires_at.getTime() <= Date.now()) {
    throw new HttpError(410, 'link_expired', 'This survey link has expired. Please ask for a new one.');
  }
  if (link.max_uses !== null && link.uses >= link.max_uses) {
    throw new HttpError(410, 'link_exhausted', 'This survey link has already been used the maximum number of times.');
  }
  if (link.kind === 'single_use' && link.uses >= 1) throw new HttpError(410, 'link_already_used', 'This survey link has already been used.');
  return link;
}

interface VersionForCollect {
  id: string;
  version: number;
  title: string;
  definition: FormDefinition;
}

async function publishedVersionOf(client: PoolClient, link: ResolvedLink): Promise<VersionForCollect> {
  const { rows } = await client.query<VersionForCollect>(
    `SELECT id, version, title, definition FROM form_version
      WHERE form_id = $1 AND status = 'published'`,
    [link.form_id],
  );
  const version = rows[0];
  if (!version) throw new HttpError(409, 'not_published', 'This survey is not open yet. Please try again later, or contact the person who shared this link.');
  return version;
}

/**
 * Applies the definition to the submitted answers, server-side.
 * Returns the values to persist (hidden questions become null, calculated questions
 * become the computed value) plus anything that must block submission.
 */
function applyDefinition(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): { values: Record<string, unknown>; missing: string[]; invalid: string[] } {
  const evaluation = evaluateForm(definition, answers);
  const values: Record<string, unknown> = {};
  for (const question of definition.questions) {
    const state = evaluation.states[question.name];
    if (!state || !state.visible) {
      // A skipped question is stored as null: "not asked" is a fact the codebook
      // documents, and keeping a stale value would make exports lie.
      values[question.name] = null;
      continue;
    }
    values[question.name] = state.value;
  }
  return { values, missing: evaluation.missing, invalid: evaluation.invalid };
}

/** Quotas count on submission, and are allowed to overshoot under concurrency. */
async function applyQuotas(
  client: PoolClient,
  formId: string,
  values: Record<string, unknown>,
): Promise<'quota_full' | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    target: number;
    count: number;
    action: string;
    condition: { question?: string; equals?: unknown } | null;
  }>(`SELECT id, name, target, count, action, condition FROM quota WHERE form_id = $1 FOR UPDATE`, [formId]);

  let full: 'quota_full' | null = null;
  for (const quota of rows) {
    const condition = quota.condition;
    const matches =
      !condition || (condition.question !== undefined && values[condition.question] === condition.equals);
    if (!matches) continue;
    const next = quota.count + 1;
    await client.query(`UPDATE quota SET count = $2 WHERE id = $1`, [quota.id, next]);
    // `hide_block` hides a section rather than ending the survey, so it does not
    // change the response status.
    if (next > quota.target && quota.action !== 'hide_block') full = 'quota_full';
  }
  return full;
}

function screenedOut(definition: FormDefinition, values: Record<string, unknown>): boolean {
  for (const trigger of definition.triggers ?? []) {
    if (trigger.type !== 'complete' || !trigger.when) continue;
    try {
      if (truthy(runExpression(trigger.when, { answers: values }))) return true;
    } catch {
      // A trigger the engine cannot read must not silently end a survey.
      continue;
    }
  }
  return false;
}

async function writeAnswers(client: PoolClient, orgId: string, responseId: string, values: Record<string, unknown>): Promise<void> {
  for (const [questionId, value] of Object.entries(values)) {
    await client.query(
      `INSERT INTO response_answer (org_id, response_id, question_id, value)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (response_id, question_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [orgId, responseId, questionId, JSON.stringify(value ?? null)],
    );
  }
}

export const platformCollectRoutes: FastifyPluginAsync = async (app) => {
  /** What the renderer needs before a response exists. */
  app.get('/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const link = await requireLink(req.params.token);
    const payload = await withCollector(link.org_id, null, async (client) => {
      const version = await publishedVersionOf(client, link);
      return {
        link: { kind: link.kind, id: link.id },
        form: { id: link.form_id, title: version.title, version: version.version, definition: version.definition },
      };
    });
    reply.header('cache-control', 'no-store');
    return reply.send(payload);
  });

  /** Start (or resume) a response. */
  app.post(
    '/:token/responses',
    async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = saveSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const responseId = randomUUID();

      const payload = await withCollector(link.org_id, responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        await client.query(
          `INSERT INTO response (id, org_id, form_id, form_version_id, status, meta, respondent_ref)
           VALUES ($1, $2, $3, $4, 'in_progress', $5::jsonb, $6)`,
          [
            responseId,
            link.org_id,
            link.form_id,
            version.id,
            JSON.stringify(body.data.embedded ?? {}),
            typeof body.data.embedded?.['pid'] === 'string' ? String(body.data.embedded['pid']) : null,
          ],
        );
        if (Object.keys(body.data.answers).length > 0) {
          const { values } = applyDefinition(version.definition, body.data.answers);
          await writeAnswers(client, link.org_id, responseId, values);
        }
        return { responseId, form: { title: version.title, version: version.version, definition: version.definition } };
      });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(payload);
    },
  );

  /** Resume: the saved answers, so an abandoned interview is recoverable. */
  app.get(
    '/:token/responses/:responseId',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const payload = await withCollector(link.org_id, req.params.responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        const { rows: response } = await client.query<{ status: string; started_at: Date; submitted_at: Date | null }>(
          `SELECT status, started_at, submitted_at FROM response WHERE id = $1`,
          [req.params.responseId],
        );
        if (!response[0]) throw new HttpError(404, 'not_found');
        const { rows: answers } = await client.query<{ question_id: string; value: unknown }>(
          `SELECT question_id, value FROM response_answer WHERE response_id = $1`,
          [req.params.responseId],
        );
        return {
          responseId: req.params.responseId,
          status: response[0].status,
          startedAt: response[0].started_at,
          submittedAt: response[0].submitted_at,
          answers: Object.fromEntries(answers.map((a) => [a.question_id, a.value])),
          form: { title: version.title, version: version.version, definition: version.definition },
        };
      });
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );

  /** Partial save. Saved on every section transition and on field blur. */
  app.patch(
    '/:token/responses/:responseId',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = saveSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const payload = await withCollector(link.org_id, req.params.responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM response WHERE id = $1`,
          [req.params.responseId],
        );
        if (!rows[0]) throw new HttpError(404, 'not_found');
        if (rows[0].status !== 'in_progress') throw new HttpError(409, 'already_submitted');

        const { values, missing, invalid } = applyDefinition(version.definition, body.data.answers);
        await writeAnswers(client, link.org_id, req.params.responseId, values);
        return { saved: Object.keys(values).length, missing, invalid };
      });
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );

  /** Submit. This is where required answers and quotas are enforced. */
  app.post(
    '/:token/responses/:responseId/submit',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = saveSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const payload = await withCollector(link.org_id, req.params.responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        // Lock the response so a double-submit cannot run the quota path twice.
        const { rows: locked } = await client.query<{ status: string }>(
          `SELECT status FROM response WHERE id = $1 FOR UPDATE`,
          [req.params.responseId],
        );
        if (!locked[0]) throw new HttpError(404, 'not_found');
        if (locked[0].status !== 'in_progress') throw new HttpError(409, 'already_submitted');

        const { values, missing, invalid } = applyDefinition(version.definition, body.data.answers);
        if (missing.length > 0 || invalid.length > 0) {
          // Nothing is written: an invalid submission must not leave half a response.
          throw new HttpError(
            422,
            'incomplete',
            JSON.stringify({ missing, invalid, message: 'required or invalid answers block submission' }),
          );
        }

        await writeAnswers(client, link.org_id, req.params.responseId, values);

        const quotaStatus = await applyQuotas(client, link.form_id, values);
        const status = quotaStatus ?? (screenedOut(version.definition, values) ? 'screened_out' : 'submitted');

        const { rows: updated } = await client.query<{ uses: number | null }>(
          `SELECT app_consume_dist_link($1) AS uses`,
          [link.id],
        );
        if (updated[0]?.uses === null || updated[0]?.uses === undefined) {
          // The link was exhausted between the check above and here.
          throw new HttpError(410, 'link_exhausted');
        }

        await client.query(`UPDATE response SET status = $2, submitted_at = now() WHERE id = $1`, [
          req.params.responseId,
          status,
        ]);
        return { responseId: req.params.responseId, status, answered: Object.keys(values).length };
      });

      await pool.query(`UPDATE dist_invite SET status = 'finished' WHERE dist_link_id = $1 AND status <> 'finished'`, [
        link.id,
      ]);
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );
};
