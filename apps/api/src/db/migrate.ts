import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrateOptions {
  /**
   * Test-only hook. Production runs migration SQL byte-for-byte, including
   * 0001 which is a verbatim copy of the frozen specs/schema.sql.
   */
  transform?: (name: string, sql: string) => string;
  log?: (message: string) => void;
}

/**
 * Applies every *.sql file in ./migrations in filename order, once each,
 * recording what ran in `schema_migrations`. Runs on the owner/superuser
 * connection because it issues DDL and CREATE ROLE.
 */
export async function runMigrations(
  connectionString: string,
  options: MigrateOptions = {},
): Promise<void> {
  const { transform, log = () => {} } = options;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const appliedRows = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) {
        log(`skip  ${file}`);
        continue;
      }
      let sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      if (transform) sql = transform(file, sql);

      log(`apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
