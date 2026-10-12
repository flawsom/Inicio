import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { generateSessionToken, sha256Hex } from '../lib/crypto.js';
import { recordAudit } from '../audit/audit.js';

export interface SessionRow {
  id: string;
  subject: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface IssuedSession {
  token: string;
  subject: string;
  expiresAt: Date;
}

function idleExpiry(): Date {
  return new Date(Date.now() + env.SESSION_IDLE_MINUTES * 60_000);
}

/** subject is `school:<uuid>` or `admin:<uuid>` — the schema's own convention. */
export async function issueSession(subject: string, ip?: string | null): Promise<IssuedSession> {
  const token = generateSessionToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = idleExpiry();
  await pool.query(`INSERT INTO session (subject, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    subject,
    tokenHash,
    expiresAt,
  ]);
  await recordAudit(pool, { actor: subject, action: 'session.issued', ip: ip ?? null });
  return { token, subject, expiresAt };
}

/** Returns null for unknown, expired (idle or absolute) sessions. */
export async function resolveSession(token: string): Promise<SessionRow | null> {
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, subject, token_hash, expires_at, created_at FROM session WHERE token_hash = $1`,
    [tokenHash],
  );
  const session = rows[0];
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at.getTime() <= now) return null;
  const absoluteMs = env.SESSION_ABSOLUTE_DAYS * 86_400_000;
  if (session.created_at.getTime() + absoluteMs <= now) return null;
  return session;
}

/**
 * Sliding idle expiry on activity, capped by the absolute lifetime so a session
 * can never be extended indefinitely. Never touches data, so a timed-out
 * respondent keeps their draft (§7.3 / §8).
 */
export async function touchSession(session: SessionRow): Promise<void> {
  const absoluteCap = session.created_at.getTime() + env.SESSION_ABSOLUTE_DAYS * 86_400_000;
  const next = Math.min(idleExpiry().getTime(), absoluteCap);
  if (next <= session.expires_at.getTime()) return;
  await pool.query(`UPDATE session SET expires_at = $2 WHERE id = $1`, [
    session.id,
    new Date(next),
  ]);
}

export async function revokeSession(token: string, ip?: string | null): Promise<void> {
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query<{ subject: string }>(
    `DELETE FROM session WHERE token_hash = $1 RETURNING subject`,
    [tokenHash],
  );
  const subject = rows[0]?.subject;
  if (subject) {
    await recordAudit(pool, { actor: subject, action: 'session.revoked', ip: ip ?? null });
  }
}
