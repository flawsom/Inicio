import { randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { env } from '../env.js';
import { pool, closePool } from '../db/pool.js';
import { recordAudit } from '../audit/audit.js';
import { normaliseEmail } from '../repositories/schools.js';

/**
 * Admin bootstrap. specs/schema.sql ships no seed, and this script refuses to
 * invent a default password: ADMIN_EMAIL + ADMIN_PASSWORD must be supplied.
 *
 * Password hashing is argon2id with OWASP-recommended parameters. hash-wasm is
 * used (pure WASM) rather than a native addon so the same code runs on Vercel
 * and Netlify without a compiler.
 */
const ARGON2 = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;
const MIN_PASSWORD_LENGTH = 12;

async function main(): Promise<void> {
  const email = env.ADMIN_EMAIL ? normaliseEmail(env.ADMIN_EMAIL) : '';
  const password = env.ADMIN_PASSWORD ?? '';

  if (!email) throw new Error('ADMIN_EMAIL is required');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const existing = await pool.query<{ id: string; role: string }>(
    `SELECT id, role FROM admin_user WHERE email = $1`,
    [email],
  );
  if (existing.rows[0] && !process.argv.includes('--force')) {
    throw new Error(
      `admin_user ${email} already exists (role=${existing.rows[0].role}). Re-run with --force to rotate the password.`,
    );
  }

  const passwordHash = await argon2id({ password, salt: randomBytes(16), ...ARGON2 });

  if (existing.rows[0]) {
    await pool.query(`UPDATE admin_user SET password_hash = $2, active = true WHERE id = $1`, [
      existing.rows[0].id,
      passwordHash,
    ]);
    await recordAudit(pool, { actor: 'cli', action: 'admin.password_rotated', target: email });
    console.log(`rotated password for admin_user ${email}`);
  } else {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO admin_user (email, password_hash, role) VALUES ($1, $2, 'super_admin') RETURNING id`,
      [email, passwordHash],
    );
    await recordAudit(pool, {
      actor: 'cli',
      action: 'admin.created',
      target: inserted.rows[0]?.id ?? email,
      meta: { email, role: 'super_admin' },
    });
    console.log(`created super_admin ${email}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`admin:create failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
