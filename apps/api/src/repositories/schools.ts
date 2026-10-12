import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool.js';

export type SchoolStatus = 'invited' | 'active' | 'disabled';

export interface SchoolRow {
  id: string;
  name: string;
  region: string | null;
  registered_email: string;
  status: SchoolStatus;
  activated: boolean;
}

/** Emails are stored case-insensitively; normalise before every lookup. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findSchoolByEmail(
  email: string,
  db: Pool | PoolClient = pool,
): Promise<SchoolRow | null> {
  const { rows } = await db.query<SchoolRow>(
    `SELECT id, name, region, registered_email, status, activated
       FROM school
      WHERE registered_email = $1`,
    [normaliseEmail(email)],
  );
  return rows[0] ?? null;
}

export async function findSchoolById(
  id: string,
  db: Pool | PoolClient = pool,
): Promise<SchoolRow | null> {
  const { rows } = await db.query<SchoolRow>(
    `SELECT id, name, region, registered_email, status, activated
       FROM school
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
