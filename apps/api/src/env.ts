import { z } from 'zod';

/**
 * Treats the strings docker-compose / dotenv give us as booleans.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

/** An unset variable and an empty-string variable mean the same thing. */
const optionalStr = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.string().optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  // Least-privilege app connection. RLS is only enforced for a role that is
  // neither superuser nor BYPASSRLS, so this must be `app_role` in production.
  //
  // `APP_DATABASE_URL` wins when it is set. A hosting provider's database
  // integration usually claims `DATABASE_URL` for the *owner* connection (the
  // Neon integration on Vercel injects exactly that), and the owner URL is what
  // migrations need while being exactly what the application must never use.
  // Two roles therefore get two names instead of being told apart by trust.
  APP_DATABASE_URL: optionalStr,
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MIGRATION_DATABASE_URL: optionalStr,
  DATABASE_SSL: boolish.default(false),

  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 characters'),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),

  SESSION_COOKIE_NAME: z.string().default('sid'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: boolish.default(false),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: boolish.default(false),
  SMTP_USER: optionalStr,
  SMTP_PASS: optionalStr,
  MAIL_FROM: z.string().default('Inicio Survey <no-reply@inicio.example>'),

  // Which relay carries mail. `smtp` is the portable default (Mailpit locally,
  // any relay in production). `resend` posts to the provider's HTTPS API on port
  // 443 — the only egress some networks allow, since SMTP ports 25/465/587 are
  // routinely blocked outright. Unset, an API key selects HTTPS and no key means
  // SMTP.
  MAIL_TRANSPORT: z.enum(['smtp', 'resend']).optional(),
  RESEND_API_KEY: optionalStr,
  RESEND_API_URL: z.string().url().default('https://api.resend.com/emails'),

  // Object storage for attachments. S3-compatible and deliberately optional:
  // with no bucket configured the collection API answers `501
  // storage_not_configured` and the renderer keeps saying that those questions
  // are not collected here, rather than offering a control that cannot work.
  //
  // The names are the AWS-standard ones on purpose. That is how the credentials
  // arrive from the provider (Neon Object Storage injects exactly these), and it
  // means every S3 tool in this environment already reads the same set. The two
  // `S3_*` overrides exist for hosts that hand out a bare endpoint.
  S3_BUCKET: optionalStr,
  S3_ENDPOINT: optionalStr,
  S3_REGION: optionalStr,
  AWS_ENDPOINT_URL_S3: optionalStr,
  AWS_ACCESS_KEY_ID: optionalStr,
  AWS_SECRET_ACCESS_KEY: optionalStr,
  AWS_REGION: optionalStr,

  // The ceiling on one attachment, enforced when the upload is authorised and
  // again against the size the storage actually reports — a client that lies
  // about the size it is about to send changes nothing.
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // The scan step. With no address there is no scanner, and the honest record of
  // that is `skipped` with a reason — never a `clean` nobody earned.
  CLAMD_HOST: optionalStr,
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Whether this deployment accepts a file no scanner has read.
  //
  // The two scan states that are not a verdict are `skipped` (no scanner is
  // configured) and `error` (a scanner was configured and could not answer). With
  // the default, either is accepted and the row keeps saying which it was - so a
  // deployment without a scanner still collects, and a field team whose route to
  // the scanner is down is not locked out of its own survey. That is a decision
  // about this deployment, so it is one named variable rather than an absence an
  // operator cannot tell apart from having forgotten CLAMD_HOST.
  //
  // `require` is the stricter reading, and it refuses at authorisation rather than
  // at submission: a deployment that asked for a scanner's verdict must not hand a
  // respondent a credential whose upload could never become an answer.
  ATTACHMENT_SCAN_POLICY: z.enum(['allow_unscanned', 'require']).default('allow_unscanned'),

  // The statistical export worker (`services/pyreadstat`), the only thing here
  // that runs Python: it writes real SPSS `.sav` and Stata `.dta` files, which no
  // maintained JavaScript writer does. Optional by design — with no URL the export
  // route keeps its honest 501 naming this variable, and a worker that is
  // configured but unreachable is a 502. A `.sav` this process cannot produce is
  // one it must not pretend to.
  PYREADSTAT_WORKER_URL: optionalStr,
  PYREADSTAT_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  REDIS_URL: optionalStr,

  // Requests per minute per address. The default protects a single-IP burst (and
  // the free tiers underneath); tests raise it because they share one address.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  // Closed by default: an unknown email only gets an account through an
  // organisation invitation (owner/admin, via the SECURITY DEFINER function).
  // This replaces the Phase-1 open-signup bridge, which let any address that
  // asked create an account. There is deliberately no permissive default: an
  // environment that wants open signup must say so out loud.
  INVITE_ONLY: boolish.default(true),

  // Used only by `pnpm admin:create`; never read on the request path.
  ADMIN_EMAIL: optionalStr,
  ADMIN_PASSWORD: optionalStr,
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  // The application connects as the least-privileged role: an explicit
  // APP_DATABASE_URL when the platform provides one, otherwise DATABASE_URL.
  return { ...parsed.data, DATABASE_URL: parsed.data.APP_DATABASE_URL ?? parsed.data.DATABASE_URL };
}

export const env: Env = loadEnv();
