import type { PoolClient } from 'pg';
import { pool } from './pool.js';

export type TenantRole = 'school' | 'admin' | 'super_admin' | 'reviewer' | 'viewer';

/** Sentinel used for admin sessions so app.school_id is always a valid uuid. */
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface TenantContext {
  role: TenantRole;
  /** Required when role is 'school'. */
  schoolId?: string | null;
}

/**
 * Runs `fn` inside a transaction whose `app.role` / `app.school_id` GUCs are
 * set for that transaction only. specs/schema.sql's RLS policies read exactly
 * these settings, so every tenant-scoped query must go through here.
 *
 * set_config(..., is_local = true) is the parameterised form of SET LOCAL: it
 * is scoped to the transaction and cannot be injected through.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (ctx.role === 'school' && !ctx.schoolId) {
    throw new Error('withTenant: role "school" requires a schoolId');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.role', $1, true), set_config('app.school_id', $2, true)`,
      [ctx.role, ctx.schoolId && ctx.schoolId.length > 0 ? ctx.schoolId : ZERO_UUID],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already unusable; release() will discard it */
    }
    throw err;
  } finally {
    client.release();
  }
}
