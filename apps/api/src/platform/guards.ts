import type { FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { resolveSession, touchSession } from '../auth/session.js';
import { recordAudit } from '../audit/audit.js';
import { HttpError, withUser } from './db.js';

export interface PlatformIdentity {
  userId: string;
  email: string;
  displayName: string | null;
}

/**
 * Platform sessions are `user:<uuid>`. Phase 1 made `school:<uuid>` and
 * `admin:<uuid>`; those are deliberately *not* accepted here — a school session
 * must not be able to act as a platform user just because it is authenticated.
 */
export function parseSubject(subject: string): string | null {
  const match = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(subject);
  return match?.[1] ?? null;
}

export async function currentIdentity(req: FastifyRequest): Promise<PlatformIdentity | null> {
  const token = req.cookies[env.SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = await resolveSession(token);
  if (!session) return null;
  const userId = parseSubject(session.subject);
  if (!userId) return null;

  // app_user is protected by RLS, so read it inside the same context every other
  // query uses rather than reaching around the policies.
  const identity = await withUser(userId, async (client) => {
    const { rows } = await client.query<{ id: string; email: string; display_name: string | null; status: string }>(
      `SELECT id, email, display_name, status FROM app_user WHERE id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row || row.status !== 'active') return null;
    return { userId: row.id, email: row.email, displayName: row.display_name };
  });
  if (!identity) return null;
  await touchSession(session);
  return identity;
}

export async function requireIdentity(req: FastifyRequest): Promise<PlatformIdentity> {
  const identity = await currentIdentity(req);
  if (!identity) throw new HttpError(401, 'unauthenticated');
  return identity;
}

export async function audit(
  req: FastifyRequest,
  actor: string,
  action: string,
  target?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await recordAudit(pool, { actor, action, target: target ?? null, meta, ip: req.ip });
}
