import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { env } from '../src/env.js';
import { MailProviderError, createResendSender } from '../src/mail/resend.js';
import { otpEmail } from '../src/mail/templates.js';
import type { MailJob } from '../src/mail/transport.js';
import { readLiveOtp } from './helpers/fixtures.js';
import {
  deliverForLogin,
  mailStatus,
  resetDeliveryForTest,
  selectTransport,
  sendMail,
  setSenderForTest,
} from '../src/mail/transport.js';

/**
 * Mail over HTTPS.
 *
 * The reason this transport exists: a network can refuse every SMTP port
 * (25/465/587) while allowing 443, and then an SMTP-only deployment cannot
 * deliver anything, however correct its configuration looks. These tests pin
 * the two things that matter — the request we actually send, and that the
 * provider's own refusal reaches the operator instead of a generic failure.
 */

interface StubCall {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): { impl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function resendWith(impl: typeof fetch) {
  return createResendSender({
    apiKey: 're_test_key',
    from: 'Inicio Survey <onboarding@resend.dev>',
    fetchImpl: impl,
  });
}

afterEach(() => {
  setSenderForTest(null);
  resetDeliveryForTest();
});

afterAll(async () => {
  await closePool();
});

describe('transport selection', () => {
  it('prefers an explicit MAIL_TRANSPORT, then an API key, then SMTP', () => {
    expect(selectTransport({})).toBe('smtp');
    expect(selectTransport({ RESEND_API_KEY: 're_k' })).toBe('resend');
    expect(selectTransport({ MAIL_TRANSPORT: 'smtp', RESEND_API_KEY: 're_k' })).toBe('smtp');
    expect(selectTransport({ MAIL_TRANSPORT: 'resend' })).toBe('resend');
  });
});

describe('resend over HTTPS', () => {
  it('posts the message the provider expects and reports the accepted id', async () => {
    const { impl, calls } = stubFetch(200, { id: '01a13009-0cfd-73fc-a20c-02aa994a25b0' });
    setSenderForTest(resendWith(impl));

    const delivery = await sendMail({ ...otpEmail('owner@example.com', '123456'), schoolId: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: 'Inicio Survey <onboarding@resend.dev>',
      to: ['owner@example.com'],
      subject: 'Your Inicio sign-in code',
    });
    expect(String(sent.text)).toContain('123456');
    // The subject carries no code and the body does: the one channel a provider,
    // a gateway and a lock screen all see is the one that stays generic.
    expect(String(sent.subject)).not.toContain('123456');
    // No reply target configured, so the field is not sent at all rather than
    // sent empty.
    expect('reply_to' in sent).toBe(false);
    // The header that keeps two codes from collapsing into one thread has to
    // travel over the API as well as over SMTP, or the same product behaves two
    // ways depending on which one its network allowed.
    const headers = sent.headers as Record<string, string>;
    expect(headers['X-Entity-Ref-ID']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(delivery.ok).toBe(true);
    expect(delivery.id).toBe('01a13009-0cfd-73fc-a20c-02aa994a25b0');

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM email_log WHERE school_id IS NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('sent');
  });

  it('sends the configured reply target when there is one', async () => {
    const { impl, calls } = stubFetch(200, { id: 'id-reply-to' });
    setSenderForTest(
      createResendSender({
        apiKey: 're_test_key',
        from: 'Inicio <inicio@unifies.codes>',
        replyTo: 'Inicio <inicio@unifies.codes>',
        fetchImpl: impl,
      }),
    );

    await sendMail({ ...otpEmail('owner@example.com', '482913'), schoolId: null });

    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent.from).toBe('Inicio <inicio@unifies.codes>');
    expect(sent.reply_to).toBe('Inicio <inicio@unifies.codes>');
  });

  it('turns a provider refusal into an actionable error, not a generic one', async () => {
    const message =
      'You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.';
    const { impl } = stubFetch(403, { statusCode: 403, name: 'validation_error', message });
    setSenderForTest(resendWith(impl));

    const err = await sendMail({ ...otpEmail('someone.else@example.com', '654321'), schoolId: null }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MailProviderError);
    expect((err as MailProviderError).message).toBe(message);
    expect((err as MailProviderError).status).toBe(403);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM email_log WHERE school_id IS NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('failed');
  });

  it('reports reachability from the last real send, never from a probe it cannot make', async () => {
    // A send-only API key can read nothing back, so before any send the honest
    // answer is "unproven" — basis `none`, not a fabricated health check.
    setSenderForTest(resendWith(stubFetch(200, { id: 'id-before' }).impl));
    const before = await mailStatus(true);
    expect(before).toMatchObject({ transport: 'resend', host: 'api.resend.com', port: 443, reachable: false, basis: 'none' });

    const { impl } = stubFetch(200, { id: 'id-1' });
    setSenderForTest(resendWith(impl));
    await sendMail({ ...otpEmail('owner@example.com', '111111'), schoolId: null });

    const after = await mailStatus(true);
    expect(after).toMatchObject({ reachable: true, basis: 'last-send' });
    expect(after.detail).toContain('id-1');

    setSenderForTest(resendWith(stubFetch(422, { message: 'domain is not verified' }).impl));
    await sendMail({ ...otpEmail('owner@example.com', '222222'), schoolId: null }).catch(() => undefined);

    const failed = await mailStatus(true);
    expect(failed).toMatchObject({ reachable: false, basis: 'last-send' });
    expect(failed.detail).toBe('domain is not verified');
  });

  it('never fails a login because email failed', async () => {
    const { impl } = stubFetch(403, { message: 'domain is not verified' });
    setSenderForTest(resendWith(impl));

    const delivery = await deliverForLogin({ ...otpEmail('owner@example.com', '333333'), schoolId: null });

    expect(delivery.ok).toBe(false);
    expect(delivery.detail).toBe('domain is not verified');
    expect(delivery.transport).toBe('resend');
  });
});

describe('login over an HTTPS relay (HTTP surface)', () => {
  let app: FastifyInstance;

  it('answers `sent` only after the relay accepted the message', async () => {
    const { impl } = stubFetch(200, { id: 'id-accepted' });
    setSenderForTest(resendWith(impl));
    app = await buildApp();
    await app.ready();

    const email = `https-${Date.now()}@example.com`;
    const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
    expect(requested.statusCode).toBe(200);
    const body = requested.json() as {
      status: string;
      mail: { transport: string; reachable: boolean; basis: string };
      delivery: { ok: boolean; id?: string };
    };
    expect(body.status).toBe('sent');
    expect(body.delivery).toMatchObject({ ok: true, id: 'id-accepted' });
    expect(body.mail).toMatchObject({ transport: 'resend', reachable: true, basis: 'last-send' });

    // The relay accepted the message and NOTHING was echoed back — signing in
    // needs the inbox, which is the point.
    expect('devCode' in body).toBe(false);

    const stored = await readLiveOtp(email);
    expect(stored).toMatch(/^[0-9]{6}$/);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { email, code: stored },
    });
    expect(verified.statusCode, verified.body).toBe(200);

    await app.close();
  });

  /**
   * The record a reader deciding "was that me?" actually needs.
   *
   * The template can only print what the call site hands it, and the call sites
   * are two routes that each hold the request's own instant and source address.
   * So this drives the real login route and reads the message it produced: the
   * facts have to arrive from the request, and the expiry has to be the server's
   * own arithmetic on the lifetime it enforces rather than a second number typed
   * beside it.
   */
  it('carries the request itself — when it came in, and from where — into the message it sends', async () => {
    const jobs: MailJob[] = [];
    setSenderForTest({
      kind: 'resend',
      endpoint: { host: 'api.resend.com', port: 443 },
      async send(job: MailJob) {
        jobs.push(job);
        return { id: 'id-record' };
      },
    });
    app = await buildApp();
    await app.ready();

    const email = `https-record-${Date.now()}@example.com`;
    const requestedAt = Date.now();
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { email },
    });
    expect(requested.statusCode, requested.body).toBe(200);

    const message = jobs[0]!;
    expect(message.html).toContain('Requested');
    expect(message.html).toContain('Network address');
    expect(message.text).toContain('Network address: 127.0.0.1');

    const askedFor = instant(message.text, 'Requested: ');
    const dies = instant(message.text, 'Expires: ');
    // The instant the reader is shown is the request that just happened, and the
    // lifetime beside it is the one the server will enforce when it checks the
    // code — not a second number typed into a template.
    expect(Math.abs(askedFor - requestedAt)).toBeLessThan(60_000);
    expect(dies - askedFor).toBe(env.OTP_TTL_MINUTES * 60_000);
    expect(message.text).toContain(`expires in ${env.OTP_TTL_MINUTES} minutes`);

    await app.close();
  });
});

/** `14 October 2026 at 09:03 UTC` — the format the template prints — as a number. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function instant(text: string, label: string): number {
  const line = text.split('\n').find((l) => l.trim().startsWith(label));
  expect(line, `${label} is not in the message`).toBeTruthy();
  const m = /(\d{1,2}) (\w+) (\d{4}) at (\d{2}):(\d{2}) UTC/.exec(line!);
  expect(m, `"${line}" is not a readable instant`).toBeTruthy();
  return Date.UTC(
    Number(m![3]),
    MONTHS.indexOf(m![2]!),
    Number(m![1]),
    Number(m![4]),
    Number(m![5]),
  );
}
