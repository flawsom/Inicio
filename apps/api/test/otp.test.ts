import { afterAll, describe, expect, it } from 'vitest';
import { pool, closePool } from '../src/db/pool.js';
import { requestOtp, verifyOtp } from '../src/auth/otp.js';
import { issueSession, resolveSession, revokeSession } from '../src/auth/session.js';
import { seedSchool, uniqueEmail } from './helpers/fixtures.js';

afterAll(async () => {
  await closePool();
});

describe('OTP auth (§7.1, §8)', () => {
  it('rejects an email that was never invited', async () => {
    const result = await requestOtp({ email: uniqueEmail('ghost') });
    expect(result.status).toBe('not_invited');
  });

  it('rejects a disabled school without revealing it exists', async () => {
    const email = uniqueEmail('disabled');
    await seedSchool(email, 'Disabled School', 'disabled');
    const result = await requestOtp({ email });
    expect(result.status).toBe('not_invited');
  });

  it('sends a 6-digit code, then verifies it and issues a session', async () => {
    const email = uniqueEmail('happy');
    await seedSchool(email, 'Happy School');
    const requested = await requestOtp({ email: email.toUpperCase() });
    expect(requested.status).toBe('sent');
    if (requested.status !== 'sent') return;
    expect(requested.code).toMatch(/^[0-9]{6}$/);

    const wrong = await verifyOtp({ email, code: '000000' });
    expect(wrong.status).toBe('invalid');

    const right = await verifyOtp({ email, code: requested.code });
    expect(right.status).toBe('verified');

    const session = await issueSession(`school:${(right as { school: { id: string } }).school.id}`);
    const resolved = await resolveSession(session.token);
    expect(resolved?.subject).toContain('school:');
    await revokeSession(session.token);
    expect(await resolveSession(session.token)).toBeNull();
  });

  it('after 3 wrong codes the outstanding OTP is dead and a fresh one is required', async () => {
    const email = uniqueEmail('bruteforce');
    await seedSchool(email, 'Brute Force School');
    const requested = await requestOtp({ email });
    expect(requested.status).toBe('sent');
    if (requested.status !== 'sent') return;

    expect((await verifyOtp({ email, code: '111111' })).status).toBe('invalid');
    expect((await verifyOtp({ email, code: '222222' })).status).toBe('invalid');
    expect((await verifyOtp({ email, code: '333333' })).status).toBe('attempts_exceeded');
    // the correct code is now useless — a fresh OTP must be requested
    expect((await verifyOtp({ email, code: requested.code })).status).toBe('attempts_exceeded');
  });

  it('reports an expired code as expired (no data loss, resend path)', async () => {
    const email = uniqueEmail('expired');
    const schoolId = await seedSchool(email, 'Expired School');
    await pool.query(
      `INSERT INTO otp (school_id, code_hash, expires_at) VALUES ($1, 'deadbeef', now() - interval '1 minute')`,
      [schoolId],
    );
    const result = await verifyOtp({ email, code: '123456' });
    expect(result.status).toBe('expired');
  });

  it('enforces the resend cooldown', async () => {
    const email = uniqueEmail('cooldown');
    await seedSchool(email, 'Cooldown School');
    expect((await requestOtp({ email })).status).toBe('sent');
    const second = await requestOtp({ email });
    expect(second.status).toBe('cooldown');
  });

  it('writes an audit trail for every auth step', async () => {
    const email = uniqueEmail('audit');
    await seedSchool(email, 'Audit School');
    const requested = await requestOtp({ email });
    expect(requested.status).toBe('sent');
    if (requested.status !== 'sent') return;
    await verifyOtp({ email, code: requested.code });
    const { rows } = await pool.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_log WHERE action LIKE 'otp.%' GROUP BY action`,
    );
    const actions = Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
    expect(actions['otp.requested']).toBeGreaterThanOrEqual(1);
    expect(actions['otp.verified']).toBeGreaterThanOrEqual(1);
  });
});
