import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { generateOtpCode, sha256Hex, timingSafeEqualHex } from '../lib/crypto.js';
import { recordAudit } from '../audit/audit.js';
import { findSchoolByEmail, normaliseEmail, type SchoolRow } from '../repositories/schools.js';

export type RequestOtpResult =
  | { status: 'sent'; code: string; school: SchoolRow }
  | { status: 'not_invited' }
  | { status: 'cooldown'; retryAfterSeconds: number };

export type VerifyOtpResult =
  | { status: 'verified'; school: SchoolRow }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'attempts_exceeded' };

interface OtpRow {
  id: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  consumed: boolean;
}

/**
 * §7.1: only registered school emails can request an OTP. Unknown or disabled
 * schools get a uniform "not invited" so the endpoint is not an email oracle.
 */
export async function requestOtp(input: { email: string; ip?: string | null }): Promise<RequestOtpResult> {
  const email = normaliseEmail(input.email);
  // Accounts are created by invitation only. There is no self-signup path here:
  // an address with no account gets the same uniform "not invited" as a
  // disabled one, so the endpoint never confirms who exists.
  const school = await findSchoolByEmail(email);
  if (!school || school.status === 'disabled') return { status: 'not_invited' };

  // Durable resend cooldown (survives restarts, unlike an in-memory limiter).
  if (env.OTP_RESEND_COOLDOWN_SECONDS > 0) {
    const recent = await pool.query<{ seconds: number | null }>(
      `SELECT CEIL(EXTRACT(EPOCH FROM ($2::timestamptz - MAX(created_at))))::int AS seconds
         FROM otp
        WHERE school_id = $1 AND created_at > $2::timestamptz - make_interval(secs => $3)`,
      [school.id, new Date(), env.OTP_RESEND_COOLDOWN_SECONDS],
    );
    // seconds is NULL when the school has no OTP inside the cooldown window.
    const seconds = recent.rows[0]?.seconds;
    if (seconds !== null && seconds !== undefined) {
      const remaining = env.OTP_RESEND_COOLDOWN_SECONDS - seconds;
      if (remaining > 0) return { status: 'cooldown', retryAfterSeconds: remaining };
    }
  }

  const code = generateOtpCode();
  const codeHash = sha256Hex(code + env.OTP_PEPPER);
  await pool.query(
    `INSERT INTO otp (school_id, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [school.id, codeHash, env.OTP_TTL_MINUTES],
  );
  await recordAudit(pool, {
    actor: `school:${school.id}`,
    action: 'otp.requested',
    target: school.id,
    ip: input.ip ?? null,
  });
  return { status: 'sent', code, school };
}

/**
 * §7.1 / §8: wrong code 3x -> the outstanding code is exhausted and a fresh
 * OTP is required. Expired code -> 'expired' (respondent is prompted to
 * resend; no data is lost). Constant-time comparison throughout.
 */
export async function verifyOtp(input: {
  email: string;
  code: string;
  ip?: string | null;
}): Promise<VerifyOtpResult> {
  const email = normaliseEmail(input.email);
  const school = await findSchoolByEmail(email);
  if (!school || school.status === 'disabled') return { status: 'invalid' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OtpRow>(
      `SELECT id, code_hash, expires_at, attempts, consumed
         FROM otp
        WHERE school_id = $1 AND consumed = false
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [school.id],
    );
    const otp = rows[0];
    if (!otp) {
      await client.query('ROLLBACK');
      return { status: 'expired' };
    }
    if (otp.expires_at.getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { status: 'expired' };
    }
    if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
      await client.query('ROLLBACK');
      return { status: 'attempts_exceeded' };
    }

    const matches = timingSafeEqualHex(sha256Hex(input.code + env.OTP_PEPPER), otp.code_hash);
    if (!matches) {
      const attempts = otp.attempts + 1;
      const exhausted = attempts >= env.OTP_MAX_ATTEMPTS;
      // Leave `consumed` false so every later attempt keeps reporting
      // attempts_exceeded ("request a fresh code") rather than a misleading
      // "expired". An exhausted code can never be redeemed, even if correct.
      await client.query('UPDATE otp SET attempts = $2 WHERE id = $1', [otp.id, attempts]);
      await recordAudit(client, {
        actor: `school:${school.id}`,
        action: exhausted ? 'otp.attempts_exceeded' : 'otp.rejected',
        target: otp.id,
        meta: { attempts },
        ip: input.ip ?? null,
      });
      await client.query('COMMIT');
      return exhausted ? { status: 'attempts_exceeded' } : { status: 'invalid' };
    }

    await client.query('UPDATE otp SET consumed = true WHERE id = $1', [otp.id]);
    await recordAudit(client, {
      actor: `school:${school.id}`,
      action: 'otp.verified',
      target: otp.id,
      ip: input.ip ?? null,
    });
    await client.query('COMMIT');
    return { status: 'verified', school };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
