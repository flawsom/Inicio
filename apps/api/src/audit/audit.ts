import type { Pool, PoolClient } from 'pg';

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append-only audit trail (AGENTS.md: every mutation writes an audit row).
 * Call this with the *same* client/transaction as the mutation it describes so
 * the two commit or roll back together.
 */
export async function recordAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, target, meta, ip) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      entry.actor,
      entry.action,
      entry.target ?? null,
      JSON.stringify(entry.meta ?? {}),
      entry.ip && entry.ip.length > 0 ? entry.ip : null,
    ],
  );
}
