import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { pool } from '../db/pool.js';
import type { RenderedMail } from './templates.js';
import { createResendSender } from './resend.js';

export interface MailJob extends RenderedMail {
  schoolId?: string | null;
}

export type MailTransportKind = 'smtp' | 'resend';

/** What a transport hands back once the relay accepted the message. */
export interface SendOutcome {
  id?: string;
}

export interface MailSender {
  kind: MailTransportKind;
  /** The endpoint an operator would go and check. */
  endpoint: { host: string; port: number };
  send(job: MailJob): Promise<SendOutcome>;
}

/**
 * Which relay carries mail? `MAIL_TRANSPORT` wins when set; otherwise an API key
 * means the HTTPS API and a bare SMTP_* configuration means SMTP. Pure, so the
 * rule can be tested without rebuilding the environment.
 */
export function selectTransport(cfg: {
  MAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
}): MailTransportKind {
  if (cfg.MAIL_TRANSPORT === 'smtp' || cfg.MAIL_TRANSPORT === 'resend') return cfg.MAIL_TRANSPORT;
  return cfg.RESEND_API_KEY ? 'resend' : 'smtp';
}

let smtp: Transporter | null = null;
let smtpForTest: Transporter | null = null;
let senderForTest: MailSender | null = null;

/** Tests inject a fake so nothing is actually sent. */
export function setTransportForTest(t: Transporter | null): void {
  smtpForTest = t;
  senderForTest = null;
}

/** Tests inject a whole sender, for transports that are not nodemailer. */
export function setSenderForTest(s: MailSender | null): void {
  senderForTest = s;
}

function getSmtpTransport(): Transporter {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // A relay that is simply not there must fail in seconds, not hang the
      // request path or a health check.
      connectionTimeout: 2000,
      greetingTimeout: 2000,
      socketTimeout: 5000,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
    });
  }
  return smtp;
}

function smtpSender(transporter: Transporter): MailSender {
  return {
    kind: 'smtp',
    endpoint: { host: env.SMTP_HOST, port: env.SMTP_PORT },
    async send(job) {
      await transporter.sendMail({
        from: env.MAIL_FROM,
        to: job.to,
        subject: job.subject,
        html: job.html,
        text: job.text,
      });
      return {};
    },
  };
}

function activeSender(): MailSender {
  if (senderForTest) return senderForTest;
  if (smtpForTest) return smtpSender(smtpForTest);
  if (selectTransport(env) === 'resend') {
    return createResendSender({
      apiKey: env.RESEND_API_KEY ?? '',
      from: env.MAIL_FROM,
      url: env.RESEND_API_URL,
    });
  }
  return smtpSender(getSmtpTransport());
}

/** The verdict of the most recent delivery attempt, whichever transport made it. */
export interface MailDelivery {
  ok: boolean;
  transport: MailTransportKind;
  id?: string;
  detail: string;
  at: string;
}

let lastDelivery: MailDelivery | null = null;

/** Exposed for tests; the last delivery is otherwise only read via mailStatus(). */
export function lastDeliveryForTest(): MailDelivery | null {
  return lastDelivery;
}

export function resetDeliveryForTest(): void {
  lastDelivery = null;
}

/**
 * §9: the database is the source of truth. We log `queued` before attempting
 * delivery and flip to `sent`/`failed` afterwards. A delivery failure is never
 * surfaced to the respondent; a later phase adds the retry queue.
 */
export async function sendMail(job: MailJob): Promise<MailDelivery> {
  const sender = activeSender();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO email_log (school_id, template, status) VALUES ($1, $2, 'queued') RETURNING id`,
    [job.schoolId ?? null, job.template],
  );
  const logId = inserted.rows[0]?.id;
  try {
    const outcome = await sender.send(job);
    if (logId) await pool.query(`UPDATE email_log SET status = 'sent' WHERE id = $1`, [logId]);
    lastDelivery = {
      ok: true,
      transport: sender.kind,
      ...(outcome.id ? { id: outcome.id } : {}),
      detail: outcome.id
        ? `${sender.kind} accepted the message (id ${outcome.id})`
        : `${sender.kind} accepted the message`,
      at: new Date().toISOString(),
    };
  } catch (err) {
    if (logId) await pool.query(`UPDATE email_log SET status = 'failed' WHERE id = $1`, [logId]);
    lastDelivery = {
      ok: false,
      transport: sender.kind,
      detail: (err as Error).message,
      at: new Date().toISOString(),
    };
    throw err;
  }
  return lastDelivery;
}

/** Fire-and-forget: keeps email off the request path so SMTP latency/outages
 *  cannot block a login (§9: "DB ok, email fails -> valid"). */
export function deliverInBackground(job: MailJob): void {
  if (env.NODE_ENV === 'test') return;
  void sendMail(job).catch((err: unknown) => {
    console.error(`[mail] delivery failed (${job.template}):`, (err as Error).message);
  });
}

/**
 * Deliver a login code and report what actually happened.
 *
 * An HTTPS relay answers in a couple of hundred milliseconds under a hard
 * timeout, so the login screen can wait for the provider's own verdict — the
 * message id on success, the provider's error text on refusal. SMTP is not
 * waited for: a dead relay there costs seconds, and its verdict comes from a
 * probe rather than a reply.
 */
export async function deliverForLogin(job: MailJob): Promise<MailDelivery> {
  const sender = activeSender();
  if (sender.kind === 'resend') {
    try {
      return await sendMail(job);
    } catch {
      // sendMail already recorded the reason; login must not fail with it.
      return lastDelivery ?? {
        ok: false,
        transport: sender.kind,
        detail: 'delivery failed',
        at: new Date().toISOString(),
      };
    }
  }
  deliverInBackground(job);
  const status = await mailStatus();
  return {
    ok: status.reachable,
    transport: sender.kind,
    detail: status.detail,
    at: status.checkedAt,
  };
}

/**
 * Is email actually deliverable from here?
 *
 * "OTP sent" was a lie in an environment with no relay: the API answered `sent`
 * while the SMTP connection was refused, and the only trace was a console line.
 * The login screen now asks first and says plainly what will happen, so a
 * missing relay is a visible fact rather than a mystery inbox.
 *
 * Never on the request path: the transporter is verified at most once a minute
 * and a failure is reported, not retried in a loop.
 */
export interface MailStatus {
  configured: boolean;
  reachable: boolean;
  transport: MailTransportKind;
  host: string;
  port: number;
  from: string;
  detail: string;
  /** How `reachable` was established: a probe, or a message the relay accepted. */
  basis: 'smtp-verify' | 'last-send' | 'none';
  checkedAt: string;
}

let cachedStatus: { at: number; status: MailStatus } | null = null;
const STATUS_TTL_MS = 60_000;

export async function mailStatus(force = false): Promise<MailStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.status;

  const sender = activeSender();
  const base = {
    configured: true,
    transport: sender.kind,
    host: sender.endpoint.host,
    port: sender.endpoint.port,
    from: env.MAIL_FROM,
  };

  if (sender.kind === 'resend') {
    // A send-only API key can read nothing back from the provider, so there is
    // nothing honest to probe. Report the last real send instead of inventing a
    // health check that would only prove the key is not allowed to read.
    const d = lastDelivery;
    cachedStatus = {
      at: now,
      status: {
        ...base,
        reachable: d?.ok ?? false,
        basis: d ? 'last-send' : 'none',
        detail:
          d?.detail ??
          'no message sent yet — the next login code will show whether the relay accepts it',
        checkedAt: new Date(now).toISOString(),
      },
    };
    return cachedStatus.status;
  }

  const failed = (detail: string): MailStatus => ({
    ...base,
    reachable: false,
    basis: 'smtp-verify',
    detail,
    checkedAt: new Date(now).toISOString(),
  });

  try {
    await getSmtpTransport().verify();
    cachedStatus = {
      at: now,
      status: { ...base, reachable: true, basis: 'smtp-verify', detail: 'SMTP connection verified', checkedAt: new Date(now).toISOString() },
    };
  } catch (err) {
    cachedStatus = {
      at: now,
      status: failed(`cannot reach ${env.SMTP_HOST}:${env.SMTP_PORT} — ${(err as Error).message}`),
    };
  }
  return cachedStatus.status;
}
