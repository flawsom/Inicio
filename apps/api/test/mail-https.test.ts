import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { MailProviderError, createResendSender } from '../src/mail/resend.js';
import { otpEmail } from '../src/mail/templates.js';
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
      subject: 'Your Inicio survey login code: 123456',
    });
    expect(String(sent.text)).toContain('123456');

    expect(delivery.ok).toBe(true);
    expect(delivery.id).toBe('01a13009-0cfd-73fc-a20c-02aa994a25b0');

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM email_log WHERE school_id IS NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('sent');
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
});
