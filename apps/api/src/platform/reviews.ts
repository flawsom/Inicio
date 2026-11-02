import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { FormDefinition, Question } from '@inicio/engine';
import { HttpError } from './db.js';
import { audit } from './guards.js';
import { requireActor, withActorOrg, type ApiActor } from './actors.js';

/**
 * Review and correction: the judgement after the interview.
 *
 * A response is evidence, not a draft. A correction therefore never overwrites
 * the original silently: the previous value is copied into an append-only
 * `review_log` row, the current answer is changed, and the state says who decided
 * and when. The log is append-only in the database, not by convention, so a later
 * request cannot rewrite the history of an earlier one.
 *
 * The queue is session-only. It exposes free text, enumerator identity and the
 * answers themselves, which is a different risk from the scoped machine API.
 */

const ACTIONS = ['claim', 'comment', 'approve', 'reject', 'reopen'] as const;

type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';
type ReviewAction = (typeof ACTIONS)[number];

interface ReviewRow {
  id: string;
  status: string;
  review_state: ReviewState;
  review_claimed_by: string | null;
  claimed_by_email: string | null;
  review_claimed_at: Date | null;
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  started_at: Date;
  submitted_at: Date | null;
  duration_seconds: string | number | null;
  enumerator_ref: string | null;
  caseid: string | null;
  form_version: number;
  form_version_id: string;
  flag_count: number;
  severe_flag_count: number;
  open_flag_count: number;
  answer_count: number;
}

interface DetailRow extends ReviewRow {
  definition: FormDefinition;
}

function stateOf(row: ReviewRow): ReviewState {
  return row.review_state;
}

function view(row: ReviewRow) {
  return {
    id: row.id,
    status: row.status,
    reviewState: stateOf(row),
    claimedBy: row.claimed_by_email,
    claimedById: row.review_claimed_by,
    claimedAt: row.review_claimed_at,
    reviewedBy: row.reviewed_by_email,
    reviewedById: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    enumeratorRef: row.enumerator_ref,
    caseid: row.caseid,
    formVersion: row.form_version,
    formVersionId: row.form_version_id,
    flags: {
      total: Number(row.flag_count),
      severe: Number(row.severe_flag_count),
      open: Number(row.open_flag_count),
    },
    answerCount: Number(row.answer_count),
  };
}

const listQuery = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'none', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const actionSchema = z.object({
  action: z.enum(ACTIONS),
  note: z.string().trim().max(2_000).optional(),
});

const correctionSchema = z.object({
  questionId: z.string().min(1).max(200),
  /** The value the reviewer saw. When present, a changed answer is a stale correction. */
  from: z.unknown().optional(),
  to: z.unknown(),
  reason: z.string().trim().max(500).optional(),
});

const correctionsSchema = z.object({
  corrections: z.array(correctionSchema).min(1).max(50),
  note: z.string().trim().max(2_000).optional(),
});

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function choiceValues(definition: FormDefinition, question: Question): string[] {
  const list = question.choices?.listName
    ? definition.choiceLists[question.choices.listName]
    : question.choices?.inline;
  return (list ?? []).map((choice) => String(choice.value));
}

function dynamicChoice(question: Question): boolean {
  return Boolean(question.appearance && /\bsearch\s*\(/.test(question.appearance));
}

/**
 * The correction is validated against the published definition, not against the
 * table. A value a question cannot produce is refused before it reaches an export.
 */
function answerIssue(definition: FormDefinition, question: Question, value: unknown): string | null {
  if (question.rules?.calculate) return 'a calculated answer is derived, not corrected';
  if (question.type === 'note') return 'a note has no answer to correct';

  if (value === null || value === undefined || value === '') {
    if (question.required === true) return 'a required answer cannot be cleared';
    return null;
  }

  switch (question.type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? null : 'an integer is required';
    case 'decimal':
    case 'percentage':
    case 'currency':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'a number is required';
    case 'yesno':
      return ['yes', 'no', '1', '0', true, false].includes(value as string | boolean) ? null : 'yes or no is required';
    case 'select_one': {
      if (typeof value !== 'string' || value.trim() === '') return 'a choice value is required';
      if (dynamicChoice(question)) return null;
      return choiceValues(definition, question).includes(value) ? null : `"${value}" is not a choice of this question`;
    }
    case 'select_multiple':
    case 'rank': {
      if (!Array.isArray(value)) return 'a list of choices is required';
      const allowed = new Set(choiceValues(definition, question));
      for (const item of value) {
        if (typeof item !== 'string' || (!dynamicChoice(question) && !allowed.has(item))) {
          return `"${String(item)}" is not a choice of this question`;
        }
      }
      return null;
    }
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'a date is required';
    case 'time':
      return typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value) ? null : 'a time is required';
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'a date and time are required';
    default:
      return typeof value === 'string' || typeof value === 'number' ? null : 'a text value is required';
  }
}

async function loadResponse(
  client: PoolClient,
  orgId: string,
  formId: string,
  responseId: string,
): Promise<DetailRow> {
  const { rows } = await client.query<DetailRow & { definition: FormDefinition }>(
    `SELECT r.id, r.status, r.review_state, r.review_claimed_by, r.review_claimed_at,
            r.reviewed_by, r.reviewed_at, r.review_note, r.started_at, r.submitted_at,
            r.duration_seconds, r.enumerator_ref, r.caseid, r.form_version_id,
            v.version AS form_version, v.definition,
            (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id) AS flag_count,
            (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id AND f.severity = 'severe') AS severe_flag_count,
            (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id AND f.status = 'open') AS open_flag_count,
            (SELECT count(*)::int FROM response_answer a WHERE a.response_id = r.id) AS answer_count,
            cu.email AS claimed_by_email, ru.email AS reviewed_by_email
       FROM response r
       JOIN form_version v ON v.id = r.form_version_id
       LEFT JOIN app_user cu ON cu.id = r.review_claimed_by
       LEFT JOIN app_user ru ON ru.id = r.reviewed_by
      WHERE r.id = $1 AND r.form_id = $2 AND r.org_id = $3`,
    [responseId, formId, orgId],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found');
  return rows[0];
}

async function loadAnswers(client: PoolClient, responseId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ question_id: string; value: unknown }>(
    `SELECT question_id, value FROM response_answer WHERE response_id = $1 ORDER BY question_id`,
    [responseId],
  );
  return Object.fromEntries(rows.map((row) => [row.question_id, row.value]));
}

async function appendLog(
  client: PoolClient,
  context: { orgId: string; formId: string; responseId: string; actorId: string },
  entry: {
    action: string;
    fromState?: string | null;
    toState?: string | null;
    note?: string | null;
    corrections?: unknown[];
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO review_log
       (org_id, form_id, response_id, action, from_state, to_state, note, corrections, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id`,
    [
      context.orgId,
      context.formId,
      context.responseId,
      entry.action,
      entry.fromState ?? null,
      entry.toState ?? null,
      entry.note ?? null,
      JSON.stringify(entry.corrections ?? []),
      context.actorId,
    ],
  );
  return rows[0]!.id;
}

function actionTargets(row: ReviewRow, action: ReviewAction): ReviewState {
  switch (action) {
    case 'claim':
      if (row.review_state === 'approved' || row.review_state === 'rejected') {
        throw new HttpError(409, 'illegal_transition', 'Reopen the response before claiming it again.');
      }
      return 'pending';
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'reopen':
      return 'pending';
    case 'comment':
      return row.review_state;
  }
}

async function performAction(
  client: PoolClient,
  actor: ApiActor,
  orgId: string,
  formId: string,
  loaded: DetailRow,
  action: ReviewAction,
  note: string | undefined,
): Promise<ReviewState> {
  if (action === 'comment' && !note) {
    throw new HttpError(400, 'note_required', 'A comment needs a note.');
  }
  if (loaded.review_claimed_by && loaded.review_claimed_by !== actor.userId && action !== 'comment') {
    throw new HttpError(409, 'claimed_by_another', 'Another reviewer has claimed this response.');
  }
  if ((action === 'claim' || action === 'approve' || action === 'reject') &&
      loaded.review_state !== 'none' && loaded.review_state !== 'pending') {
    throw new HttpError(409, 'illegal_transition', `This response is already ${loaded.review_state}. Reopen it first.`);
  }
  if (action === 'reopen' && loaded.review_state === 'none') {
    throw new HttpError(409, 'illegal_transition', 'This response has not been reviewed yet.');
  }
  if (action === 'reopen' && loaded.review_state === 'pending' && !loaded.review_claimed_by) {
    throw new HttpError(409, 'illegal_transition', 'This response is already open for review.');
  }

  const next = actionTargets(loaded, action);
  if (action === 'comment') {
    await client.query(`UPDATE response SET review_note = $2 WHERE id = $1`, [loaded.id, note ?? null]);
  } else if (action === 'claim') {
    await client.query(
      `UPDATE response
          SET review_state = 'pending',
              review_claimed_by = $2,
              review_claimed_at = now(),
              review_note = COALESCE($3, review_note)
        WHERE id = $1`,
      [loaded.id, actor.userId, note ?? null],
    );
  } else if (action === 'reopen') {
    await client.query(
      `UPDATE response
          SET review_state = 'pending',
              review_claimed_by = NULL,
              review_claimed_at = NULL,
              reviewed_by = NULL,
              reviewed_at = NULL,
              review_note = COALESCE($2, review_note)
        WHERE id = $1`,
      [loaded.id, note ?? null],
    );
  } else {
    await client.query(
      `UPDATE response
          SET review_state = $2,
              review_claimed_by = NULL,
              review_claimed_at = NULL,
              reviewed_by = $3,
              reviewed_at = now(),
              review_note = COALESCE($4, review_note)
        WHERE id = $1`,
      [loaded.id, next, actor.userId, note ?? null],
    );
  }

  await appendLog(
    client,
    { orgId, formId, responseId: loaded.id, actorId: actor.userId },
    { action, fromState: loaded.review_state, toState: next, note: note ?? null },
  );
  return next;
}

export const platformReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/orgs/:orgId/forms/:formId/review',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string }; Querystring: Record<string, string> }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      const { state, limit, offset } = parsed.data;

      const payload = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<ReviewRow>(
          `SELECT r.id, r.status, r.review_state, r.review_claimed_by, r.review_claimed_at,
                  r.reviewed_by, r.reviewed_at, r.review_note, r.started_at, r.submitted_at,
                  r.duration_seconds, r.enumerator_ref, r.caseid, r.form_version_id,
                  v.version AS form_version,
                  (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id) AS flag_count,
                  (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id AND f.severity = 'severe') AS severe_flag_count,
                  (SELECT count(*)::int FROM response_flag f WHERE f.response_id = r.id AND f.status = 'open') AS open_flag_count,
                  (SELECT count(*)::int FROM response_answer a WHERE a.response_id = r.id) AS answer_count,
                  cu.email AS claimed_by_email, ru.email AS reviewed_by_email
             FROM response r
             JOIN form_version v ON v.id = r.form_version_id
             LEFT JOIN app_user cu ON cu.id = r.review_claimed_by
             LEFT JOIN app_user ru ON ru.id = r.reviewed_by
            WHERE r.org_id = $1 AND r.form_id = $2
              AND ($3 = 'all' OR r.review_state = $3)
            ORDER BY CASE r.review_state WHEN 'pending' THEN 0 WHEN 'none' THEN 1 ELSE 2 END,
                     r.started_at ASC
            LIMIT $4 OFFSET $5`,
          [req.params.orgId, req.params.formId, state, limit, offset],
        );
        const { rows: counts } = await client.query<{
          review_state: string;
          claimed: number;
          total: number;
        }>(
          `SELECT review_state,
                  count(*) FILTER (WHERE review_claimed_by IS NOT NULL)::int AS claimed,
                  count(*)::int AS total
             FROM response
            WHERE org_id = $1 AND form_id = $2
            GROUP BY review_state`,
          [req.params.orgId, req.params.formId],
        );
        return { rows, counts };
      });

      return reply.send({
        responses: payload.rows.map(view),
        summary: Object.fromEntries(payload.counts.map((row) => [row.review_state, {
          total: Number(row.total),
          claimed: Number(row.claimed),
          unclaimed: Number(row.total) - Number(row.claimed),
        }])),
        limit,
        offset,
      });
    },
  );

  app.get(
    '/orgs/:orgId/forms/:formId/review/:responseId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; responseId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const payload = await withActorOrg(actor, req.params.orgId, async (client) => {
        const loaded = await loadResponse(client, req.params.orgId, req.params.formId, req.params.responseId);
        const answers = await loadAnswers(client, loaded.id);
        const { rows: log } = await client.query(
          `SELECT l.id, l.action, l.from_state, l.to_state, l.note, l.corrections,
                  l.created_at, u.email AS actor
             FROM review_log l
             LEFT JOIN app_user u ON u.id = l.actor_id
            WHERE l.response_id = $1
            ORDER BY l.created_at, l.id`,
          [loaded.id],
        );
        const { rows: flags } = await client.query(
          `SELECT id, question_id, kind, severity, detail, status, note, created_at
             FROM response_flag
            WHERE response_id = $1
            ORDER BY CASE severity WHEN 'severe' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, created_at DESC`,
          [loaded.id],
        );
        const { rows: timings } = await client.query(
          `SELECT field_name, total_seconds, first_seen_seconds, visits
             FROM response_field_timing
            WHERE response_id = $1
            ORDER BY field_name`,
          [loaded.id],
        );
        return { response: view(loaded), answers, definition: loaded.definition, log, flags, timings };
      });
      return reply.send(payload);
    },
  );

  app.post(
    '/orgs/:orgId/forms/:formId/review/:responseId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; responseId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = actionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const updated = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const loaded = await loadResponse(client, req.params.orgId, req.params.formId, req.params.responseId);
          const next = await performAction(
            client,
            actor,
            req.params.orgId,
            req.params.formId,
            loaded,
            parsed.data.action,
            parsed.data.note,
          );
          return { ...loaded, review_state: next };
        },
        { write: true },
      );
      await audit(req, `user:${actor.userId}`, `review.${parsed.data.action}`, updated.id, {
        orgId: req.params.orgId,
        formId: req.params.formId,
        to: updated.review_state,
      });
      return reply.send({ response: view(updated) });
    },
  );

  app.post(
    '/orgs/:orgId/forms/:formId/review/:responseId/corrections',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; responseId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = correctionsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const result = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const loaded = await loadResponse(client, req.params.orgId, req.params.formId, req.params.responseId);
          if (loaded.status === 'in_progress') {
            throw new HttpError(409, 'not_submitted', 'An interview that is still open cannot be corrected.');
          }
          if (loaded.review_claimed_by && loaded.review_claimed_by !== actor.userId) {
            throw new HttpError(409, 'claimed_by_another', 'Another reviewer has claimed this response.');
          }

          const byName = new Map(loaded.definition.questions.map((question) => [question.name, question]));
          const current = await loadAnswers(client, loaded.id);
          const logCorrections: Array<{ questionId: string; from: unknown; to: unknown; reason?: string }> = [];

          for (const correction of parsed.data.corrections) {
            const question = byName.get(correction.questionId);
            if (!question) throw new HttpError(400, 'unknown_question', `"${correction.questionId}" is not a question in this version.`);
            if (question.type === 'note' || question.rules?.calculate) {
              throw new HttpError(400, 'not_correctable', `"${question.name}" is derived and cannot be corrected.`);
            }
            const issue = answerIssue(loaded.definition, question, correction.to);
            if (issue) throw new HttpError(422, 'invalid_value', `"${question.name}": ${issue}`);
            if (correction.from !== undefined && !jsonEqual(current[question.name], correction.from)) {
              throw new HttpError(
                409,
                'stale_correction',
                `"${question.name}" changed since you opened it. Reload the response before correcting it.`,
              );
            }
            const before = current[question.name] ?? null;
            await client.query(
              `INSERT INTO response_answer (org_id, response_id, question_id, value)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (response_id, question_id)
               DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
              [req.params.orgId, loaded.id, question.name, JSON.stringify(correction.to ?? null)],
            );
            current[question.name] = correction.to ?? null;
            logCorrections.push({
              questionId: question.name,
              from: before,
              to: correction.to ?? null,
              ...(correction.reason ? { reason: correction.reason } : {}),
            });
          }

          const nextState: ReviewState = loaded.review_state === 'none' ? 'pending' : loaded.review_state;
          await client.query(
            `UPDATE response
                SET review_state = $2,
                    reviewed_by = $3,
                    reviewed_at = now(),
                    review_note = COALESCE($4, review_note)
              WHERE id = $1`,
            [loaded.id, nextState, actor.userId, parsed.data.note ?? null],
          );
          // `performAction` is not used here because a correction is its own action
          // with its own evidence, not an approve/reject disguised as a comment.
          await appendLog(
            client,
            { orgId: req.params.orgId, formId: req.params.formId, responseId: loaded.id, actorId: actor.userId },
            {
              action: 'correction',
              fromState: loaded.review_state,
              toState: nextState,
              note: parsed.data.note ?? null,
              corrections: logCorrections,
            },
          );
          return { responseId: loaded.id, reviewState: nextState, corrections: logCorrections, answers: current };
        },
        { write: true },
      );

      await audit(req, `user:${actor.userId}`, 'review.correction', result.responseId, {
        orgId: req.params.orgId,
        formId: req.params.formId,
        count: result.corrections.length,
      });
      return reply.send(result);
    },
  );
};
