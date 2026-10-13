/**
 * Deliver what is due, across every organisation.
 *
 * The API drains an organisation on the request that produced the event, which
 * covers the ordinary case. It cannot cover all of them: a serverless instance may
 * be frozen the moment its response is returned, and a retry scheduled for two
 * hours later has no request to ride on. That is what this is for —
 *
 *   pnpm --filter @inicio/api webhooks:drain          # everything due
 *   pnpm --filter @inicio/api webhooks:drain --org <uuid>
 *
 * It runs on the owner connection (MIGRATION_DATABASE_URL) on purpose: this is the
 * one job whose whole definition is "every organisation", and the alternative — a
 * SECURITY DEFINER function a tenant could call with someone else's org id — would
 * be a wider door than the job needs. A scheduler (cron, a queue, a platform
 * cron job) invokes it; until one exists, this is a manual command, and the README
 * says so rather than implying deliveries are instant.
 *
 * Safe to run twice: a delivery that has been claimed by a concurrent run is
 * re-delivered, which is why every attempt carries the same delivery id and the
 * receiving side is expected to treat it as an idempotency key.
 */
import { Client } from 'pg';
import { drainWith } from '../src/platform/webhooks/dispatch.js';

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL (owner connection) is required');

  const orgIndex = process.argv.indexOf('--org');
  const orgId = orgIndex === -1 ? null : process.argv[orgIndex + 1];
  if (orgIndex !== -1 && !orgId) throw new Error('--org needs a uuid');

  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex === -1 ? 50 : Number(process.argv[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('--limit must be 1..1000');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tally = await drainWith(client, orgId, limit);
    console.log(
      `webhooks: ${tally.attempted} due, ${tally.delivered} delivered, ` +
        `${tally.retrying} retrying, ${tally.failed} failed`,
    );
    if (tally.attempted === 0) console.log('nothing was due');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`drain failed: ${(err as Error).message}`);
  process.exit(1);
});
