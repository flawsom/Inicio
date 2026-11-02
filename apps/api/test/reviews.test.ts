import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import {
  createOrgFor,
  createPublishedForm,
  signInPlatform,
  uniqueEmail,
} from './helpers/fixtures.js';

/**
 * Review is a judgement with a history, not a status field.
 *
 * These tests hold the parts that make the difference: a claim is exclusive, a
 * decision is append-only, a correction copies the old value into the log, and a
 * stale correction is refused instead of overwriting somebody else's change.
 */

const definition: FormDefinition = {
  title: 'Household review',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_name', name: 'name', type: 'text', label: { en: 'Name' }, required: true },
    { id: 'q_age', name: 'age', type: 'integer', label: { en: 'Age' } },
  ],
  choiceLists: {},
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function submittedResponse(
  cookie: string,
  formId: string,
  answers: Record<string, unknown> = { name: 'Amina', age: 42 },
): Promise<{ responseId: string; token: string }> {
  const link = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/links`,
    headers: { cookie },
    payload: { kind: 'anonymous' },
  });
  expect(link.statusCode, link.body).toBe(201);
  const token = (link.json() as { token: string }).token;
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses`,
    payload: {},
  });
  expect(started.statusCode, started.body).toBe(201);
  const responseId = (started.json() as { responseId: string }).responseId;
  const submitted = await app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
    payload: { answers },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  return { responseId, token };
}

describe('review and correction', () => {
  it('claims, approves, reopens and keeps every decision in order', async () => {
    const owner = await signInPlatform(app, uniqueEmail('review-owner'));
    const orgId = await createOrgFor(app, owner, 'Review org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'Review form', definition);
    const { responseId } = await submittedResponse(owner.cookie, formId);

    const queue = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review?state=all`,
      headers: { cookie: owner.cookie },
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const queued = (queue.json() as { responses: Array<{ id: string; reviewState: string }> }).responses[0]!;
    expect(queued.id).toBe(responseId);
    // Submitting immediately raises the severe speeding flag, and a severe flag
    // puts an otherwise unreviewed response into the queue on its own.
    expect(queued.reviewState).toBe('pending');

    const claimed = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
      payload: { action: 'claim', note: 'I am taking this one.' },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect((claimed.json() as { response: { reviewState: string } }).response.reviewState).toBe('pending');

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
      payload: { action: 'approve', note: 'Clean interview.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((approved.json() as { response: { reviewState: string } }).response.reviewState).toBe('approved');

    const twice = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
      payload: { action: 'approve' },
    });
    expect(twice.statusCode).toBe(409);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
      payload: { action: 'reopen', note: 'One answer needs a check.' },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect((reopened.json() as { response: { reviewState: string } }).response.reviewState).toBe('pending');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const log = (detail.json() as { log: Array<{ action: string; note: string | null }> }).log;
    expect(log.map((entry) => entry.action)).toEqual(['claim', 'approve', 'reopen']);
    expect(log[1]?.note).toBe('Clean interview.');
  });

  it('corrects an answer, copies the old value into the log, and refuses a stale edit', async () => {
    const owner = await signInPlatform(app, uniqueEmail('review-correct'));
    const orgId = await createOrgFor(app, owner, 'Correction org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'Correction form', definition);
    const { responseId } = await submittedResponse(owner.cookie, formId);

    const corrected = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}/corrections`,
      headers: { cookie: owner.cookie },
      payload: {
        note: 'The name was written twice.',
        corrections: [{ questionId: 'name', from: 'Amina', to: 'Amina B', reason: 'spelling' }],
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect((corrected.json() as { answers: Record<string, unknown> }).answers.name).toBe('Amina B');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      headers: { cookie: owner.cookie },
    });
    const body = detail.json() as {
      answers: Record<string, unknown>;
      log: Array<{ action: string; corrections: Array<{ questionId: string; from: unknown; to: unknown }> }>;
    };
    expect(body.answers.name).toBe('Amina B');
    expect(body.log.at(-1)?.action).toBe('correction');
    expect(body.log.at(-1)?.corrections[0]).toMatchObject({ questionId: 'name', from: 'Amina', to: 'Amina B' });

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}/corrections`,
      headers: { cookie: owner.cookie },
      payload: { corrections: [{ questionId: 'name', from: 'Amina', to: 'Someone else' }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_correction' });
  });

  it('refuses a value the question type cannot produce', async () => {
    const owner = await signInPlatform(app, uniqueEmail('review-invalid'));
    const orgId = await createOrgFor(app, owner, 'Invalid correction org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'Invalid form', definition);
    const { responseId } = await submittedResponse(owner.cookie, formId);

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}/corrections`,
      headers: { cookie: owner.cookie },
      payload: { corrections: [{ questionId: 'age', to: 'forty-two' }] },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: 'invalid_value' });
  });

  it('exports the append-only correction log beside the corrected data', async () => {
    const owner = await signInPlatform(app, uniqueEmail('review-export'));
    const orgId = await createOrgFor(app, owner, 'Correction export org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'Correction export form', definition);
    const { responseId } = await submittedResponse(owner.cookie, formId, { name: 'Amina', age: 42 });

    const corrected = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/review/${responseId}/corrections`,
      headers: { cookie: owner.cookie },
      payload: {
        corrections: [{ questionId: 'name', from: 'Amina', to: 'Amina K.', reason: 'Checked the consent form.' }],
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses/export?format=csv`,
      headers: { cookie: owner.cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const files = unzipSync(new Uint8Array(exported.rawPayload));
    const names = Object.keys(files);
    const logName = names.find((name) => name.endsWith('corrections.csv'));
    expect(logName).toBeDefined();
    const log = strFromU8(files[logName!]!);
    expect(log).toContain('name');
    expect(log).toContain('Amina K.');
    expect(log).toContain('Checked the consent form.');
    const data = strFromU8(files[names.find((name) => name.endsWith('data.csv'))!]!);
    expect(data).toContain('Amina K.');
  });

  it('does not let another organisation read or decide a review', async () => {
    const owner = await signInPlatform(app, uniqueEmail('review-private'));
    const outsider = await signInPlatform(app, uniqueEmail('review-outsider'));
    const orgId = await createOrgFor(app, owner, 'Private review org');
    const outsiderOrg = await createOrgFor(app, outsider, 'Outsider review org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'Private form', definition);
    const { responseId } = await submittedResponse(owner.cookie, formId);

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${outsiderOrg}/forms/${formId}/review/${responseId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(read.statusCode).toBe(404);

    const decide = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${outsiderOrg}/forms/${formId}/review/${responseId}`,
      headers: { cookie: outsider.cookie },
      payload: { action: 'approve' },
    });
    expect(decide.statusCode).toBe(404);
  });
});
