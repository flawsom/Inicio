import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

/**
 * Platform request context.
 *
 * Phase 1's `withTenant` sets `app.role` / `app.school_id` for the school schema.
 * The platform model keys off `app.user_id` and `app.org_id` (see 0003), so it
 * needs its own wrapper — and the two must not be mixed in one transaction.
 *
 * The rules that make tenant isolation real rather than decorative:
 *  - `app.org_id` is set **only after** membership has been verified in the same
 *    transaction, so a caller cannot ask for an org it does not belong to.
 *  - even if `app.org_id` were forged, the policies read *membership*, so the
 *    rows still would not come back.
 *  - `set_config(..., true)` is transaction-local: nothing leaks to the next
 *    request that checks out the same pooled connection.
 */

export interface PlatformUser {
  id: string;
}

/**
 * Who was refused, in the audit trail's own actor form.
 *
 * Attached to a refusal at the point where the code knows who the caller is, because
 * that is the only place that knows: `requireActor` has resolved a key or a session
 * and is about to refuse it, while the error handler that writes the row sees only an
 * error. An unauthenticated `401` attaches nothing, which is deliberate — there is no
 * actor to attribute it to, and a row per anonymous guess is a growth vector rather
 * than a record.
 */
export interface RefusedActor {
  /** `user:<uuid>` or `key:<uuid>`. */
  actor: string;
  meta?: Record<string, unknown>;
}

/**
 * Fastify's error handler keys off `statusCode`, so carrying it here means a route
 * can simply throw and the response still has the right status and machine-readable
 * code. `code` is our own vocabulary, not a Node error code.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  constructor(
    status: number,
    readonly code: string,
    message?: string,
    /** Present when the refusal is attributable: the handler records it as `access.denied`. */
    readonly audit?: RefusedActor,
  ) {
    super(message ?? code);
    this.statusCode = status;
  }
}

export async function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return run({ userId }, fn);
}

/**
 * Verifies membership, then runs `fn` with `app.org_id` set. Throws 404 (not 403)
 * when the caller is not a member: whether an organisation exists is not a
 * member's business to probe.
 */
export async function withOrg<T>(
  userId: string,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { roles?: ReadonlyArray<'owner' | 'admin' | 'member' | 'viewer'>; write?: boolean } = {},
): Promise<T> {
  return run({ userId, orgId }, async (client) => {
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    const role = rows[0]?.role;
    if (!role) throw new HttpError(404, 'not_found');
    if (options.roles && !options.roles.includes(role as 'owner')) {
      throw new HttpError(403, 'forbidden', `requires role: ${options.roles.join(', ')}`, {
        actor: `user:${userId}`,
        meta: { orgId, role, requiredRoles: options.roles },
      });
    }
    if (options.write && role === 'viewer') {
      throw new HttpError(403, 'read_only_role', 'a viewer can read and export, but not change anything', {
        actor: `user:${userId}`,
        meta: { orgId, role },
      });
    }
    return fn(client);
  });
}

async function run<T>(
  ctx: { userId: string; orgId?: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `true` => is_local: scoped to this transaction only.
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    if (ctx.orgId) await client.query(`SELECT set_config('app.org_id', $1, true)`, [ctx.orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is unusable; release() discards it */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Roster role of the caller in an org, or null. */
export async function membershipRole(userId: string, orgId: string): Promise<string | null> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM membership WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return rows[0]?.role ?? null;
  });
}

/**
 * Public collection context.
 *
 * A respondent is not a member of anything, so membership-based policies cannot
 * authorise them. The policies for this case (see 0003) require
 * `app.collector = 'on'` plus the *single* response this transaction may touch, and
 * `app.org_id` set to the organisation that owns the distribution link the token
 * resolved to. A collector therefore cannot read any other response, any other
 * organisation, or any of the authoring tables — the policy set is that narrow on
 * purpose.
 */
export async function withCollector<T>(
  orgId: string,
  responseId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await client.query(`SELECT set_config('app.collector', 'on', true)`);
    if (responseId) await client.query(`SELECT set_config('app.response_id', $1, true)`, [responseId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* release() discards an unusable connection */
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface ResolvedLink {
  id: string;
  org_id: string;
  form_id: string;
  kind: 'anonymous' | 'single_use' | 'multiple' | 'panel';
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  active: boolean;
}
