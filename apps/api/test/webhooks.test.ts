import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { drainOrg } from '../src/platform/webhooks/dispatch.js';
import { createOrgFor, signInPlatform, uniqueEmail, type PlatformSession } from './helpers/fixtures.js';

/**
 * Webhooks, end to end, with the receiver stubbed and everything else real.
 *
 * `fetch` is replaced for the whole file, so a delivery is a fact we can inspect:
 * the URL, the headers, the signature and the body. What the stub returns decides
 * whether the queue records a success or schedules a retry, which is how the
 * retry/backoff behaviour is asserted without waiting two hours.
 *
 * What is deliberately *not* stubbed: the enqueue transaction, the RLS-scoped read
 * of what is due, the outcome bookkeeping and the endpoint's failure counter. Those
 * are the parts that are hard to get right.
 */

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let captured: Captured[] = [];
let responder: () => { status: number; body: string } = () => ({ status: 200, body: 'ok' });
/** When set, the receiver is unreachable rather than answering badly. */
let transportError: string | null = null;

beforeAll(async () => {
  // Typed from `fetch` itself rather than from the DOM's `RequestInfo`/`RequestInit`:
  // the API package is Node-only and has no DOM lib, and the global's own signature is
  // the thing being replaced.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: String(init?.body ?? ''),
    });
    if (transportError) throw new Error(transportError);
    const answer = responder();
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  captured = [];
  transportError = null;
  responder = () => ({ status: 200, body: 'ok' });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const definition = {
  title: 'Webhook form',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
  ],
  choiceLists: {},
};

interface Scenario {
  owner: PlatformSession;
  orgId: string;
  formId: string;
  versionId: string;
}

/** An organisation with a draft form: nothing is published until a test says so. */
async function scenario(prefix: string): Promise<Scenario> {
  const owner = await signInPlatform(app, uniqueEmail(prefix));
  const orgId = await createOrgFor(app, owner, `${prefix} org`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: owner.cookie },
    payload: { orgId, name: `${prefix} form`, definition },
  });
  expect(created.statusCode, created.body).toBe(201);
  const body = created.json() as { form: { id: string }; version: { id: string } };
  return { owner, orgId, formId: body.form.id, versionId: body.version.id };
}

async function addEndpoint(
  scenario: Scenario,
  events: string[],
  url = 'https://receiver.test/hook',
): Promise<{ id: string; secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${scenario.orgId}/webhooks`,
    headers: { cookie: scenario.owner.cookie },
    payload: { url, events, description: 'test receiver' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { endpoint: { id: string }; secret: string };
  return { id: body.endpoint.id, secret: body.secret };
}

async function deliveries(scenario: Scenario, endpointId: string, limit = 50) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${scenario.orgId}/webhooks/${endpointId}/deliveries?limit=${limit}`,
    headers: { cookie: scenario.owner.cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { deliveries: Array<Record<string, unknown>> }).deliveries;
}

async function publish(scenario: Scenario): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/forms/${scenario.formId}/versions/${scenario.versionId}/publish`,
    headers: { cookie: scenario.owner.cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('webhook endpoints', () => {
  it('returns the signing secret exactly once and never in a read response', async () => {
    const s = await scenario('hooks-secret');
    const { id, secret } = await addEndpoint(s, ['form.published']);
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: s.owner.cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const endpoints = (list.json() as { endpoints: Array<Record<string, unknown>> }).endpoints;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ id, url: 'https://receiver.test/hook', active: true });
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('whsec_');

    // It is stored rather than hashed, because signing needs the key itself. That
    // is the one credential in the schema with that property, and the response
    // hygiene above is the whole defence.
    const rows = await adminQuery<{ secret: string }>(`SELECT secret FROM webhook WHERE id = $1`, [id]);
    expect(rows[0]!.secret).toBe(secret);
  });

  it('refuses a plaintext receiver and a subscription with no events', async () => {
    const s = await scenario('hooks-validate');

    const insecure = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: s.owner.cookie },
      payload: { url: 'http://receiver.test/hook', events: ['form.published'] },
    });
    expect(insecure.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: s.owner.cookie },
      payload: { url: 'https://receiver.test/hook', events: [] },
    });
    expect(empty.statusCode).toBe(400);

    const unknownEvent = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: s.owner.cookie },
      payload: { url: 'https://receiver.test/hook', events: ['form.exploded'] },
    });
    expect(unknownEvent.statusCode).toBe(400);
  });

  it('enqueues one delivery per subscribed endpoint, in the publish transaction, and none for the others', async () => {
    const s = await scenario('hooks-publish');
    const watcher = await addEndpoint(s, ['form.published']);
    const bystander = await addEndpoint(s, ['response.submitted'], 'https://other.test/hook');

    await publish(s);

    const watched = await deliveries(s, watcher.id);
    expect(watched).toHaveLength(1);
    expect(watched[0]).toMatchObject({ event: 'form.published', status: 'pending', attempts: 0 });
    expect((watched[0]!.payload as { data: { formId: string } }).data.formId).toBe(s.formId);

    expect(await deliveries(s, bystander.id)).toHaveLength(0);
  });

  it('enqueues response.submitted when a respondent submits through a public link', async () => {
    const s = await scenario('hooks-submit');
    const endpoint = await addEndpoint(s, ['response.submitted']);
    await publish(s);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${s.formId}/links`,
      headers: { cookie: s.owner.cookie },
      payload: { kind: 'anonymous' },
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = (link.json() as { token: string }).token;

    const clientId = crypto.randomUUID();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { clientId },
    });
    expect(started.statusCode, started.body).toBe(201);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${clientId}/submit`,
      payload: { answers: { consent: 'yes', score: 5 } },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    // The event row is written in the submission's own transaction, so its presence
    // here is the guarantee — delivery itself is the drain's job and is driven
    // deterministically by the tests below rather than raced against here.
    const rows = await deliveries(s, endpoint.id);
    const submittedEvents = rows.filter((row) => row.event === 'response.submitted');
    expect(submittedEvents).toHaveLength(1);
    const payload = submittedEvents[0]!.payload as { data: { responseId: string; status: string } };
    expect(payload.data.responseId).toBe(clientId);
    expect(payload.data.status).toBe('submitted');
  });

  it('signs a delivery so a receiver can verify it without a shared clock or a shared secret leak', async () => {
    const s = await scenario('hooks-sign');
    const { id, secret } = await addEndpoint(s, ['form.published']);
    await publish(s);

    const tally = await drainOrg(s.owner.userId, s.orgId);
    expect(tally.delivered).toBe(1);
    expect(captured).toHaveLength(1);

    const request = captured[0]!;
    expect(request.url).toBe('https://receiver.test/hook');

    const rows = await deliveries(s, id);
    const deliveryId = String(rows[0]!.id);
    const timestamp = request.headers['x-inicio-timestamp']!;
    const expected = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.${request.body}`, 'utf8')
      .digest('hex')}`;

    expect(request.headers['x-inicio-signature']).toBe(expected);
    expect(request.headers['x-inicio-delivery']).toBe(deliveryId);
    expect(request.headers['x-inicio-event']).toBe('form.published');
    expect(request.headers['content-type']).toBe('application/json');

    // The signed material must cover the timestamp, or an old validly-signed body
    // replays forever.
    const forged = `sha256=${createHmac('sha256', secret).update(request.body, 'utf8').digest('hex')}`;
    expect(request.headers['x-inicio-signature']).not.toBe(forged);

    const payload = JSON.parse(request.body) as { id: string; event: string; organisation: string; data: unknown };
    expect(payload.event).toBe('form.published');
    expect(payload.organisation).toBe(s.orgId);
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.data).toBeTruthy();
  });

  it('records a success, and schedules a retry with a growing delay when the receiver fails', async () => {
    const s = await scenario('hooks-retry');
    const { id } = await addEndpoint(s, ['form.published']);
    await publish(s);

    // A receiver that is *unreachable* is a different fact from one that answers
    // 500: the first has no status and keeps the reason in `error`, the second is
    // recorded by status. Both must schedule a retry.
    transportError = 'ECONNREFUSED: the receiver is not listening';
    const failed = await drainOrg(s.owner.userId, s.orgId);
    expect(failed.retrying).toBe(1);

    const afterFailure = (await deliveries(s, id))[0]!;
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1, response_status: null });
    expect(String(afterFailure.error)).toContain('ECONNREFUSED');
    expect(new Date(String(afterFailure.next_attempt_at)).getTime()).toBeGreaterThan(Date.now());

    // The receiver comes back: the same delivery id is retried and marked delivered.
    transportError = null;
    responder = () => ({ status: 201, body: 'thanks' });
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks/deliveries/${afterFailure.id}/retry`,
      headers: { cookie: s.owner.cookie },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect((retried.json() as { drained: { delivered: number } }).drained.delivered).toBe(1);

    const afterSuccess = (await deliveries(s, id))[0]!;
    expect(afterSuccess).toMatchObject({ status: 'delivered', response_status: 201, attempts: 1 });
    expect(afterSuccess.delivered_at).not.toBeNull();

    const endpointRow = await adminQuery<{ failure_count: number; last_success_at: Date | null }>(
      `SELECT failure_count, last_success_at FROM webhook WHERE id = $1`,
      [id],
    );
    expect(endpointRow[0]!.failure_count).toBe(0);
    expect(endpointRow[0]!.last_success_at).not.toBeNull();
  });

  it('gives up after five attempts and leaves the failure visible', async () => {
    const s = await scenario('hooks-giveup');
    const { id } = await addEndpoint(s, ['form.published']);
    await publish(s);

    responder = () => ({ status: 503, body: 'still down' });
    const first = await drainOrg(s.owner.userId, s.orgId);
    expect(first.retrying).toBe(1);

    // The backoff is real (an hour by the fifth attempt), so the clock is rewound
    // between attempts rather than the schedule being weakened for the test.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await adminQuery(`UPDATE webhook_delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [
        (await deliveries(s, id))[0]!.id,
      ]);
      await drainOrg(s.owner.userId, s.orgId);
    }

    const final = (await deliveries(s, id))[0]!;
    expect(final).toMatchObject({ status: 'failed', attempts: 5, response_status: 503 });

    // Failed is terminal for the queue: another drain does not pick it up.
    const idle = await drainOrg(s.owner.userId, s.orgId);
    expect(idle.attempted).toBe(0);

    const endpointRow = await adminQuery<{ failure_count: number }>(
      `SELECT failure_count FROM webhook WHERE id = $1`,
      [id],
    );
    expect(endpointRow[0]!.failure_count).toBe(5);
  });

  it('sends a test event and waits for the receiver to answer', async () => {
    const s = await scenario('hooks-test');
    const { id } = await addEndpoint(s, ['form.published']);

    const ping = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}/test`,
      headers: { cookie: s.owner.cookie },
    });
    expect(ping.statusCode, ping.body).toBe(200);
    expect(ping.json()).toMatchObject({ delivered: true, status: 200 });

    responder = () => ({ status: 404, body: 'no such route' });
    const broken = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}/test`,
      headers: { cookie: s.owner.cookie },
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ delivered: false, status: 404 });

    // Both attempts are in the history, including the failing one.
    const rows = await deliveries(s, id);
    expect(rows.filter((row) => row.event === 'webhook.test')).toHaveLength(2);
  });

  it('lets a member read endpoints and delivery history but not change an endpoint', async () => {
    const s = await scenario('hooks-roles');
    const { id } = await addEndpoint(s, ['form.published']);

    const memberEmail = uniqueEmail('hooks-member');
    const invited = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${s.orgId}/members`,
      headers: { cookie: s.owner.cookie },
      payload: { email: memberEmail, role: 'member' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const member = await signInPlatform(app, memberEmail);

    const readable = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: member.cookie },
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect((readable.json() as { endpoints: unknown[] }).endpoints).toHaveLength(1);

    const deliveryList = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}/deliveries`,
      headers: { cookie: member.cookie },
    });
    expect(deliveryList.statusCode, deliveryList.body).toBe(200);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}`,
      headers: { cookie: member.cookie },
      payload: { active: false },
    });
    expect(patched.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}`,
      headers: { cookie: member.cookie },
    });
    expect(deleted.statusCode).toBe(403);
  });

  it('re-enables an endpoint with a cleared failure history', async () => {
    const s = await scenario('hooks-reenable');
    const { id } = await addEndpoint(s, ['form.published']);

    // Drive it to the auto-disable cap: twenty-five consecutive failures, which is
    // the number where retrying forever stops being diligence.
    await adminQuery(
      `UPDATE webhook SET failure_count = 25, active = false, disabled_at = now() WHERE id = $1`,
      [id],
    );

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${s.orgId}/webhooks`,
      headers: { cookie: s.owner.cookie },
    });
    const disabled = (listed.json() as { endpoints: Array<Record<string, unknown>> }).endpoints[0]!;
    expect(disabled.active).toBe(false);
    expect(String(disabled.reason)).toContain('consecutive failures');

    const reenabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${s.orgId}/webhooks/${id}`,
      headers: { cookie: s.owner.cookie },
      payload: { active: true },
    });
    expect(reenabled.statusCode, reenabled.body).toBe(200);
    expect(reenabled.json()).toMatchObject({ endpoint: { active: true, failureCount: 0, disabledAt: null } });
  });
});
