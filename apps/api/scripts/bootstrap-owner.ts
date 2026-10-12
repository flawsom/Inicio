/**
 * Create the first owner of an organisation.
 *
 * Why this exists separately from signup: signup is invite-only, so the very
 * first account cannot be invited by anybody. It has to be created deliberately,
 * once, by whoever operates the deployment, which is also the reason this runs
 * against the migration (owner) connection rather than the application role.
 *
 *   pnpm --filter @inicio/api bootstrap:owner --email you@example.com --org Inicio
 *
 * It is idempotent: running it again for an existing account just makes sure the
 * membership exists with the owner role.
 */
import { Client } from 'pg';

interface Args {
  email: string;
  org: string;
  slug?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const email = get('email')?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('--email is required and must be a valid address');
  }
  const org = get('org')?.trim() || 'Inicio';
  return { email, org, slug: get('slug') };
}

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required (owner connection)');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');

    const { rows: users } = await client.query<{ id: string }>(
      `INSERT INTO app_user (email) VALUES ($1::citext)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [args.email],
    );
    const userId = users[0]!.id;

    const { rows: orgs } = await client.query<{ id: string }>(
      `INSERT INTO org (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [args.org, args.slug ?? slugify(args.org)],
    );
    const orgId = orgs[0]!.id;

    await client.query(
      `INSERT INTO membership (org_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner'`,
      [orgId, userId],
    );

    await client.query('COMMIT');
    console.log(`owner ready: ${args.email}`);
    console.log(`  organisation: ${args.org} (${orgId})`);
    console.log('  role:         owner');
    console.log('  sign in at the login page with an emailed one time code.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`bootstrap failed: ${(err as Error).message}`);
  process.exit(1);
});
