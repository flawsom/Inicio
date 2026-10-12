import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, closePool } from '../src/db/pool.js';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), 'sql');

/**
 * The multi-tenant isolation contract, executed against real PostgreSQL as the
 * least-privilege app_role. The SQL asserts internally and raises on the first
 * violated invariant, so reaching the end is the assertion.
 *
 * Isolation here is keyed to *membership*, not to app.org_id: a forged
 * app.org_id must not grant anything to a non-member.
 */
describe('platform multi-tenancy (migration 0003)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('holds every isolation invariant', async () => {
    const sql = await readFile(join(sqlDir, 'platform-rls.sql'), 'utf8');
    await expect(pool.query(sql)).resolves.toBeDefined();
  });
});
