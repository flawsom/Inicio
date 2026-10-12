import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  buildExportBundle,
  exportXlsForm,
  importXlsForm,
  validateForm,
  zipFiles,
  type ExportFormat,
  type FormDefinition,
} from '@inicio/engine';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError, withUser } from './db.js';
import { audit } from './guards.js';
import { requireAcceptedTerms } from './terms.js';
import { TEMPLATES, findTemplate } from './templates.js';

/**
 * Forms, versions, responses, exports and distribution links.
 *
 * These routes run with only `app.user_id` set and let RLS decide what exists.
 * There is deliberately no `:orgId` in most paths to get wrong: a form belonging to
 * somebody else is not a row, so it is a 404 rather than a permission argument.
 */

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'form';

const looseDefinition = z.object({
  title: z.string().min(1),
  defaultLanguage: z.string().min(2).default('en'),
  languages: z.array(z.string()).default(['en']),
  groups: z.array(z.unknown()).default([]),
  questions: z.array(z.unknown()).default([]),
  choiceLists: z.record(z.array(z.unknown())).default({}),
  variables: z.array(z.unknown()).optional(),
  triggers: z.array(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
});

/** Structural sanity only: `validateForm` is the authority on what is publishable. */
function asDefinition(input: unknown): FormDefinition {
  return looseDefinition.parse(input) as unknown as FormDefinition;
}

const createSchema = z.object({
  orgId: z.string().uuid(),
  projectId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(60).optional(),
  definition: z.unknown().optional(),
  templateId: z.string().optional(),
  xlsformBase64: z.string().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export interface FormRow {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  slug: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface VersionRow {
  id: string;
  version: number;
  title: string;
  definition: FormDefinition;
  published_at: Date | null;
}

async function loadForm(client: PoolClient, formId: string): Promise<FormRow> {
  const { rows } = await client.query<FormRow>(`SELECT * FROM form WHERE id = $1`, [formId]);
  const form = rows[0];
  if (!form) throw new HttpError(404, 'not_found');
  return form;
}

/** The version a respondent sees today: the published one. */
export async function publishedVersion(client: PoolClient, formId: string): Promise<VersionRow | null> {
  const { rows } = await client.query<VersionRow>(
    `SELECT id, version, title, definition, published_at FROM form_version WHERE form_id = $1 AND status = 'published'`,
    [formId],
  );
  return rows[0] ?? null;
}

async function nextVersionNumber(client: PoolClient, formId: string): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM form_version WHERE form_id = $1`,
    [formId],
  );
  return rows[0]?.next ?? 1;
}

export const platformFormRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------------ forms */

  app.get('/templates', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        questionCount: t.definition.questions.length,
        languages: t.definition.languages,
      })),
    });
  });

  app.get('/forms', async (req: FastifyRequest<{ Querystring: { includeArchived?: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const forms = await withUser(identity.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.id, f.name, f.slug, f.org_id, f.project_id, f.archived_at, f.created_at, f.updated_at,
                o.name AS organisation,
                pv.version AS published_version,
                dv.id AS draft_version_id,
                (SELECT count(*)::int FROM response r WHERE r.form_id = f.id AND r.status = 'submitted') AS submitted_count,
                (SELECT count(*)::int FROM response r WHERE r.form_id = f.id AND r.status = 'in_progress') AS in_progress_count,
                (SELECT count(*)::int FROM dist_link l WHERE l.form_id = f.id AND l.active) AS active_links
           FROM form f
           JOIN org o ON o.id = f.org_id
           LEFT JOIN form_version pv ON pv.form_id = f.id AND pv.status = 'published'
           LEFT JOIN form_version dv ON dv.form_id = f.id AND dv.status = 'draft'
          WHERE ($1::boolean OR f.archived_at IS NULL)
          ORDER BY f.updated_at DESC`,
        [req.query.includeArchived === 'true'],
      );
      return rows;
    });
    reply.header('cache-control', 'private, no-store');
    return reply.send({ forms });
  });

  app.post('/forms', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const created = await withUser(identity.userId, async (client) => {
      const { rows: forms } = await client.query<{ id: string }>(
        `INSERT INTO form (org_id, project_id, name, slug) VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, name, slug, project_id, created_at`,
        [parsed.data.orgId, parsed.data.projectId ?? null, parsed.data.name, parsed.data.slug ?? slugify(parsed.data.name)],
      );
      const form = forms[0];
      if (!form) throw new HttpError(500, 'create_failed');

      // Import at creation, so "new form from a spreadsheet" is a single call.
      let definition: FormDefinition;
      let notes: unknown[] = [];
      if (parsed.data.xlsformBase64) {
        const imported = importXlsForm(new Uint8Array(Buffer.from(parsed.data.xlsformBase64, 'base64')));
        definition = imported.definition;
        notes = imported.notes;
      } else if (parsed.data.definition !== undefined) {
        definition = asDefinition(parsed.data.definition);
      } else if (parsed.data.templateId) {
        const template = findTemplate(parsed.data.templateId);
        if (!template) throw new HttpError(404, 'unknown_template', `no template "${parsed.data.templateId}"`);
        // A template is an ordinary definition: it is copied, then edited, and it is
        // analysed at publish time like anything else.
        definition = template;
      } else {
        definition = asDefinition({
          title: parsed.data.title ?? parsed.data.name,
          defaultLanguage: 'en',
          languages: ['en'],
          groups: [],
          questions: [],
          choiceLists: {},
        });
      }

      const { rows: versions } = await client.query(
        `INSERT INTO form_version (org_id, form_id, version, status, title, definition, created_by)
         VALUES ($1, $2, 1, 'draft', $3, $4::jsonb, $5)
         RETURNING id, version, status, title, definition, created_at`,
        [parsed.data.orgId, form.id, definition.title, JSON.stringify(definition), identity.userId],
      );
      return { form, version: versions[0], notes };
    });

    await audit(req, `user:${identity.userId}`, 'form.created', (created.form as { id: string }).id, {
      orgId: parsed.data.orgId,
    });
    return reply.code(201).send(created);
  });

  app.get('/forms/:formId', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const payload = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      const { rows: versions } = await client.query(
        `SELECT id, version, status, title, based_on, created_by, published_at, created_at,
                jsonb_array_length(coalesce(definition->'questions', '[]'::jsonb)) AS question_count
           FROM form_version WHERE form_id = $1 ORDER BY version DESC`,
        [req.params.formId],
      );
      const { rows: counts } = await client.query(
        `SELECT status, count(*)::int AS count FROM response WHERE form_id = $1 GROUP BY status`,
        [req.params.formId],
      );
      return { form, versions, responsesByStatus: counts };
    });
    reply.header('cache-control', 'private, no-store');
    return reply.send(payload);
  });

  app.patch('/forms/:formId', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(160).optional(),
        slug: z.string().trim().min(1).max(60).optional(),
        projectId: z.string().uuid().nullish(),
        archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const form = await withUser(identity.userId, async (client) => {
      await loadForm(client, req.params.formId);
      const { rows } = await client.query(
        `UPDATE form
            SET name = coalesce($2, name),
                slug = coalesce($3, slug),
                project_id = CASE WHEN $4::boolean THEN $5::uuid ELSE project_id END,
                archived_at = CASE WHEN $6::boolean THEN now()
                                   WHEN $6::boolean = false THEN NULL
                                   ELSE archived_at END
          WHERE id = $1
      RETURNING id, name, slug, project_id, archived_at, updated_at`,
        [
          req.params.formId,
          parsed.data.name ?? null,
          parsed.data.slug ?? null,
          parsed.data.projectId !== undefined,
          parsed.data.projectId ?? null,
          parsed.data.archived ?? null,
        ],
      );
      return rows[0];
    });
    return reply.send({ form });
  });

  /* --------------------------------------------------------------- versions */

  app.post('/forms/:formId/versions', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = z.object({ basedOn: z.string().uuid().nullish() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const version = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      // Lock the form while numbering: two concurrent edits would otherwise race
      // for the same version, and a unique-violation 500 is a poor way to say
      // "try again".
      await client.query(`SELECT id FROM form WHERE id = $1 FOR UPDATE`, [form.id]);

      let base: VersionRow | null;
      if (parsed.data.basedOn) {
        const { rows } = await client.query<VersionRow>(
          `SELECT id, version, title, definition, published_at FROM form_version WHERE id = $1 AND form_id = $2`,
          [parsed.data.basedOn, form.id],
        );
        base = rows[0] ?? null;
        if (!base) throw new HttpError(404, 'not_found');
      } else {
        base = await publishedVersion(client, form.id);
      }

      const definition =
        base?.definition ??
        asDefinition({ title: form.name, defaultLanguage: 'en', languages: ['en'], groups: [], questions: [], choiceLists: {} });
      const next = await nextVersionNumber(client, form.id);

      // One draft at a time: replace it rather than accumulating abandoned drafts.
      await client.query(`DELETE FROM form_version WHERE form_id = $1 AND status = 'draft'`, [form.id]);
      const { rows } = await client.query(
        `INSERT INTO form_version (org_id, form_id, version, status, title, definition, based_on, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, $6, $7)
         RETURNING id, version, status, title, definition, based_on, created_at`,
        [form.org_id, form.id, next, definition.title, JSON.stringify(definition), base?.id ?? null, identity.userId],
      );
      return rows[0];
    });
    return reply.code(201).send({ version });
  });

  app.get(
    '/forms/:formId/versions/:versionId',
    async (req: FastifyRequest<{ Params: { formId: string; versionId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const version = await withUser(identity.userId, async (client) => {
        await loadForm(client, req.params.formId);
        const { rows } = await client.query(
          `SELECT id, form_id, version, status, title, definition, based_on, published_at, created_at
             FROM form_version WHERE id = $1 AND form_id = $2`,
          [req.params.versionId, req.params.formId],
        );
        return rows[0] ?? null;
      });
      if (!version) throw new HttpError(404, 'not_found');
      return reply.send({ version });
    },
  );

  app.put(
    '/forms/:formId/versions/:versionId',
    async (req: FastifyRequest<{ Params: { formId: string; versionId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const body = z.object({ definition: z.unknown() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const result = await withUser(identity.userId, async (client) => {
        await loadForm(client, req.params.formId);
        const { rows: existing } = await client.query<{ status: string }>(
          `SELECT status FROM form_version WHERE id = $1 AND form_id = $2`,
          [req.params.versionId, req.params.formId],
        );
        const current = existing[0];
        if (!current) throw new HttpError(404, 'not_found');
        // A published version is immutable: it answered real responses, and
        // rewriting it would rewrite history. Edit by making a draft from it.
        if (current.status === 'published') {
          throw new HttpError(409, 'version_immutable', 'published versions are immutable — create a new draft from it');
        }
        if (current.status === 'archived') throw new HttpError(409, 'version_archived');

        const definition = asDefinition(body.data.definition);
        const report = validateForm(definition);
        const { rows } = await client.query(
          `UPDATE form_version SET definition = $3::jsonb, title = $4 WHERE id = $1 AND form_id = $2
           RETURNING id, version, status, title, definition, created_at`,
          [req.params.versionId, req.params.formId, JSON.stringify(definition), definition.title],
        );
        // RLS narrows this UPDATE to zero rows for a viewer rather than raising, so
        // an empty result is a permission answer, not a success.
        if (!rows[0]) throw new HttpError(403, 'forbidden', 'your role in this organisation cannot edit forms');
        // Saving is allowed to be imperfect (a half-built form is normal); the errors
        // come back so the builder can show them, and publishing is what enforces them.
        return { version: rows[0], warnings: report.warnings, errors: report.errors };
      });
      return reply.send(result);
    },
  );

  app.post(
    '/forms/:formId/versions/:versionId/publish',
    async (req: FastifyRequest<{ Params: { formId: string; versionId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const result = await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        const { rows: found } = await client.query<{ id: string; status: string; definition: FormDefinition }>(
          `SELECT id, status, definition FROM form_version WHERE id = $1 AND form_id = $2`,
          [req.params.versionId, req.params.formId],
        );
        const version = found[0];
        if (!version) throw new HttpError(404, 'not_found');
        if (version.status === 'published') return { version: null, report: validateForm(version.definition), alreadyPublished: true };

        // Publication is where authoring errors become a blocked publish instead of
        // a respondent looking at a broken form mid-interview.
        const report = validateForm(version.definition);
        if (report.errors.length > 0) {
          throw new HttpError(422, 'invalid_definition', report.errors.join('; '));
        }

        await client.query(`SELECT id FROM form WHERE id = $1 FOR UPDATE`, [form.id]);
        // Archive first: the one-published-version index would reject the update
        // if both rows were published at the same instant.
        await client.query(`UPDATE form_version SET status = 'archived' WHERE form_id = $1 AND status = 'published'`, [
          form.id,
        ]);
        const { rows } = await client.query(
          `UPDATE form_version SET status = 'published', published_at = now()
            WHERE id = $1 RETURNING id, version, status, title, published_at`,
          [req.params.versionId],
        );
        if (!rows[0]) throw new HttpError(403, 'forbidden', 'your role in this organisation cannot publish forms');
        await client.query(`DELETE FROM form_version WHERE form_id = $1 AND status = 'draft' AND id <> $2`, [
          form.id,
          req.params.versionId,
        ]);
        return { version: rows[0], report, alreadyPublished: false };
      });

      if (!result.alreadyPublished) {
        await audit(req, `user:${identity.userId}`, 'form.published', req.params.formId, {
          versionId: req.params.versionId,
        });
      }
      return reply.send(result);
    },
  );

  app.post(
    '/forms/:formId/versions/:versionId/restore',
    async (req: FastifyRequest<{ Params: { formId: string; versionId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const version = await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        const { rows: found } = await client.query<{ id: string; title: string; definition: FormDefinition }>(
          `SELECT id, title, definition FROM form_version WHERE id = $1 AND form_id = $2`,
          [req.params.versionId, req.params.formId],
        );
        const source = found[0];
        if (!source) throw new HttpError(404, 'not_found');

        await client.query(`SELECT id FROM form WHERE id = $1 FOR UPDATE`, [form.id]);
        const next = await nextVersionNumber(client, form.id);
        await client.query(`DELETE FROM form_version WHERE form_id = $1 AND status = 'draft'`, [form.id]);
        // Restoring never rewrites the old version; it creates a new draft from it.
        const { rows } = await client.query(
          `INSERT INTO form_version (org_id, form_id, version, status, title, definition, based_on, created_by)
           VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, $6, $7)
           RETURNING id, version, status, title, based_on, created_at`,
          [form.org_id, form.id, next, source.title, JSON.stringify(source.definition), source.id, identity.userId],
        );
        return rows[0];
      });
      await audit(req, `user:${identity.userId}`, 'form.version_restored', req.params.formId, {
        from: req.params.versionId,
      });
      return reply.code(201).send({ version });
    },
  );

  /* ------------------------------------------------- XLSForm import / export */

  app.post('/forms/:formId/import', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = z.object({ xlsformBase64: z.string().min(1), versionId: z.string().uuid().nullish() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const result = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      const imported = importXlsForm(new Uint8Array(Buffer.from(parsed.data.xlsformBase64, 'base64')));

      if (parsed.data.versionId) {
        const { rows: existing } = await client.query<{ status: string }>(
          `SELECT status FROM form_version WHERE id = $1 AND form_id = $2`,
          [parsed.data.versionId, form.id],
        );
        if (!existing[0]) throw new HttpError(404, 'not_found');
        if (existing[0].status !== 'draft') throw new HttpError(409, 'version_immutable', 'import into a draft version');
        await client.query(`UPDATE form_version SET definition = $3::jsonb, title = $4 WHERE id = $1 AND form_id = $2`, [
          parsed.data.versionId,
          form.id,
          JSON.stringify(imported.definition),
          imported.definition.title,
        ]);
        return { versionId: parsed.data.versionId, definition: imported.definition, notes: imported.notes, sheets: imported.sheets };
      }

      await client.query(`SELECT id FROM form WHERE id = $1 FOR UPDATE`, [form.id]);
      const next = await nextVersionNumber(client, form.id);
      await client.query(`DELETE FROM form_version WHERE form_id = $1 AND status = 'draft'`, [form.id]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO form_version (org_id, form_id, version, status, title, definition, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, $6) RETURNING id`,
        [form.org_id, form.id, next, imported.definition.title, JSON.stringify(imported.definition), identity.userId],
      );
      return { versionId: rows[0]?.id, definition: imported.definition, notes: imported.notes, sheets: imported.sheets };
    });

    await audit(req, `user:${identity.userId}`, 'form.imported', req.params.formId, {
      dropped: (result.notes as Array<{ kind: string }>).filter((n) => n.kind === 'dropped').length,
    });
    return reply.code(201).send(result);
  });

  app.get(
    '/forms/:formId/xlsform',
    async (req: FastifyRequest<{ Params: { formId: string }; Querystring: { versionId?: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const result = await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        const { rows } = req.query.versionId
          ? await client.query<{ definition: FormDefinition }>(
              `SELECT definition FROM form_version WHERE id = $1 AND form_id = $2`,
              [req.query.versionId, form.id],
            )
          : await client.query<{ definition: FormDefinition }>(
              `SELECT definition FROM form_version WHERE form_id = $1
                ORDER BY (status = 'draft') DESC, version DESC LIMIT 1`,
              [form.id],
            );
        const definition = rows[0]?.definition;
        if (!definition) throw new HttpError(404, 'not_found');
        return { xlsform: exportXlsForm(definition), slug: form.slug };
      });

      return reply
        .code(200)
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${result.slug}.xlsx"`)
        .header('x-export-notes', String(result.xlsform.notes.length))
        .send(Buffer.from(result.xlsform.bytes));
    },
  );

  /* -------------------------------------------------------------- responses */

  app.get(
    '/forms/:formId/responses',
    async (
      req: FastifyRequest<{ Params: { formId: string }; Querystring: { status?: string; limit?: string; offset?: string } }>,
      reply: FastifyReply,
    ) => {
      const identity = await requireAcceptedTerms(req);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const statuses = req.query.status ? req.query.status.split(',').filter(Boolean) : null;

      const payload = await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        const { rows: responses } = await client.query(
          `SELECT r.id, r.form_version_id, r.status, r.started_at, r.submitted_at, r.updated_at,
                  v.version AS form_version,
                  coalesce(
                    (SELECT jsonb_object_agg(a.question_id, a.value) FROM response_answer a WHERE a.response_id = r.id),
                    '{}'::jsonb
                  ) AS answers
             FROM response r
             JOIN form_version v ON v.id = r.form_version_id
            WHERE r.form_id = $1
              AND ($2::text[] IS NULL OR r.status = ANY($2::text[]))
            ORDER BY r.started_at DESC
            LIMIT $3 OFFSET $4`,
          [form.id, statuses, limit, offset],
        );
        const { rows: counts } = await client.query(
          `SELECT status, count(*)::int AS count FROM response WHERE form_id = $1 GROUP BY status`,
          [form.id],
        );
        return { responses, counts, limit, offset };
      });
      reply.header('cache-control', 'private, no-store');
      return reply.send(payload);
    },
  );

  /* ------------------------------------------- live analytics (never cached) */

  app.get('/forms/:formId/analytics', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const payload = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      const published = await publishedVersion(client, form.id);
      const { rows: counts } = await client.query(
        `SELECT status, count(*)::int AS count FROM response WHERE form_id = $1 GROUP BY status`,
        [form.id],
      );
      const { rows: tallies } = await client.query(
        `SELECT a.question_id, a.value, count(*)::int AS count
           FROM response_answer a
           JOIN response r ON r.id = a.response_id
          WHERE r.form_id = $1 AND r.status = 'submitted'
          GROUP BY a.question_id, a.value
          ORDER BY a.question_id, count(*) DESC`,
        [form.id],
      );
      const { rows: timeline } = await client.query(
        `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
                count(*)::int AS started,
                count(*) FILTER (WHERE status = 'submitted')::int AS submitted
           FROM response WHERE form_id = $1
          GROUP BY 1 ORDER BY 1`,
        [form.id],
      );
      return {
        definition: published?.definition ?? null,
        publishedVersion: published?.version ?? null,
        byStatus: counts,
        tallies,
        timeline,
        generatedAt: new Date().toISOString(),
      };
    });
    // Computed on every request from the live tables: no cache, no snapshot table.
    reply.header('cache-control', 'private, no-store');
    return reply.send(payload);
  });

  /* ---------------------------------------------------------------- exports */

  app.get(
    '/forms/:formId/responses/export',
    async (
      req: FastifyRequest<{
        Params: { formId: string };
        Querystring: { format?: string; multiSelect?: string; includeInProgress?: string; language?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const identity = await requireAcceptedTerms(req);
      const format = (req.query.format ?? 'csv').toLowerCase();
      if (!['csv', 'xlsx', 'json', 'sav', 'dta'].includes(format)) {
        return reply.code(400).send({ error: 'unknown_format', format });
      }
      if (format === 'sav' || format === 'dta') {
        // Refused, not faked: a file that only fails once a researcher imports it
        // into SPSS is worse than an honest refusal.
        return reply.code(501).send({
          error: 'format_not_available',
          format,
          reason: 'SPSS .sav and Stata .dta need the pyreadstat export worker; export csv, xlsx or json instead',
        });
      }

      const payload = await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        const published = await publishedVersion(client, form.id);
        if (!published) throw new HttpError(409, 'not_published', 'Publish a version in the Builder tab before exporting responses.');

        const { rows: raw } = await client.query<{
          id: string;
          status: 'in_progress' | 'submitted' | 'screened_out' | 'quota_full';
          started_at: Date;
          submitted_at: Date | null;
          answers: Record<string, unknown>;
        }>(
          `SELECT r.id, r.status, r.started_at, r.submitted_at,
                  coalesce(
                    (SELECT jsonb_object_agg(a.question_id, a.value) FROM response_answer a WHERE a.response_id = r.id),
                    '{}'::jsonb
                  ) AS answers
             FROM response r
            WHERE r.form_id = $1
            ORDER BY r.started_at`,
          [form.id],
        );

        // question_id holds the stable question NAME, so an export never depends on
        // database row ids surviving.
        const responses = raw.map((row) => ({
          id: row.id,
          status: row.status,
          startedAt: row.started_at?.toISOString() ?? null,
          submittedAt: row.submitted_at?.toISOString() ?? null,
          answers: row.answers,
        }));

        const bundle = buildExportBundle(published.definition, responses, {
          formats: [format as ExportFormat],
          multiSelect: req.query.multiSelect === 'slots' ? 'slots' : 'dichotomous',
          includeInProgress: req.query.includeInProgress !== 'false',
          language: req.query.language ?? undefined,
          formVersion: published.version,
          // The export metadata names the *published* version it descends from,
          // including when that version went live. A null here used to mean
          // "published" and "never published" looked identical in meta.json.
          publishedAt: published.published_at?.toISOString() ?? null,
        });
        return { bundle, slug: form.slug };
      });

      const { files } = payload.bundle;
      const single = files.length === 1 ? files[0] : undefined;
      if (single) {
        return reply
          .code(200)
          .header('content-type', single.contentType)
          .header('content-disposition', `attachment; filename="${payload.slug}-${single.name}"`)
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(single.bytes));
      }

      // A CSV export is a bundle (data + codebook + labels + missing + meta), so it
      // arrives as one archive rather than five separate downloads.
      const archive = zipFiles(files, payload.slug);
      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${payload.slug}-export.zip"`)
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(archive));
    },
  );

  /* ------------------------------------------------------- distribution links */

  app.get('/forms/:formId/links', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const links = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      const { rows } = await client.query(
        `SELECT id, kind, label, expires_at, max_uses, uses, active, created_at
           FROM dist_link WHERE form_id = $1 ORDER BY created_at DESC`,
        [form.id],
      );
      return rows;
    });
    return reply.send({ links });
  });

  app.post('/forms/:formId/links', async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = z
      .object({
        kind: z.enum(['anonymous', 'single_use', 'multiple', 'panel']),
        label: z.string().trim().max(120).nullish(),
        maxUses: z.number().int().positive().nullish(),
        expiresInDays: z.number().int().positive().max(3650).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const payload = await withUser(identity.userId, async (client) => {
      const form = await loadForm(client, req.params.formId);
      // 32 bytes of CSPRNG: the token is the credential, so it must be unguessable.
      const token = randomBytes(32).toString('base64url');
      const { rows } = await client.query(
        `INSERT INTO dist_link (org_id, form_id, kind, token_hash, label, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END)
         RETURNING id, kind, label, max_uses, expires_at, active, created_at`,
        [
          form.org_id,
          form.id,
          parsed.data.kind,
          sha256Hex(token),
          parsed.data.label ?? null,
          parsed.data.maxUses ?? null,
          parsed.data.expiresInDays ?? null,
        ],
      );
      return { link: rows[0], token };
    });

    await audit(req, `user:${identity.userId}`, 'dist_link.created', req.params.formId, { kind: parsed.data.kind });
    // The raw token is returned exactly once and stored only as a hash, because it
    // is a bearer credential and must not be recoverable from the database.
    return reply.code(201).send({
      ...payload,
      collectPath: `/api/v1/collect/${payload.token}`,
      warning: 'Copy this link now: only its hash is stored, so it cannot be shown again.',
    });
  });

  app.delete(
    '/forms/:formId/links/:linkId',
    async (req: FastifyRequest<{ Params: { formId: string; linkId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      await withUser(identity.userId, async (client) => {
        const form = await loadForm(client, req.params.formId);
        await client.query(`UPDATE dist_link SET active = false WHERE id = $1 AND form_id = $2`, [
          req.params.linkId,
          form.id,
        ]);
      });
      return reply.code(204).send();
    },
  );
};
