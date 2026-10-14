import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { generateSessionToken, sha256Hex } from '../lib/crypto.js';
import { HttpError, withOrg } from './db.js';
import { audit } from './guards.js';
import { requireActor } from './actors.js';

/**
 * API keys: a machine credential for one organisation.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *  1. **A key belongs to a user as well as an organisation.** Every policy in this
 *     schema authorises through `membership` (see 0003), so a key that carried only
 *     an org id could not read a single row without either a bespoke policy branch
 *     — a second place for tenancy to be wrong — or an RLS bypass. Bound to its
 *     creator, a key inherits exactly the boundary a browser session has: same
 *     policies, same 404s for foreign rows, and removing the person from the team
 *     stops the key on the next request. Revocation is not a separate mechanism
 *     that can drift; it is the membership check that already exists.
 *
 *  2. **The secret is shown once and stored as a hash.** `sha256(secret)` is the
 *     only form on disk. What an operator can see afterwards is the prefix — enough
 *     to match a key to the row in an audit trail, not enough to use it.
 *
 * A key is *narrower* than a session: it can only reach the routes that declare a
 * scope, and it can only act inside the organisation it was issued for.
 */

/**
 * The whole vocabulary, deliberately small. Every scope is a capability somebody
 * would actually grant an integration, and each one is checked at the route that
 * uses it rather than inferred from the path.
 */
export const API_SCOPES = [
  'forms:read',
  'responses:read',
  'responses:export',
  'analytics:read',
  'flags:read',
  'flags:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * The subset a route actually declares.
 *
 * Today that is the whole vocabulary, because every scope names a route that exists:
 * `forms:read` (list, one form, a version's definition, the XLSForm export),
 * `responses:read`, `analytics:read`, `responses:export`, and `flags:read` /
 * `flags:write` for the quality queue.
 *
 * The list is kept separate from the vocabulary on purpose. A scope is a promise
 * about a capability rather than about a route that exists this week, so the next
 * scope may be published before its route is wired — and a key carrying only
 * vocabulary is a key that can call nothing, which is a bad first experience and a
 * lie the console would otherwise repeat. `GET /api-scopes` reports this flag, the
 * console disables what it cannot grant, and `api-keys.test.ts` asserts that the
 * catalogue never runs ahead of the routes that declare a scope.
 */
export const ENFORCED_SCOPES: readonly ApiScope[] = [
  'forms:read',
  'responses:read',
  'responses:export',
  'analytics:read',
  'flags:read',
  'flags:write',
];

/** Shown in the console and in the docs, so a scope is never a magic string. */
export const API_SCOPE_DETAIL: Record<ApiScope, string> = {
  'forms:read': 'Read forms and their published definitions.',
  'responses:read': 'Read responses and their answers.',
  'responses:export': 'Download exports (CSV bundle, XLSX, JSON).',
  'analytics:read': 'Read tallies, timelines and sync-conflict counts.',
  'flags:read': 'Read the quality-flag queue.',
  'flags:write': 'Resolve, dismiss or raise a quality flag.',
};

export const apiScopeSchema = z.enum(API_SCOPES);

export interface ResolvedApiKey {
  keyId: string;
  userId: string;
  orgId: string;
  scopes: readonly ApiScope[];
}

/** `ik_` + 32 random bytes. The prefix is the first 11 characters: `ik_ab12cd34`. */
export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `ik_${generateSessionToken()}`;
  return { secret, prefix: secret.slice(0, 11), hash: sha256Hex(secret) };
}

const SECRET_PATTERN = /^ik_[0-9a-f]{64}$/;

/**
 * Turn a presented secret into an actor, or nothing.
 *
 * The lookup itself is a SECURITY DEFINER function (0010) because it runs before
 * any session exists; everything after it — reading a form, reading a response —
 * goes through the ordinary tenant context, where the membership policies apply.
 * An expired or revoked key is simply not an actor.
 */
export async function resolveApiKey(secret: string): Promise<ResolvedApiKey | null> {
  // Refuse anything that is not shaped like a key before touching the database:
  // an arbitrary Authorization header is not a reason to run a query.
  if (!SECRET_PATTERN.test(secret)) return null;
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    org_id: string;
    scopes: string[];
    active: boolean;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(`SELECT id, user_id, org_id, scopes, active, expires_at, revoked_at FROM app_resolve_api_key($1)`, [
    sha256Hex(secret),
  ]);
  const key = rows[0];
  if (!key) return null;
  if (!key.active || key.revoked_at) return null;
  if (key.expires_at && key.expires_at.getTime() <= Date.now()) return null;
  // Fire and forget: a bookkeeping write must never fail a request that is
  // otherwise authorised.
  void pool
    .query(`SELECT app_touch_api_key($1)`, [key.id])
    .catch(() => undefined);
  return {
    keyId: key.id,
    userId: key.user_id,
    orgId: key.org_id,
    // A scope the code no longer knows is dropped rather than trusted: if a
    // future migration removes a capability, an old key does not keep it.
    scopes: key.scopes.filter((scope): scope is ApiScope =>
      (API_SCOPES as readonly string[]).includes(scope),
    ),
  };
}

/** The visible half of a key row, as the console and the audit trail see it. */
/**
 * The visible half of a key row, as the console and the audit trail see it.
 *
 * The column names are 0001's (`label`, `active`); the API shape is the one a
 * client thinks in (`name`), and the difference is confined to the aliases here.
 */
interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
}

const view = (row: KeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: row.scopes,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  createdBy: row.created_by,
  // Stated rather than inferred by the client, because "can this key still be
  // used" is exactly the question an operator opens this screen to answer.
  active: row.active && (row.expires_at === null || row.expires_at.getTime() > Date.now()),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(apiScopeSchema).max(API_SCOPES.length).default([]),
  // Bounded: a key that outlives the study it was issued for is a key nobody
  // remembers to revoke.
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

export const platformKeyRoutes: FastifyPluginAsync = async (app) => {
  /** What a client may ask for, so the console never hard-codes the list. */
  app.get('/api-scopes', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req);
    return reply.send({
      scopes: API_SCOPES.map((scope) => ({
        scope,
        detail: API_SCOPE_DETAIL[scope],
        enforced: ENFORCED_SCOPES.includes(scope),
      })),
      actor: { via: actor.via },
    });
  });

  app.get(
    '/orgs/:orgId/api-keys',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const keys = await withOrg(actor.userId, req.params.orgId, async (client) => {
        const { rows } = await client.query<KeyRow>(
          `SELECT k.id, k.label AS name, k.prefix, k.scopes, k.active, k.created_at, k.last_used_at,
                  k.expires_at, k.revoked_at, u.email AS created_by
             FROM api_key k
             LEFT JOIN app_user u ON u.id = k.user_id
            WHERE k.org_id = $1
            ORDER BY k.created_at DESC`,
          [req.params.orgId],
        );
        return rows;
      });
      return reply.send({ keys: keys.map(view) });
    },
  );

  /**
   * Mint a key. The secret is in this response and nowhere else, ever: no read
   * route can return it, because only its hash exists.
   */
  app.post(
    '/orgs/:orgId/api-keys',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const { secret, prefix, hash } = generateApiKey();
      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
        : null;

      const created = await withOrg(
        actor.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<KeyRow>(
            `INSERT INTO api_key (org_id, user_id, label, prefix, key_hash, scopes, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
             RETURNING id, label AS name, prefix, scopes, active, created_at, last_used_at,
                       expires_at, revoked_at, (SELECT email FROM app_user WHERE id = $2) AS created_by`,
            [
              req.params.orgId,
              actor.userId,
              parsed.data.name,
              prefix,
              hash,
              parsed.data.scopes,
              expiresAt,
            ],
          );
          return rows[0]!;
        },
        // Issuing a long-lived credential is an administrative act.
        { roles: ['owner', 'admin'] },
      );

      // The audit row records the prefix, never the secret.
      await audit(req, `user:${actor.userId}`, 'api_key.created', created.id, {
        orgId: req.params.orgId,
        name: created.name,
        prefix: created.prefix,
        scopes: created.scopes,
      });
      return reply.code(201).send({ key: view(created), secret });
    },
  );

  /**
   * Rotate: the old secret dies on the next request and a new one inherits the
   * grant.
   *
   * Three properties are deliberate.
   *
   *  1. **The new key keeps the original creator, its scopes and its expiry.**
   *     Rotation changes the secret and nothing else. Binding the new key to
   *     whoever pressed the button would silently move the credential's authority
   *     (an admin rotating a member's key would hand themselves a key that can do
   *     what the member could), and extending the expiry would make "rotate" a
   *     quiet way to keep a lapsed grant alive.
   *  2. **The old key is dead immediately, not within a grace window.** The
   *     requirement is that a rotated key stops working within 60 seconds; a
   *     refusal on the very next request is stronger than that, and an overlap
   *     window is a second live credential that nobody is watching.
   *  3. **A key whose creator has left the team is refused rather than rotated.**
   *     The membership check is what authorises every policy in this schema, so the
   *     new secret would authenticate and then reach nothing: a rotation that
   *     answers `201` and hands over a dead key is worse than a refusal that says
   *     what to do instead.
   */
  app.post(
    '/orgs/:orgId/api-keys/:keyId/rotate',
    async (
      req: FastifyRequest<{ Params: { orgId: string; keyId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const { secret, prefix, hash } = generateApiKey();

      const rotated = await withOrg(
        actor.userId,
        req.params.orgId,
        async (client) => {
          const { rows: previous } = await client.query<{
            id: string;
            user_id: string;
            name: string;
            prefix: string;
            scopes: string[];
            expires_at: Date | null;
          }>(
            `UPDATE api_key
                SET active = false, revoked_at = now(), revoked_by = $3
              WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
              RETURNING id, user_id, label AS name, prefix, scopes, expires_at`,
            [req.params.keyId, req.params.orgId, actor.userId],
          );
          const old = previous[0];
          if (!old) return null;

          const { rows: stillMember } = await client.query<{ role: string }>(
            `SELECT role FROM membership WHERE org_id = $1 AND user_id = $2`,
            [req.params.orgId, old.user_id],
          );
          if (!stillMember[0]) {
            // Thrown inside the transaction, so the revocation above rolls back with
            // it: a refused rotation must not leave the organisation with no key.
            throw new HttpError(
              409,
              'creator_not_a_member',
              'the person this key belongs to is no longer in this organisation, so a rotated key would reach nothing: revoke it and create a new one',
            );
          }

          const { rows } = await client.query<KeyRow>(
            `INSERT INTO api_key (org_id, user_id, label, prefix, key_hash, scopes, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
             RETURNING id, label AS name, prefix, scopes, active, created_at, last_used_at,
                       expires_at, revoked_at, (SELECT email FROM app_user WHERE id = $2) AS created_by`,
            [req.params.orgId, old.user_id, old.name, prefix, hash, old.scopes, old.expires_at],
          );
          return { previous: old, next: rows[0]! };
        },
        { roles: ['owner', 'admin'] },
      );
      if (!rotated) throw new HttpError(404, 'not_found');

      // Prefixes, never secrets: this row is readable by anyone with the audit log.
      await audit(req, `user:${actor.userId}`, 'api_key.rotated', rotated.next.id, {
        orgId: req.params.orgId,
        name: rotated.next.name,
        previousKeyId: rotated.previous.id,
        previousPrefix: rotated.previous.prefix,
        prefix: rotated.next.prefix,
        scopes: rotated.next.scopes,
        expiresAt: rotated.next.expires_at,
      });
      return reply
        .code(201)
        .send({ key: view(rotated.next), secret, revokedKeyId: rotated.previous.id });
    },
  );

  /** Revoke. Kept as a soft delete so the audit trail keeps its target. */
  app.delete(
    '/orgs/:orgId/api-keys/:keyId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; keyId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const revoked = await withOrg(
        actor.userId,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string; prefix: string }>(
            `UPDATE api_key
                SET active = false, revoked_at = now(), revoked_by = $3
              WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
              RETURNING id, prefix`,
            [req.params.keyId, req.params.orgId, actor.userId],
          );
          return rows[0] ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      if (!revoked) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, 'api_key.revoked', revoked.id, {
        orgId: req.params.orgId,
        prefix: revoked.prefix,
      });
      return reply.code(204).send();
    },
  );
};
