import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  chiSquareTest,
  detectOutliers,
  frequencyReport,
  twoSampleTTest,
  type FormDefinition,
  type Question,
} from '@inicio/engine';
import { HttpError } from './db.js';
import { audit } from './guards.js';
import { requireActor, withActorOrg } from './actors.js';
import { QC_DEFAULTS, recordFlags, type DetectedFlag } from './flags.js';

/**
 * Statistical quality control over the responses a form already holds.
 *
 * Every check is explicit: the IQR multiple, the too-frequent share, the
 * significance level, and the values treated as missing are request parameters
 * with documented defaults. The report is evidence. A flag is a row in the same
 * queue as speeding and straight-lining, which means a reviewer can see it, open
 * the response, and record a decision.
 */

const scanSchema = z.object({
  outlierMultiple: z.number().finite().positive().max(10).default(QC_DEFAULTS.outlierMultiple),
  minShare: z.number().finite().min(0).max(1).default(QC_DEFAULTS.minShare),
  maxShare: z.number().finite().min(0).max(1).default(QC_DEFAULTS.maxShare),
  alpha: z.number().finite().min(0.001).max(0.5).default(QC_DEFAULTS.alpha),
  exclusions: z.array(z.number().finite()).max(20).default([]),
});

interface RawAnswer {
  response_id: string;
  enumerator_ref: string | null;
  question_id: string;
  value: unknown;
}

interface Finding extends DetectedFlag {
  responseId: string;
}

interface NumericPoint {
  responseId: string;
  value: number;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function numericQuestions(definition: FormDefinition): Question[] {
  return definition.questions.filter((question) =>
    ['integer', 'decimal', 'percentage', 'currency'].includes(question.type),
  );
}

function categoricalQuestions(definition: FormDefinition): Question[] {
  return definition.questions.filter((question) => ['select_one', 'yesno'].includes(question.type));
}

/**
 * The scan. `write` is false for the report read, true for the queue action;
 * both use exactly the same arithmetic, so the report cannot describe a different
 * check from the one that produced the flags.
 */
async function runQc(
  client: PoolClient,
  formId: string,
  orgId: string,
  definition: FormDefinition,
  options: z.infer<typeof scanSchema>,
  write: boolean,
): Promise<{ findings: Finding[]; scanned: number; byKind: Record<string, number> }> {
  const { rows } = await client.query<RawAnswer>(
    `SELECT r.id AS response_id, r.enumerator_ref, a.question_id, a.value
       FROM response r
       JOIN response_answer a ON a.response_id = r.id
      WHERE r.form_id = $1 AND r.org_id = $2 AND r.status = 'submitted'
      ORDER BY r.id`,
    [formId, orgId],
  );

  const byQuestion = new Map<string, RawAnswer[]>();
  for (const row of rows) {
    const bucket = byQuestion.get(row.question_id) ?? [];
    bucket.push(row);
    byQuestion.set(row.question_id, bucket);
  }

  const findings: Finding[] = [];
  const add = (responseId: string, flag: DetectedFlag): void => {
    findings.push({ ...flag, responseId });
  };

  for (const question of numericQuestions(definition)) {
    const answers = byQuestion.get(question.name) ?? [];
    const points: NumericPoint[] = answers
      .map((answer) => ({ responseId: answer.response_id, value: numericValue(answer.value) }))
      .filter((point): point is NumericPoint => point.value !== null);
    if (points.length < 4) continue;

    const values = points.map((point) => point.value);
    const outliers = detectOutliers(values, options.outlierMultiple, options.exclusions);
    for (const outlier of outliers.outliers) {
      const point = points[outlier.index];
      if (!point) continue;
      add(point.responseId, {
        kind: 'outlier',
        severity: 'warn',
        questionId: question.name,
        detail: {
          value: outlier.value,
          lowerBound: outliers.lowerBound,
          upperBound: outliers.upperBound,
          q1: outliers.q1,
          q3: outliers.q3,
          iqr: outliers.iqr,
          multiple: options.outlierMultiple,
          n: outliers.n,
          excluded: options.exclusions,
          rule: `outside q1 - ${options.outlierMultiple} * iqr and q3 + ${options.outlierMultiple} * iqr`,
        },
      });
    }

    // An enumerator's mean against everyone else's, for the people who were
    // actually identified. Unassigned interviews are not a group with an identity.
    const groups = new Map<string, NumericPoint[]>();
    for (const answer of answers) {
      if (!answer.enumerator_ref) continue;
      const value = numericValue(answer.value);
      if (value === null) continue;
      const bucket = groups.get(answer.enumerator_ref) ?? [];
      bucket.push({ responseId: answer.response_id, value });
      groups.set(answer.enumerator_ref, bucket);
    }
    if (groups.size >= 2) {
      for (const [enumerator, pointsInGroup] of groups) {
        const rest = [...groups.entries()]
          .filter(([name]) => name !== enumerator)
          .flatMap(([, entries]) => entries);
        if (pointsInGroup.length < 2 || rest.length < 2) continue;
        const test = twoSampleTTest(pointsInGroup.map((point) => point.value), rest.map((point) => point.value), options.alpha);
        if (!test.significant) continue;
        for (const point of pointsInGroup) {
          add(point.responseId, {
            kind: 'group_mean',
            severity: test.p !== null && test.p < 0.01 ? 'severe' : 'warn',
            questionId: question.name,
            detail: {
              enumerator,
              groupMean: test.mean,
              restMean: test.expected,
              t: test.t,
              df: test.df,
              p: test.p,
              alpha: options.alpha,
              test: test.test,
              rule: 'Welch two-sample t test against all other enumerators',
            },
          });
        }
      }
    }
  }

  for (const question of categoricalQuestions(definition)) {
    const answers = (byQuestion.get(question.name) ?? [])
      .map((answer) => ({ responseId: answer.response_id, enumerator: answer.enumerator_ref, value: stringValue(answer.value) }))
      .filter((answer): answer is { responseId: string; enumerator: string | null; value: string } => answer.value !== null);
    if (answers.length < 2) continue;

    const counts: Record<string, number> = {};
    for (const answer of answers) counts[answer.value] = (counts[answer.value] ?? 0) + 1;
    for (const finding of frequencyReport(counts, answers.length, options.minShare, options.maxShare)) {
      for (const answer of answers.filter((candidate) => candidate.value === finding.value)) {
        add(answer.responseId, {
          kind: finding.kind,
          severity: 'warn',
          questionId: question.name,
          detail: {
            value: finding.value,
            count: finding.count,
            share: Number(finding.share.toFixed(4)),
            total: answers.length,
            maxShare: options.maxShare,
            minShare: options.minShare,
            rule: finding.kind === 'too_frequent'
              ? `share >= ${options.maxShare}`
              : `share <= ${options.minShare}`,
          },
        });
      }
    }

    const groups = new Map<string, Array<{ responseId: string; value: string }>>();
    for (const answer of answers) {
      if (!answer.enumerator) continue;
      const bucket = groups.get(answer.enumerator) ?? [];
      bucket.push({ responseId: answer.responseId, value: answer.value });
      groups.set(answer.enumerator, bucket);
    }
    if (groups.size >= 2) {
      const optionsList = [...new Set(answers.map((answer) => answer.value))].sort();
      const groupNames = [...groups.keys()].sort();
      const table = groupNames.map((name) =>
        optionsList.map((value) => groups.get(name)!.filter((answer) => answer.value === value).length),
      );
      const test = chiSquareTest(table, options.alpha);
      if (test.significant) {
        for (const name of groupNames) {
          for (const answer of groups.get(name) ?? []) {
            add(answer.responseId, {
              kind: 'group_distribution',
              severity: test.p < 0.01 ? 'severe' : 'warn',
              questionId: question.name,
              detail: {
                enumerator: name,
                statistic: test.statistic,
                df: test.df,
                p: test.p,
                alpha: options.alpha,
                test: test.test,
                groups: groupNames,
                options: optionsList,
                rule: 'Pearson chi-squared test of independence across enumerators',
              },
            });
          }
        }
      }
    }
  }

  if (write && findings.length > 0) {
    // One call per response, because recordFlags is idempotent per response and
    // kind. Grouping first avoids opening a transaction for every finding twice.
    const byResponse = new Map<string, DetectedFlag[]>();
    for (const finding of findings) {
      const bucket = byResponse.get(finding.responseId) ?? [];
      bucket.push(finding);
      byResponse.set(finding.responseId, bucket);
    }
    for (const [responseId, flags] of byResponse) {
      await recordFlags(client, { orgId, formId, responseId }, flags);
    }
  }

  const byKind = findings.reduce<Record<string, number>>((summary, finding) => {
    summary[finding.kind] = (summary[finding.kind] ?? 0) + 1;
    return summary;
  }, {});
  return { findings, scanned: new Set(rows.map((row) => row.response_id)).size, byKind };
}

export const platformQcRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/orgs/:orgId/forms/:formId/qc/report',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string }; Querystring: Record<string, string> }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = scanSchema.safeParse({
        ...req.query,
        exclusions: req.query.exclusions ? req.query.exclusions.split(',').map(Number) : undefined,
      });
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const report = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<{ definition: FormDefinition }>(
          `SELECT v.definition
             FROM form_version v
             JOIN form f ON f.id = v.form_id
            WHERE f.id = $1 AND f.org_id = $2 AND v.status = 'published'
            ORDER BY v.version DESC
            LIMIT 1`,
          [req.params.formId, req.params.orgId],
        );
        if (!rows[0]) throw new HttpError(409, 'not_published', 'Publish a version before running statistical QC.');
        return runQc(client, req.params.formId, req.params.orgId, rows[0].definition, parsed.data, false);
      });
      return reply.send({
        findings: report.findings.map((finding) => ({
          responseId: finding.responseId,
          kind: finding.kind,
          severity: finding.severity,
          questionId: finding.questionId,
          detail: finding.detail,
        })),
        scanned: report.scanned,
        byKind: report.byKind,
        options: parsed.data,
      });
    },
  );

  app.post(
    '/orgs/:orgId/forms/:formId/qc/scan',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = scanSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const report = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ definition: FormDefinition }>(
            `SELECT v.definition
               FROM form_version v
               JOIN form f ON f.id = v.form_id
              WHERE f.id = $1 AND f.org_id = $2 AND v.status = 'published'
              LIMIT 1`,
            [req.params.formId, req.params.orgId],
          );
          if (!rows[0]) throw new HttpError(409, 'not_published', 'Publish a version before running statistical QC.');
          return runQc(client, req.params.formId, req.params.orgId, rows[0].definition, parsed.data, true);
        },
        { write: true },
      );

      await audit(req, `user:${actor.userId}`, 'qc.scanned', req.params.formId, {
        orgId: req.params.orgId,
        scanned: report.scanned,
        flagged: report.findings.length,
      });
      return reply.send({
        scanned: report.scanned,
        flagged: report.findings.length,
        byKind: report.byKind,
        options: parsed.data,
      });
    },
  );
};
