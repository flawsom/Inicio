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
