import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { withTenant, ZERO_UUID } from '../src/db/tenant.js';
import { seedAnswer, seedQuestionnaire, seedResponseSet, seedSchool, uniqueEmail } from './helpers/fixtures.js';

/**
 * BUILD.md §6 headline invariant: school A cannot read school B's rows.
 * The whole suite runs through the least-privilege app_role connection, which
 * is the only connection shape for which these policies actually do anything
 * (superusers and BYPASSRLS roles bypass RLS by design).
 */
describe('row-level security', () => {
  let schoolA = '';
  let schoolB = '';
  let rsA = '';
  let rsB = '';

  beforeAll(async () => {
    schoolA = await seedSchool(uniqueEmail('a'), 'School A');
    schoolB = await seedSchool(uniqueEmail('b'), 'School B');
    const questionnaireId = await seedQuestionnaire();
    rsA = await seedResponseSet(schoolA, questionnaireId);
    rsB = await seedResponseSet(schoolB, questionnaireId);
    await seedAnswer(rsA, schoolA, 'a1', { value: 'A answer' });
    await seedAnswer(rsB, schoolB, 'b1', { value: 'B answer' });
    await withTenant({ role: 'admin' }, async (client) => {
      await client.query(
        `INSERT INTO attachment (response_set_id, school_id, question_id, filename, mime, size_bytes, storage_key)
         VALUES ($1, $2, 'a1', 'a.pdf', 'application/pdf', 10, 'k/a'), ($3, $4, 'b1', 'b.pdf', 'application/pdf', 10, 'k/b')`,
        [rsA, schoolA, rsB, schoolB],
      );
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it('school A sees only its own response_set / answer / attachment rows', async () => {
    const seen = await withTenant({ role: 'school', schoolId: schoolA }, async (client) => {
      const rs = await client.query<{ school_id: string }>('SELECT school_id FROM response_set');
      const an = await client.query<{ school_id: string }>('SELECT school_id FROM answer');
      const at = await client.query<{ school_id: string }>('SELECT school_id FROM attachment');
      return { rs: rs.rows, an: an.rows, at: at.rows };
    });
    expect(seen.rs).toHaveLength(1);
    expect(seen.rs[0]!.school_id).toBe(schoolA);
    expect(seen.an).toHaveLength(1);
    expect(seen.an[0]!.school_id).toBe(schoolA);
    expect(seen.at).toHaveLength(1);
    expect(seen.at[0]!.school_id).toBe(schoolA);
  });

  it('school A cannot reach school B even by primary key', async () => {
    const count = await withTenant({ role: 'school', schoolId: schoolA }, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM response_set WHERE id = $1`,
        [rsB],
      );
      return rows[0]!.n;
    });
    expect(count).toBe('0');
  });

  it('school A cannot update or delete school B rows', async () => {
    const affected = await withTenant({ role: 'school', schoolId: schoolA }, async (client) => {
      const upd = await client.query(`UPDATE answer SET value_json = '"pwned"'::jsonb WHERE school_id = $1`, [schoolB]);
      const del = await client.query(`DELETE FROM answer WHERE school_id = $1`, [schoolB]);
      return { upd: upd.rowCount, del: del.rowCount };
    });
    expect(affected.upd).toBe(0);
    expect(affected.del).toBe(0);
  });

  it('school A cannot INSERT a row attributed to school B (WITH CHECK)', async () => {
    await expect(
      withTenant({ role: 'school', schoolId: schoolA }, async (client) => {
        await client.query(
          `INSERT INTO answer (response_set_id, school_id, question_id, value_json)
           VALUES ($1, $2, 'spoof', '1'::jsonb)`,
          [rsB, schoolB],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('admin sees every school; reviewer sees all but cannot write', async () => {
    const adminCount = await withTenant({ role: 'admin' }, async (client) => {
      const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM response_set');
      return rows[0]!.n;
    });
    expect(adminCount).toBe('2');

    const viewerCount = await withTenant({ role: 'viewer' }, async (client) => {
      const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM answer');
      return rows[0]!.n;
    });
    expect(viewerCount).toBe('2');

    await expect(
      withTenant({ role: 'reviewer' }, async (client) => {
        await client.query(`UPDATE answer SET value_json = '"x"'::jsonb`);
      }),
    ).resolves.toBeUndefined(); // policy allows 0 rows, no error
    const stillTwo = await withTenant({ role: 'admin' }, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM answer WHERE value_json = '"x"'::jsonb`,
      );
      return rows[0]!.n;
    });
    expect(stillTwo).toBe('0');
  });

  it('an unset tenant context reaches nothing', async () => {
    const count = await withTenant({ role: 'viewer' }, async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.role', '']);
      const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM response_set');
      return rows[0]!.n;
    });
    expect(count).toBe('0');
  });

  it('ZERO_UUID sentinel never matches a real school', async () => {
    const count = await withTenant({ role: 'school', schoolId: ZERO_UUID }, async (client) => {
      const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM response_set');
      return rows[0]!.n;
    });
    expect(count).toBe('0');
  });
});
