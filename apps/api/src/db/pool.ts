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
