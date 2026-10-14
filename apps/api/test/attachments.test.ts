import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import type { FormDefinition } from '@inicio/engine';
import { buildApp } from '../src/app.js';
import { env } from '../src/env.js';
import { createOrgFor, signInPlatform, uniqueEmail } from './helpers/fixtures.js';

/**
 * Attachments: a file a respondent sends, and the four things that decide
 * whether it becomes an answer.
 *
 * The path has no pass-through server: the API authorises one object (a question,
 * a type, a ceiling), signs a URL for exactly that object, and the bytes travel
 * from the browser to the store. So there are four claims worth holding, and none
 * of them is visible in a happy-path response:
 *
 *   1. the presigned URL is genuinely valid SigV4, and is bound to one object —
 *      proven by a stub store that *recomputes the signature from the incoming
 *      request* and refuses a URL whose path, query or signed headers were changed;
 *   2. the limits are the server's, not the client's: the declared size is
 *      checked before a credential exists, and the *store's own* HEAD is what gets
 *      recorded, because a device that declares two kilobytes and sends ten
 *      megabytes is the case the declaration cannot cover;
 *   3. the scan step has four outcomes and `clean` means a scanner said so — an
 *      unscanned file is `skipped`, an unreachable scanner is `error`, and an
 *      infected one is deleted. A file nobody looked at must never be
 *      indistinguishable from one that was checked;
 *   4. a response cannot be submitted carrying a file the server never accepted.
 *
 * The stub store (`node:http`) verifies the signature with its own code, and the
 * stub scanner (`node:net`) speaks clamd's INSTREAM framing properly — including
 * the zero-length terminator — so a test that gets a verdict has also proven the
 * client framed the stream the way a scanner requires.
 */

// `src/env.ts` reads its configuration once, when it is imported. This has to run
// before any `src/` module loads, which is exactly what `vi.hoisted` is for.
vi.hoisted(() => {
  process.env.S3_BUCKET = 'inicio-test-bucket';
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key-0123456789';
  process.env.AWS_REGION = 'us-east-1';
});

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-0123456789';
const BUCKET = 'inicio-test-bucket';
const CEILING = 2048;

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** What the store holds. The tests assert against this, not against a mock's call log. */
const objects = new Map<string, StoredObject>();
/** Every request the stub refused, and why. A 403 must be a signature mismatch, never a flake. */
const refusals: string[] = [];

/* ------------------------------------------------------------------ the store */

/** RFC 3986, the encoding SigV4 signs: `encodeURIComponent` leaves `!'()*` alone and SigV4 does not. */
function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(character) || (!encodeSlash && character === '/')) out += character;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Recompute the signature from the request, independently of the application.
 *
 * This is the only check that shows a presigned URL is *valid* rather than
 * well-shaped: if the API's canonical request differs from this one by a single
 * byte — an unsorted query, a header it forgot to sign, a path encoded
 * differently — the signatures differ and the request is refused. A test that
 * imported the application's own signer could only prove it agrees with itself.
 */
function verifySignature(request: IncomingMessage): string | null {
  const raw = request.url ?? '';
  const [path, search = ''] = raw.split('?');
  const params = new URLSearchParams(search);
  const provided = params.get('X-Amz-Signature');
  if (!provided) return 'no signature on the query';

  const credential = params.get('X-Amz-Credential') ?? '';
  const [keyId, date, region, service, terminator] = credential.split('/');
  if (keyId !== ACCESS_KEY) return `unknown access key ${keyId}`;
  if (service !== 's3' || terminator !== 'aws4_request') return `unexpected scope ${credential}`;
  const amzDate = params.get('X-Amz-Date') ?? '';

  const signedHeaders = (params.get('X-Amz-SignedHeaders') ?? '').split(';');
  const canonicalHeaders = signedHeaders
    .map((name) => {
      const value =
        name === 'host' ? String(request.headers.host ?? '') : String(request.headers[name] ?? '');
      if (!value) return `missing signed header ${name}`;
      return `${name}:${value.trim()}\n`;
    })
    .join('');

  const canonicalQuery = [...params.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    request.method ?? 'GET',
    path ?? '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${date}/${region}/${service}/${terminator}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, value: string): Buffer =>
    createHmac('sha256', key).update(value, 'utf8').digest();
  const kDate = hmac(`AWS4${SECRET_KEY}`, date ?? '');
  const kRegion = hmac(kDate, region ?? '');
  const kService = hmac(kRegion, service ?? '');
  const signingKey = hmac(kService, terminator ?? 'aws4_request');
  const expected = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return expected === provided ? null : `signature mismatch (sent ${provided.slice(0, 12)}…)`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** The object key as it arrived, minus the bucket segment (kept encoded, as signed). */
function keyOf(path: string): string {
  return path.replace(new RegExp(`^/${BUCKET}/`), '');
}

let store: Server;
let storePort = 0;

beforeAll(async () => {
  store = createServer((request, response) => {
    void (async () => {
      try {
        const refusal = verifySignature(request);
        if (refusal) {
          refusals.push(refusal);
          response.writeHead(403, { 'content-type': 'application/xml' });
          response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
          return;
        }

        const [path = '/'] = (request.url ?? '/').split('?');
        const key = keyOf(path);

        if (request.method === 'PUT') {
          const body = await readBody(request);
          objects.set(key, { body, contentType: String(request.headers['content-type'] ?? '') });
          response.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
          response.end();
          return;
        }
        if (request.method === 'HEAD') {
          const object = objects.get(key);
          if (!object) {
            response.writeHead(404);
            response.end();
            return;
          }
          response.writeHead(200, {
            'content-length': String(object.body.byteLength),
            'content-type': object.contentType,
          });
          response.end();
          return;
        }
        if (request.method === 'GET') {
          const object = objects.get(key);
          if (!object) {
            response.writeHead(404);
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': object.contentType });
          response.end(object.body);
          return;
        }
        if (request.method === 'DELETE') {
          // A store that answers 204 for a key it never held would hide a delete
          // that never happened, so absence is a 404 here and the client is written
          // to treat that as success.
          response.writeHead(objects.delete(key) ? 204 : 404);
          response.end();
          return;
        }
        response.writeHead(405);
        response.end();
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
  const address = store.address();
  storePort = typeof address === 'object' && address ? address.port : 0;

  // The endpoint is mutated rather than set through the environment because the
  // port is only known once the server is listening, and `env` is a plain object
  // built at import: every read of it happens per request (`storageConfig()`), so
  // pointing it here is what makes a dynamic port usable at all.
  env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${storePort}`;
});

/* ---------------------------------------------------------------- the scanner */

const CLAMD_CLEAN = 'stream: OK\0';
const CLAMD_INFECTED = 'stream: Eicar-Test-Signature FOUND\0';

let clamdVerdict = CLAMD_CLEAN;
/** Bytes the stub actually parsed out of the stream, so framing is provable. */
let clamdStreamBytes = -1;
// The scanner speaks over a raw socket, so its stub is a `net` server: typing it as
// the http one compiles only until the test config (which includes tests) is asked.
let clamd: NetServer;
let clamdPort = 0;

beforeAll(async () => {
  clamd = createNetServer((socket) => {
    const header = 'zINSTREAM\0';
    let buffer = Buffer.alloc(0);
    let cursor = -1;
    let streamed = 0;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (cursor === -1) {
        if (buffer.byteLength < header.length) return;
        if (buffer.subarray(0, header.length).toString('latin1') !== header) {
          socket.destroy();
          return;
        }
        cursor = header.length;
      }
      // The framing, parsed properly: 4-byte big-endian lengths, chunks that may
      // arrive split across packets, and a zero-length chunk that ends it. A client
      // that sends the bytes without the framing gets no verdict at all.
      while (cursor + 4 <= buffer.byteLength) {
        const length = buffer.readUInt32BE(cursor);
        cursor += 4;
        if (length === 0) {
          clamdStreamBytes = streamed;
          socket.write(clamdVerdict);
          return;
        }
        if (cursor + length > buffer.byteLength) {
          cursor -= 4;
          return;
        }
        cursor += length;
        streamed += length;
      }
    });
  });
  await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
  const address = clamd.address();
  clamdPort = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()));
  await new Promise<void>((resolve) => clamd.close(() => resolve()));
});

/* --------------------------------------------------------------- the fixtures */

const definition: FormDefinition = {
  title: 'Field visit with attachments',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
    { id: 'photo', name: 'photo', type: 'image', label: { en: 'Photo' } },
    { id: 'document', name: 'document', type: 'file', label: { en: 'Document' } },
    { id: 'reason', name: 'reason', type: 'text', label: { en: 'Reason' } },
  ],
  choiceLists: {},
};

/**
 * The same form the way this repository's own fixtures are written: a question's
 * `id` is a code-like key (`q_photo`) and its `name` is the one answers are stored
 * under. Both are in every definition the platform ships.
 */
const differingKeys: FormDefinition = {
  ...definition,
  title: 'Field visit (id and name differ)',
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
    { id: 'q_photo', name: 'photo', type: 'image', label: { en: 'Photo' } },
  ],
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  objects.clear();
  refusals.length = 0;
  clamdVerdict = CLAMD_CLEAN;
  clamdStreamBytes = -1;
  env.UPLOAD_MAX_BYTES = CEILING;
  // An unscanned deployment is the default state here, and each scan test opts in.
  env.CLAMD_HOST = undefined;
  env.CLAMD_PORT = clamdPort;
  env.CLAMD_TIMEOUT_MS = 1000;
  // The accepting default, stated here so a test that opts into `require` cannot
  // leak that choice into the next one.
  env.ATTACHMENT_SCAN_POLICY = 'allow_unscanned';
});

interface Scenario {
  owner: { cookie: string };
  orgId: string;
  formId: string;
  token: string;
}

async function published(prefix: string, def: FormDefinition = definition): Promise<Scenario> {
  const owner = await signInPlatform(app, uniqueEmail(prefix));
  const orgId = await createOrgFor(app, owner, `${prefix} org`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: owner.cookie },
    payload: { orgId, name: `${prefix} form`, definition: def },
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

  const link = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${formId}/links`,
    headers: { cookie: owner.cookie },
    payload: { kind: 'anonymous' },
  });
  expect(link.statusCode, link.body).toBe(201);
  return { owner, orgId, formId, token: (link.json() as { token: string }).token };
}

/** Start a response the way a device does: it owns the id, so a retry resumes. */
async function startResponse(token: string): Promise<string> {
  const clientId = crypto.randomUUID();
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses`,
    payload: { clientId },
  });
  expect(started.statusCode, started.body).toBe(201);
  return clientId;
}

interface Authorised {
  attachmentId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  maxBytes: number;
}

async function authorise(
  token: string,
  responseId: string,
  payload: { questionId: string; filename: string; mime: string; sizeBytes: number },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses/${responseId}/attachments`,
    payload,
  });
}

async function complete(token: string, responseId: string, attachmentId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses/${responseId}/attachments/${attachmentId}/complete`,
  });
}

async function submit(
  token: string,
  responseId: string,
  answers: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
    payload: { answers },
  });
}

/** Authorise, upload and complete in one go — the path a device takes when online. */
async function attach(
  token: string,
  responseId: string,
  overrides: Partial<{ questionId: string; filename: string; mime: string; sizeBytes: number }> = {},
  body: Buffer = Buffer.from('a photograph, honest'),
): Promise<Authorised & { completeBody: Record<string, unknown>; statusCode: number }> {
  const declared = {
    questionId: 'photo',
    filename: 'field notes.jpg',
    mime: 'image/jpeg',
    sizeBytes: body.byteLength,
    ...overrides,
  };
  const authorised = await authorise(token, responseId, declared);
  expect(authorised.statusCode, authorised.body).toBe(201);
  const payload = authorised.json() as Authorised;

  const uploaded = await fetch(payload.uploadUrl, {
    method: 'PUT',
    headers: payload.headers,
    body: new Uint8Array(body),
  });
  expect(uploaded.status, `the store refused the upload: ${refusals.join('; ')}`).toBe(200);

  const done = await complete(token, responseId, payload.attachmentId);
  return {
    ...payload,
    statusCode: done.statusCode,
    completeBody: done.statusCode < 400 ? (done.json() as Record<string, unknown>) : (done.json() as Record<string, unknown>),
  };
}

async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const attachmentRows = (responseId: string) =>
  adminQuery<{ status: string; scan_status: string; size_bytes: number; sha256: string | null; question_id: string }>(
    `SELECT status, scan_status, size_bytes, sha256, question_id FROM response_attachment WHERE response_id = $1`,
    [responseId],
  );

describe('attachments', () => {
  /* ---------------------------------------------------- 1. the signed URL */

  it('signs a URL the store verifies itself, bound to one object', async () => {
    const { token } = await published('sign');
    const responseId = await startResponse(token);
    const body = Buffer.from('a photograph, honest');

    const authorised = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'field notes.jpg',
      mime: 'image/jpeg',
      sizeBytes: body.byteLength,
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    const payload = authorised.json() as Authorised;

    // The key is the organisation, the response, the attachment and a filename
    // that has been through the sanitiser — `field notes.jpg` reaches the store
    // as `field-notes.jpg`, because a key is a path in somebody else's service.
    expect(payload.uploadUrl).toContain(`/${BUCKET}/`);
    expect(payload.uploadUrl).toContain(`/responses/${responseId}/${payload.attachmentId}/field-notes.jpg`);
    expect(payload.headers['content-type']).toBe('image/jpeg');
    expect(payload.maxBytes).toBe(CEILING);

    const uploaded = await fetch(payload.uploadUrl, {
      method: 'PUT',
      headers: payload.headers,
      body: new Uint8Array(body),
    });
    expect(uploaded.status, refusals.join('; ')).toBe(200);
    expect(refusals).toEqual([]);

    // One object, under the key that was signed — and its bytes are the bytes.
    expect(objects.size).toBe(1);
    const [key] = [...objects.keys()];
    expect(key).toContain(`/responses/${responseId}/${payload.attachmentId}/`);
    expect(key!.endsWith('field-notes.jpg')).toBe(true);
    expect([...objects.values()][0]!.body.toString()).toBe('a photograph, honest');
  });

  it('refuses a URL whose path, query or signed header was changed', async () => {
    const { token } = await published('tamper');
    const responseId = await startResponse(token);
    const authorised = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    const { uploadUrl, headers, attachmentId } = authorised.json() as Authorised;

    // A different object than the one that was authorised: the path is signed, so
    // the credential cannot be pointed at somebody else's key.
    const elsewhere = await fetch(uploadUrl.replace(attachmentId, crypto.randomUUID()), {
      method: 'PUT',
      headers,
      body: new Uint8Array(Buffer.from('elsewhere')),
    });
    expect(elsewhere.status).toBe(403);

    // A longer life than the one granted: the expiry is signed too.
    const longer = await fetch(uploadUrl.replace('X-Amz-Expires=900', 'X-Amz-Expires=901'), {
      method: 'PUT',
      headers,
      body: new Uint8Array(Buffer.from('longer')),
    });
    expect(longer.status).toBe(403);

    // The signed content type is part of the signature, so a client that uploads
    // something else is refused by the store, not merely contradicted later.
    const retyped = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(Buffer.from('retyped')),
    });
    expect(retyped.status).toBe(403);

    expect(objects.size).toBe(0);

    // And the API's own verdict on that attachment is the honest one: the file
    // never arrived, so the question is still unanswered.
    const done = await complete(token, responseId, attachmentId);
    expect(done.statusCode, done.body).toBe(409);
    expect((done.json() as { error: string }).error).toBe('upload_missing');
    expect(refusals).toHaveLength(3);
  });

  /* ------------------------------------------------- 2. type and capability */

  it('takes a file only on a question that asks for one', async () => {
    const { token } = await published('notupload');
    const responseId = await startResponse(token);

    const res = await authorise(token, responseId, {
      questionId: 'reason',
      filename: 'notes.pdf',
      mime: 'application/pdf',
      sizeBytes: 100,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: string }).error).toBe('not_an_upload_question');
    expect(objects.size).toBe(0);
  });

  it('accepts only the kinds the question declares, and says what it accepts', async () => {
    const { token } = await published('types');
    const responseId = await startResponse(token);

    const refused = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'report.pdf',
      mime: 'application/pdf',
      sizeBytes: 100,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    const refusal = refused.json() as { error: string; message: string };
    expect(refusal.error).toBe('type_not_allowed');
    // The refusal names what would have been accepted, so a respondent is not left
    // guessing at a rule they cannot see.
    expect(refusal.message).toContain('image/jpeg');

    // The same bytes are fine on the question that asks for a document.
    const accepted = await authorise(token, responseId, {
      questionId: 'document',
      filename: 'report.pdf',
      mime: 'application/pdf',
      sizeBytes: 100,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);

    // A mime with parameters, or in the wrong case, is the same mime.
    const shouted = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/JPEG; charset=binary',
      sizeBytes: 100,
    });
    expect(shouted.statusCode, shouted.body).toBe(201);

    // A question that is not on this instrument cannot be answered with a file.
    const unknown = await authorise(token, responseId, {
      questionId: 'not-a-question',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 100,
    });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect((unknown.json() as { error: string }).error).toBe('unknown_question');

    expect(objects.size).toBe(0);
  });

  it('tells the renderer the ceiling, the accepted kinds and whether a scanner is configured', async () => {
    const { token } = await published('capability');

    const resolved = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const capability = (resolved.json() as {
      attachments: {
        enabled: boolean;
        maxBytes: number;
        scan: string;
        unscanned: string;
        mime: Record<string, string[]>;
      };
    }).attachments;

    expect(capability.enabled).toBe(true);
    expect(capability.maxBytes).toBe(CEILING);
    // With no scanner configured the page is told so, because "these files are not
    // scanned" is a fact a respondent deserves before they send one.
    expect(capability.scan).toBe('off');
    // The policy travels with the capability, so the page can say what happens to a
    // file no scanner has read instead of leaving it to be inferred from `scan`.
    expect(capability.unscanned).toBe('accepted');
    expect(capability.mime.image).toContain('image/jpeg');
    expect(capability.mime.file).toContain('application/pdf');
    expect(capability.mime.image).not.toContain('application/pdf');
  });

  /* --------------------------------------------------------- 3. size limits */

  it('refuses a declaration above the ceiling before any credential is signed', async () => {
    const { token } = await published('toolarge');
    const responseId = await startResponse(token);

    const res = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'huge.jpg',
      mime: 'image/jpeg',
      sizeBytes: CEILING + 1,
    });
    expect(res.statusCode, res.body).toBe(413);
    expect((res.json() as { error: string }).error).toBe('too_large');
    // Nothing was written and no URL exists to leak.
    expect(await attachmentRows(responseId)).toEqual([]);
  });

  it('believes the store, not the declaration, and deletes what is too big', async () => {
    const { token } = await published('liar');
    const responseId = await startResponse(token);

    // Declared at ten bytes, sent at twice the ceiling. The declaration is checked
    // at authorisation and the *store's own HEAD* is what is recorded at
    // completion; this is the case the declaration cannot cover.
    const authorised = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'small.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    const payload = authorised.json() as Authorised;

    const uploaded = await fetch(payload.uploadUrl, {
      method: 'PUT',
      headers: payload.headers,
      body: new Uint8Array(Buffer.alloc(CEILING * 2, 0x41)),
    });
    expect(uploaded.status, refusals.join('; ')).toBe(200);

    const done = await complete(token, responseId, payload.attachmentId);
    expect(done.statusCode, done.body).toBe(413);
    expect((done.json() as { error: string }).error).toBe('too_large');

    // The bytes are gone and the row records that it was refused, so the file is
    // not sitting in the bucket with a row that reads like a success.
    expect(objects.size).toBe(0);
    const rows = await attachmentRows(responseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('deleted');

    // And the question cannot be submitted with it.
    const submitted = await submit(token, responseId, {
      consent: 'yes',
      score: 5,
      photo: payload.attachmentId,
    });
    expect(submitted.statusCode, submitted.body).toBe(422);
    expect((submitted.json() as { error: string }).error).toBe('attachment_not_ready');
  });

  /* ---------------------------------------------------------- 4. the scan */

  it('records a clean verdict from a scanner that read every byte', async () => {
    const { token } = await published('clean');
    const responseId = await startResponse(token);
    env.CLAMD_HOST = '127.0.0.1';

    const body = Buffer.from('a photograph, honest');
    const result = await attach(token, responseId, {}, body);
    expect(result.statusCode, JSON.stringify(result.completeBody)).toBe(200);
    expect(result.completeBody['scanStatus']).toBe('clean');

    // The scanner parsed the whole file out of the INSTREAM framing: chunk lengths
    // and the zero-length terminator were all correct, which is what makes the
    // verdict a verdict rather than a coincidence.
    expect(clamdStreamBytes).toBe(body.byteLength);

    const rows = await attachmentRows(responseId);
    expect(rows[0]!.status).toBe('uploaded');
    expect(rows[0]!.scan_status).toBe('clean');
    expect(objects.size).toBe(1);
  });

  it('deletes an infected file, records why, and refuses the answer', async () => {
    const { token } = await published('infected');
    const responseId = await startResponse(token);
    env.CLAMD_HOST = '127.0.0.1';
    clamdVerdict = CLAMD_INFECTED;

    const result = await attach(token, responseId);
    expect(result.statusCode, JSON.stringify(result.completeBody)).toBe(422);
    expect(result.completeBody['error']).toBe('attachment_infected');

    // A file a scanner named does not stay in the store because a row says it
    // exists, and the row says what happened rather than reading like a success.
    expect(objects.size).toBe(0);
    const rows = await attachmentRows(responseId);
    expect(rows[0]!.status).toBe('deleted');
    expect(rows[0]!.scan_status).toBe('infected');

    const submitted = await submit(token, responseId, {
      consent: 'yes',
      score: 5,
      photo: result.attachmentId,
    });
    expect(submitted.statusCode, submitted.body).toBe(422);
    expect((submitted.json() as { error: string }).error).toBe('attachment_not_ready');
  });

  it('records an unreachable scanner as an error, never as clean', async () => {
    const { token } = await published('scanerror');
    const responseId = await startResponse(token);

    // A port that was open a moment ago and is now closed: configured, and unable
    // to answer. The verdict must be `error`, because `clean` would be a claim
    // about a file that nothing looked at.
    const disappearing = createNetServer();
    await new Promise<void>((resolve) => disappearing.listen(0, '127.0.0.1', resolve));
    const deadAddress = disappearing.address();
    const deadPort = typeof deadAddress === 'object' && deadAddress ? deadAddress.port : 0;
    await new Promise<void>((resolve) => disappearing.close(() => resolve()));

    env.CLAMD_HOST = '127.0.0.1';
    env.CLAMD_PORT = deadPort;

    const result = await attach(token, responseId);
    expect(result.statusCode, JSON.stringify(result.completeBody)).toBe(200);
    expect(result.completeBody['scanStatus']).toBe('error');
    expect(String(result.completeBody['scanDetail'])).not.toMatch(/found nothing/i);

    const rows = await attachmentRows(responseId);
    expect(rows[0]!.status).toBe('uploaded');
    expect(rows[0]!.scan_status).toBe('error');

    // Under the default policy the file is accepted - and the row still says `error`,
    // not `skipped`, because a scanner that was down and a deployment that has none are
    // different facts and an operator reading the data has to be able to tell them apart.
    const submitted = await submit(token, responseId, {
      consent: 'yes',
      score: 5,
      photo: result.attachmentId,
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((await attachmentRows(responseId))[0]!.scan_status).toBe('error');

    // `require` is the reading that fails closed, and here it fails at submission: a
    // scanner *is* configured, so authorisation is handed out and the verdict is what
    // decides - a file the scanner never gave a verdict for is not an answer.
    env.ATTACHMENT_SCAN_POLICY = 'require';
    const stricter = await published('scanerror-require');
    const stricterResponse = await startResponse(stricter.token);
    const unscanned = await attach(stricter.token, stricterResponse);
    expect(unscanned.completeBody['scanStatus']).toBe('error');

    const refused = await submit(stricter.token, stricterResponse, {
      consent: 'yes',
      score: 5,
      photo: unscanned.attachmentId,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect((refused.json() as { error: string }).error).toBe('attachment_not_ready');
  });

  it('stores a file unscanned only when it says so', async () => {
    const { token } = await published('noscanner');
    const responseId = await startResponse(token);
    // `beforeEach` leaves CLAMD_HOST unset: no scanner is configured, and that is
    // recorded as `skipped` rather than as a clean bill of health.
    const result = await attach(token, responseId);
    expect(result.statusCode, JSON.stringify(result.completeBody)).toBe(200);
    expect(result.completeBody['scanStatus']).toBe('skipped');

    const rows = await attachmentRows(responseId);
    expect(rows[0]!.scan_status).toBe('skipped');

    // A deployment with no scanner can still collect: the status is recorded, and
    // the submission is allowed because nothing claimed the file was checked.
    const submitted = await submit(token, responseId, {
      consent: 'yes',
      score: 5,
      photo: result.attachmentId,
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    // The policy is in the capability too, so the page can say which of the two this
    // deployment does rather than implying that no scanner means no files.
    const resolved = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect((resolved.json() as { attachments: { scan: string; unscanned: string } }).attachments).toMatchObject(
      { scan: 'off', unscanned: 'accepted' },
    );
  });

  it('refuses to authorise a file at all when the policy needs a scanner there is not', async () => {
    const { token } = await published('require-noscanner');
    const responseId = await startResponse(token);
    // `beforeEach` leaves CLAMD_HOST unset, so this policy cannot be satisfied here.
    env.ATTACHMENT_SCAN_POLICY = 'require';

    const refused = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(refused.statusCode, refused.body).toBe(503);
    expect((refused.json() as { error: string }).error).toBe('scan_required');

    // Refused before a credential existed: nothing to upload to, and no `pending` row
    // left waiting for bytes that could never become an answer. The page is told the
    // same thing up front, so it does not offer a control that would fail on use.
    expect(await attachmentRows(responseId)).toEqual([]);
    expect(objects.size).toBe(0);

    const resolved = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    const capability = (resolved.json() as { attachments: { enabled: boolean; scan: string; unscanned: string } })
      .attachments;
    expect(capability.enabled).toBe(false);
    expect(capability.scan).toBe('off');
    expect(capability.unscanned).toBe('refused');
  });

  /* --------------------------------------------------- 5. ownership, retries */

  it('does not attach a file to another token\u2019s response', async () => {
    const first = await published('owner-a');
    const second = await published('owner-b');
    const mine = await startResponse(first.token);
    const theirs = await startResponse(second.token);

    // My link, somebody else's response.
    const crossed = await authorise(first.token, theirs, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(crossed.statusCode, crossed.body).toBe(404);
    expect((crossed.json() as { error: string }).error).toBe('not_found');

    // And the other direction, which is the same rule.
    const crossedBack = await authorise(second.token, mine, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(crossedBack.statusCode, crossedBack.body).toBe(404);

    // Nothing was written anywhere, and nothing is readable from either side.
    expect(await attachmentRows(mine)).toEqual([]);
    expect(await attachmentRows(theirs)).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it('refuses a new attachment once the response has been submitted', async () => {
    const { token } = await published('submitted');
    const responseId = await startResponse(token);

    const done = await submit(token, responseId, { consent: 'yes', score: 5 });
    expect(done.statusCode, done.body).toBe(200);

    const late = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(late.statusCode, late.body).toBe(409);
    expect((late.json() as { error: string }).error).toBe('already_submitted');
    expect(await attachmentRows(responseId)).toEqual([]);
  });

  it('completes an upload once, however many times it is asked', async () => {
    const { token } = await published('retry');
    const responseId = await startResponse(token);

    const first = await attach(token, responseId);
    expect(first.statusCode, JSON.stringify(first.completeBody)).toBe(200);

    // A device that lost the answer to the first completion retries it. It must get
    // the same answer rather than a second write — and the second call must not
    // hash, scan or delete anything again.
    const again = await complete(token, responseId, first.attachmentId);
    expect(again.statusCode, again.body).toBe(200);
    const body = again.json() as { alreadyComplete?: boolean; scanStatus: string; attachmentId: string };
    expect(body.alreadyComplete).toBe(true);
    expect(body.scanStatus).toBe('skipped');
    expect(body.attachmentId).toBe(first.attachmentId);
    expect(await attachmentRows(responseId)).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it('refuses a submission whose answer names a file the server never accepted', async () => {
    const { token } = await published('notready');
    const responseId = await startResponse(token);

    // An attachment that was authorised and never uploaded: the reference exists on
    // the device and the bytes do not exist anywhere.
    const authorised = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    const { attachmentId } = authorised.json() as Authorised;

    const submitted = await submit(token, responseId, { consent: 'yes', score: 5, photo: attachmentId });
    expect(submitted.statusCode, submitted.body).toBe(422);
    const refusal = submitted.json() as { error: string; message: string };
    expect(refusal.error).toBe('attachment_not_ready');
    // The refusal names the question, so the device knows which answer to reopen.
    expect(refusal.message).toContain('photo');

    // The response is untouched: a refused submission must not half-write itself.
    // `adminQuery` returns the rows themselves, not a result object: destructuring
    // `.rows` off an array yields undefined, which read as a TypeError rather than
    // as the assertion this test is making.
    const rows = await adminQuery<{ status: string }>(
      `SELECT status FROM response WHERE id = $1`,
      [responseId],
    );
    expect(rows[0]!.status).toBe('in_progress');

    // Once the file really is there, the same submission goes through.
    const uploaded = await fetch((authorised.json() as Authorised).uploadUrl, {
      method: 'PUT',
      headers: (authorised.json() as Authorised).headers,
      body: new Uint8Array(Buffer.from('a photograph, honest')),
    });
    expect(uploaded.status, refusals.join('; ')).toBe(200);
    const completed = await complete(token, responseId, attachmentId);
    expect(completed.statusCode, completed.body).toBe(200);

    const accepted = await submit(token, responseId, { consent: 'yes', score: 5, photo: attachmentId });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  /* ------------------------------------------------------ 6. the store wins */

  it('records the size and hash the store measured, not the ones the client declared', async () => {
    const { token } = await published('measured');
    const responseId = await startResponse(token);
    const body = Buffer.from('a photograph, honest');

    const authorised = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      // A lie that is inside the ceiling: the row must still hold the truth.
      sizeBytes: 5,
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    const payload = authorised.json() as Authorised;

    const uploaded = await fetch(payload.uploadUrl, {
      method: 'PUT',
      headers: payload.headers,
      body: new Uint8Array(body),
    });
    expect(uploaded.status, refusals.join('; ')).toBe(200);

    const done = await complete(token, responseId, payload.attachmentId);
    expect(done.statusCode, done.body).toBe(200);
    const result = done.json() as { sizeBytes: number; sha256: string; filename: string };
    expect(result.sizeBytes).toBe(body.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    // The name the person chose is kept for the human; the key is the sanitised one.
    expect(result.filename).toBe('photo.jpg');

    const rows = await attachmentRows(responseId);
    expect(rows[0]!.size_bytes).toBe(body.byteLength);
    expect(rows[0]!.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  /* ------------------------------- the key the rest of the platform uses */

  it('accepts the question key the answers are stored under, when an id and a name differ', async () => {
    // Every definition this platform ships labels a question with a code-like `id`
    // (`q_photo`) and a `name` (`photo`), and it is the **name** that the rest of
    // the platform stores an answer under: `planSync` keys `values` and
    // `response_answer.question_id` by name, and the console reads them back the
    // same way. An attachment therefore has to travel on that key, or the file and
    // the answer it belongs to can never be joined — and a submission could carry
    // a file the server never accepted.
    const { token } = await published('keys', differingKeys);
    const responseId = await startResponse(token);

    const res = await authorise(token, responseId, {
      questionId: 'photo',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
    });
    // EXPECTED TO FAIL until the route looks the question up by the same key the
    // answers use. Today it matches `question.id` only, so `photo` is 404
    // `unknown_question` while `q_photo` would be accepted and stored under a key
    // no answer ever carries.
    expect(res.statusCode, res.body).toBe(201);
  });
});
