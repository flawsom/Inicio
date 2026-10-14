import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate.js';

// Resolved before any src/ module reads env.ts (setup files run first).
const SOURCE = process.env.MIGRATION_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';

/**
 * Tests own their own database.
 *
 * Each test file drops and recreates `public`, which used to mean that running
 * the suite destroyed the development data sitting in the same database: the
 * organisation somebody had just created, and their account with it. Two names,
 * two databases: `${name}_test` for the suite, the configured one for everything
 * else. The test database is created on first use and reused afterwards.
 */
function testUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, '') || 'postgres';
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

const SUPER = testUrl(SOURCE);
const APP = testUrl(
  process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://app_role@127.0.0.1:55432/postgres',
);

/**
 * The suite's database is local by construction, and this refuses to pretend otherwise.
 *
 * `src/env.ts` prefers `APP_DATABASE_URL`, and a workspace whose environment names a
 * deployment there — which is the normal way to point the app at production — would
 * otherwise have a test run create `..._test` on that cluster and drop its schema one
 * database over from the real data. The names the application uses and the name the
 * tests use are the same names, so the only safe reading is a local host: anything
 * else stops the run and says which variable to change instead of guessing.
 */
const LOCAL_HOST = /^postgres(ql)?:\/\/[^@/]*@(\[[^\]]+\]|127\.0\.0\.1|localhost|::1)(:\d+)?\//;
for (const [name, url] of [
  ['MIGRATION_DATABASE_URL', SOURCE],
  ['APP_DATABASE_URL / DATABASE_URL', APP],
] as const) {
  if (!LOCAL_HOST.test(url)) {
    throw new Error(
      `Refusing to run: ${name} points at ${new URL(url).host}, which is not this machine. ` +
        'Tests own a local database — point MIGRATION_DATABASE_URL, APP_DATABASE_URL and ' +
        'DATABASE_URL at 127.0.0.1 (see .env.example) rather than at a deployment.',
    );
  }
}

async function ensureTestDatabase(): Promise<void> {
  const target = new URL(SUPER);
  const name = target.pathname.replace(/^\//, '');
  const admin = new Client({ connectionString: SOURCE });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (rows.length === 0) {
    // Role membership is a cluster-level fact, so app_role exists in the new
    // database as soon as it is created; grants are applied by the migrations.
    await admin.query(`CREATE DATABASE ${JSON.stringify(name).replace(/"/g, '"')}`);
  }
  await admin.end();
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: APP,
  // `src/env.ts` prefers APP_DATABASE_URL over DATABASE_URL, so pinning only
  // DATABASE_URL left the application connected to whatever the surrounding
  // environment named — in CI, the un-migrated `postgres` database, while the
  // migrations went to `postgres_test`. Both names now point at the suite's own
  // database, which is the only way "the tests own their database" holds off a
  // developer's machine.
  APP_DATABASE_URL: APP,
  MIGRATION_DATABASE_URL: SUPER,
  OTP_PEPPER: 'test-pepper-0123456789abcdef',
  OTP_TTL_MINUTES: '10',
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
  SESSION_COOKIE_NAME: 'sid',
  SESSION_IDLE_MINUTES: '60',
  SESSION_ABSOLUTE_DAYS: '30',
  COOKIE_SECURE: 'false',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  /*
   * Which relay carries mail, pinned rather than inherited.
   *
   * A workspace `.env` holds a live provider key, because that is how the
   * deployment sends mail — and `selectTransport` prefers a key over SMTP. So
   * without this line the suite did two things it must never do: it really sent
   * login codes to the provider over `fetch`, and it asserted against whichever
   * transport the machine happened to be configured for. Both showed up as
   * failures on a developer's machine and passed in CI, which is the worst way
   * round: the mail verdict reported `last-send` — the provider accepting a
   * message — where the test was asserting the SMTP probe, and the webhook
   * receiver's capture held the provider's own HTTP call as well as the delivery
   * under test. Pinning the transport makes both deterministic and makes a real
   * send impossible. The provider path is tested where it belongs: by injecting a
   * sender, in `mail-https.test.ts`.
   */
  MAIL_TRANSPORT: 'smtp',
  APP_ORIGIN: 'http://localhost:3000',
  // Tests sign in through the front door: request → read the code the way the
  // mailbox would (fixtures.readLiveOtp, from the stored hash) → verify. There is
  // no dev echo anywhere in the codebase, and none of the tests need one.
  // The suite signs up fresh users directly; the invite-only default would
  // turn every signIn into a 404 and hide what the test was checking.
  INVITE_ONLY: 'false',
  // Hundreds of requests arrive from one address in this suite; the production
  // default would return 429 and hide whatever the test was actually checking.
  RATE_LIMIT_MAX: '100000',
  MAIL_FROM: 'Inicio Survey <no-reply@inicio.example>',
});

await ensureTestDatabase();

// Fresh schema for each test file.
const admin = new Client({ connectionString: SUPER });
await admin.connect();
await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
await admin.query('CREATE SCHEMA public');

// The sandbox PostgreSQL has no contrib. Production (postgres:16 image, Neon,
// Tiger Cloud) does, and then migrations run byte-for-byte as written. Only
// when an extension is genuinely missing do we substitute a stand-in, and we
// say so, rather than silently pretending citext semantics were exercised.
let transform: ((name: string, sql: string) => string) | undefined;

try {
  await admin.query('CREATE EXTENSION IF NOT EXISTS citext');
} catch {
  console.warn('[test] citext unavailable — using a domain stand-in; case-insensitive semantics NOT verified here');
  transform = (_name, sql) =>
    sql.replace(/CREATE EXTENSION IF NOT EXISTS citext;/g, 'CREATE DOMAIN citext AS text;');
}

try {
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
} catch {
  const previous = transform;
  transform = (name, sql) =>
    (previous ? previous(name, sql) : sql).replace(
      /CREATE EXTENSION IF NOT EXISTS pgcrypto;/g,
      '-- pgcrypto absent; gen_random_uuid() is built into PostgreSQL 13+',
    );
}

await admin.end();

await runMigrations(SUPER, transform ? { transform } : {});
