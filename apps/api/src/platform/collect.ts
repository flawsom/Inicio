import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  datasetContext,
  evaluateForm,
  evaluateSpeed,
  findCase,
  findEnumerator,
  parseSpeedSpec,
  runExpression,
  truthy,
  type DatasetContext,
  type FieldTiming,
  type FormDefinition,
  type SpeedOptions,
} from '@inicio/engine';
import { applyDatasetPublish, loadCollectDatasets } from './datasets.js';
import { pool } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError, withCollector, type ResolvedLink } from './db.js';
import { allowedMimes, isUploadQuestion, mimeAllowed, normaliseMime, safeFilename } from '../storage/limits.js';
import {
  StorageError,
  deleteObject,
  getObjectBytes,
  headObject,
  presignPut,
  storageConfig,
  uploadMaxBytes,
} from '../storage/s3.js';
import { scanBytes, scannerConfigured, unscannedAccepted } from '../storage/scan.js';
import { flagSubmission } from './flags.js';
import { drainAsCollector, emitWebhook } from './webhooks/dispatch.js';
import { env } from '../env.js';
import { registerDurableLimit } from '../lib/rate-limit.js';

/**
 * Public collection. Nothing here requires a session — the bearer token *is* the
 * authorisation, which is why only its hash is stored and why every query below is
 * confined by the collector policies to one response in one organisation.
 *
 * The server is the authority for logic: answers are re-evaluated here with the same
 * engine the browser uses, required-but-unanswered questions block submission, hidden
 * questions are stored as null rather than silently kept, and calculated values are
 * stored so an export never depends on a client having computed them.
 *
 * Offline-first (SPEC §16, §17, §37): a device may collect for hours with no
 * network. When it reconnects it sends the answers it holds plus the last server
 * state it saw as `base`. Two guarantees follow:
 *   - the device owns a stable UUID, so a retried start resolves to the *same*
 *     response rather than creating a second one (nothing is duplicated);
 *   - when both the device and the server changed the same field, both values are
 *     kept — the server's stays authoritative, the device's is preserved, and the
 *     disagreement is recorded. Nothing is silently overwritten (nothing is lost).
 */

const answersSchema = z.record(z.string(), z.unknown());
/** `custom-specify-other` writes `code|verbatim`; the key is the field name. */
const pluginMetadataSchema = z.record(z.string(), z.string().max(4000));
const startSchema = z.object({
  /** The device's stable id for this response. Retries are idempotent against it. */
  clientId: z.string().uuid().optional(),
  answers: answersSchema.default({}),
  /** The last server-confirmed answers the device saw, for conflict detection. */
  base: answersSchema.optional(),
  /** A case selected from a case list, or `?caseid=` on the link. */
  caseid: z.string().trim().min(1).max(200).optional(),
  /** An enumerator id selected from an attached enumerator list. */
  enumerator: z.string().trim().min(1).max(200).optional(),
  /** Panel links carry an opaque id/ticket from the query string. */
  embedded: z.record(z.string(), z.unknown()).optional(),
  /** SurveyCTO plug-in metadata, keyed by field name. */
  metadata: pluginMetadataSchema.optional(),
});
const timingSchema = z.object({
  question: z.string().min(1).max(120),
  /** Milliseconds since the interview began. */
  shownAt: z.number().finite().min(0).max(86_400_000),
  answeredAt: z.number().finite().min(0).max(86_400_000),
  visits: z.number().int().min(1).max(1_000).optional(),
});
const paradataSchema = z.object({
  timings: z.array(timingSchema).max(500).default([]),
});
const saveSchema = z.object({
  answers: answersSchema.default({}),
  base: answersSchema.optional(),
  embedded: z.record(z.string(), z.unknown()).optional(),
  /** SurveyCTO plug-in metadata, keyed by field name. */
  metadata: pluginMetadataSchema.optional(),
  /** Per-field timings, written as they arrive so review sees them live. */
  paradata: paradataSchema.optional(),
});

/**
 * What a device says it is about to send.
 *
 * Declared, not believed. The filename and the size are what the person chose and
 * what the store is authorised for; every one of these is checked again against
 * the object that actually arrives before a row is called `uploaded`.
 */
const attachmentSchema = z.object({
  // The question's **name**, not its id: `planSync` keys the answers it stores in
  // `response_answer.question_id` by name (`values[question.name]`), and the
  // expression language addresses `${question_name}`. Using the id here would
  // attach the file to a question the answers never mention, and the submission
  // cross-check below could not see it either.
  questionId: z.string().min(1).max(120),
  filename: z.string().min(1).max(255),
  mime: z.string().min(3).max(120),
  sizeBytes: z.coerce.number().int().positive(),
  /**
   * Present only for an `audio audit` segment. The start is the device's wall
   * clock, not the upload's: a clip that began six minutes into the interview and
   * arrived a minute later is still a clip of minute six.
   */
  audit: z
    .object({
      startedAt: z.string().datetime(),
      durationSeconds: z.number().finite().min(0).max(3600).optional(),
    })
    .optional(),
});

/**
 * What the renderer needs to offer a file control honestly, or to say it cannot.
 *
 * `enabled` is the deployment's answer about itself: with no bucket configured it
 * is false, and the page goes on saying that these questions are not collected
 * here instead of offering a control that would fail on use. `scan` reports
 * whether the bytes will be looked at, because that is a fact a respondent and an
 * operator both deserve to know before anything is sent.
 */
function attachmentCapability() {
  return {
    // A file can be attached only when there is somewhere to put it *and* the policy
    // can be satisfied: with `require` and no scanner there is no honest control to
    // offer, so the page goes on saying these questions are not collected here.
    enabled: storageConfig() !== null && (unscannedAccepted() || scannerConfigured()),
    maxBytes: uploadMaxBytes(),
    scan: scannerConfigured() ? 'on' : 'off',
    // The policy, stated rather than left to be inferred from `scan`: a client can
    // then say what this deployment does with a file no scanner read, instead of
    // hoping the absence of a scanner is the same thing as accepting one.
    unscanned: unscannedAccepted() ? 'accepted' : 'refused',
    mime: {
      image: allowedMimes('image'),
      audio: allowedMimes('audio'),
      video: allowedMimes('video'),
      file: allowedMimes('file'),
    },
  };
}

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

/** Structural comparison for JSON values; `undefined` and `null` are the same absence here. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

export type ConflictKind = 'device_server_mismatch' | 'calculation_mismatch';

export interface SyncEntry {
  questionId: string;
  /** What the server will store in `response_answer.value`. */
  value: unknown;
  /** The device's value when the two disagreed; preserved, never dropped. */
  deviceValue?: unknown;
  conflict: ConflictKind | null;
}

export interface SyncPlan {
  entries: SyncEntry[];
  /** Canonical values after logic, keyed by question name — what the device should adopt as `base`. */
  values: Record<string, unknown>;
  missing: string[];
  invalid: string[];
  conflicts: number;
}

/**
 * Decides, per question, whether the incoming device answer, the stored server
 * answer, or neither should win (SPEC §37.1/§37.2).
 *
 * The rules, in order:
 *  - relevance and calculation are recomputed server-side, always;
 *  - with no `base` the device is authoritative (a first sync, or an older client);
 *  - when only the device moved, the device wins;
 *  - when only the server moved, the server wins;
 *  - when both moved differently, the server wins *and* the device value is kept
 *    alongside it, with the disagreement recorded.
 */
export function planSync(
  definition: FormDefinition,
  incoming: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  current: Map<string, unknown>,
  datasets?: DatasetContext,
  pluginMetadata?: Record<string, string>,
): SyncPlan {
  // `once()` reads the values the server already stored, so a retried save keeps
  // the first draw instead of computing a new random value on every request.
  const onceValues = Object.fromEntries(current);
  const evaluation = evaluateForm(definition, incoming, { datasets, onceValues, pluginMetadata });
  const entries: SyncEntry[] = [];
  const values: Record<string, unknown> = {};
  let conflicts = 0;

  for (const question of definition.questions) {
    const state = evaluation.states[question.name];
    // A hidden question is stored as null: "not asked" is a fact the codebook
    // documents, and keeping a stale value would make exports lie.
    const serverValue = !state || !state.visible ? null : state.value ?? null;
    const hasCurrent = current.has(question.name);
    const currentValue = hasCurrent ? current.get(question.name) : undefined;

    let stored: unknown = serverValue;
    let deviceValue: unknown;
    let conflict: ConflictKind | null = null;

    if (base === undefined || !hasCurrent) {
      // No baseline, or the server holds nothing to defend: the device wins.
      stored = serverValue;
    } else {
      const baseValue = base[question.name];
      const clientChanged = !sameJson(serverValue, baseValue);
      const serverChanged = !sameJson(currentValue, baseValue);

      if (!clientChanged) {
        stored = currentValue ?? null;
      } else if (!serverChanged || sameJson(serverValue, currentValue)) {
        stored = serverValue;
      } else {
        stored = currentValue ?? null;
        deviceValue = serverValue;
        conflict = 'device_server_mismatch';
      }
    }

    // §13.4 — a derived value the device computed must equal the server's.
    if (question.rules?.calculate && state?.visible && incoming[question.name] !== undefined && !sameJson(incoming[question.name], serverValue)) {
      if (conflict === null) {
        conflict = 'calculation_mismatch';
        deviceValue = incoming[question.name];
        stored = serverValue;
      }
    }

    if (conflict) conflicts += 1;
    const final = stored ?? null;
    values[question.name] = final;
    entries.push(deviceValue === undefined ? { questionId: question.name, value: final, conflict } : { questionId: question.name, value: final, deviceValue, conflict });
  }

  return { entries, values, missing: evaluation.missing, invalid: evaluation.invalid, conflicts };
}

/** The enumerator id an answer names, if this form has an enumerator question. */
function enumeratorAnswer(definition: FormDefinition, values: Record<string, unknown>): string | null {
  const question = definition.questions.find((candidate) => candidate.type === 'enumerator');
  if (!question) return null;
  const value = values[question.name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function readCurrent(client: PoolClient, responseId: string): Promise<Map<string, unknown>> {
  const { rows } = await client.query<{ question_id: string; value: unknown }>(
    `SELECT question_id, value FROM response_answer WHERE response_id = $1`,
    [responseId],
  );
  return new Map(rows.map((row) => [row.question_id, row.value]));
}

async function writePluginMetadata(
  client: PoolClient,
  responseId: string,
  metadata: Record<string, string> | undefined,
): Promise<void> {
  if (metadata === undefined) return;
  await client.query(
    `UPDATE response
        SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('pluginMetadata', $2::jsonb)
      WHERE id = $1`,
    [responseId, JSON.stringify(metadata)],
  );
}

async function writeAnswers(client: PoolClient, orgId: string, responseId: string, plan: SyncPlan): Promise<void> {
  for (const entry of plan.entries) {
    await client.query(
      `INSERT INTO response_answer (org_id, response_id, question_id, value, device_value)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (response_id, question_id)
       DO UPDATE SET value = EXCLUDED.value, device_value = EXCLUDED.device_value, updated_at = now()`,
      [
        orgId,
        responseId,
        entry.questionId,
        JSON.stringify(entry.value ?? null),
        entry.deviceValue === undefined ? null : JSON.stringify(entry.deviceValue ?? null),
      ],
    );

    if (entry.conflict) {
      await client.query(
        `INSERT INTO response_conflict (org_id, response_id, question_id, kind, server_value, device_value)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (response_id, question_id)
         DO UPDATE SET kind = EXCLUDED.kind, server_value = EXCLUDED.server_value,
                       device_value = EXCLUDED.device_value, detected_at = now()`,
        [
          orgId,
          responseId,
          entry.questionId,
          entry.conflict,
          JSON.stringify(entry.value ?? null),
          JSON.stringify(entry.deviceValue ?? null),
        ],
      );
    }
  }
}

interface TimingRow {
  field_name: string;
  total_seconds: number;
  first_seen_seconds: number;
  visits: number;
}

/**
 * Turn device timings into rows, dropping anything the form does not ask.
 *
 * A timing is paradata, not an answer: it can never create a field, never change
 * a value, and never exceed a day. Names not in the published definition are
 * ignored, so a modified client cannot write arbitrary rows into the table.
 */
function timingRows(definition: FormDefinition, paradata: z.infer<typeof paradataSchema> | undefined): TimingRow[] {
  const known = new Set(definition.questions.map((question) => question.name));
  const seen = new Set<string>();
  const rows: TimingRow[] = [];
  for (const timing of paradata?.timings ?? []) {
    if (!known.has(timing.question) || seen.has(timing.question)) continue;
    seen.add(timing.question);
    const total = Math.min(86_400, Math.max(0, (timing.answeredAt - timing.shownAt) / 1000));
    rows.push({
      field_name: timing.question,
      total_seconds: Math.round(total * 1000) / 1000,
      first_seen_seconds: Math.round(Math.max(0, timing.shownAt)) / 1000,
      visits: timing.visits ?? 1,
    });
  }
  return rows;
}

async function writeFieldTimings(
  client: PoolClient,
  orgId: string,
  responseId: string,
  definition: FormDefinition,
  paradata: z.infer<typeof paradataSchema> | undefined,
): Promise<void> {
  const rows = timingRows(definition, paradata);
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO response_field_timing (org_id, response_id, field_name, total_seconds, first_seen_seconds, visits)
     SELECT $1, $2, x.field_name, x.total_seconds, x.first_seen_seconds, x.visits
       FROM jsonb_to_recordset($3::jsonb) AS x(field_name text, total_seconds numeric, first_seen_seconds numeric, visits integer)
     ON CONFLICT (response_id, field_name) DO UPDATE
        SET total_seconds = EXCLUDED.total_seconds,
            first_seen_seconds = LEAST(response_field_timing.first_seen_seconds, EXCLUDED.first_seen_seconds),
            visits = GREATEST(response_field_timing.visits, EXCLUDED.visits),
            updated_at = now()`,
    [orgId, responseId, JSON.stringify(rows)],
  );
}

/**
 * The server's own speed verdict, from the device's timings and the server's answers.
 *
 * The device computes the same thing for its own copy, but a value that lands in a
 * dataset is written here: answers are canonical on the server, so the timing of
 * an answer the server rejected must not lower a violation count.
 */
function speedReportFor(
  definition: FormDefinition,
  paradata: z.infer<typeof paradataSchema> | undefined,
  answers: Record<string, unknown>,
): ReturnType<typeof evaluateSpeed> {
  const options: SpeedOptions = { thresholds: {} };
  for (const question of definition.questions) {
    if (question.audit?.kind !== 'speed_violations' || !question.audit.spec) continue;
    const parsed = parseSpeedSpec(question.audit.spec);
    if ('error' in parsed) continue;
    Object.assign(options.thresholds ?? {}, parsed.thresholds);
    if (parsed.minimumFormSeconds !== undefined) options.minimumFormSeconds = parsed.minimumFormSeconds;
  }

  const byName = new Map(definition.questions.map((question) => [question.name, question]));
  const timings: FieldTiming[] = [];
  for (const timing of paradata?.timings ?? []) {
    const question = byName.get(timing.question);
    if (!question) continue;
    const value = answers[timing.question];
    timings.push({
      question: timing.question,
      type: question.type,
      shownAt: timing.shownAt,
      answeredAt: timing.answeredAt,
      answer: value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value),
    });
  }
  return evaluateSpeed(timings, options);
}

/** Write the three speed audit fields from the server's verdict. */
function applySpeedAuditValues(definition: FormDefinition, plan: SyncPlan, report: ReturnType<typeof evaluateSpeed>): void {
  for (const question of definition.questions) {
    if (!question.audit) continue;
    const key =
      question.audit.kind === 'speed_violations' || question.audit.kind === 'speed_violations_count'
        ? 'speed_violations_count'
        : question.audit.kind === 'speed_violations_list'
          ? 'speed_violations_list'
          : null;
    if (key === null) continue;
    const value = report.values[key] ?? (key === 'speed_violations_list' ? '' : 0);
    plan.values[question.name] = value;
    const entry = plan.entries.find((candidate) => candidate.questionId === question.name);
    if (entry) entry.value = value;
    else plan.entries.push({ questionId: question.name, value, conflict: null });
  }
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

export const platformCollectRoutes: FastifyPluginAsync = async (app) => {
  // A second, independent ceiling for public collection, keyed on the distribution
  // link rather than on the address.
  //
  // The per-address limit registered in app.ts still applies to every route here (two
  // registrations, two counters, both consulted), so this one exists for the thing a
  // single address cannot see: one link being hammered, from anywhere. A link is what a
  // flood targets, and it is also the unit a field team shares, so it is capped at a
  // value a busy team never reaches and a flood does.
  //
  // Registered inside this plugin on purpose. `onRoute` is encapsulated, so a nested
  // registration covers the routes of this plugin and nothing else: the header the rest
  // of the API is told about stays the per-address one (probed, not assumed: see the
  // `link` tests).
  await registerDurableLimit(app, {
    max: env.COLLECT_RATE_LIMIT_MAX,
    namespace: 'link',
    subject: (req) => (req.params as { token?: string } | undefined)?.token ?? 'unknown',
  });

  /** What the renderer needs before a response exists. */
  app.get('/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const link = await requireLink(req.params.token);
    const payload = await withCollector(link.org_id, null, async (client) => {
      const version = await publishedVersionOf(client, link);
      const datasets = await loadCollectDatasets(client, version.id);
      return {
        link: { kind: link.kind, id: link.id },
        form: { id: link.form_id, title: version.title, version: version.version, definition: version.definition },
        datasets,
        attachments: attachmentCapability(),
      };
    });
    reply.header('cache-control', 'no-store');
    return reply.send(payload);
  });

  /**
   * Start (or resume) a response.
   *
   * When the device supplies its own `clientId`, that id *is* the response id, so
   * a start retried after a dropped connection returns the existing response
   * instead of creating a second one. That is the whole point: syncing twice must
   * not duplicate anything.
   */
  app.post(
    '/:token/responses',
    async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = startSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const clientId = body.data.clientId;
      const responseId = clientId ?? randomUUID();

      const payload = await withCollector(link.org_id, responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        const form = { title: version.title, version: version.version, definition: version.definition };
        const datasets = await loadCollectDatasets(client, version.id);
        const context = datasetContext(datasets);
        const requestedCase = body.data.caseid ?? (typeof body.data.embedded?.['caseid'] === 'string' ? body.data.embedded['caseid'] : undefined);
        const caseId = requestedCase?.trim() || null;
        if (caseId && Object.values(context).some((table) => table.kind === 'cases') && !findCase(context, caseId)) {
          throw new HttpError(422, 'unknown_case', 'That case is not in this form\'s case list. Check the case id and try again.');
        }
        const requestedEnumerator = body.data.enumerator
          ?? (typeof body.data.embedded?.['enumerator'] === 'string' ? body.data.embedded['enumerator'] : undefined);
        const enumeratorRef = requestedEnumerator?.trim() || null;
        if (enumeratorRef && Object.values(context).some((table) => table.kind === 'enumerators') && !findEnumerator(context, enumeratorRef)) {
          throw new HttpError(422, 'unknown_enumerator', 'That enumerator is not in this form\'s enumerator list.');
        }

        // `app.response_id` is already this id, so the collector policy lets the
        // lookup see exactly the one row that could be ours.
        const { rows: existing } = await client.query<{ id: string; form_id: string; status: string; caseid: string | null }>(
          `SELECT id, form_id, status, caseid FROM response WHERE id = $1`,
          [responseId],
        );
        if (existing[0]) {
          if (existing[0].form_id !== link.form_id) {
            throw new HttpError(409, 'client_id_conflict', 'That device reference belongs to a different survey.');
          }
          await writePluginMetadata(client, responseId, body.data.metadata);
          return { responseId, created: false, status: existing[0].status, caseid: existing[0].caseid, form, datasets };
        }

        const { rows: inserted } = await client.query<{ id: string }>(
          `INSERT INTO response (id, org_id, form_id, form_version_id, status, meta, respondent_ref, client_uuid, caseid, enumerator_ref)
           VALUES ($1, $2, $3, $4, 'in_progress', $5::jsonb, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            responseId,
            link.org_id,
            link.form_id,
            version.id,
            JSON.stringify({
              ...(body.data.embedded ?? {}),
              ...(body.data.metadata && Object.keys(body.data.metadata).length > 0
                ? { pluginMetadata: body.data.metadata }
                : {}),
            }),
            typeof body.data.embedded?.['pid'] === 'string' ? String(body.data.embedded['pid']) : null,
            clientId ?? null,
            caseId,
            enumeratorRef,
          ],
        );

        if (inserted.length === 0) {
          // Lost a race with a concurrent start for the same client id: the other
          // one won, which is the same outcome this call wanted.
          const { rows: again } = await client.query<{ id: string; form_id: string; status: string; caseid: string | null }>(
            `SELECT id, form_id, status, caseid FROM response WHERE id = $1`,
            [responseId],
          );
          if (!again[0] || again[0].form_id !== link.form_id) {
            throw new HttpError(409, 'client_id_conflict', 'That device reference belongs to a different survey.');
          }
          return { responseId, created: false, status: again[0].status, caseid: again[0].caseid, form, datasets };
        }

        const seeded: Record<string, unknown> = { ...body.data.answers };
        // SurveyCTO's `caseid` metadata field is imported as a calculate with no
        // expression. Seeding it makes the familiar `pulldata('cases', ..., ${caseid})`
        // pattern work without asking the enumerator to type the id twice.
        if (caseId && version.definition.questions.some((question) => question.name === 'caseid')) {
          seeded.caseid = caseId;
        }
        if (Object.keys(seeded).length > 0) {
          const plan = planSync(version.definition, seeded, body.data.base, new Map(), context, body.data.metadata);
          await writeAnswers(client, link.org_id, responseId, plan);
        }
        return { responseId, created: true, status: 'in_progress', caseid: caseId, enumeratorRef, form, datasets };
      });
      reply.header('cache-control', 'no-store');
      return reply.code(payload.created ? 201 : 200).send(payload);
    },
  );

  /** Resume: the saved answers, so an abandoned interview is recoverable. */
  app.get(
    '/:token/responses/:responseId',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const payload = await withCollector(link.org_id, req.params.responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        const datasets = await loadCollectDatasets(client, version.id);
        const { rows: response } = await client.query<{
          status: string;
          started_at: Date;
          submitted_at: Date | null;
          caseid: string | null;
          enumerator_ref: string | null;
          meta: Record<string, unknown> | null;
        }>(
          `SELECT status, started_at, submitted_at, caseid, enumerator_ref, meta FROM response WHERE id = $1`,
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
          caseid: response[0].caseid,
          enumeratorRef: response[0].enumerator_ref,
          startedAt: response[0].started_at,
          submittedAt: response[0].submitted_at,
          answers: Object.fromEntries(answers.map((a) => [a.question_id, a.value])),
          // Omitted when the server has never stored metadata. An empty object is a
          // value in its own right: it is how the device is told a field was cleared.
          ...(response[0].meta?.['pluginMetadata'] && typeof response[0].meta['pluginMetadata'] === 'object'
            ? { pluginMetadata: response[0].meta['pluginMetadata'] as Record<string, string> }
            : {}),
          form: { title: version.title, version: version.version, definition: version.definition },
          datasets,
        };
      });
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );

  /** Partial save. Saved on every section transition, on field blur, and on a timer. */
  app.patch(
    '/:token/responses/:responseId',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = saveSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const payload = await withCollector(link.org_id, req.params.responseId, async (client) => {
        const version = await publishedVersionOf(client, link);
        const { rows } = await client.query<{ status: string; caseid: string | null }>(
          `SELECT status, caseid FROM response WHERE id = $1`,
          [req.params.responseId],
        );
        if (!rows[0]) throw new HttpError(404, 'not_found');
        if (rows[0].status !== 'in_progress') throw new HttpError(409, 'already_submitted');

        const datasets = await loadCollectDatasets(client, version.id);
        const incoming = { ...body.data.answers };
        // The case id is on the response, not in every keystroke. Re-seed it so a
        // later save or submit cannot null the field that makes pulldata() work.
        if (rows[0].caseid && version.definition.questions.some((question) => question.name === 'caseid')) {
          incoming.caseid = rows[0].caseid;
        }
        const plan = planSync(
          version.definition,
          incoming,
          body.data.base,
          await readCurrent(client, req.params.responseId),
          datasetContext(datasets),
          body.data.metadata,
        );
        await writePluginMetadata(client, req.params.responseId, body.data.metadata);
        await writeAnswers(client, link.org_id, req.params.responseId, plan);
        const answeredEnumerator = enumeratorAnswer(version.definition, plan.values);
        if (version.definition.questions.some((question) => question.type === 'enumerator')) {
          await client.query(`UPDATE response SET enumerator_ref = $2 WHERE id = $1`, [
            req.params.responseId,
            answeredEnumerator,
          ]);
        }
        await writeFieldTimings(client, link.org_id, req.params.responseId, version.definition, body.data.paradata);
        // `answers` is what the server actually holds: the device adopts it as its
        // new baseline, so the next sync compares against reality rather than hope.
        return { saved: plan.entries.length, missing: plan.missing, invalid: plan.invalid, answers: plan.values, conflicts: plan.conflicts };
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
        const { rows: locked } = await client.query<{ status: string; caseid: string | null }>(
          `SELECT status, caseid FROM response WHERE id = $1 FOR UPDATE`,
          [req.params.responseId],
        );
        if (!locked[0]) throw new HttpError(404, 'not_found');
        if (locked[0].status !== 'in_progress') throw new HttpError(409, 'already_submitted');

        const datasets = await loadCollectDatasets(client, version.id);
        const incoming = { ...body.data.answers };
        if (locked[0].caseid && version.definition.questions.some((question) => question.name === 'caseid')) {
          incoming.caseid = locked[0].caseid;
        }
        const plan = planSync(
          version.definition,
          incoming,
          body.data.base,
          await readCurrent(client, req.params.responseId),
          datasetContext(datasets),
          body.data.metadata,
        );
        await writePluginMetadata(client, req.params.responseId, body.data.metadata);
        // Timings are the text audit and the raw material for speed violations. The
        // verdict is written into the audit fields here, so it is the server's and
        // not a number a device could choose.
        applySpeedAuditValues(version.definition, plan, speedReportFor(version.definition, body.data.paradata, plan.values));

        // An answer that names a file is only as good as the file. A device can
        // hold a reference for a question whose bytes never arrived, were refused
        // for their type, or were deleted after a scan found something - so the
        // submission checks the row the reference points at instead of trusting
        // the value it was sent. A question answered this way is not accepted
        // until the server has looked at the object itself.
        const uploadAnswers = Object.keys(plan.values).filter((questionId) => {
          const question = version.definition.questions.find((candidate) => candidate.name === questionId);
          const value = plan.values[questionId];
          const answered = value !== undefined && value !== null && value !== '';
          return Boolean(question && isUploadQuestion(question.type) && answered);
        });
        if (uploadAnswers.length > 0) {
          const { rows: stored } = await client.query<{ question_id: string; status: string; scan_status: string }>(
            `SELECT question_id, status, scan_status FROM response_attachment
              WHERE response_id = $1 AND question_id = ANY($2::text[])`,
            [req.params.responseId, uploadAnswers],
          );
          // `clean` is accepted because a scanner said so. `skipped` and `error` are
          // accepted when this deployment's policy allows an unscanned file - and even
          // then the row is left saying which of the two it was, because an operator
          // has to be able to see a scanner that was down rather than a decision.
          const usable = new Set(
            stored
              .filter(
                (row) =>
                  row.status === 'uploaded' &&
                  (row.scan_status === 'clean' ||
                    (unscannedAccepted() && (row.scan_status === 'skipped' || row.scan_status === 'error'))),
              )
              .map((row) => row.question_id),
          );
          const notReady = uploadAnswers.filter((questionId) => !usable.has(questionId));
          if (notReady.length > 0) {
            throw new HttpError(
              422,
              'attachment_not_ready',
              `These answers are waiting for a file the server has not accepted: ${notReady.join(', ')}. Please reopen those questions and attach the file again.`,
            );
          }
        }

        if (plan.missing.length > 0 || plan.invalid.length > 0) {
          // Nothing is written: an invalid submission must not leave half a response.
          throw new HttpError(
            422,
            'incomplete',
            JSON.stringify({ missing: plan.missing, invalid: plan.invalid, message: 'required or invalid answers block submission' }),
          );
        }

        await writeAnswers(client, link.org_id, req.params.responseId, plan);
        const answeredEnumerator = enumeratorAnswer(version.definition, plan.values);
        if (version.definition.questions.some((question) => question.type === 'enumerator')) {
          await client.query(`UPDATE response SET enumerator_ref = $2 WHERE id = $1`, [
            req.params.responseId,
            answeredEnumerator,
          ]);
        }
        await writeFieldTimings(client, link.org_id, req.params.responseId, version.definition, body.data.paradata);

        const quotaStatus = await applyQuotas(client, link.form_id, plan.values);
        const status = quotaStatus ?? (screenedOut(version.definition, plan.values) ? 'screened_out' : 'submitted');

        const { rows: updated } = await client.query<{ uses: number | null }>(
          `SELECT app_consume_dist_link($1) AS uses`,
          [link.id],
        );
        if (updated[0]?.uses === null || updated[0]?.uses === undefined) {
          // The link was exhausted between the check above and here.
          throw new HttpError(410, 'link_exhausted');
        }

        const caseid = locked[0].caseid
          ?? (typeof plan.values.caseid === 'string' && plan.values.caseid.trim() !== '' ? plan.values.caseid.trim() : null);
        if (caseid && !locked[0].caseid) {
          await client.query(`UPDATE response SET caseid = $2 WHERE id = $1`, [req.params.responseId, caseid]);
        }

        // A case write-back is part of the submission, not a job after it: if the
        // row cannot be updated, the response must not commit claiming that it was.
        let caseUpdated = 0;
        if (status === 'submitted') {
          const written = await applyDatasetPublish(client, {
            orgId: link.org_id,
            versionId: version.id,
            values: plan.values,
            responseId: req.params.responseId,
            caseid,
          });
          caseUpdated = written.updated;
        }

        const { rows: stamped } = await client.query<{ started_at: Date; submitted_at: Date }>(
          `UPDATE response SET status = $2, submitted_at = now() WHERE id = $1
           RETURNING started_at, submitted_at`,
          [req.params.responseId, status],
        );

        // Quality control runs here because this is the only moment the duration,
        // the answers and the server's own clock are in one place. The detectors are
        // ordinary reads of this response, so the collector policies still bound
        // them: a public link can flag its own submission and nothing else.
        const timing = stamped[0];
        if (timing && status === 'submitted') {
          await flagSubmission(client, {
            orgId: link.org_id,
            formId: link.form_id,
            responseId: req.params.responseId,
            startedAt: timing.started_at,
            submittedAt: timing.submitted_at,
          });
          // Same transaction as the submission: a response that committed has its
          // event rows, and a submission that rolled back has none.
          await emitWebhook(client, link.org_id, 'response.submitted', {
            formId: link.form_id,
            responseId: req.params.responseId,
            status,
            answered: plan.entries.length,
            conflicts: plan.conflicts,
          });
        }
        return { responseId: req.params.responseId, status, answered: plan.entries.length, conflicts: plan.conflicts, caseUpdated };
      });

      // Delivery happens after the response has been written and the respondent is
      // gone: an integration must never be able to slow down or fail a submission.
      // A sweep (scripts/webhooks-drain.ts) covers anything this misses, because a
      // serverless instance may be frozen the moment its response is returned.
      void drainAsCollector(link.org_id).catch(() => undefined);

      await pool.query(`UPDATE dist_invite SET status = 'finished' WHERE dist_link_id = $1 AND status <> 'finished'`, [
        link.id,
      ]);
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );

  /**
   * Authorise one file, and hand back a URL that can upload that file and nothing else.
   *
   * The order is the point. The question is looked up in the *published* version
   * the link points at, so a question that is not on this instrument cannot be
   * answered with a file; the type is checked against that question's own
   * allowlist, so a photo question cannot be answered with a document; the size is
   * checked against the ceiling; and only then is a store request signed, with the
   * content type bound into the signature. A URL that has been handed out uploads
   * one object, of one type, of the declared size or less.
   *
   * The row written here is `pending` on both axes - the row exists, the bytes do
   * not - so nothing is attached to an answer until `complete` has looked at what
   * arrived.
   */
  app.post(
    '/:token/responses/:responseId/attachments',
    async (req: FastifyRequest<{ Params: { token: string; responseId: string } }>, reply: FastifyReply) => {
      const link = await requireLink(req.params.token);
      const body = attachmentSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      // A refusal that is this *deployment's* answer rather than the caller's mistake
      // - no storage, or a policy asking for a scanner it has not got - is returned
      // instead of thrown, so it can be sent with its own code and sentence: `app.ts`
      // collapses every 5xx body into a generic `internal_error`, and the collection
      // page has a sentence for each of these.
      type Authorisation =
        | {
            kind: 'authorised';
            payload: {
              attachmentId: string;
              uploadUrl: string;
              expiresInSeconds: number;
              headers: Record<string, string>;
              maxBytes: number;
            };
          }
        | { kind: 'refused'; status: number; code: string; message: string };

      let outcome: Authorisation;
      try {
        outcome = await withCollector(link.org_id, req.params.responseId, async (client): Promise<Authorisation> => {
          const version = await publishedVersionOf(client, link);
          // The response id comes from the device, and a device can carry one from
          // another survey - so the row is checked against *this* link's form before
          // a credential exists for it. The tenant policy keeps other organisations
          // out; it cannot see that two of our own links point at two forms, which
          // is the boundary this route is the only guard for.
          const { rows: response } = await client.query<{ status: string; form_id: string }>(
            `SELECT status, form_id FROM response WHERE id = $1`,
            [req.params.responseId],
          );
          if (!response[0] || response[0].form_id !== link.form_id) throw new HttpError(404, 'not_found');
          if (response[0].status !== 'in_progress') throw new HttpError(409, 'already_submitted');

          const question = version.definition.questions.find(
            (candidate) => candidate.name === body.data.questionId,
          );
          if (!question) {
            throw new HttpError(404, 'unknown_question', 'That question is not on this survey. Please reload the page.');
          }
          // An audio audit field is a calculate, but its clip travels the same
          // verified path as a media answer: authorise, upload, HEAD, hash, scan.
          // Treating it as an audio upload is what keeps the guard a type guard
          // rather than an exemption.
          const isAudioAudit = question.audit?.kind === 'audio_audit';
          if (!isUploadQuestion(question.type) && !isAudioAudit) {
            throw new HttpError(400, 'not_an_upload_question', 'That question does not take a file.');
          }
          if (isAudioAudit && !body.data.audit) {
            throw new HttpError(422, 'audit_metadata_required', 'That audio audit needs the time its recording began.');
          }
          const uploadType = isAudioAudit ? 'audio' : question.type;

          const mime = normaliseMime(body.data.mime);
          if (!mimeAllowed(uploadType, mime)) {
            throw new HttpError(
              422,
              'type_not_allowed',
              `That kind of file cannot be attached to this question. Accepted: ${allowedMimes(uploadType).join(', ')}.`,
            );
          }
          const max = uploadMaxBytes();
          if (body.data.sizeBytes > max) {
            throw new HttpError(
              413,
              'too_large',
              `That file is larger than this survey accepts. The limit is ${Math.round(max / (1024 * 1024))} MB.`,
            );
          }
          if (!storageConfig()) {
            // The deployment's own answer, not the client's problem to guess at.
            return {
              kind: 'refused',
              status: 501,
              code: 'storage_not_configured',
              message: 'This survey is not collecting files at the moment. Please answer the other questions.',
            };
          }
          if (!unscannedAccepted() && !scannerConfigured()) {
            // The policy wants a scanner's verdict and there is no scanner, so the
            // refusal belongs here: handing out a credential whose upload could never
            // become an answer would make the respondent find out after sending a file.
            return {
              kind: 'refused',
              status: 503,
              code: 'scan_required',
              message: 'This survey is not accepting files at the moment. Please answer the other questions.',
            };
          }

          const attachmentId = randomUUID();
          const storageKey = `${link.org_id}/responses/${req.params.responseId}/${attachmentId}/${safeFilename(body.data.filename)}`;
          await client.query(
            `INSERT INTO response_attachment
               (id, org_id, response_id, question_id, filename, mime, size_bytes, storage_key, status, scan_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'pending')`,
            [
              attachmentId,
              link.org_id,
              req.params.responseId,
              body.data.questionId,
              body.data.filename,
              mime,
              body.data.sizeBytes,
              storageKey,
            ],
          );
          if (isAudioAudit && body.data.audit) {
            // The clip row exists before the bytes do, exactly like the attachment:
            // a reviewer never sees a clip that was not verified, and a failed
            // upload leaves a pending row rather than a dangling file.
            await client.query(
              `INSERT INTO response_audit_clip
                 (org_id, response_id, field_name, storage_key, mime, size_bytes, duration_seconds, scan_status, started_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::timestamptz)
               ON CONFLICT (response_id, field_name) DO UPDATE
                  SET storage_key = EXCLUDED.storage_key,
                      mime = EXCLUDED.mime,
                      size_bytes = EXCLUDED.size_bytes,
                      duration_seconds = EXCLUDED.duration_seconds,
                      scan_status = 'pending',
                      sha256 = NULL,
                      started_at = EXCLUDED.started_at`,
              [
                link.org_id,
                req.params.responseId,
                body.data.questionId,
                storageKey,
                mime,
                body.data.sizeBytes,
                body.data.audit.durationSeconds ?? null,
                body.data.audit.startedAt,
              ],
            );
          }

          return {
            kind: 'authorised',
            payload: {
              attachmentId,
              uploadUrl: presignPut(storageKey, mime),
              expiresInSeconds: 900,
              headers: { 'content-type': mime },
              maxBytes: max,
            },
          };
        });
      } catch (err) {
        if (err instanceof StorageError) {
          // Sent rather than thrown, for the same reason as the refusals above: the
          // page has a sentence for "the store did not answer", and only a body that
          // survives `app.ts` lets the client reach it.
          return reply.code(502).send({
            error: 'storage_unavailable',
            message: 'The place this survey keeps files did not answer. Please try again in a moment.',
          });
        }
        throw err;
      }

      if (outcome.kind === 'refused') {
        return reply.code(outcome.status).send({ error: outcome.code, message: outcome.message });
      }

      reply.header('cache-control', 'no-store');
      return reply.code(201).send(outcome.payload);
    },
  );

  /**
   * Look at what actually arrived, and only then call it an answer.
   *
   * This is where the client's declarations stop mattering: the store is asked
   * what it holds, and *that* is the size that is recorded - a device that said
   * two kilobytes and sent ten megabytes is discovered here. The type bound into
   * the signature is checked against what came back. The bytes are hashed, so the
   * row can be compared with the object later. And the scan step runs on the bytes
   * themselves, because a file nobody looked at is just a file from the internet.
   *
   * A rejection is written *and committed* before it is reported - the outcome is
   * returned rather than thrown, so a transaction cannot roll back the record of
   * why a file was refused while the file itself is already gone.
   */
  app.post(
    '/:token/responses/:responseId/attachments/:attachmentId/complete',
    async (
      req: FastifyRequest<{ Params: { token: string; responseId: string; attachmentId: string } }>,
      reply: FastifyReply,
    ) => {
      const link = await requireLink(req.params.token);

      type Completion =
        | { kind: 'uploaded'; payload: Record<string, unknown> }
        | { kind: 'rejected'; status: number; code: string; message: string };

      let outcome: Completion;
      try {
        outcome = await withCollector(link.org_id, req.params.responseId, async (client): Promise<Completion> => {
          const { rows } = await client.query<{
            id: string;
            question_id: string;
            filename: string;
            mime: string;
            size_bytes: number;
            storage_key: string;
            status: string;
            scan_status: string;
          }>(
            `SELECT id, question_id, filename, mime, size_bytes, storage_key, status, scan_status
               FROM response_attachment
              WHERE id = $1 AND response_id = $2
              FOR UPDATE`,
            [req.params.attachmentId, req.params.responseId],
          );
          const attachment = rows[0];
          if (!attachment) throw new HttpError(404, 'attachment_not_found');

          // The same boundary the presign draws: this attachment has to belong to a
          // response of the form *this* link points at. Knowing an id is not
          // authority to spend another survey's attachment.
          const { rows: owner } = await client.query<{ form_id: string }>(
            `SELECT form_id FROM response WHERE id = $1`,
            [req.params.responseId],
          );
          if (!owner[0] || owner[0].form_id !== link.form_id) throw new HttpError(404, 'not_found');

          // A device that retried the completion, or came back online mid-upload,
          // gets the same answer rather than a second write.
          if (attachment.status === 'uploaded') {
            return {
              kind: 'uploaded',
              payload: {
                attachmentId: attachment.id,
                questionId: attachment.question_id,
                filename: attachment.filename,
                status: 'uploaded',
                scanStatus: attachment.scan_status,
                sizeBytes: attachment.size_bytes,
                alreadyComplete: true,
              },
            };
          }
          if (attachment.status === 'deleted') {
            return {
              kind: 'rejected',
              status: 422,
              code: 'attachment_rejected',
              message: 'That file was not accepted, so this question is still unanswered. Please attach another one.',
            };
          }

          const max = uploadMaxBytes();
          const head = await headObject(attachment.storage_key);
          if (!head || head.sizeBytes === 0) {
            return {
              kind: 'rejected',
              status: 409,
              code: 'upload_missing',
              message: 'The file did not finish arriving. Please try attaching it again.',
            };
          }

          // The store's answer wins over the client's declaration, every time.
          if (head.sizeBytes > max) {
            await deleteObject(attachment.storage_key);
            await client.query(`UPDATE response_attachment SET status = 'deleted' WHERE id = $1`, [attachment.id]);
            return {
              kind: 'rejected',
              status: 413,
              code: 'too_large',
              message: `That file is larger than this survey accepts. The limit is ${Math.round(max / (1024 * 1024))} MB.`,
            };
          }
          if (head.contentType && normaliseMime(head.contentType) !== normaliseMime(attachment.mime)) {
            await deleteObject(attachment.storage_key);
            await client.query(`UPDATE response_attachment SET status = 'deleted' WHERE id = $1`, [attachment.id]);
            return {
              kind: 'rejected',
              status: 422,
              code: 'type_mismatch',
              message: 'The file that arrived was not the kind this question accepts. Please attach another one.',
            };
          }

          const bytes = await getObjectBytes(attachment.storage_key, max);
          const digest = createHash('sha256').update(bytes).digest('hex');
          const scan = await scanBytes(bytes);

          if (scan.status === 'infected') {
            // The bytes leave the store before the row records why: a file a scanner
            // named is not kept because a row says it exists.
            await deleteObject(attachment.storage_key);
            await client.query(
              `UPDATE response_attachment SET status = 'deleted', scan_status = 'infected' WHERE id = $1`,
              [attachment.id],
            );
            await client.query(
              `UPDATE response_audit_clip SET scan_status = 'infected' WHERE response_id = $1 AND storage_key = $2`,
              [req.params.responseId, attachment.storage_key],
            );
            return {
              kind: 'rejected',
              status: 422,
              code: 'attachment_infected',
              message: 'That file was refused by the security scan, so it has been deleted. Please attach another one.',
            };
          }

          await client.query(
            `UPDATE response_attachment
                SET status = 'uploaded', scan_status = $2, sha256 = $3, size_bytes = $4, uploaded_at = now()
              WHERE id = $1`,
            [attachment.id, scan.status, digest, head.sizeBytes],
          );
          // An audio audit clip shares the attachment's bytes and verification
          // status; this update finds the clip by the storage key both rows share.
          await client.query(
            `UPDATE response_audit_clip
                SET scan_status = $3, sha256 = $4, size_bytes = $5
              WHERE response_id = $1 AND storage_key = $2`,
            [req.params.responseId, attachment.storage_key, scan.status, digest, head.sizeBytes],
          );

          return {
            kind: 'uploaded',
            payload: {
              attachmentId: attachment.id,
              questionId: attachment.question_id,
              filename: attachment.filename,
              status: 'uploaded',
              scanStatus: scan.status,
              scanDetail: scan.detail,
              sizeBytes: head.sizeBytes,
              sha256: digest,
            },
          };
        });
      } catch (err) {
        if (err instanceof StorageError) {
          throw new HttpError(
            502,
            'storage_unavailable',
            'The place this survey keeps files did not answer, so the file has not been accepted. Please try again in a moment.',
          );
        }
        throw err;
      }

      if (outcome.kind === 'rejected') {
        return reply.code(outcome.status).send({ error: outcome.code, detail: outcome.message });
      }
      reply.header('cache-control', 'no-store');
      return reply.send(outcome.payload);
    },
  );
};
