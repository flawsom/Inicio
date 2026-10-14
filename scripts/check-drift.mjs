#!/usr/bin/env node
/**
 * Has the deployed database fallen behind this checkout's migrations?
 *
 * The failure this exists for is quiet by nature. A migration merged to `main` either
 * runs against production or it does not — and if it does not, the application is
 * deployed and *reachable* while the tables its newest screens read do not exist there.
 * Nothing 500s: the new route answers `500` only when somebody opens the new screen, and
 * the health check, the landing page and every older surface keep answering `200`. That
 * is exactly how the deployment spent a day nine migrations deep while the repository
 * believed it was migrated.
 *
 * So this reads the one number the running service publishes about its own schema —
 * `GET /api/v1/public/summary` reports the `schema_migrations` ledger it just read, on
 * the connection it actually uses — and compares it with the migration files in this
 * checkout. No credentials, no database driver, nothing to install: the endpoint is
 * public by design and reports no tenant data.
 *
 * Exit codes, because a caller has to tell the two failures apart:
 *   0  in step — the deployment has applied exactly the migrations this checkout has;
 *   1  drift — it has applied fewer (or, just as importantly, more: a database ahead of
 *      `main` means a branch's migration was applied by hand or main is behind the
 *      deployment it is supposed to describe);
 *   2  unreadable — the summary could not be read at all, which is an outage or a bad
 *      `DRIFT_URL`, not drift. Reporting that as drift would train everyone to ignore it.
 *
 * `DRIFT_URL` overrides the origin, so the same check runs against a preview deployment.
 *
 *   node scripts/check-drift.mjs
 *   DRIFT_URL=https://inicio-prjct.vercel.app node scripts/check-drift.mjs
 */
import { readdirSync } from 'node:fs';

const BASE = process.env.DRIFT_URL ?? 'https://inicio.unifies.codes';
const MIGRATIONS = 'apps/api/src/db/migrations';

/** What this checkout says the schema should be. */
function expectedLedger() {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return { count: files.length, latest: files.at(-1) ?? null, files };
}

/** What the deployment says its schema is. */
async function deployedLedger() {
  const response = await fetch(`${BASE}/api/v1/public/summary`, {
    headers: { accept: 'application/json' },
    // A drift check that reads a cached answer is a check that reports the past.
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`${BASE}/api/v1/public/summary answered ${response.status}`);
  const body = await response.json();
  const database = body?.database;
  if (!database || typeof database.migrationsApplied !== 'number') {
    throw new Error(`${BASE}/api/v1/public/summary did not report a database ledger`);
  }
  return database;
}

const expected = expectedLedger();
let deployed;
try {
  deployed = await deployedLedger();
} catch (error) {
  console.error(`✗ unreadable: ${error.message}`);
  console.error(`  Cannot tell whether the schema is in step — check the deployment, not its migrations.`);
  process.exit(2);
}

console.log(`checkout     ${expected.count} migrations, latest ${expected.latest}`);
console.log(
  `deployment   ${deployed.migrationsApplied} applied, latest ${deployed.latestMigration} ` +
    `(pg ${deployed.version}, compute up since ${deployed.startedAt})`,
);

if (deployed.migrationsApplied === expected.count && deployed.latestMigration === expected.latest) {
  console.log(`\n✓ in step: ${BASE} is running this checkout's schema.`);
  process.exit(0);
}

console.log('');
if (deployed.migrationsApplied < expected.count) {
  // Named, not counted: "one behind" is not actionable, "0011_attachments.sql has not
  // been applied" is. The files are in order, so the tail past what the deployment has
  // is exactly the set it is missing.
  const missing = expected.files.slice(deployed.migrationsApplied);
  console.error(`✗ drift: the deployment is ${expected.count - deployed.migrationsApplied} migration(s) behind this checkout`);
  for (const file of missing) console.error(`    not applied there: ${file}`);
  console.error(`\n  close it with the deployment's own owner connection, exactly as the README says:`);
  console.error(`    MIGRATION_DATABASE_URL='postgres://…' pnpm --filter @inicio/api db:migrate`);
} else if (deployed.migrationsApplied > expected.count) {
  console.error(`✗ drift: the deployment has applied ${deployed.migrationsApplied} migrations, this checkout has ${expected.count}`);
  console.error(`    latest there is ${deployed.latestMigration}, here it is ${expected.latest}`);
  console.error(`  A database ahead of main means a migration was applied from a branch, or main is behind`);
  console.error(`  the deployment it describes. Either way the two no longer agree.`);
} else {
  // Same count, different latest: a migration was renamed, reordered or replaced, which
  // is a defect in its own right — the ledger is append-only and names are its history.
  console.error(`✗ drift: both have ${expected.count} migrations but not the same latest one`);
  console.error(`    there ${deployed.latestMigration}, here ${expected.latest}`);
  console.error(`  Migrations are append-only and never renamed; the two names disagreeing means one side changed one.`);
}
process.exit(1);
