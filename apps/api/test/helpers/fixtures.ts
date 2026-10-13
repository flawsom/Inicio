import type { FastifyInstance } from 'fastify';
import { Client, type PoolClient } from 'pg';
import { pool } from '../../src/db/pool.js';
import { withTenant } from '../../src/db/tenant.js';
import { PRIVACY, TERMS } from '../../src/legal/documents.js';

let counter = 0;
export function uniqueEmail(prefix = 'school'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.org`;
}

export async function seedSchool(
  email: string,
  name = 'Test School',
  status: 'invited' | 'active' | 'disabled' = 'active',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO school (name, registered_email, status, activated)
     VALUES ($1, $2, $3::school_status, $4) RETURNING id`,
    [name, email, status, status !== 'invited'],
  );
  return rows[0]!.id;
}

export async function seedQuestionnaire(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO questionnaire (version, status, title, config)
     VALUES ($1, 'draft', 'Phase 1 fixture', '{}'::jsonb) RETURNING id`,
    [`v-test-${Date.now()}-${Math.random()}`],
  );
  return rows[0]!.id;
}

/** response_set / answer / attachment sit behind FORCE RLS: seed as an admin tenant. */
export async function seedResponseSet(schoolId: string, questionnaireId: string): Promise<string> {
  return withTenant({ role: 'admin' }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO response_set (school_id, questionnaire_id) VALUES ($1, $2) RETURNING id`,
      [schoolId, questionnaireId],
    );
    return rows[0]!.id;
  });
}

export async function seedAnswer(
  responseSetId: string,
  schoolId: string,
  questionId: string,
  value: unknown,
): Promise<void> {
  await withTenant({ role: 'admin' }, async (client: PoolClient) => {
    await client.query(
      `INSERT INTO answer (response_set_id, school_id, question_id, value_json) VALUES ($1, $2, $3, $4::jsonb)`,
      [responseSetId, schoolId, questionId, JSON.stringify(value)],
    );
  });
}

/**
 * Read the live OTP for a user by brute-checking the 10^6 space against the
 * stored hash.
 *
 * The API never echoes codes to clients — that was the hole where anyone could
 * complete login without a mailbox. Tests therefore sign in the way a real
 * user does: request a code, "receive" it, submit it. The inbox is the
 * database here; the hash is the ground truth for what was issued, and a
 * 6-digit space costs nothing to search offline from inside a test.
 */
export async function readLiveOtp(email: string): Promise<string | null> {
  // RLS keys app_user reads on `app.user_id`, which no test session has — set
  // it superuser-side. This connection reads exactly one row: the live code
  // for one address, which is what the inbox would hold.
  const admin = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ code_hash: string }>(
      `SELECT code_hash
         FROM user_otp o
         JOIN app_user u ON u.id = o.user_id
        WHERE u.email = $1::citext AND o.consumed = false
        ORDER BY o.created_at DESC
        LIMIT 1`,
      [email],
    );
    const hash = rows[0]?.code_hash;
    if (!hash) return null;
    const { sha256Hex } = await import('../../src/lib/crypto.js');
    const pepper = process.env.OTP_PEPPER ?? '';
    for (let n = 0; n < 1_000_000; n += 1) {
      const code = String(n).padStart(6, '0');
      if (sha256Hex(`${code}${pepper}`) === hash) return code;
    }
    return null;
  } finally {
    await admin.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Platform fixtures                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sign in against the real platform surface, as a person does.
 *
 * Shared by the suites that need a signed in account but are not about sign-in,
 * so that "how do I get a session" stays one answer. The steps are the real ones:
 * request a code, read what was actually issued out of the database, verify it,
 * and accept the current terms, because nothing else is reachable until you do.
 */
export interface PlatformSession {
  cookie: string;
  userId: string;
  email: string;
}

export async function signInPlatform(app: FastifyInstance, email: string): Promise<PlatformSession> {
  const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
  if (requested.statusCode !== 200) throw new Error(`otp request failed: ${requested.body}`);
  const code = await readLiveOtp(email);
  if (!code) throw new Error(`no live OTP for ${email}`);

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { email, code },
  });
  if (verified.statusCode !== 200) throw new Error(`otp verify failed: ${verified.body}`);
  const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/terms/accept',
    headers: { cookie },
    payload: { termsVersion: TERMS.version, privacyVersion: PRIVACY.version, accepted: true },
  });
  if (accepted.statusCode !== 200) throw new Error(`terms accept failed: ${accepted.body}`);

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  if (me.statusCode !== 200) throw new Error(`me failed: ${me.body}`);
  return { cookie, userId: (me.json() as { user: { id: string } }).user.id, email };
}

export async function createOrgFor(app: FastifyInstance, session: PlatformSession, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    headers: { cookie: session.cookie },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`create org failed: ${res.body}`);
  return (res.json() as { organisation: { id: string } }).organisation.id;
}

/** A form, a published version of it, and the version id, in one call. */
export async function createPublishedForm(
  app: FastifyInstance,
  session: PlatformSession,
  orgId: string,
  name: string,
  definition: unknown,
): Promise<{ formId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: session.cookie },
    payload: { orgId, name, definition },
  });
  if (created.statusCode !== 201) throw new Error(`create form failed: ${created.body}`);
  const formId = (created.json() as { form: { id: string }; version: { id: string } }).form.id;
  const versionId = (created.json() as { version: { id: string } }).version.id;

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
    headers: { cookie: session.cookie },
  });
  if (published.statusCode !== 200) throw new Error(`publish failed: ${published.body}`);
  return { formId, versionId };
}
