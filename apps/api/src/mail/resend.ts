import type { SendOutcome, MailTransportKind } from './transport.js';

/** The provider's error body: { statusCode, name, message }. */
interface ProviderError {
  message?: string;
  name?: string;
  statusCode?: number;
}

/**
 * A non-2xx answer from the relay, carrying the provider's own words.
 *
 * Callers get a message they can act on — "the domain is not verified" and
 * "you can only send to your own address" are the two an operator actually
 * has to fix, and folding both into a generic 502 would hide the remedy.
 */
export class MailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerName?: string,
  ) {
    super(message);
    this.name = 'MailProviderError';
  }
}

/**
 * The parts of a fetch response this module actually reads.
 *
 * Declared structurally on purpose: the ambient `Response` type depends on
 * which lib set is in scope (DOM, undici through @types/node, or the Workers
 * runtime), and a bundler that type-checks the function with a different lib set
 * should not be able to break a correct call site.
 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export interface ResendConfig {
  apiKey: string;
  from: string;
  /** Where a reply should land, when that is a real mailbox. */
  replyTo?: string;
  /** Overridable so tests (and self-hosted gateways) never hit the network. */
  url?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Resend over HTTPS.
 *
 * Why this exists next to the SMTP adapter: SMTP ports (25/465/587) are commonly
 * blocked by the network a service actually runs on. The deployment this was
 * built against refuses every one of them — connection timeout to
 * smtp.resend.com:465/587/25 — while HTTPS on 443 works. A relay that can only
 * be reached over 465 is therefore not a design; it is a single point of
 * silence.
 *
 * The one thing the two transports must not disagree about is the headers: a
 * message that keeps its own thread through SMTP and loses it through the API is
 * the same product behaving two ways depending on how it was deployed, so the
 * `headers` object a job carries is posted as the provider's own `headers` field
 * rather than dropped on the floor.
 */
export function createResendSender(cfg: ResendConfig): {
  kind: MailTransportKind;
  endpoint: { host: string; port: number };
  send(job: {
    to: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<SendOutcome>;
} {
  const url = cfg.url ?? 'https://api.resend.com/emails';
  const doFetch: FetchLike = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const endpoint = { host: new URL(url).hostname, port: Number(new URL(url).port || 443) };

  return {
    kind: 'resend',
    endpoint,
    async send(job) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [job.to],
          subject: job.subject,
          html: job.html,
          text: job.text,
          // Only sent when set: a field the provider has to interpret as empty is
          // a field that shows up in a bounce report one day.
          ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
          ...(job.headers && Object.keys(job.headers).length > 0 ? { headers: job.headers } : {}),
        }),
        // The OTP route waits for this, so it must never hang the login.
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
      });

      const body = (await res.json().catch(() => ({}))) as { id?: string } & ProviderError;
      if (!res.ok) {
        throw new MailProviderError(
          body.message ?? `mail provider returned HTTP ${res.status}`,
          res.status,
          body.name,
        );
      }
      return { id: body.id };
    },
  };
}
