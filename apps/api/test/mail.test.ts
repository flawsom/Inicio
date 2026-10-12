import { afterAll, afterEach, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { pool, closePool } from '../src/db/pool.js';
import { sendMail, setTransportForTest } from '../src/mail/transport.js';
import { otpEmail } from '../src/mail/templates.js';
import { seedSchool, uniqueEmail } from './helpers/fixtures.js';

afterEach(() => setTransportForTest(null));
afterAll(async () => {
  await closePool();
});

describe('email delivery (§7.9, §9)', () => {
  it('records an email_log row and flips it to sent', async () => {
    const email = uniqueEmail('mail');
    const schoolId = await seedSchool(email, 'Mail School');
    setTransportForTest(nodemailer.createTransport({ jsonTransport: true }));

    await sendMail({ ...otpEmail(email, '123456'), schoolId });

    const { rows } = await pool.query<{ status: string; template: string }>(
      `SELECT status, template FROM email_log WHERE school_id = $1 ORDER BY id DESC LIMIT 1`,
      [schoolId],
    );
    expect(rows[0]).toEqual({ status: 'sent', template: 'otp' });
  });

  it('records a failed send as failed without throwing at the caller of deliverInBackground', async () => {
    const email = uniqueEmail('mailfail');
    const schoolId = await seedSchool(email, 'Mail Fail School');
    setTransportForTest(
      nodemailer.createTransport({ host: '127.0.0.1', port: 1, secure: false, tls: { rejectUnauthorized: false }, connectionTimeout: 500 }),
    );

    await expect(sendMail({ ...otpEmail(email, '999999'), schoolId })).rejects.toBeTruthy();

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM email_log WHERE school_id = $1 ORDER BY id DESC LIMIT 1`,
      [schoolId],
    );
    expect(rows[0]!.status).toBe('failed');
  });
});
