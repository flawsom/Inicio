import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { HttpError } from './db.js';
import { audit } from './guards.js';
import { requireActor, withActorOrg } from './actors.js';
import { emitWebhook } from './webhooks/dispatch.js';

/**
 * Quality flags: a queue, not a score.
 *
 * The competition's answer to data quality is either a spreadsheet the analyst
 * builds afterwards or a proprietary "quality score" that no one can audit. This
 * is deliberately neither:
 *
 *  * **Every flag says what made it fire.** `detail` carries the observed
 *    duration, the value that repeated, or the id of the response it duplicates.
 *    A flag you cannot argue with is a flag you cannot trust, and an automated
 *    system that hides its reasoning gets switched off within a fortnight.
 *  * **The detectors are pure functions with named thresholds.** They are tested
 *    at the boundary, so "why did this not flag" has an answer that is a number
 *    rather than a shrug.
 *  * **The decision is recorded, not just the detection.** Who resolved it, when,
 *    and what they said. Dismissing a flag is a legitimate outcome; dismissing it
 *    silently is not.
 *  * **Two of the three run at submission, where the evidence is.** The duration,
 *    the answers and the server's own clock are only in one place at one moment.
 *    The third — duplicates — needs to see the whole form, so it is an explicit
 *    scan rather than something that pretends to be real-time.
 */

export const FLAG_KINDS = ['speeding', 'straight_lining', 'duplicate', 'manual'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_KIND_DETAIL: Record<FlagKind, string> = {
  speeding: 'The interview was completed faster than the threshold for its length.',
  straight_lining: 'Most answers share one value, which is what answering without reading looks like.',
  duplicate: 'The answers are identical to another submitted response on the same form.',
  manual: 'Raised by a person.',
};

/** With no per-form threshold configured yet, these are the numbers, stated openly. */
export const SPEED_FLOOR_SECONDS = 20;
export const SPEED_PER_QUESTION_SECONDS = 4;
/** And this is what "most answers are the same" means here. */
export const STRAIGHT_LINE_MIN_ANSWERS = 4;
export const STRAIGHT_LINE_SHARE = 0.8;

export interface DetectedFlag {
  kind: FlagKind;
  severity: 'info' | 'warn' | 'severe';
  questionId: string | null;
  detail: Record<string, unknown>;
}

export interface AnswerRow {
  question_id: string;
  value: unknown;
}

/** Scalar only: an array value cannot be "the same answer" in a meaningful sense. */
function asScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return null;
}

/**
 * Too fast for its length.
 *
 * A threshold *per question* plus a floor rather than one fixed number: three
 * questions in ten seconds is not suspicious, thirty questions in ten seconds is
 * not physically possible while reading.
 */
export function detectSpeeding(durationSeconds: number, answeredCount: number): DetectedFlag | null {
  const threshold = Math.max(SPEED_FLOOR_SECONDS, SPEED_PER_QUESTION_SECONDS * answeredCount);
  if (answeredCount === 0) return null;
  if (durationSeconds >= threshold) return null;
  return {
    kind: 'speeding',
    severity: durationSeconds < threshold / 2 ? 'severe' : 'warn',
    questionId: null,
    detail: {
      durationSeconds: Math.round(durationSeconds),
      thresholdSeconds: threshold,
      answeredQuestions: answeredCount,
      rule: `max(${SPEED_FLOOR_SECONDS}s, ${SPEED_PER_QUESTION_SECONDS}s x questions)`,
    },
  };
}

/**
 * The same answer over and over.
 *
 * Reported with the value that repeated and the questions it repeated across, so
 * a reviewer can open the response and disagree with the rule on the evidence.
 */
export function detectStraightLining(answers: AnswerRow[]): DetectedFlag | null {
  const scalars = answers
    .map((answer) => ({ question_id: answer.question_id, value: asScalar(answer.value) }))
    .filter((answer): answer is { question_id: string; value: string } => answer.value !== null);
  if (scalars.length < STRAIGHT_LINE_MIN_ANSWERS) return null;

  const counts = new Map<string, string[]>();
  for (const answer of scalars) {
    const list = counts.get(answer.value) ?? [];
    list.push(answer.question_id);
    counts.set(answer.value, list);
  }
  const [value, questionIds] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
  const share = questionIds.length / scalars.length;
  if (share < STRAIGHT_LINE_SHARE) return null;

  return {
    kind: 'straight_lining',
    severity: share === 1 && questionIds.length >= 6 ? 'severe' : 'warn',
    questionId: null,
    detail: {
      value,
      share: Number(share.toFixed(2)),
      questionsInLine: questionIds.length,
      answeredQuestions: scalars.length,
      questionIds,
      rule: `${Math.round(STRAIGHT_LINE_SHARE * 100)}% of at least ${STRAIGHT_LINE_MIN_ANSWERS} answers`,
    },
  };
}

/**
 * Write flags, ignoring ones already recorded (the unique index in 0010 is the
 * arbiter, so a re-submit or a sync retry cannot double up), and announce the new
 * ones. Runs on the caller's client: a flag and the response it describes commit
 * together or not at all.
 */
export async function recordFlags(
  client: PoolClient,
  context: { orgId: string; formId: string; responseId: string; userId?: string | null },
  flags: DetectedFlag[],
): Promise<number> {
  let written = 0;
  for (const flag of flags) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO response_flag
         (org_id, form_id, response_id, question_id, kind, severity, detail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (response_id, kind, coalesce(question_id, '')) DO NOTHING
       RETURNING id`,
      [
        context.orgId,
        context.formId,
        context.responseId,
        flag.questionId,
        flag.kind,
        flag.severity,
        JSON.stringify(flag.detail),
        context.userId ?? null,
      ],
    );
    if (rows[0]) {
      written += 1;
      await emitWebhook(client, context.orgId, 'response.flagged', {
        formId: context.formId,
        responseId: context.responseId,
        flagId: rows[0].id,
        kind: flag.kind,
        severity: flag.severity,
      });
    }
  }
  return written;
}

/**
 * The whole-form detector: exact duplicate submissions.
 *
 * It cannot run at submission time — a respondent's transaction may only see its
 * own response (the collector policies in 0003), which is precisely the property
 * that stops a public link from reading other people's data. Seeing the whole form
 * is an organiser's privilege, so this is a scan, and it says so.
 */
async function detectDuplicates(client: PoolClient, formId: string): Promise<number> {
  const { rows } = await client.query<{ duplicate_id: string; original_id: string; sig: string }>(
    `WITH signatures AS (
       SELECT r.id,
              (SELECT md5(string_agg(a.question_id || '=' || coalesce(a.value::text, '~'), '|' ORDER BY a.question_id))
                 FROM response_answer a WHERE a.response_id = r.id) AS sig
         FROM response r
        WHERE r.form_id = $1 AND r.status = 'submitted'
     ), ranked AS (
       SELECT id, sig, row_number() OVER (PARTITION BY sig ORDER BY id) AS rn,
              first_value(id) OVER (PARTITION BY sig ORDER BY id) AS first_id
         FROM signatures
        WHERE sig IS NOT NULL
     )
     SELECT id AS duplicate_id, first_id AS original_id, sig
       FROM ranked
      WHERE rn > 1`,
    [formId],
  );

  let written = 0;
  const { rows: form } = await client.query<{ org_id: string }>(`SELECT org_id FROM form WHERE id = $1`, [
    formId,
  ]);
  const orgId = form[0]?.org_id;
  if (!orgId) return 0;

  for (const row of rows) {
    const flag: DetectedFlag = {
      kind: 'duplicate',
      severity: 'severe',
      questionId: null,
      detail: {
        duplicateOf: row.original_id,
        answersHash: row.sig,
        rule: 'every stored answer pair is identical to another submitted response',
      },
    };
    // `detected_at`-equivalent: a scan is a deliberate act, so it is attributed to
    // nobody and carries no creator. The evidence is the hash, not a person.
    written += await recordFlags(client, { orgId, formId, responseId: row.duplicate_id }, [flag]);
  }
  return written;
}

interface FlagRow {
  id: string;
  form_id: string;
  form_name: string;
  response_id: string;
  question_id: string | null;
  kind: string;
  severity: string;
  detail: Record<string, unknown>;
  status: string;
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

const viewFlag = (row: FlagRow) => ({
  id: row.id,
  formId: row.form_id,
  formName: row.form_name,
  responseId: row.response_id,
  questionId: row.question_id,
  kind: row.kind,
  kindDetail: FLAG_KIND_DETAIL[row.kind as FlagKind] ?? row.kind,
  severity: row.severity,
  detail: row.detail,
  status: row.status,
  note: row.note,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by,
});

const listQuery = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open'),
  formId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const resolveSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(1_000).optional(),
});

export const platformFlagRoutes: FastifyPluginAsync = async (app) => {
  /** The vocabulary, so the console renders a legend without hard-coding it. */
  app.get('/flag-kinds', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req);
    return reply.send({
      kinds: FLAG_KINDS.map((kind) => ({ kind, detail: FLAG_KIND_DETAIL[kind] })),
      thresholds: {
        speeding: `under max(${SPEED_FLOOR_SECONDS}s, ${SPEED_PER_QUESTION_SECONDS}s x answered questions)`,
        straightLining: `${Math.round(STRAIGHT_LINE_SHARE * 100)}% of at least ${STRAIGHT_LINE_MIN_ANSWERS} answers share one value`,
      },
      actor: { via: actor.via },
    });
  });

  /**
   * The queue. Reading it is `flags:read`, which is what a QC pipeline uses to
   * pull the work and a dashboard uses to count it.
   */
  app.get(
    '/orgs/:orgId/flags',
    async (
      req: FastifyRequest<{ Params: { orgId: string }; Querystring: Record<string, string> }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req, { scope: 'flags:read' });
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      const { status, formId, limit } = parsed.data;

      const result = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<FlagRow>(
          `SELECT f.id, f.form_id, fm.name AS form_name, f.response_id, f.question_id, f.kind,
                  f.severity, f.detail, f.status, f.note, f.created_at, f.resolved_at,
                  u.email AS resolved_by
             FROM response_flag f
             JOIN form fm ON fm.id = f.form_id
             LEFT JOIN app_user u ON u.id = f.resolved_by
            WHERE f.org_id = $1
              AND ($2 = 'all' OR f.status = $2)
              AND ($3::uuid IS NULL OR f.form_id = $3)
            ORDER BY CASE f.severity WHEN 'severe' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                     f.created_at DESC
            LIMIT $4`,
          [req.params.orgId, status, formId ?? null, limit],
        );
        const { rows: counts } = await client.query<{ status: string; kind: string; n: number }>(
          `SELECT status, kind, count(*)::int AS n
             FROM response_flag
            WHERE org_id = $1 AND ($2::uuid IS NULL OR form_id = $2)
            GROUP BY status, kind`,
          [req.params.orgId, formId ?? null],
        );
        return { rows, counts };
      });

      return reply.send({
        flags: result.rows.map(viewFlag),
        // Counts by status *and* kind: "three speeding, one duplicate, two open"
        // is the sentence a reviewer actually needs.
        summary: {
          byStatus: Object.fromEntries(
            [...new Set(result.counts.map((c) => c.status))].map((s) => [
              s,
              result.counts.filter((c) => c.status === s).reduce((sum, c) => sum + c.n, 0),
            ]),
          ),
          byKind: Object.fromEntries(
            [...new Set(result.counts.map((c) => c.kind))].map((k) => [
              k,
              result.counts.filter((c) => c.kind === k).reduce((sum, c) => sum + c.n, 0),
            ]),
          ),
          open: result.counts.filter((c) => c.status === 'open').reduce((sum, c) => sum + c.n, 0),
        },
      });
    },
  );

  /** Resolve or dismiss, with the reason kept. */
  app.patch(
    '/orgs/:orgId/flags/:flagId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; flagId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req, { scope: 'flags:write' });
      const parsed = resolveSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const updated = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<FlagRow>(
            `UPDATE response_flag f
                SET status = $3, note = COALESCE($4, f.note), resolved_by = $5, resolved_at = now()
              WHERE f.id = $1 AND f.org_id = $2
              RETURNING f.id, f.form_id, (SELECT name FROM form WHERE id = f.form_id) AS form_name,
                        f.response_id, f.question_id, f.kind, f.severity, f.detail, f.status, f.note,
                        f.created_at, f.resolved_at, (SELECT email FROM app_user WHERE id = $5) AS resolved_by`,
            [req.params.flagId, req.params.orgId, parsed.data.status, parsed.data.note ?? null, actor.userId],
          );
          const flag = rows[0];
          if (!flag) return null;
          await emitWebhook(client, req.params.orgId, 'flag.resolved', {
            formId: flag.form_id,
            responseId: flag.response_id,
            flagId: flag.id,
            status: flag.status,
            note: flag.note,
          });
          return flag;
        },
        { write: true },
      );
      if (!updated) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, `flag.${parsed.data.status}`, updated.id, {
        orgId: req.params.orgId,
        kind: updated.kind,
      });
      return reply.send({ flag: viewFlag(updated) });
    },
  );

  /** Raise one by hand: some findings are judgement, not arithmetic. */
  app.post(
    '/orgs/:orgId/forms/:formId/responses/:responseId/flags',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; responseId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req, { scope: 'flags:write' });
      const parsed = z
        .object({
          questionId: z.string().max(200).optional(),
          severity: z.enum(['info', 'warn', 'severe']).default('warn'),
          note: z.string().trim().min(1).max(1_000),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const written = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string; org_id: string; form_id: string }>(
            `SELECT id, org_id, form_id FROM response WHERE id = $1 AND form_id = $2 AND org_id = $3`,
            [req.params.responseId, req.params.formId, req.params.orgId],
          );
          if (!rows[0]) throw new HttpError(404, 'not_found');
          // The count, not a bare `true`: an identical finding already on the
          // response is refused by the unique index, and answering `queued: true`
          // for a write that did not happen is the kind of small lie that makes a
          // second identical complaint look recorded when it was dropped.
          return recordFlags(
            client,
            {
              orgId: req.params.orgId,
              formId: req.params.formId,
              responseId: req.params.responseId,
              userId: actor.userId,
            },
            [
              {
                kind: 'manual',
                severity: parsed.data.severity,
                questionId: parsed.data.questionId ?? null,
                detail: { note: parsed.data.note, raisedBy: 'a person', rule: 'manual' },
              },
            ],
          );
        },
        { write: true },
      );
      // Nothing recorded means the finding was already there, which is a `200`
      // with the reason stated rather than an audit row claiming a raise.
      if (written === 0) return reply.code(200).send({ queued: false, reason: 'already_recorded' });
      await audit(req, `user:${actor.userId}`, 'flag.raised', req.params.responseId, {
        orgId: req.params.orgId,
        formId: req.params.formId,
      });
      return reply.code(201).send({ queued: true });
    },
  );

  /**
   * Run the whole-form detector. Idempotent: a second run finds nothing new
   * because the unique index refuses to record the same finding twice.
   */
  app.post(
    '/orgs/:orgId/forms/:formId/flags/scan',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req, { scope: 'flags:write' });
      const flagged = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query(`SELECT id FROM form WHERE id = $1 AND org_id = $2`, [
            req.params.formId,
            req.params.orgId,
          ]);
          if (!rows[0]) throw new HttpError(404, 'not_found');
          return detectDuplicates(client, req.params.formId);
        },
        { write: true },
      );
      await audit(req, `user:${actor.userId}`, 'flag.scanned', req.params.formId, {
        orgId: req.params.orgId,
        flagged,
      });
      return reply.send({ flagged });
    },
  );
};

/**
 * The submission-time detectors, in one call, for the collector path.
 *
 * Kept here rather than in collect.ts so the thresholds and the rules live beside
 * the documentation of what they mean.
 */
export async function flagSubmission(
  client: PoolClient,
  context: { orgId: string; formId: string; responseId: string; startedAt: Date; submittedAt: Date },
): Promise<number> {
  const { rows: answers } = await client.query<AnswerRow>(
    `SELECT question_id, value FROM response_answer WHERE response_id = $1`,
    [context.responseId],
  );
  const answered = answers.filter((answer) => asScalar(answer.value) !== null);
  const durationSeconds = (context.submittedAt.getTime() - context.startedAt.getTime()) / 1000;

  const detected: DetectedFlag[] = [];
  const speeding = detectSpeeding(durationSeconds, answered.length);
  if (speeding) detected.push(speeding);
  const lining = detectStraightLining(answers);
  if (lining) detected.push(lining);
  if (detected.length === 0) return 0;

  return recordFlags(client, { ...context, userId: null }, detected);
}

