import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import { createOrgFor, createPublishedForm, signInPlatform, type PlatformSession } from './helpers/fixtures.js';

/**
 * Quality flags and the flag queue (`apps/api/src/platform/flags.ts`, 0010).
 *
 * What is being held to account here:
 *
 *  * the two submission-time detectors fire at the boundary they document and
 *    not one answer earlier, and each flag carries the evidence that made it fire
 *    (the duration and its threshold, the value that repeated, the id it
 *    duplicates) rather than a bare verdict;
 *  * the duplicate scan is *not* a submission-time detector — a respondent's
 *    transaction may only see its own response, so the test proves the flag is
 *    absent until the scan is asked for, and that asking twice does not double it;
 *  * the queue is a workflow: a decision is recorded with who made it and why, and
 *    resolving a flag moves it out of the open list without destroying it;
 *  * tenancy and scope still hold, because a queue is somewhere a machine
 *    credential is most likely to be pointed — so it is also where the scopes are
 *    tested end to end.
 *
 * Everything runs over HTTP against the real database as the least-privileged app
 * role, with responses driven through the public collection surface exactly as a
 * device would drive them.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ fixtures */

/**
 * The duration a response reports comes from `response.started_at` →
 * `submitted_at`, so a test that wants a specific duration has to move the clock
 * it started from. This is the only write the suite makes outside the API, and it
 * is the field the feature reads.
 */
async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

interface Scenario {
  session: PlatformSession;
  orgId: string;
  formId: string;
  token: string;
}

async function scenario(prefix: string, definition: FormDefinition): Promise<Scenario> {
  const email = `${prefix}-${Date.now()}-${Math.random()}@example.com`;
  const session = await signInPlatform(app, email);
  const orgId = await createOrgFor(app, session, `${prefix} org`);
  const { formId } = await createPublishedForm(app, session, orgId, `${prefix} form`, definition);
  const link = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/links`,
    headers: { cookie: session.cookie },
    payload: { kind: 'anonymous' },
  });
  expect(link.statusCode, link.body).toBe(201);
  return { session, orgId, formId, token: (link.json() as { token: string }).token };
}

/**
 * Start, age the clock, submit — the three steps a device takes. `ageSeconds` is
 * how long the interview is made to have taken.
 */
async function submitAfter(
  token: string,
  answers: Record<string, unknown>,
  ageSeconds: number,
): Promise<string> {
  const clientId = crypto.randomUUID();
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses`,
    payload: { clientId },
  });
  expect(started.statusCode, started.body).toBe(201);

  await adminQuery(`UPDATE response SET started_at = now() - $2::interval WHERE id = $1`, [
    clientId,
    `${ageSeconds} seconds`,
  ]);

  const submitted = await app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses/${clientId}/submit`,
    payload: { answers },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  expect((submitted.json() as { status: string }).status).toBe('submitted');
  return clientId;
}

interface FlagView {
  id: string;
  formId: string;
  responseId: string;
  questionId: string | null;
  kind: string;
  severity: string;
  detail: Record<string, unknown>;
  status: string;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface Queue {
  flags: FlagView[];
  summary: { byStatus: Record<string, number>; byKind: Record<string, number>; open: number };
}

async function queue(orgId: string, query = '', cookie?: string, bearer?: string): Promise<Queue> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${orgId}/flags${query}`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Queue;
}

const kindsFor = (view: Queue, responseId: string): string[] =>
  view.flags.filter((flag) => flag.responseId === responseId).map((flag) => flag.kind);

const flagFor = (view: Queue, responseId: string, kind: string): FlagView => {
  const found = view.flags.find((flag) => flag.responseId === responseId && flag.kind === kind);
  if (!found) throw new Error(`no ${kind} flag for response ${responseId}: ${JSON.stringify(view.flags)}`);
  return found;
};

/* ------------------------------------------------------------- definitions */

/** Two required questions: a speed threshold of max(20s, 4 × 2) = 20 seconds. */
const speedForm: FormDefinition = {
  title: 'Speed check',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
  ],
  choiceLists: {},
};

/** Four required integers: enough for the straight-line rule and its 80 % boundary. */
const lineForm: FormDefinition = {
  title: 'Line check',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_a', name: 'a', type: 'integer', label: { en: 'A' }, required: true },
    { id: 'q_b', name: 'b', type: 'integer', label: { en: 'B' }, required: true },
    { id: 'q_c', name: 'c', type: 'integer', label: { en: 'C' }, required: true },
    { id: 'q_d', name: 'd', type: 'integer', label: { en: 'D' }, required: true },
  ],
  choiceLists: {},
};

/** Three required integers, answered with distinct values: the duplicate fixture. */
const dupForm: FormDefinition = {
  title: 'Duplicate check',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_a', name: 'a', type: 'integer', label: { en: 'A' }, required: true },
    { id: 'q_b', name: 'b', type: 'integer', label: { en: 'B' }, required: true },
    { id: 'q_c', name: 'c', type: 'integer', label: { en: 'C' }, required: true },
  ],
  choiceLists: {},
};

const TEN_MINUTES = 600;

/* -------------------------------------------------------------------- tests */

describe('quality flags and the flag queue', () => {
  it('flags an interview that is too fast for its length, and says by how much', async () => {
    const { session, orgId, formId, token } = await scenario('flag-speed', speedForm);

    // 5 s for two questions: under half of the 20 s threshold, so `severe`.
    const veryFast = await submitAfter(token, { consent: 'yes', score: 5 }, 5);
    // 15 s: under the threshold but not under half of it, so `warn`.
    const fast = await submitAfter(token, { consent: 'no', score: 2 }, 15);
    // Ten minutes for two questions: not a finding, and the test asserts the
    // detector stays quiet rather than only that it fires.
    const unhurried = await submitAfter(token, { consent: 'yes', score: 8 }, TEN_MINUTES);

    const view = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);

    const severe = flagFor(view, veryFast, 'speeding');
    expect(severe.severity).toBe('severe');
    expect(severe.detail.thresholdSeconds).toBe(20);
    expect(severe.detail.answeredQuestions).toBe(2);
    expect(severe.detail.durationSeconds as number).toBeLessThan(10);
    expect(severe.detail.rule).toBe('max(20s, 4s x questions)');
    expect(severe.questionId).toBeNull();

    const warn = flagFor(view, fast, 'speeding');
    expect(warn.severity).toBe('warn');
    expect(warn.detail.durationSeconds as number).toBeGreaterThanOrEqual(10);
    expect(warn.detail.durationSeconds as number).toBeLessThan(20);

    expect(kindsFor(view, unhurried)).toEqual([]);

    // The queue counts what it returns.
    const open = await queue(orgId, `?formId=${formId}`, session.cookie);
    expect(open.summary.open).toBe(open.flags.length);
    expect(open.summary.byKind.speeding).toBe(2);
  });

  it('flags a straight line only at the boundary it claims', async () => {
    const { session, orgId, formId, token } = await scenario('flag-line', lineForm);

    // 4 of 4 answers identical: 100 %, well past the 80 % rule.
    const allSame = await submitAfter(token, { a: 3, b: 3, c: 3, d: 3 }, TEN_MINUTES);
    // 3 of 4 identical is exactly 75 %: under the rule, so no flag.
    const mostlySame = await submitAfter(token, { a: 4, b: 4, c: 4, d: 1 }, TEN_MINUTES);
    // Nothing repeated.
    const varied = await submitAfter(token, { a: 1, b: 2, c: 3, d: 4 }, TEN_MINUTES);

    const view = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);

    const flag = flagFor(view, allSame, 'straight_lining');
    expect(flag.severity).toBe('warn');
    expect(flag.detail.value).toBe('3');
    expect(flag.detail.share).toBe(1);
    expect(flag.detail.questionsInLine).toBe(4);
    expect(flag.detail.answeredQuestions).toBe(4);
    expect(Array.isArray(flag.detail.questionIds)).toBe(true);
    expect(new Set(flag.detail.questionIds as string[]).size).toBe(4);
    expect(flag.detail.rule).toBe('80% of at least 4 answers');

    // The boundary is the point: 75 % is not a straight line, and neither is a
    // set of distinct answers.
    expect(kindsFor(view, mostlySame)).toEqual([]);
    expect(kindsFor(view, varied)).toEqual([]);
  });

  it('does not call three identical answers a straight line', async () => {
    const { session, orgId, formId, token } = await scenario('flag-short', dupForm);
    // Three answers, all the same: still below the four-answer minimum, so the
    // detector must stay quiet even though the share is 100 %.
    const short = await submitAfter(token, { a: 5, b: 5, c: 5 }, TEN_MINUTES);
    const view = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    expect(kindsFor(view, short)).toEqual([]);
  });

  it('finds an exact duplicate only when the scan is asked for it, and only once', async () => {
    const { session, orgId, formId, token } = await scenario('flag-dupe', dupForm);
    const answers = { a: 1, b: 2, c: 3 };
    const first = await submitAfter(token, answers, TEN_MINUTES);
    const second = await submitAfter(token, answers, TEN_MINUTES);

    const before = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    // Two identical submissions, and no duplicate flag: a respondent's
    // transaction may not read another response, so this detector cannot run
    // there. The scan is the only place it can see the whole form.
    expect(before.flags.filter((flag) => flag.kind === 'duplicate')).toEqual([]);
    expect(kindsFor(before, first)).toEqual([]);
    expect(kindsFor(before, second)).toEqual([]);

    const scanned = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/flags/scan`,
      headers: { cookie: session.cookie },
    });
    expect(scanned.statusCode, scanned.body).toBe(200);
    expect((scanned.json() as { flagged: number }).flagged).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/flags/scan`,
      headers: { cookie: session.cookie },
    });
    expect(again.statusCode, again.body).toBe(200);
    // The unique index is the arbiter: a second scan finds nothing new.
    expect((again.json() as { flagged: number }).flagged).toBe(0);

    const after = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    const duplicates = after.flags.filter((flag) => flag.kind === 'duplicate');
    expect(duplicates).toHaveLength(1);
    const flag = duplicates[0]!;
    expect(flag.severity).toBe('severe');
    // The flagged response and the one it duplicates are different rows, and both
    // are real responses on this form.
    expect([first, second]).toContain(flag.responseId);
    expect(flag.detail.duplicateOf).not.toBe(flag.responseId);
    expect([first, second]).toContain(flag.detail.duplicateOf);
    expect(flag.detail.answersHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps a person's flag with the note that justified it, and insists on one", async () => {
    const { session, orgId, formId, token } = await scenario('flag-manual', dupForm);
    const responseId = await submitAfter(token, { a: 7, b: 8, c: 9 }, TEN_MINUTES);
    const url = `/api/v1/orgs/${orgId}/forms/${formId}/responses/${responseId}/flags`;

    const noteMissing = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie },
      payload: { severity: 'severe' },
    });
    expect(noteMissing.statusCode).toBe(400);

    const raised = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie },
      payload: { severity: 'severe', note: 'The household said they were never visited.' },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    expect((raised.json() as { queued: boolean }).queued).toBe(true);

    const view = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    const manual = flagFor(view, responseId, 'manual');
    expect(manual.severity).toBe('severe');
    expect(manual.detail.note).toBe('The household said they were never visited.');
    expect(manual.questionId).toBeNull();
    expect(manual.status).toBe('open');

    // Raising the same kind against the same response again is not a second row:
    // the queue shows one manual finding, which is the property the unique index
    // exists to hold — and the answer says so rather than claiming a write. A `201
    // queued: true` here would be the small lie that makes a second complaint look
    // recorded when it was dropped.
    const twice = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie },
      payload: { severity: 'warn', note: 'A second opinion about the same response.' },
    });
    expect(twice.statusCode, twice.body).toBe(200);
    expect((twice.json() as { queued: boolean; reason: string }).queued).toBe(false);
    expect((twice.json() as { reason: string }).reason).toBe('already_recorded');
    const after = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    expect(after.flags.filter((flag) => flag.responseId === responseId && flag.kind === 'manual')).toHaveLength(1);
    expect(flagFor(after, responseId, 'manual').detail.note).toBe(
      'The household said they were never visited.',
    );

    // A flag against a response that does not exist is a 404 rather than a silent
    // write into the queue.
    const stray = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/responses/${crypto.randomUUID()}/flags`,
      headers: { cookie: session.cookie },
      payload: { severity: 'warn', note: 'no such response' },
    });
    expect(stray.statusCode).toBe(404);
  });

  it('records the decision, not just the detection', async () => {
    const { session, orgId, formId, token } = await scenario('flag-resolve', dupForm);
    const responseId = await submitAfter(token, { a: 1, b: 2, c: 3 }, TEN_MINUTES);
    await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/responses/${responseId}/flags`,
      headers: { cookie: session.cookie },
      payload: { severity: 'warn', note: 'Check the GPS against the rota.' },
    });

    const queueBefore = await queue(orgId, `?formId=${formId}`, session.cookie);
    expect(queueBefore.summary.open).toBe(1);
    const flagId = queueBefore.flags[0]!.id;

    const resolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${flagId}`,
      headers: { cookie: session.cookie },
      payload: { status: 'resolved', note: 'The visit is confirmed by the supervisor.' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const decided = (resolved.json() as { flag: FlagView }).flag;
    expect(decided.status).toBe('resolved');
    expect(decided.note).toBe('The visit is confirmed by the supervisor.');
    expect(decided.resolvedAt).toBeTruthy();
    expect(decided.resolvedBy).toBe(session.email);

    // Out of the open list, kept in the record.
    const open = await queue(orgId, `?formId=${formId}`, session.cookie);
    expect(open.flags).toEqual([]);
    expect(open.summary.open).toBe(0);
    const resolvedList = await queue(orgId, `?formId=${formId}&status=resolved`, session.cookie);
    expect(resolvedList.flags.map((flag) => flag.id)).toEqual([flagId]);
    const everything = await queue(orgId, `?formId=${formId}&status=all`, session.cookie);
    expect(everything.summary.byStatus.resolved).toBe(1);
    expect(everything.summary.open).toBe(0);

    // An unknown flag is a 404, and a status outside the vocabulary is refused
    // rather than treated as open.
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${crypto.randomUUID()}`,
      headers: { cookie: session.cookie },
      payload: { status: 'resolved' },
    });
    expect(unknown.statusCode).toBe(404);
    const nonsense = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${flagId}`,
      headers: { cookie: session.cookie },
      payload: { status: 'open' },
    });
    expect(nonsense.statusCode).toBe(400);

    // Dismissing is a different outcome from resolving, and is reported as one.
    const secondResponse = await submitAfter(token, { a: 4, b: 5, c: 6 }, TEN_MINUTES);
    await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/responses/${secondResponse}/flags`,
      headers: { cookie: session.cookie },
      payload: { severity: 'info', note: 'Possibly a duplicate of the paper form.' },
    });
    const secondFlagId = (await queue(orgId, `?formId=${formId}`, session.cookie)).flags[0]!.id;
    const dismissed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${secondFlagId}`,
      headers: { cookie: session.cookie },
      payload: { status: 'dismissed', note: 'Two different enumerators, two real visits.' },
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    const dismissedList = await queue(orgId, `?formId=${formId}&status=dismissed`, session.cookie);
    expect(dismissedList.flags.map((flag) => flag.id)).toEqual([secondFlagId]);
    const summary = (await queue(orgId, `?formId=${formId}&status=all`, session.cookie)).summary;
    expect(summary.byStatus.dismissed).toBe(1);
    expect(summary.byStatus.resolved).toBe(1);
  });

  it("keeps one organisation's queue out of another's", async () => {
    const a = await scenario('flag-tenant-a', dupForm);
    const b = await scenario('flag-tenant-b', dupForm);
    const responseId = await submitAfter(a.token, { a: 1, b: 2, c: 3 }, TEN_MINUTES);
    await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${a.orgId}/forms/${a.formId}/responses/${responseId}/flags`,
      headers: { cookie: a.session.cookie },
      payload: { severity: 'warn', note: 'A finding that belongs to A.' },
    });
    const aQueue = await queue(a.orgId, `?formId=${a.formId}&status=all`, a.session.cookie);
    expect(aQueue.flags).toHaveLength(1);

    // B's own queue is empty, and A's queue is not merely empty for B: it is a
    // 404, so B cannot learn whether A has flags at all.
    const bQueue = await queue(b.orgId, '', b.session.cookie);
    expect(bQueue.flags).toEqual([]);
    expect(bQueue.summary.open).toBe(0);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${a.orgId}/flags`,
      headers: { cookie: b.session.cookie },
    });
    expect(foreign.statusCode).toBe(404);

    const foreignPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${a.orgId}/flags/${aQueue.flags[0]!.id}`,
      headers: { cookie: b.session.cookie },
      payload: { status: 'resolved' },
    });
    expect(foreignPatch.statusCode).toBe(404);

    const foreignScan = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${a.orgId}/forms/${a.formId}/flags/scan`,
      headers: { cookie: b.session.cookie },
    });
    expect(foreignScan.statusCode).toBe(404);
  });

  it('answers the machine surface for a scoped key and refuses everything else', async () => {
    const { session, orgId, formId, token } = await scenario('flag-keys', dupForm);
    const responseId = await submitAfter(token, { a: 1, b: 2, c: 3 }, TEN_MINUTES);
    await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/responses/${responseId}/flags`,
      headers: { cookie: session.cookie },
      payload: { severity: 'warn', note: 'For the QC pipeline to pick up.' },
    });

    const mint = async (name: string, scopes: string[]) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/api-keys`,
        headers: { cookie: session.cookie },
        payload: { name, scopes },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { key: { id: string; name: string; scopes: string[]; prefix: string }; secret: string };
    };

    const reader = await mint('QC reader', ['flags:read']);
    const writer = await mint('QC writer', ['flags:read', 'flags:write']);
    expect(reader.secret).toMatch(/^ik_[0-9a-f]{64}$/);
    expect(reader.key.scopes).toEqual(['flags:read']);

    // Read: the queue is readable by a key that was granted exactly that.
    const viaKey = await queue(orgId, `?formId=${formId}&status=all`, undefined, reader.secret);
    expect(viaKey.flags).toHaveLength(1);

    // Write: refused, and the refusal names the scope that is missing.
    const flagId = viaKey.flags[0]!.id;
    const patchWithReader = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${flagId}`,
      headers: { authorization: `Bearer ${reader.secret}` },
      payload: { status: 'resolved' },
    });
    expect(patchWithReader.statusCode).toBe(403);
    expect(patchWithReader.json()).toMatchObject({ error: 'insufficient_scope' });

    const scanWithReader = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/flags/scan`,
      headers: { authorization: `Bearer ${reader.secret}` },
    });
    expect(scanWithReader.statusCode).toBe(403);
    expect(scanWithReader.json()).toMatchObject({ error: 'insufficient_scope' });

    // The writer can do both.
    const scanWithWriter = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/flags/scan`,
      headers: { authorization: `Bearer ${writer.secret}` },
    });
    expect(scanWithWriter.statusCode, scanWithWriter.body).toBe(200);
    const patchWithWriter = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/flags/${flagId}`,
      headers: { authorization: `Bearer ${writer.secret}` },
      payload: { status: 'dismissed', note: 'Handled by the pipeline.' },
    });
    expect(patchWithWriter.statusCode, patchWithWriter.body).toBe(200);

    // A route that declares no scope is session-only: the default for every
    // endpoint written before machine access existed is deny, not allow.
    const kindsViaKey = await app.inject({
      method: 'GET',
      url: '/api/v1/flag-kinds',
      headers: { authorization: `Bearer ${reader.secret}` },
    });
    expect(kindsViaKey.statusCode).toBe(403);
    expect(kindsViaKey.json()).toMatchObject({ error: 'key_not_permitted' });

    // And a key is bound to the organisation it was issued for.
    const other = await scenario('flag-keys-other', dupForm);
    const crossOrg = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${other.orgId}/flags`,
      headers: { authorization: `Bearer ${reader.secret}` },
    });
    expect(crossOrg.statusCode).toBe(403);
    expect(crossOrg.json()).toMatchObject({ error: 'key_org_mismatch' });

    // Revoked means revoked, on the very next request.
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/api-keys/${reader.key.id}`,
      headers: { cookie: session.cookie },
    });
    expect(revoked.statusCode).toBe(204);
    const afterRevoke = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: { authorization: `Bearer ${reader.secret}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json()).toMatchObject({ error: 'invalid_api_key' });
    // The writer's key is untouched, so the revocation was of one key and not of
    // the organisation's machine access in general. (`status=all`, because the
    // flag the writer dismissed is deliberately no longer open.)
    const writerStillWorks = await queue(orgId, '?status=all', undefined, writer.secret);
    expect(writerStillWorks.flags).toHaveLength(1);
    expect(writerStillWorks.flags[0]!.status).toBe('dismissed');
  });

  it('publishes the vocabulary and the thresholds it applies', async () => {
    const session = await signInPlatform(app, `flag-vocab-${Date.now()}@example.com`);
    const res = await app.inject({ method: 'GET', url: '/api/v1/flag-kinds', headers: { cookie: session.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      kinds: Array<{ kind: string; detail: string }>;
      thresholds: { speeding: string; straightLining: string };
    };
    expect(body.kinds.map((k) => k.kind)).toEqual(['speeding', 'straight_lining', 'duplicate', 'manual']);
    // The numbers in the API are the numbers in the documentation of the rule.
    expect(body.thresholds.speeding).toContain('20s');
    expect(body.thresholds.straightLining).toContain('80%');
    // Each kind explains itself in a finished sentence, so the console never renders
    // a bare identifier where a reviewer needs words. (`manual`'s is the short one:
    // "Raised by a person." — a length floor here would be about the wording, not
    // about the guarantee.)
    expect(body.kinds.every((k) => k.detail.trim().endsWith('.') && k.detail.trim().length > 10)).toBe(true);
  });
});
