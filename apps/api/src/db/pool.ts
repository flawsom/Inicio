import { Pool } from 'pg';
import { env } from '../env.js';

/**
 * Application pool. Connects as the least-privilege role from DATABASE_URL.
 * Small pool: serverless invocations are short-lived and the database (Neon /
 * Tiger Cloud) provides server-side pooling.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'production' ? 5 : 10,
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Tenancy is a property of the database connection, not a promise about the
 * queries.
 *
 * PostgreSQL row level security is bypassed entirely for a superuser and for any
 * role holding BYPASSRLS, and it is not applied to a table's owner unless the
 * table has FORCE ROW LEVEL SECURITY. A deployment that connects as the database
 * owner therefore has no tenant boundary at all, however careful the SQL is:
 * every organisation could read every other organisation's rows.
 *
 * Managed platforms make this the easy mistake, because the connection string
 * they hand out is the owner's. So it is checked rather than assumed, on every
 * cold start. In production a connection that cannot enforce RLS stops the
 * process; anywhere else it is a loud warning, because a developer's local role
 * may legitimately differ.
 */
export async function assertTenancyEnforced(): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const role = rows[0];
  if (!role) throw new Error('could not read the current database role');

  if (!role.rolsuper && !role.rolbypassrls) return;

  const why = role.rolsuper ? 'is a superuser' : 'has BYPASSRLS';
  const detail =
    `the API is connected as "${role.rolname}", which ${why}, so row level security is not ` +
    `enforced and one organisation could read another's data. Point APP_DATABASE_URL (or ` +
    `DATABASE_URL) at the least-privilege role created by migration 0002.`;

  if (env.NODE_ENV === 'production') throw new Error(`Refusing to start: ${detail}`);
  console.warn(`[tenancy] ${detail}`);
}
