import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, withOrg, withUser } from './db.js';
import { audit } from './guards.js';
import { requireAcceptedTerms } from './terms.js';

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(60).optional(),
});
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
});
const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(60).optional(),
});

export const platformOrgRoutes: FastifyPluginAsync = async (app) => {
  app.get('/orgs', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const rows = await withUser(identity.userId, async (client) => {
      const { rows: found } = await client.query(
        `SELECT o.id, o.name, o.slug, o.plan, o.brand, m.role, o.created_at,
                (SELECT count(*)::int FROM form f WHERE f.org_id = o.id AND f.archived_at IS NULL) AS form_count,
                (SELECT count(*)::int FROM membership mm WHERE mm.org_id = o.id) AS member_count
           FROM membership m
           JOIN org o ON o.id = m.org_id
          WHERE m.user_id = $1
          ORDER BY o.created_at`,
        [identity.userId],
      );
      return found;
    });
    return reply.send({ organisations: rows });
  });

  app.post('/orgs', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const created = await withUser(identity.userId, async (client) => {
      // SECURITY DEFINER: creating the org and its first owner-membership has to
      // happen before any membership exists to authorise it.
      const { rows } = await client.query<{ app_create_org: string }>(
        `SELECT app_create_org($1, $2)`,
        [parsed.data.name, parsed.data.slug ?? slugify(parsed.data.name)],
      );
      const orgId = rows[0]?.app_create_org;
      if (!orgId) throw new HttpError(500, 'create_failed');
      const { rows: orgs } = await client.query(`SELECT id, name, slug, plan, created_at FROM org WHERE id = $1`, [orgId]);
      return orgs[0];
    });

    await audit(req, `user:${identity.userId}`, 'org.created', created?.['id'] as string, { name: parsed.data.name });
    return reply.code(201).send({ organisation: created });
  });

  app.get('/orgs/:orgId', async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const org = await withOrg(identity.userId, req.params.orgId, async (client) => {
      const { rows } = await client.query(`SELECT id, name, slug, plan, brand, created_at FROM org WHERE id = $1`, [
        req.params.orgId,
      ]);
      return rows[0] ?? null;
    });
    if (!org) throw new HttpError(404, 'not_found');
    return reply.send({ organisation: org });
  });

  app.patch(
    '/orgs/:orgId',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

      const org = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query(
            `UPDATE org SET name = $2 WHERE id = $1 RETURNING id, name, slug, plan`,
            [req.params.orgId, parsed.data.name],
          );
          return rows[0] ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      if (!org) throw new HttpError(404, 'not_found');
      await audit(req, `user:${identity.userId}`, 'org.renamed', req.params.orgId, { name: parsed.data.name });
      return reply.send({ organisation: org });
    },
  );

  app.get('/orgs/:orgId/members', async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
    const identity = await requireAcceptedTerms(req);
    const members = await withOrg(identity.userId, req.params.orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT m.id, m.user_id, m.role, m.created_at, u.email, u.display_name
           FROM membership m
           JOIN app_user u ON u.id = m.user_id
          WHERE m.org_id = $1
          ORDER BY m.created_at`,
        [req.params.orgId],
      );
      return rows;
    });
    return reply.send({ members });
  });

  app.post(
    '/orgs/:orgId/members',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

      const userId = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          // Naming a non-member is impossible under app_user's own policies, so the
          // invite path runs in a SECURITY DEFINER function that re-checks the
          // caller's role itself.
          const { rows } = await client.query<{ app_invite_member: string }>(
            `SELECT app_invite_member($1, $2::citext, $3)`,
            [req.params.orgId, parsed.data.email, parsed.data.role],
          );
          return rows[0]?.app_invite_member ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      await audit(req, `user:${identity.userId}`, 'org.member_invited', req.params.orgId, {
        email: parsed.data.email,
        role: parsed.data.role,
      });
      return reply.code(201).send({ userId, role: parsed.data.role });
    },
  );

  app.delete(
    '/orgs/:orgId/members/:userId',
    async (req: FastifyRequest<{ Params: { orgId: string; userId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          const { rows: target } = await client.query<{ role: string }>(
            `SELECT role FROM membership WHERE org_id = $1 AND user_id = $2`,
            [req.params.orgId, req.params.userId],
          );
          if (!target[0]) throw new HttpError(404, 'not_found');

          // An organisation must never be left with no owner.
          if (target[0].role === 'owner') {
            const { rows: owners } = await client.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM membership WHERE org_id = $1 AND role = 'owner'`,
              [req.params.orgId],
            );
            if ((owners[0]?.count ?? 0) <= 1) {
              throw new HttpError(409, 'last_owner', 'promote another owner before removing this one');
            }
          }

          await client.query(`DELETE FROM membership WHERE org_id = $1 AND user_id = $2`, [
            req.params.orgId,
            req.params.userId,
          ]);
        },
        { roles: ['owner', 'admin'] },
      );
      await audit(req, `user:${identity.userId}`, 'org.member_removed', req.params.orgId, { userId: req.params.userId });
      return reply.code(204).send();
    },
  );

  app.get(
    '/orgs/:orgId/projects',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const projects = await withOrg(identity.userId, req.params.orgId, async (client) => {
        const { rows } = await client.query(
          `SELECT p.id, p.name, p.slug, p.created_at,
                  (SELECT count(*)::int FROM form f WHERE f.project_id = p.id) AS form_count
             FROM project p WHERE p.org_id = $1 ORDER BY p.created_at`,
          [req.params.orgId],
        );
        return rows;
      });
      return reply.send({ projects });
    },
  );

  app.post(
    '/orgs/:orgId/projects',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const parsed = projectSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const project = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query(
            `INSERT INTO project (org_id, name, slug) VALUES ($1, $2, $3)
             RETURNING id, name, slug, created_at`,
            [req.params.orgId, parsed.data.name, parsed.data.slug ?? slugify(parsed.data.name)],
          );
          return rows[0];
        },
        { write: true },
      );
      return reply.code(201).send({ project });
    },
  );
};
