import { afterAll, afterEach, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { env } from '../src/env.js';
import { pool, closePool } from '../src/db/pool.js';
import { sendMail, setTransportForTest } from '../src/mail/transport.js';
import { otpEmail, welcomeEmail } from '../src/mail/templates.js';
import { seedSchool, uniqueEmail } from './helpers/fixtures.js';

/**
 * A transport that keeps the composed message instead of sending it.
 *
 * SMTP is the one path where the template's work can be undone by the transport
 * — a header the relay never receives is a header the reader never sees — so the
 * assertion has to be on `mail.data`, after nodemailer has composed it. The
 * built-in `jsonTransport` would do as well, except that it hides the object
 * behind a string, and a test that parses JSON to find out whether a header
 * exists is a test about JSON.parse.
 */
function captureTransport(): { transport: nodemailer.Transporter; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    name: 'capture',
    version: '0.0.1',
    send(mail: { data: Record<string, unknown> }, callback: (err: Error | null, info: Record<string, unknown>) => void) {
      sent.push(mail.data);
      callback(null, {});
    },
  } as unknown as nodemailer.Transport;
  return { transport: nodemailer.createTransport(transport), sent };
}

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

  it('composes the message an operator configured, reply target included', async () => {
    const email = uniqueEmail('replyto');
    const schoolId = await seedSchool(email, 'Reply-To School');
    const { transport, sent } = captureTransport();
    setTransportForTest(transport);

    await sendMail({ ...welcomeEmail(email, { organisation: 'Reply-To School', role: 'owner' }), schoolId });

    const composed = sent[0]!;
    expect(composed.from).toBe(env.MAIL_FROM);
    expect(composed.to).toBe(email);
    expect(composed.subject).toBe('Welcome to Inicio, Reply-To School');
    // A reply target is not decoration: the welcome invites a reply, and the
    // sender is an address that may well be unable to receive one.
    expect(composed.replyTo).toBe(env.MAIL_REPLY_TO);
    expect(composed.html).toBeTypeOf('string');
    expect(composed.text).toBeTypeOf('string');

    const { rows } = await pool.query<{ status: string; template: string }>(
      `SELECT status, template FROM email_log WHERE school_id = $1 ORDER BY id DESC LIMIT 1`,
      [schoolId],
    );
    expect(rows[0]).toEqual({ status: 'sent', template: 'welcome' });
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
