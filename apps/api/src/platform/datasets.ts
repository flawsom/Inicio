import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  type DatasetRow,
  type DatasetTable,
  type FormDefinition,
} from '@inicio/engine';
import { HttpError } from './db.js';
import { audit } from './guards.js';
import { requireActor, withActorOrg } from './actors.js';

/**
 * Server datasets: the tables an instrument reads before it asks, and updates
 * after it is answered.
 *
 * The important boundary is not the CRUD. It is that a dataset is attached to a
 * *form version*, not to a form. A published version answered real interviews, so
 * the data it could read has to stay knowable: attaching a new case list to the
 * form must not change what an old instrument reads.
 *
 * Rows are JSON objects. The API validates them, infers the ordered column list
 * once, and keeps `row_key` as a separate text column so the unique index is a
 * real index rather than an expression over JSON.
 */

export const DATASET_MAX_ROWS = 5_000;
export const DATASET_MAX_COLUMNS = 100;

const CODE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const createSchema = z.object({
  code: z.string().trim().min(1).max(60).regex(CODE_RE, 'code must start with a letter and contain only letters, numbers and underscores'),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['data', 'cases']).default('data'),
  uniqueField: z.string().trim().min(1).max(120).regex(COLUMN_RE, 'uniqueField must be a column name').default('id'),
});

const rowsSchema = z.object({
  mode: z.enum(['replace', 'append', 'merge']).default('merge'),
  rows: z.array(z.record(z.string(), z.unknown())).max(DATASET_MAX_ROWS),
});

const attachSchema = z.object({
  datasetId: z.string().uuid(),
  keyQuestion: z.string().trim().min(1).max(120).nullish(),
  publish: z.boolean().default(false),
  mapping: z.record(z.string(), z.string().min(1).max(120)).optional(),
});

interface DatasetDbRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  kind: 'data' | 'cases';
  unique_field: string;
  columns: string[];
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  row_count?: number;
}

interface DatasetAttachmentRow {
  id: string;
  dataset_id: string;
  dataset_code: string;
  dataset_name: string;
  kind: string;
  unique_field: string;
  columns: string[];
  key_question: string | null;
  mapping: Record<string, string>;
  publish: boolean;
  row_count: number;
  created_at: Date;
}

function viewDataset(row: DatasetDbRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    uniqueField: row.unique_field,
    columns: Array.isArray(row.columns) ? row.columns : [],
    rowCount: Number(row.row_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function viewAttachment(row: DatasetAttachmentRow) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    code: row.dataset_code,
    name: row.dataset_name,
    kind: row.kind,
    uniqueField: row.unique_field,
    columns: Array.isArray(row.columns) ? row.columns : [],
    keyQuestion: row.key_question,
    mapping: row.mapping ?? {},
    publish: row.publish,
    rowCount: Number(row.row_count ?? 0),
    createdAt: row.created_at,
  };
}

function normaliseRow(row: Record<string, unknown>): DatasetRow {
  const out: DatasetRow = {};
  for (const [key, value] of Object.entries(row)) {
    const column = key.trim();
    if (column === '' || !COLUMN_RE.test(column)) {
      throw new HttpError(400, 'invalid_column', `"${key}" is not a valid column name. Use letters, numbers and underscores, starting with a letter or underscore.`);
    }
    if (value !== null && typeof value === 'object') {
      throw new HttpError(400, 'invalid_value', `The value for "${column}" must be text, a number, true/false or empty.`);
    }
    out[column] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new HttpError(400, 'empty_row', 'A dataset row cannot be empty.');
  }
  if (Object.keys(out).length > DATASET_MAX_COLUMNS) {
    throw new HttpError(400, 'too_many_columns', `A dataset row may have at most ${DATASET_MAX_COLUMNS} columns.`);
  }
  return out;
}

function inferColumns(rows: DatasetRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function rowKey(row: DatasetRow, field: string): string {
  const value = row[field];
  if (value === null || value === undefined) {
    throw new HttpError(400, 'missing_key', `Every row needs a value in "${field}", the unique field.`);
  }
  const key = String(value).trim();
  if (key === '') throw new HttpError(400, 'missing_key', `Every row needs a non-empty value in "${field}", the unique field.`);
  if (key.length > 500) throw new HttpError(400, 'key_too_long', `The value in "${field}" is longer than 500 characters.`);
  return key;
}

export async function loadCollectDatasets(client: PoolClient, versionId: string): Promise<DatasetTable[]> {
  const { rows } = await client.query<{ datasets: unknown }>(
    `SELECT app_collect_datasets($1) AS datasets`,
    [versionId],
  );
  const value = rows[0]?.datasets;
  if (!Array.isArray(value)) return [];
  return value as DatasetTable[];
}

/**
 * The write-back rule, executed in the response's own transaction.
 *
 * The collector has no policy on the dataset tables. It calls the narrow
 * SECURITY DEFINER function from 0014, which can only touch a dataset attached to
 * this exact version in this organisation. `||` merges the new object into the
 * old one, so an unmapped case column is preserved. A blank key is skipped inside
 * the function rather than creating a row nobody can find.
 */
export async function applyDatasetPublish(
  client: PoolClient,
  context: {
    orgId: string;
    versionId: string;
    values: Record<string, unknown>;
    responseId: string;
    caseid: string | null;
  },
): Promise<{ updated: number }> {
  const { rows } = await client.query<{ updated: number }>(
    `SELECT app_apply_dataset_publish($1, $2::jsonb, $3) AS updated`,
    [context.versionId, JSON.stringify(context.values), context.caseid],
  );
  return { updated: Number(rows[0]?.updated ?? 0) };
}

/** Load a dataset without leaking another organisation's row into a 404-shaped answer. */
async function loadDataset(client: PoolClient, orgId: string, datasetId: string): Promise<DatasetDbRow> {
  const { rows } = await client.query<DatasetDbRow>(
    `SELECT id, org_id, code, name, kind, unique_field, columns, created_at, updated_at, archived_at
       FROM server_dataset WHERE id = $1 AND org_id = $2`,
    [datasetId, orgId],
  );
  const dataset = rows[0];
  if (!dataset) throw new HttpError(404, 'not_found');
  return dataset;
}

async function loadVersion(client: PoolClient, orgId: string, formId: string, versionId: string): Promise<{ id: string; definition: FormDefinition }> {
  const { rows } = await client.query<{ id: string; definition: FormDefinition }>(
    `SELECT id, definition FROM form_version
      WHERE id = $1 AND form_id = $2 AND org_id = $3`,
    [versionId, formId, orgId],
  );
  const version = rows[0];
  if (!version) throw new HttpError(404, 'not_found');
  return version;
}

function autoMapping(definition: FormDefinition, columns: string[]): Record<string, string> {
  const questions = new Set(definition.questions.map((question) => question.name));
  return Object.fromEntries(columns.filter((column) => questions.has(column)).map((column) => [column, column]));
}

export const platformDatasetRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------------ datasets */

  app.get('/orgs/:orgId/datasets', async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
    const actor = await requireActor(req);
    const datasets = await withActorOrg(actor, req.params.orgId, async (client) => {
      const { rows } = await client.query<DatasetDbRow>(
        `SELECT d.id, d.org_id, d.code, d.name, d.kind, d.unique_field, d.columns,
                d.created_at, d.updated_at, d.archived_at,
                (SELECT count(*)::int FROM server_dataset_row r WHERE r.dataset_id = d.id) AS row_count
           FROM server_dataset d
          WHERE d.org_id = $1 AND d.archived_at IS NULL
          ORDER BY d.kind DESC, d.name`,
        [req.params.orgId],
      );
      return rows.map(viewDataset);
    });
    return reply.send({ datasets });
  });

  app.post('/orgs/:orgId/datasets', async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
    const actor = await requireActor(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { code, name, kind, uniqueField } = parsed.data;

    try {
      const dataset = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<DatasetDbRow>(
            `INSERT INTO server_dataset (org_id, code, name, kind, unique_field, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, org_id, code, name, kind, unique_field, columns, created_at, updated_at, archived_at`,
            [req.params.orgId, code, name, kind, uniqueField, actor.userId],
          );
          return rows[0]!;
        },
        { write: true },
      );
      await audit(req, `user:${actor.userId}`, 'dataset.created', dataset.id, {
        orgId: req.params.orgId,
        code,
        kind,
      });
      return reply.code(201).send({ dataset: viewDataset(dataset) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'dataset_code_taken', `A dataset with the code "${code}" already exists in this organisation.`);
      }
      throw err;
    }
  });

  app.get(
    '/orgs/:orgId/datasets/:datasetId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; datasetId: string }; Querystring: { limit?: string; offset?: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const payload = await withActorOrg(actor, req.params.orgId, async (client) => {
        const dataset = await loadDataset(client, req.params.orgId, req.params.datasetId);
        const { rows } = await client.query<{ row_key: string; data: DatasetRow; updated_at: Date }>(
          `SELECT row_key, data, updated_at
             FROM server_dataset_row
            WHERE dataset_id = $1
            ORDER BY row_key
            LIMIT $2 OFFSET $3`,
          [dataset.id, limit, offset],
        );
        const { rows: counted } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM server_dataset_row WHERE dataset_id = $1`,
          [dataset.id],
        );
        return {
          dataset: viewDataset({ ...dataset, row_count: counted[0]?.n ?? 0 }),
          rows: rows.map((row) => ({ key: row.row_key, data: row.data, updatedAt: row.updated_at })),
          total: counted[0]?.n ?? 0,
          limit,
          offset,
        };
      });
      return reply.send(payload);
    },
  );

  app.put(
    '/orgs/:orgId/datasets/:datasetId/rows',
    async (req: FastifyRequest<{ Params: { orgId: string; datasetId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const parsed = rowsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { mode } = parsed.data;
      const normalised = parsed.data.rows.map(normaliseRow);
      const keys = new Set<string>();

      try {
        const result = await withActorOrg(
          actor,
          req.params.orgId,
          async (client) => {
            const dataset = await loadDataset(client, req.params.orgId, req.params.datasetId);
            await client.query(`SELECT id FROM server_dataset WHERE id = $1 FOR UPDATE`, [dataset.id]);

            const importedColumns = inferColumns(normalised);
            const columns = mode === 'replace'
              ? importedColumns
              : [...new Set([...(dataset.columns ?? []), ...importedColumns])];

            const prepared = normalised.map((row) => {
              const key = rowKey(row, dataset.unique_field);
              if (keys.has(key)) {
                throw new HttpError(409, 'duplicate_key', `The key "${key}" appears more than once in this upload.`);
              }
              keys.add(key);
              return { key, row };
            });

            if (mode === 'replace') {
              await client.query(`DELETE FROM server_dataset_row WHERE dataset_id = $1`, [dataset.id]);
            }

            for (const item of prepared) {
              if (mode === 'append') {
                const { rows } = await client.query<{ id: string }>(
                  `INSERT INTO server_dataset_row (org_id, dataset_id, row_key, data)
                   VALUES ($1, $2, $3, $4::jsonb)
                   ON CONFLICT (dataset_id, row_key) DO NOTHING
                   RETURNING id`,
                  [req.params.orgId, dataset.id, item.key, JSON.stringify(item.row)],
                );
                if (!rows[0]) {
                  throw new HttpError(409, 'duplicate_key', `The key "${item.key}" already exists. Use merge to update it.`);
                }
              } else {
                await client.query(
                  `INSERT INTO server_dataset_row (org_id, dataset_id, row_key, data)
                   VALUES ($1, $2, $3, $4::jsonb)
                   ON CONFLICT (dataset_id, row_key)
                   DO UPDATE SET data = server_dataset_row.data || EXCLUDED.data, updated_at = now()`,
                  [req.params.orgId, dataset.id, item.key, JSON.stringify(item.row)],
                );
              }
            }

            await client.query(
              `UPDATE server_dataset SET columns = $2::jsonb WHERE id = $1`,
              [dataset.id, JSON.stringify(columns)],
            );

            const { rows: counted } = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM server_dataset_row WHERE dataset_id = $1`,
              [dataset.id],
            );
            return { imported: prepared.length, total: counted[0]?.n ?? 0, columns };
          },
          { write: true },
        );

        await audit(req, `user:${actor.userId}`, 'dataset.rows_imported', req.params.datasetId, {
          orgId: req.params.orgId,
          mode,
          imported: result.imported,
        });
        return reply.send({ mode, ...result });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new HttpError(409, 'duplicate_key', 'That upload contains a key that is already in the dataset. Use merge to update it.');
        }
        throw err;
      }
    },
  );

  app.delete(
    '/orgs/:orgId/datasets/:datasetId',
    async (req: FastifyRequest<{ Params: { orgId: string; datasetId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const archived = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `UPDATE server_dataset SET archived_at = now()
              WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
              RETURNING id`,
            [req.params.datasetId, req.params.orgId],
          );
          return rows[0] ?? null;
        },
        { write: true },
      );
      if (!archived) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, 'dataset.archived', req.params.datasetId, {
        orgId: req.params.orgId,
      });
      return reply.code(204).send();
    },
  );

  /* ---------------------------------------------------------------- attachments */

  app.get(
    '/orgs/:orgId/forms/:formId/versions/:versionId/datasets',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; versionId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const attachments = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<DatasetAttachmentRow>(
          `SELECT fd.id, fd.dataset_id, d.code AS dataset_code, d.name AS dataset_name,
                  d.kind, d.unique_field, d.columns, fd.key_question, fd.mapping, fd.publish,
                  fd.created_at,
                  (SELECT count(*)::int FROM server_dataset_row r WHERE r.dataset_id = d.id) AS row_count
             FROM form_dataset fd
             JOIN server_dataset d ON d.id = fd.dataset_id
            WHERE fd.org_id = $1 AND fd.form_id = $2 AND fd.form_version_id = $3
            ORDER BY d.name`,
          [req.params.orgId, req.params.formId, req.params.versionId],
        );
        return rows.map(viewAttachment);
      });
      return reply.send({ datasets: attachments });
    },
  );

  app.post(
    '/orgs/:orgId/forms/:formId/versions/:versionId/datasets',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; versionId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = attachSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }

      const attachment = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const version = await loadVersion(client, req.params.orgId, req.params.formId, req.params.versionId);
          const dataset = await loadDataset(client, req.params.orgId, parsed.data.datasetId);
          if (dataset.archived_at) throw new HttpError(409, 'dataset_archived', 'That dataset has been archived.');

          const mapping = parsed.data.mapping ?? autoMapping(version.definition, dataset.columns ?? []);
          for (const [column, question] of Object.entries(mapping)) {
            if (!(dataset.columns ?? []).includes(column)) {
              throw new HttpError(400, 'unknown_column', `"${column}" is not a column in this dataset.`);
            }
            if (!version.definition.questions.some((candidate) => candidate.name === question)) {
              throw new HttpError(400, 'unknown_question', `"${question}" is not a question in this version.`);
            }
          }

          const keyQuestion = parsed.data.keyQuestion === null
            ? null
            : parsed.data.keyQuestion ?? (version.definition.questions.some((q) => q.name === dataset.unique_field) ? dataset.unique_field : null);
          if (keyQuestion !== null && !version.definition.questions.some((candidate) => candidate.name === keyQuestion)) {
            throw new HttpError(400, 'unknown_question', `"${keyQuestion}" is not a question in this version.`);
          }
          if (parsed.data.publish && !keyQuestion && dataset.kind !== 'cases') {
            throw new HttpError(400, 'key_question_required', 'A write-back attachment needs a key question.');
          }

          const { rows } = await client.query<DatasetAttachmentRow>(
            `INSERT INTO form_dataset
               (org_id, form_id, form_version_id, dataset_id, key_question, mapping, publish, created_by)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
             ON CONFLICT (form_version_id, dataset_id)
             DO UPDATE SET key_question = EXCLUDED.key_question, mapping = EXCLUDED.mapping,
                           publish = EXCLUDED.publish
             RETURNING id, dataset_id, $9::text AS dataset_code, $10::text AS dataset_name,
                       $11::text AS kind, $12::text AS unique_field, $13::jsonb AS columns,
                       key_question, mapping, publish, created_at,
                       0::int AS row_count`,
            [
              req.params.orgId,
              req.params.formId,
              req.params.versionId,
              dataset.id,
              keyQuestion,
              JSON.stringify(mapping),
              parsed.data.publish,
              actor.userId,
              dataset.code,
              dataset.name,
              dataset.kind,
              dataset.unique_field,
              JSON.stringify(dataset.columns ?? []),
            ],
          );
          return rows[0]!;
        },
        { write: true },
      );

      await audit(req, `user:${actor.userId}`, 'dataset.attached', attachment.dataset_id, {
        orgId: req.params.orgId,
        formId: req.params.formId,
        versionId: req.params.versionId,
        publish: attachment.publish,
      });
      return reply.code(201).send({ dataset: viewAttachment(attachment) });
    },
  );

  app.delete(
    '/orgs/:orgId/forms/:formId/versions/:versionId/datasets/:attachmentId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; formId: string; versionId: string; attachmentId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const removed = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `DELETE FROM form_dataset
              WHERE id = $1 AND org_id = $2 AND form_id = $3 AND form_version_id = $4
              RETURNING id`,
            [req.params.attachmentId, req.params.orgId, req.params.formId, req.params.versionId],
          );
          return rows[0] ?? null;
        },
        { write: true },
      );
      if (!removed) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, 'dataset.detached', req.params.attachmentId, {
        orgId: req.params.orgId,
        formId: req.params.formId,
        versionId: req.params.versionId,
      });
      return reply.code(204).send();
    },
  );
};
