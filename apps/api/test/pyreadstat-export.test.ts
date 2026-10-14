import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import { env } from '../src/env.js';
import { createOrgFor, signInPlatform, uniqueEmail } from './helpers/fixtures.js';

/**
 * `.sav` / `.dta`: the export that has to come from somewhere else.
 *
 * These two formats are the only exports this API cannot produce. They are written
 * by the pyreadstat worker (`services/pyreadstat`), so the claim worth holding is
 * not "a file came back" — it is the pair of boundaries around it:
 *
 *   1. with no worker configured the route keeps its honest `501`, and the reason
 *      it gives names the variable that would change that. A deployment that
 *      cannot write SPSS files must say so rather than emit something an analyst
 *      discovers is broken at the import step;
 *   2. with a worker configured the file is the worker's bytes, and the *dataset*
 *      is what travels — the columns, their prompts, their numeric-ness, the value
 *      labels and the missing codes the engine computed. A worker handed a CSV
 *      would be a different, worse design, and this is what tells them apart;
 *   3. a worker that cannot be reached is a `502` and no file at all. The one
 *      outcome that must never happen is a zero-byte download.
 *
 * The worker is stubbed over a local HTTP server, the way the attachment suite
 * stubs object storage: what the test asserts on is the request the worker
 * received and the bytes the client returned, not a mock's call log.
 */

const definition: FormDefinition = {
  title: 'Clinic visit',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
  ],
  choiceLists: {},
};

/** The bytes the stub worker hands back, so "the file is the worker's" is checkable. */
const SAV_BYTES = Buffer.from('$FL2@(#) SPSS DATA FILE - written by the worker, not by Node');
const DTA_BYTES = Buffer.from('<stata_dta>written by the worker, not by Node</stata_dta>');

interface Capture {
  url: string;
  body: {
    format?: string;
    fileLabel?: string;
    columns?: Array<{ variable: string; label: string; numeric: boolean }>;
    valueLabels?: Array<{ variable: string; code: string; label: string }>;
    missingCodes?: Array<{ code: string; numeric: number | null }>;
    notes?: string[];
    rows?: unknown[];
  };
}

let app: FastifyInstance;
let worker: Server;
let workerUrl = '';
let captured: Capture[] = [];
let workerReply: { status: number; body: Buffer; notes: string[] } = { status: 200, body: SAV_BYTES, notes: [] };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  worker = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const raw = Buffer.concat(chunks).toString('utf8');
      captured.push({
        url: request.url ?? '',
        body: raw ? (JSON.parse(raw) as Capture['body']) : {},
      });

      if (workerReply.status !== 200) {
        response.writeHead(workerReply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_request', detail: 'no columns' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-inicio-notes': JSON.stringify(workerReply.notes),
        'x-inicio-variables': '6',
        'x-inicio-cases': '0',
      });
      response.end(workerReply.body);
    })();
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address() as AddressInfo;
  workerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => worker.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  workerReply = { status: 200, body: SAV_BYTES, notes: [] };
  // No worker is the default state: every test that wants a file opts in.
  env.PYREADSTAT_WORKER_URL = undefined;
});

interface Scenario {
  cookie: string;
  formId: string;
}

async function published(prefix: string): Promise<Scenario> {
  const owner = await signInPlatform(app, uniqueEmail(prefix));
  const orgId = await createOrgFor(app, owner, `${prefix} org`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: owner.cookie },
    payload: { orgId, name: `${prefix} form`, definition },
  });
  expect(created.statusCode, created.body).toBe(201);
  const formId = (created.json() as { form: { id: string } }).form.id;
  const versionId = (created.json() as { version: { id: string } }).version.id;

  const pub = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
    headers: { cookie: owner.cookie },
  });
  expect(pub.statusCode, pub.body).toBe(200);
  return { cookie: owner.cookie, formId };
}

function exportAs(scenario: Scenario, format: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/forms/${scenario.formId}/responses/export?format=${format}`,
    headers: { cookie: scenario.cookie },
  });
}

/** A port nothing is listening on: bound to learn a number, then released. */
async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('statistical exports', () => {
  it('refuses .sav with a reason that names the variable which would change it', async () => {
    const scenario = await published('sav-unconfigured');

    const response = await exportAs(scenario, 'sav');
    expect(response.statusCode, response.body).toBe(501);
    const refusal = response.json() as { error: string; format: string; reason: string };
    expect(refusal.error).toBe('format_not_available');
    expect(refusal.format).toBe('sav');
    // The reason is the whole point of a 501 instead of a broken file: an operator
    // must be able to read what is missing and set it.
    expect(refusal.reason).toContain('PYREADSTAT_WORKER_URL');
    expect(captured).toHaveLength(0);
  });

  it('sends the worker the dataset rather than a flattened grid', async () => {
    const scenario = await published('sav-configured');
    env.PYREADSTAT_WORKER_URL = workerUrl;
    workerReply = { status: 200, body: SAV_BYTES, notes: ['variable "score" is written as "score_"'] };

    const response = await exportAs(scenario, 'sav');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-spss-sav');
    expect(response.headers['content-disposition']).toContain('.sav');
    // The file is the worker's bytes, byte for byte — nothing here rewrites it.
    expect(Buffer.from(response.rawPayload).equals(SAV_BYTES)).toBe(true);
    // What the writer had to change is reported, not swallowed.
    expect(response.headers['x-export-notes']).toBe('1');
    expect(String(response.headers['x-export-notes-detail'])).toContain('score_');

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toContain('/write');
    expect(request.body.format).toBe('sav');
    expect(request.body.fileLabel).toBe('Clinic visit');

    // The engine's columns travel with their prompts and their numeric-ness: the
    // worker is told what the data means, not just what it looks like.
    const consent = request.body.columns?.find((column) => column.variable === 'consent');
    const score = request.body.columns?.find((column) => column.variable === 'score');
    expect(consent).toEqual({ variable: 'consent', label: 'Consent', numeric: false });
    expect(score?.numeric).toBe(true);

    // Value labels and the declared missing codes go with them, because a code
    // without its label is what makes a statistical export useless.
    expect(request.body.valueLabels?.some((label) => label.variable === 'consent')).toBe(true);
    expect(request.body.missingCodes?.some((code) => code.numeric === -99)).toBe(true);
  });

  it('asks for .dta as .dta, and answers with the type that goes with it', async () => {
    const scenario = await published('dta-configured');
    env.PYREADSTAT_WORKER_URL = workerUrl;
    workerReply = { status: 200, body: DTA_BYTES, notes: [] };

    const response = await exportAs(scenario, 'dta');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-stata-dta');
    expect(response.headers['content-disposition']).toContain('.dta');
    expect(Buffer.from(response.rawPayload).equals(DTA_BYTES)).toBe(true);
    expect(captured[0]?.body.format).toBe('dta');
  });

  it('answers 502 rather than a file when the worker cannot be reached', async () => {
    const scenario = await published('sav-unreachable');
    env.PYREADSTAT_WORKER_URL = `http://127.0.0.1:${await closedPort()}`;

    const response = await exportAs(scenario, 'sav');
    expect(response.statusCode, response.body).toBe(502);
    const failure = response.json() as { error: string; message: string };
    expect(failure.error).toBe('export_worker_unavailable');
    // A 502 with no body would be a download that fails halfway; this is a refusal.
    expect(response.rawPayload.length).toBeGreaterThan(0);
  });

  it('treats a worker that produces nothing as a failure, not an empty download', async () => {
    const scenario = await published('sav-empty');
    env.PYREADSTAT_WORKER_URL = workerUrl;
    workerReply = { status: 200, body: Buffer.alloc(0), notes: [] };

    const response = await exportAs(scenario, 'sav');
    expect(response.statusCode, response.body).toBe(502);
    expect((response.json() as { error: string }).error).toBe('export_worker_unavailable');
  });
});
