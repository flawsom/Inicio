import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { mailStatus } from '../mail/transport.js';
import { HttpError, withOrg } from './db.js';
import { audit } from './guards.js';
import { requireAcceptedTerms } from './terms.js';
import { sha256Hex } from '../lib/crypto.js';

/**
 * The administration surface: the roster, the invitations, and mail health.
 *
 * Every route here is scoped to one organisation and requires owner or admin
 * there. A member or viewer cannot reach any of it, and the check is on the
 * server, not in the menu: `withOrg({ roles: ['owner','admin'] })` runs before
 * the handler body. Membership is also re-checked on every request, so removing
 * someone takes effect immediately rather than at their next sign in.
 */

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
  /** Days the invitation stays usable. Capped: a long lived link is a liability. */
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
});

const roleSchema = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) });

/** 32 random bytes, URL safe. Stored only as a hash; shown exactly once. */
function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export const platformAdminRoutes: FastifyPluginAsync = async (app) => {
  // ---------------------------------------------------------------- roster ---
  app.patch(
    '/orgs/:orgId/members/:userId',
    async (req: FastifyRequest<{ Params: { orgId: string; userId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

      const member = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          // Replacing the last owner would leave an organisation nobody can
          // administer, so the demotion is refused rather than silently applied.
          if (parsed.data.role !== 'owner') {
            const { rows } = await client.query<{ role: string; owners: number }>(
              `SELECT m.role,
                      (SELECT count(*)::int FROM membership o
                        WHERE o.org_id = m.org_id AND o.role = 'owner') AS owners
                 FROM membership m
                WHERE m.org_id = $1 AND m.user_id = $2`,
              [req.params.orgId, req.params.userId],
            );
            const row = rows[0];
            if (!row) throw new HttpError(404, 'not_found');
            if (row.role === 'owner' && row.owners <= 1) {
              throw new HttpError(409, 'last_owner', 'promote another owner before changing this one');
            }
          }
          const { rows: updated } = await client.query(
            `UPDATE membership SET role = $3 WHERE org_id = $1 AND user_id = $2
             RETURNING user_id, role`,
            [req.params.orgId, req.params.userId, parsed.data.role],
          );
          if (!updated[0]) throw new HttpError(404, 'not_found');
          return updated[0];
        },
        { roles: ['owner', 'admin'] },
      );

      await audit(req, `user:${identity.userId}`, 'org.member_role_changed', req.params.orgId, {
        userId: req.params.userId,
        role: parsed.data.role,
      });
      return reply.send({ member });
    },
  );

  // ------------------------------------------------------------ invitations ---
  app.get(
    '/orgs/:orgId/invites',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const invites = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          // The token hash is never returned: the link exists in the response to
          // its creation and nowhere else.
          const { rows } = await client.query(
            `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
                    (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS pending
               FROM member_invite i
              WHERE i.org_id = $1
              ORDER BY i.created_at DESC
              LIMIT 100`,
            [req.params.orgId],
          );
          return rows;
        },
        { roles: ['owner', 'admin'] },
      );
      return reply.send({ invites });
    },
  );

  app.post(
    '/orgs/:orgId/invites',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

      const { token, hash } = newInviteToken();
      const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);

      const invite = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ app_create_invite: string }>(
            `SELECT app_create_invite($1, $2::citext, $3, $4, $5)`,
            [req.params.orgId, parsed.data.email, parsed.data.role, hash, expiresAt],
          );
          const id = rows[0]?.app_create_invite;
          if (!id) throw new HttpError(500, 'invite_failed');
          const { rows: stored } = await client.query(
            `SELECT id, email, role, expires_at, created_at FROM member_invite WHERE id = $1`,
            [id],
          );
          return stored[0];
        },
        { roles: ['owner', 'admin'] },
      );

      await audit(req, `user:${identity.userId}`, 'org.invite_created', req.params.orgId, {
        email: parsed.data.email,
        role: parsed.data.role,
        inviteId: invite?.['id'],
        // The token itself is never audited: logs are not a credential store.
      });

      return reply.code(201).send({
        invite,
        // Shown once, never retrievable later.
        url: `${env.APP_ORIGIN}/invite/${token}`,
        singleUse: true,
      });
    },
  );

  app.delete(
    '/orgs/:orgId/invites/:inviteId',
    async (req: FastifyRequest<{ Params: { orgId: string; inviteId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      const revoked = await withOrg(
        identity.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query(
            `UPDATE member_invite SET revoked_at = now()
              WHERE id = $2 AND org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              RETURNING id`,
            [req.params.orgId, req.params.inviteId],
          );
          if (!rows[0]) throw new HttpError(404, 'not_found');
          return rows[0];
        },
        { roles: ['owner', 'admin'] },
      );
      await audit(req, `user:${identity.userId}`, 'org.invite_revoked', req.params.orgId, {
        inviteId: req.params.inviteId,
      });
      return reply.send({ revoked });
    },
  );

  // ------------------------------------------------------------ mail health ---
  app.get(
    '/orgs/:orgId/diagnostics/mail',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const identity = await requireAcceptedTerms(req);
      await withOrg(identity.userId, req.params.orgId, async () => undefined, { roles: ['owner', 'admin'] });

      // The technical detail lives here rather than on the login page: an
      // administrator can act on it, an anonymous visitor should not be told
      // which relay refused or why.
      const status = await mailStatus(true);
      const { rows } = await pool.query<{ template: string; status: string; ts: string }>(
        `SELECT template, status, ts
           FROM email_log
          ORDER BY ts DESC
          LIMIT 20`,
      );
      return reply.send({ status, recent: rows });
    },
  );
};
