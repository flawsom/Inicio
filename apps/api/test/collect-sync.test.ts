import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import { PRIVACY, TERMS } from '../src/legal/documents.js';
import { readLiveOtp } from './helpers/fixtures.js';

/**
 * Offline-first collection (SPEC §16, §17, §37).
 *
 * A device may collect for hours without a network and then sync. These tests
 * hold the two promises that make that safe: syncing twice never duplicates a
 * response, and a disagreement between the device and the server is *kept*
 * rather than silently resolved. Everything below runs over HTTP against the
 * real database as the non-superuser role.
 */

const definition: FormDefinition = {
  title: 'Field visit',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'q_reason', name: 'reason', type: 'text', label: { en: 'Why not' }, rules: { visibleIf: "${consent} = 'no'" } },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
  ],
  choiceLists: {},
};

const withCalculation: FormDefinition = {
  ...definition,
  questions: [...definition.questions, { id: 'q_double', name: 'double', type: 'calculate', label: { en: 'Double' }, rules: { calculate: '${score} * 2' } }],
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface Session {
  cookie: string;
}

async function signIn(email: string): Promise<Session> {
  const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
  expect(requested.statusCode, requested.body).toBe(200);
  const code = await readLiveOtp(email);
  if (!code) throw new Error(`no live OTP for ${email}`);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { email, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/terms/accept',
    headers: { cookie },
    payload: { termsVersion: TERMS.version, privacyVersion: PRIVACY.version, accepted: true },
  });
  return { cookie };
}

interface Scenario {
  owner: Session;
  formId: string;
  token: string;
}

async function published(prefix: string, def: FormDefinition = definition): Promise<Scenario> {
  const owner = await signIn(`${prefix}-${Date.now()}-${Math.random()}@example.com`);
  const org = await app.inject({ method: 'POST', url: '/api/v1/orgs', headers: { cookie: owner.cookie }, payload: { name: `${prefix} org` } });
  expect(org.statusCode, org.body).toBe(201);
  const orgId = (org.json() as { organisation: { id: string } }).organisation.id;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: owner.cookie },
    payload: { orgId, name: 'Field visit', definition: def },
  });
  expect(created.statusCode, created.body).toBe(201);
  const formId = (created.json() as { form: { id: string } }).form.id;
  const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
  const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;
  const pub = await app.inject({ method: 'POST', url: `/api/v1/forms/${formId}/versions/${versionId}/publish`, headers: { cookie: owner.cookie } });
  expect(pub.statusCode, pub.body).toBe(200);
  const link = await app.inject({ method: 'POST', url: `/api/v1/forms/${formId}/links`, headers: { cookie: owner.cookie }, payload: { kind: 'anonymous' } });
  expect(link.statusCode, link.body).toBe(201);
  return { owner, formId, token: (link.json() as { token: string }).token };
}

/** Reads the raw rows the API would never expose, to prove nothing was thrown away. */
async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

describe('offline-first collection sync', () => {
  it('makes a start idempotent against the device UUID', async () => {
    const { formId, token } = await published('idem');
    const clientId = crypto.randomUUID();

    const first = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });
    expect(first.statusCode, first.body).toBe(201);
    expect((first.json() as { created: boolean }).created).toBe(true);
    expect((first.json() as { responseId: string }).responseId).toBe(clientId);

    // The same start, retried after a dropped connection.
    const second = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json() as { created: boolean }).created).toBe(false);
    expect((second.json() as { responseId: string }).responseId).toBe(clientId);

    // Exactly one response exists — the duplicate did not create a second row.
    const rows = await adminQuery<{ count: string }>(`SELECT count(*)::text AS count FROM response WHERE form_id = $1`, [formId]);
    expect(rows[0]!.count).toBe('1');
  });

  it('merges non-overlapping edits from two devices and keeps the server value where they collide', async () => {
    const { owner, formId, token } = await published('merge');
    const clientId = crypto.randomUUID();
    const start = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });
    expect(start.statusCode, start.body).toBe(201);

    // Device 1, first sync after collecting offline.
    const base0 = {};
    const save0 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'yes', score: 3 }, base: base0 },
    });
    expect(save0.statusCode, save0.body).toBe(200);
    const canonical0 = (save0.json() as { answers: Record<string, unknown> }).answers;
    expect(canonical0.score).toBe(3);
    // The server tells the device what it now holds, so the device compares
    // against reality next time rather than against its own assumption.
    expect(canonical0.reason).toBeNull();

    // Device 1 edits the score only.
    const save1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'yes', score: 9 }, base: { consent: 'yes', score: 3 } },
    });
    expect(save1.statusCode, save1.body).toBe(200);
    expect((save1.json() as { conflicts: number }).conflicts).toBe(0);
    expect((save1.json() as { answers: Record<string, unknown> }).answers.score).toBe(9);

    // Device 2, which also started from score 3, syncs a *different* score: both
    // sides moved, so the server keeps its value and preserves the device's.
    const save2 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'yes', score: 5 }, base: { consent: 'yes', score: 3 } },
    });
    expect(save2.statusCode, save2.body).toBe(200);
    const body2 = save2.json() as { conflicts: number; answers: Record<string, unknown> };
    expect(body2.conflicts).toBe(1);
    // Not a silent overwrite: the server's 9 survives, and the device's 5 is kept.
    expect(body2.answers.score).toBe(9);
    const answerRow = await adminQuery<{ value: unknown; device_value: unknown }>(
      `SELECT a.value, a.device_value FROM response_answer a
        WHERE a.response_id = $1 AND a.question_id = 'score'`,
      [clientId],
    );
    expect(answerRow[0]!.value).toBe(9);
    expect(answerRow[0]!.device_value).toBe(5);
    const conflictRow = await adminQuery<{ kind: string }>(
      `SELECT kind FROM response_conflict WHERE response_id = $1 AND question_id = 'score'`,
      [clientId],
    );
    expect(conflictRow[0]!.kind).toBe('device_server_mismatch');

    // Device 2 edits a *different* field. Device 1's score must survive the merge.
    const save3 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'no', score: 3 }, base: { consent: 'yes', score: 3 } },
    });
    expect(save3.statusCode, save3.body).toBe(200);
    const body3 = save3.json() as { answers: Record<string, unknown>; conflicts: number };
    expect(body3.answers.consent).toBe('no');
    expect(body3.answers.score).toBe(9);

    // The organiser can see the disagreement rather than discovering it in SPSS.
    const analytics = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/analytics`, headers: { cookie: owner.cookie } });
    expect(analytics.statusCode, analytics.body).toBe(200);
    expect((analytics.json() as { conflicts: number }).conflicts).toBe(1);
    const listed = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/responses`, headers: { cookie: owner.cookie } });
    const rows = (listed.json() as { responses: Array<{ conflict_count: number }> }).responses;
    expect(rows[0]!.conflict_count).toBe(1);
  });

  it('nulls a hidden answer and flags a calculated value the device got wrong', async () => {
    const { formId, token } = await published('calc', withCalculation);
    const clientId = crypto.randomUUID();
    await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });

    // Visible: reason is kept.
    const visible = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'no', reason: 'declined', score: 4, double: 8 } },
    });
    expect((visible.json() as { answers: Record<string, unknown> }).answers.reason).toBe('declined');

    // Consent flips to yes, so reason becomes irrelevant: stored as null, not kept.
    const hidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'yes', reason: 'declined', score: 4, double: 8 } },
    });
    expect((hidden.json() as { answers: Record<string, unknown> }).answers.reason).toBeNull();

    // A device that reports a derived value the server disagrees with is flagged,
    // and the server's own computation is what gets stored.
    const tampered = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${clientId}`,
      payload: { answers: { consent: 'yes', score: 4, double: 999 } },
    });
    const body = tampered.json() as { answers: Record<string, unknown>; conflicts: number };
    expect(body.answers.double).toBe(8);
    expect(body.conflicts).toBe(1);
    const kinds = await adminQuery<{ kind: string }>(
      `SELECT kind FROM response_conflict WHERE response_id = $1 AND question_id = 'double'`,
      [clientId],
    );
    expect(kinds[0]!.kind).toBe('calculation_mismatch');
    void formId;
  });

  it('is idempotent across a retried submit, and counts the response once', async () => {
    const { owner, formId, token } = await published('submit');
    const clientId = crypto.randomUUID();
    await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${clientId}/submit`,
      payload: { answers: { consent: 'yes', score: 7 }, base: {} },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { status: string }).status).toBe('submitted');

    // The device was offline when it pressed Submit and retries now.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${clientId}/submit`,
      payload: { answers: { consent: 'yes', score: 7 }, base: {} },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: 'already_submitted' });

    const rows = await adminQuery<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM response WHERE form_id = $1 GROUP BY status`,
      [formId],
    );
    expect(rows).toEqual([{ status: 'submitted', count: '1' }]);
    void owner;
  });

  it('still blocks an invalid submission and writes nothing', async () => {
    const { token } = await published('invalid');
    const clientId = crypto.randomUUID();
    await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: { clientId } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${clientId}/submit`,
      payload: { answers: { consent: 'yes' }, base: {} },
    });
    expect(res.statusCode, res.body).toBe(422);
    const detail = JSON.parse((res.json() as { message: string }).message) as { missing: string[] };
    expect(detail.missing).toContain('score');
    const rows = await adminQuery<{ status: string }>(`SELECT status FROM response WHERE id = $1`, [clientId]);
    expect(rows[0]!.status).toBe('in_progress');
  });

  it('refuses a client UUID that belongs to a different survey', async () => {
    const a = await published('cross-a');
    const b = await published('cross-b');
    const clientId = crypto.randomUUID();
    const started = await app.inject({ method: 'POST', url: `/api/v1/collect/${a.token}/responses`, payload: { clientId } });
    expect(started.statusCode, started.body).toBe(201);
    // The same device UUID presented against another survey in the same org set.
    const clash = await app.inject({ method: 'POST', url: `/api/v1/collect/${b.token}/responses`, payload: { clientId } });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json()).toMatchObject({ error: 'client_id_conflict' });
  });
});
