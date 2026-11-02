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
 * Statistical QC is arithmetic with an evidence trail.
 *
 * The scan writes ordinary flags, so the reviewer sees an outlier in the same
 * queue as a speeding interview and can make the same recorded decision about it.
 */

const definition: FormDefinition = {
  title: 'QC form',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_age', name: 'age', type: 'integer', label: { en: 'Age' } },
    {
      id: 'q_colour',
      name: 'colour',
      type: 'select_one',
      label: { en: 'Favourite colour' },
      choices: {
        inline: [
          { value: 'red', label: { en: 'Red' } },
          { value: 'blue', label: { en: 'Blue' } },
        ],
      },
    },
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

async function submit(cookie: string, formId: string, answers: Record<string, unknown>): Promise<void> {
  const link = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/links`,
    headers: { cookie },
    payload: { kind: 'anonymous' },
  });
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
}

describe('statistical quality control', () => {
  it('flags an outlier and a too-frequent option, and reports the thresholds', async () => {
    const owner = await signInPlatform(app, uniqueEmail('qc-owner'));
    const orgId = await createOrgFor(app, owner, 'QC org');
    const { formId } = await createPublishedForm(app, owner, orgId, 'QC form', definition);

    for (const [age, colour] of [
      [10, 'red'], [11, 'red'], [10, 'red'], [12, 'red'], [11, 'red'], [100, 'blue'],
    ] as const) {
      await submit(owner.cookie, formId, { age, colour });
    }

    const report = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/qc/report`,
      headers: { cookie: owner.cookie },
    });
    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      scanned: number;
      byKind: Record<string, number>;
      findings: Array<{ kind: string; detail: Record<string, unknown> }>;
    };
    expect(body.scanned).toBe(6);
    expect(body.byKind.outlier).toBe(1);
    expect(body.byKind.too_frequent).toBeGreaterThanOrEqual(1);
    const outlier = body.findings.find((finding) => finding.kind === 'outlier');
    expect(outlier?.detail).toMatchObject({ value: 100, multiple: 1.5 });
    expect(outlier?.detail['upperBound']).toBeLessThan(100);

    const scan = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/qc/scan`,
      headers: { cookie: owner.cookie },
      payload: { outlierMultiple: 1.5, maxShare: 0.8, minShare: 0.01 },
    });
    expect(scan.statusCode, scan.body).toBe(200);
    expect((scan.json() as { flagged: number }).flagged).toBeGreaterThan(0);

    const flags = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags?formId=${formId}&status=all&limit=100`,
      headers: { cookie: owner.cookie },
    });
    const kinds = (flags.json() as { flags: Array<{ kind: string }> }).flags.map((flag) => flag.kind);
    expect(kinds).toContain('outlier');
    expect(kinds).toContain('too_frequent');
  });

  it('compares each enumerator against the rest and records the test and p-value', async () => {
    const owner = await signInPlatform(app, uniqueEmail('qc-groups'));
    const orgId = await createOrgFor(app, owner, 'QC groups org');
    const { formId, versionId } = await createPublishedForm(app, owner, orgId, 'QC groups form', definition);

    const dataset = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/datasets`,
      headers: { cookie: owner.cookie },
      payload: { code: 'enumerators', name: 'Field team', kind: 'enumerators' },
    });
    expect(dataset.statusCode, dataset.body).toBe(201);
    const datasetId = (dataset.json() as { dataset: { id: string } }).dataset.id;
    const imported = await app.inject({
      method: 'PUT',
      url: `/api/v1/orgs/${orgId}/datasets/${datasetId}/rows`,
      headers: { cookie: owner.cookie },
      payload: {
        mode: 'replace',
        rows: [
          { id: 'EN-01', name: 'Amina' },
          { id: 'EN-02', name: 'Joseph' },
        ],
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
      headers: { cookie: owner.cookie },
      payload: { datasetId, keyQuestion: null, publish: false },
    });
    expect(attached.statusCode, attached.body).toBe(201);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'anonymous' },
    });
    const token = (link.json() as { token: string }).token;
    const rows: Array<[string, number]> = [
      ['EN-01', 9], ['EN-01', 10], ['EN-01', 11],
      ['EN-02', 29], ['EN-02', 30], ['EN-02', 31],
    ];
    for (const [enumerator, age] of rows) {
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/collect/${token}/responses`,
        payload: { enumerator },
      });
      expect(started.statusCode, started.body).toBe(201);
      const responseId = (started.json() as { responseId: string }).responseId;
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
        payload: { answers: { age, colour: 'red' } },
      });
      expect(submitted.statusCode, submitted.body).toBe(200);
    }

    const report = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/qc/report`,
      headers: { cookie: owner.cookie },
    });
    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      findings: Array<{ kind: string; detail: Record<string, unknown> }>;
    };
    const group = body.findings.filter((finding) => finding.kind === 'group_mean');
    expect(group).toHaveLength(6);
    expect(group[0]?.detail).toMatchObject({
      test: 'Welch two-sample t test',
      alpha: 0.05,
    });
    expect(group[0]?.detail['p']).toBeLessThan(0.05);
    expect(group[0]?.detail['p']).not.toBeNaN();
  });

  it('refuses a scan before a version is published', async () => {
    const owner = await signInPlatform(app, uniqueEmail('qc-draft'));
    const orgId = await createOrgFor(app, owner, 'QC draft org');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { name: 'Draft only', orgId },
    });
    expect(created.statusCode, created.body).toBe(201);
    const formId = (created.json() as { form: { id: string } }).form.id;
    const scan = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/forms/${formId}/qc/scan`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(scan.statusCode).toBe(409);
    expect(scan.json()).toMatchObject({ error: 'not_published' });
  });
});
