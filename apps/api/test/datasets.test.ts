import type { FastifyInstance } from 'fastify';
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
 * Server datasets end to end, over HTTP and the real database.
 *
 * The claim under test is not CRUD. It is the loop: a case list exists, a form
 * version reads it with pulldata(), a case link names a row, and the submission
 * updates that row in the same transaction. If any of those is stubbed, the
 * "case management" sentence is not true.
 */

const caseDefinition: FormDefinition = {
  title: 'Household visit',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_caseid', name: 'caseid', type: 'calculate', label: { en: 'Case' } },
    {
      id: 'q_head',
      name: 'head_name',
      type: 'calculate',
      label: { en: 'Head of household' },
      rules: { calculate: "pulldata('cases', 'head_name', 'id', ${caseid})" },
    },
    { id: 'q_visit', name: 'visit_note', type: 'text', label: { en: 'Visit note' }, required: true },
    { id: 'q_outcome', name: 'outcome', type: 'text', label: { en: 'Outcome' }, required: true },
    { id: 'q_village', name: 'village_note', type: 'text', label: { en: 'Village note' } },
  ],
  choiceLists: {},
};

const sampleDefinition: FormDefinition = {
  title: 'Sample form',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [{ id: 'q_household', name: 'household', type: 'text', label: { en: 'Household' } }],
  choiceLists: {},
};

const enumeratorDefinition: FormDefinition = {
  title: 'Enumerator visit',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_enum', name: 'enum', type: 'enumerator', label: { en: 'Enumerator' } },
    { id: 'q_note', name: 'note', type: 'text', label: { en: 'Note' } },
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

async function createDataset(
  cookie: string,
  orgId: string,
  payload: { code: string; name: string; kind?: 'data' | 'cases' | 'enumerators'; uniqueField?: string },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/datasets`,
    headers: { cookie },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { dataset: { id: string } }).dataset.id;
}

async function importRows(
  cookie: string,
  orgId: string,
  datasetId: string,
  mode: 'replace' | 'append' | 'merge' | 'clear',
  rows: Array<Record<string, unknown>>,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/orgs/${orgId}/datasets/${datasetId}/rows`,
    headers: { cookie },
    payload: { mode, rows },
  });
}

async function createLink(cookie: string, formId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/links`,
    headers: { cookie },
    payload: { kind: 'anonymous' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

describe('server datasets and cases', () => {
  it('runs the case loop: attach, preload with pulldata, submit, write the case back', async () => {
    const owner = await signInPlatform(app, uniqueEmail('case-owner'));
    const orgId = await createOrgFor(app, owner, 'Case org');
    const { formId, versionId } = await createPublishedForm(app, owner, orgId, 'Household visit', caseDefinition);
    const datasetId = await createDataset(owner.cookie, orgId, {
      code: 'cases',
      name: 'Household cases',
      kind: 'cases',
      uniqueField: 'id',
    });

    const imported = await importRows(owner.cookie, orgId, datasetId, 'replace', [
      { id: 'HH-101', head_name: 'Amina', village: 'Kigoma', last_visit: '', status: 'open' },
      { id: 'HH-102', head_name: 'Joseph', village: 'Mwanza', last_visit: '', status: 'open' },
    ]);
    expect(imported.statusCode, imported.body).toBe(200);
    expect((imported.json() as { imported: number; total: number }).imported).toBe(2);
    expect((imported.json() as { imported: number; total: number }).total).toBe(2);

    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
      headers: { cookie: owner.cookie },
      payload: {
        datasetId,
        keyQuestion: 'caseid',
        publish: true,
        mapping: { last_visit: 'visit_note', status: 'outcome', village: 'village_note' },
      },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    expect((attached.json() as { dataset: { publish: boolean; code: string } }).dataset).toMatchObject({
      publish: true,
      code: 'cases',
    });

    const token = await createLink(owner.cookie, formId);
    const served = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(served.statusCode, served.body).toBe(200);
    const servedBody = served.json() as { datasets: Array<{ code: string; rows: unknown[] }> };
    expect(servedBody.datasets.map((dataset) => dataset.code)).toEqual(['cases']);
    expect(servedBody.datasets[0]?.rows).toHaveLength(2);

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { caseid: 'HH-101' },
    });
    expect(started.statusCode, started.body).toBe(201);
    const startedBody = started.json() as { responseId: string; caseid: string; datasets: unknown[] };
    expect(startedBody.caseid).toBe('HH-101');
    const responseId = startedBody.responseId;

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { visit_note: 'Visited on 1 November', outcome: 'complete' } },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((submitted.json() as { status: string; caseUpdated: number }).status).toBe('submitted');
    expect((submitted.json() as { caseUpdated: number }).caseUpdated).toBe(1);

    const responses = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses`,
      headers: { cookie: owner.cookie },
    });
    const stored = (responses.json() as { responses: Array<{ answers: Record<string, unknown> }> }).responses[0]!;
    expect(stored.answers['caseid']).toBe('HH-101');
    expect(stored.answers['head_name']).toBe('Amina');
    expect(stored.answers['visit_note']).toBe('Visited on 1 November');

    const dataset = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/datasets/${datasetId}`,
      headers: { cookie: owner.cookie },
    });
    expect(dataset.statusCode, dataset.body).toBe(200);
    const rows = (dataset.json() as { rows: Array<{ key: string; data: Record<string, unknown> }> }).rows;
    const row = rows.find((candidate) => candidate.key === 'HH-101')!;
    expect(row.data['head_name']).toBe('Amina');
    expect(row.data['last_visit']).toBe('Visited on 1 November');
    expect(row.data['status']).toBe('complete');
    // The mapped village question was never answered. A blank is not an instruction
    // to erase the case column the enumerator did not touch.
    expect(row.data['village']).toBe('Kigoma');
    // The other case was not touched by this interview.
    expect(rows.find((candidate) => candidate.key === 'HH-102')?.data['status']).toBe('open');
  });

  it('refuses an unknown case instead of opening an interview against no row', async () => {
    const owner = await signInPlatform(app, uniqueEmail('case-unknown'));
    const orgId = await createOrgFor(app, owner, 'Unknown case org');
    const { formId, versionId } = await createPublishedForm(app, owner, orgId, 'Household visit', caseDefinition);
    const datasetId = await createDataset(owner.cookie, orgId, {
      code: 'cases',
      name: 'Cases',
      kind: 'cases',
    });
    await importRows(owner.cookie, orgId, datasetId, 'replace', [
      { id: 'HH-201', head_name: 'Neema' },
    ]);
    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
      headers: { cookie: owner.cookie },
      payload: { datasetId, keyQuestion: 'caseid' },
    });
    expect(attached.statusCode, attached.body).toBe(201);

    const token = await createLink(owner.cookie, formId);
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { caseid: 'HH-999' },
    });
    expect(started.statusCode, started.body).toBe(422);
    expect(started.json()).toMatchObject({ error: 'unknown_case' });
  });

  it('keeps replace, append and merge distinct, and refuses a duplicate key in append', async () => {
    const owner = await signInPlatform(app, uniqueEmail('dataset-modes'));
    const orgId = await createOrgFor(app, owner, 'Dataset modes org');
    const datasetId = await createDataset(owner.cookie, orgId, {
      code: 'sample',
      name: 'Sample',
      uniqueField: 'household',
    });

    const first = await importRows(owner.cookie, orgId, datasetId, 'replace', [
      { household: 'A', village: 'North' },
      { household: 'B', village: 'South' },
    ]);
    expect(first.statusCode, first.body).toBe(200);

    const merged = await importRows(owner.cookie, orgId, datasetId, 'merge', [
      { household: 'B', village: 'East', note: 'moved' },
      { household: 'C', village: 'West' },
    ]);
    expect(merged.statusCode, merged.body).toBe(200);
    expect((merged.json() as { total: number }).total).toBe(3);

    // A merge upload may name only the columns that changed: the row is patched,
    // not replaced, so a column the file does not mention survives.
    const patched = await importRows(owner.cookie, orgId, datasetId, 'merge', [
      { household: 'B', note: 'follow-up due' },
    ]);
    expect(patched.statusCode, patched.body).toBe(200);
    const mergedRows = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/datasets/${datasetId}`,
      headers: { cookie: owner.cookie },
    });
    const rowB = (mergedRows.json() as { rows: Array<{ key: string; data: Record<string, unknown> }> }).rows
      .find((candidate) => candidate.key === 'B');
    expect(rowB?.data).toMatchObject({ village: 'East', note: 'follow-up due' });

    const appended = await importRows(owner.cookie, orgId, datasetId, 'append', [
      { household: 'D', village: 'Central' },
    ]);
    expect(appended.statusCode, appended.body).toBe(200);
    expect((appended.json() as { total: number }).total).toBe(4);

    const duplicate = await importRows(owner.cookie, orgId, datasetId, 'append', [
      { household: 'A', village: 'Duplicate' },
    ]);
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'duplicate_key' });

    const replaced = await importRows(owner.cookie, orgId, datasetId, 'replace', [
      { household: 'Z', village: 'Only' },
    ]);
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((replaced.json() as { total: number }).total).toBe(1);

    const cleared = await importRows(owner.cookie, orgId, datasetId, 'clear', []);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ imported: 0, total: 0, columns: [] });
    const empty = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/datasets/${datasetId}`,
      headers: { cookie: owner.cookie },
    });
    expect((empty.json() as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('queues a dataset.changed webhook in the same transaction as an import', async () => {
    const owner = await signInPlatform(app, uniqueEmail('dataset-webhook'));
    const orgId = await createOrgFor(app, owner, 'Dataset webhook org');
    const datasetId = await createDataset(owner.cookie, orgId, { code: 'sample', name: 'Sample' });
    const endpoint = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { url: 'https://receiver.example/hook', events: ['dataset.changed'] },
    });
    expect(endpoint.statusCode, endpoint.body).toBe(201);
    const endpointId = (endpoint.json() as { endpoint: { id: string } }).endpoint.id;

    const imported = await importRows(owner.cookie, orgId, datasetId, 'replace', [{ id: 'A', value: 'one' }]);
    expect(imported.statusCode, imported.body).toBe(200);
    const cleared = await importRows(owner.cookie, orgId, datasetId, 'clear', []);
    expect(cleared.statusCode, cleared.body).toBe(200);

    const deliveries = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/webhooks/${endpointId}/deliveries`,
      headers: { cookie: owner.cookie },
    });
    expect(deliveries.statusCode, deliveries.body).toBe(200);
    const rows = (deliveries.json() as {
      deliveries: Array<{ event: string; status: string; payload: { data: Record<string, unknown> } }>;
    }).deliveries;
    expect(rows.every((row) => row.event === 'dataset.changed' && row.status === 'pending')).toBe(true);
    expect(rows.map((row) => row.payload.data['mode']).sort()).toEqual(['clear', 'replace']);
  });

  it('validates an enumerator against the attached enumerator list and stores the identity', async () => {
    const owner = await signInPlatform(app, uniqueEmail('enumerator-owner'));
    const orgId = await createOrgFor(app, owner, 'Enumerator org');
    const { formId, versionId } = await createPublishedForm(app, owner, orgId, 'Enumerator form', enumeratorDefinition);
    const datasetId = await createDataset(owner.cookie, orgId, {
      code: 'enumerators',
      name: 'Field team',
      kind: 'enumerators',
    });
    const imported = await importRows(owner.cookie, orgId, datasetId, 'replace', [
      { id: 'EN-01', name: 'Amina' },
      { id: 'EN-02', name: 'Joseph' },
    ]);
    expect(imported.statusCode, imported.body).toBe(200);

    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
      headers: { cookie: owner.cookie },
      payload: { datasetId, keyQuestion: null, publish: false },
    });
    expect(attached.statusCode, attached.body).toBe(201);

    const token = await createLink(owner.cookie, formId);
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { enumerator: 'EN-01' },
    });
    expect(started.statusCode, started.body).toBe(201);
    expect((started.json() as { enumeratorRef: string }).enumeratorRef).toBe('EN-01');

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { enumerator: 'EN-99' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: 'unknown_enumerator' });
  });

  it('lets a scoped key read datasets but not write them without datasets:write', async () => {
    const owner = await signInPlatform(app, uniqueEmail('dataset-key'));
    const orgId = await createOrgFor(app, owner, 'Dataset key org');
    await createDataset(owner.cookie, orgId, { code: 'sample', name: 'Sample' });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: owner.cookie },
      payload: { name: 'Reader', scopes: ['datasets:read'] },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const secret = (minted.json() as { secret: string }).secret;

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/datasets`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { datasets: unknown[] }).datasets).toHaveLength(1);

    const write = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/datasets`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { code: 'other', name: 'Other' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it('does not let another organisation read the dataset or attach it', async () => {
    const owner = await signInPlatform(app, uniqueEmail('dataset-owner'));
    const outsider = await signInPlatform(app, uniqueEmail('dataset-outsider'));
    const orgId = await createOrgFor(app, owner, 'Private data org');
    const outsiderOrg = await createOrgFor(app, outsider, 'Outsider org');
    const datasetId = await createDataset(owner.cookie, orgId, { code: 'private', name: 'Private' });
    const form = await createPublishedForm(app, outsider, outsiderOrg, 'Outsider form', sampleDefinition);

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/datasets/${datasetId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(read.statusCode).toBe(404);

    const attach = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${outsiderOrg}/forms/${form.formId}/versions/${form.versionId}/datasets`,
      headers: { cookie: outsider.cookie },
      payload: { datasetId },
    });
    expect(attach.statusCode).toBe(404);
  });
});
