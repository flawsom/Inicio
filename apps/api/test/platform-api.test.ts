import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildApp } from '../src/app.js';
import { PRIVACY, TERMS } from '../src/legal/documents.js';
import { Client } from 'pg';
import { readLiveOtp, uniqueEmail } from './helpers/fixtures.js';
import type { FormDefinition } from '@inicio/engine';

/**
 * End-to-end through the real HTTP surface and the real database, as a
 * non-superuser role with RLS enabled. Nothing here stubs the tenant boundary:
 * the isolation assertions are made against PostgreSQL, which is the only place
 * isolation is actually enforced.
 */

const validDefinition: FormDefinition = {
  title: 'Pulse check 2026',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true, choices: { listName: 'yesno' } },
    { id: 'q_reason', name: 'reason', type: 'text', label: { en: 'Why not' }, rules: { visibleIf: "${consent} = 'no'" } },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true, validation: { constraint: '. >= 0 and . <= 10', message: { en: 'Between 0 and 10' } } },
  ],
  choiceLists: { yesno: [{ value: 'yes', label: { en: 'Yes' } }, { value: 'no', label: { en: 'No' } }] },
};

const brokenDefinition: FormDefinition = {
  ...validDefinition,
  questions: [
    ...validDefinition.questions,
    { id: 'q_ghost', name: 'ghosted', type: 'text', label: { en: 'Ghost' }, rules: { visibleIf: '${nowhere} = 1' } },
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

interface Session {
  cookie: string;
  userId: string;
  email: string;
}

async function signIn(email: string): Promise<Session> {
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { email },
  });
  expect(requested.statusCode, requested.body).toBe(200);
  // The API no longer echoes codes; tests read what was actually issued.
  const code = await readLiveOtp(email);
  if (!code) throw new Error(`no live OTP for ${email}: ${requested.body}`);

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { email, code },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

  // A real account cannot use anything until it accepts the current terms, so
  // the helper does what a person does: tick the box and continue.
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/terms/accept',
    headers: { cookie },
    payload: { termsVersion: TERMS.version, privacyVersion: PRIVACY.version, accepted: true },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  expect(me.statusCode).toBe(200);
  return { cookie, userId: (me.json() as { user: { id: string } }).user.id, email };
}

async function createOrg(session: Session, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    headers: { cookie: session.cookie },
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { organisation: { id: string } }).organisation.id;
}

async function createForm(session: Session, orgId: string, name: string, definition: unknown): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/forms',
    headers: { cookie: session.cookie },
    payload: { orgId, name, definition },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { form: { id: string } }).form.id;
}

describe('platform sign-in', () => {
  it('signs up an unknown email, signs it in, and reports organisations', async () => {
    const session = await signIn(`owner-${Date.now()}@example.com`);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: session.cookie } });
    const body = me.json() as { user: { id: string; email: string }; organisations: unknown[] };
    expect(body.user.id).toBe(session.userId);
    expect(body.user.email).toBe(session.email);
    expect(body.organisations).toEqual([]);
  });

  it('rejects a signed-out caller and refuses a non-user session subject', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('says plainly when email cannot be delivered instead of claiming it was sent', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/mail-status' });
    expect(status.statusCode).toBe(200);
    const mail = status.json() as { reachable: boolean; basis: string; detail?: string };
    // There is no SMTP server in the test environment, and the API says so.
    expect(mail.reachable).toBe(false);
    expect(mail.basis).toBe('smtp-verify');
    // The public reply says whether, not why: the relay and the provider's own
    // error text are behind the administrator's console.
    expect(mail.detail).toBeUndefined();
    // The dev echo is gone for good: the API offers no on-screen shortcut into
    // an inbox that does not exist.
    expect('echoesCodes' in mail).toBe(false);

    const email = uniqueEmail('mail');
    const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
    expect(requested.statusCode).toBe(200);
    const body = requested.json() as {
      status: string;
      mail: { reachable: boolean; detail?: string; host?: string; from?: string };
      delivery: { ok: boolean; detail: string };
    };
    // "not_delivered", not a reassuring "sent" that never arrives.
    expect(body.status).toBe('not_delivered');
    expect(body.mail.reachable).toBe(false);
    // The anonymous reply carries no relay, transport or provider detail, and
    // the delivery verdict itself reaches only the signed in administrator.
    expect(body.mail.detail).toBeUndefined();
    expect(body.mail.host).toBeUndefined();
    expect(body.mail.from).toBeUndefined();
    expect(body.delivery.ok).toBe(false);
    // And no code is ever handed back to the client — signing in requires the
    // email that never arrived, which is the honest answer here.
    // Read superuser-side: RLS hides unverified users from the app role, and
    // the assertion here is about issuance, not visibility.
    const admin = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.connect();
    const issued = await admin.query<{ consumed: boolean }>(
      `SELECT o.consumed
         FROM user_otp o JOIN app_user u ON u.id = o.user_id
        WHERE u.email = $1::citext`,
      [email],
    );
    await admin.end();
    expect(issued.rows[0]!.consumed).toBe(false);

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { email, code: '000000' },
    });
    expect(verified.statusCode, verified.body).toBe(401);
  });

  it('does not accept a wrong code, and never reveals whether the account existed', async () => {
    const email = `wr-${Date.now()}@example.com`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { email, code: '000000' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: 'invalid_otp' });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { email: `nobody-${Date.now()}@example.com`, code: '123456' },
    });
    expect(unknown.statusCode).toBe(401);
  });
});

describe('organisations and the roster', () => {
  it('creates an organisation, invites a teammate, and lists live counts', async () => {
    const owner = await signIn(`owner2-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Field Research Co');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie: owner.cookie } });
    const organisations = (listed.json() as { organisations: Array<{ id: string; role: string; member_count: number }> }).organisations;
    expect(organisations).toHaveLength(1);
    expect(organisations[0]).toMatchObject({ id: orgId, role: 'owner', member_count: 1 });

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { cookie: owner.cookie },
      payload: { email: `viewer-${Date.now()}@example.com`, role: 'viewer' },
    });
    expect(invite.statusCode, invite.body).toBe(201);

    const members = await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/members`, headers: { cookie: owner.cookie } });
    expect((members.json() as { members: unknown[] }).members).toHaveLength(2);
  });

  it('refuses to remove the last owner', async () => {
    const owner = await signIn(`owner3-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Solo Org');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/members/${owner.userId}`,
      headers: { cookie: owner.cookie },
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toMatchObject({ error: 'last_owner' });
  });
});

describe('cross-organisation isolation over HTTP', () => {
  it('hides another organisation’s form, refuses its creation, and never leaks its rows', async () => {
    const owner = await signIn(`iso-owner-${Date.now()}@example.com`);
    const outsider = await signIn(`iso-outsider-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Private Org');
    const formId = await createForm(owner, orgId, 'Confidential survey', validDefinition);

    // Reading somebody else's form is a 404: whether it exists is not the outsider's business.
    const peek = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: outsider.cookie } });
    expect(peek.statusCode).toBe(404);

    // The list is empty rather than filtered client-side.
    const mine = await app.inject({ method: 'GET', url: '/api/v1/forms', headers: { cookie: outsider.cookie } });
    expect((mine.json() as { forms: unknown[] }).forms).toEqual([]);

    // Forging org_id is refused by the database, not by a route-level check.
    const forge = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: outsider.cookie },
      payload: { orgId, name: 'Sneaky', definition: validDefinition },
    });
    expect(forge.statusCode).toBe(403);
    expect(forge.json()).toMatchObject({ error: 'forbidden' });

    // Nor can the outsider manage the roster or read the org.
    const orgRead = await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}`, headers: { cookie: outsider.cookie } });
    expect(orgRead.statusCode).toBe(404);
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { cookie: outsider.cookie },
      payload: { email: outsider.email, role: 'owner' },
    });
    expect(invite.statusCode).toBe(404);

    // And responses are not readable either.
    const responses = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses`,
      headers: { cookie: outsider.cookie },
    });
    expect(responses.statusCode).toBe(404);

    // The owner still sees everything: the isolation is not a blanket denial.
    const ownerSees = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    expect(ownerSees.statusCode).toBe(200);
  });

  it('lets a viewer read and export but not edit', async () => {
    const owner = await signIn(`viewer-owner-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Viewer Org');
    const formId = await createForm(owner, orgId, 'Read only', validDefinition);

    const viewerEmail = `viewer-${Date.now()}@example.com`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { cookie: owner.cookie },
      payload: { email: viewerEmail, role: 'viewer' },
    });
    const viewer = await signIn(viewerEmail);

    const read = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: viewer.cookie } });
    expect(read.statusCode).toBe(200);
    const versionId = (read.json() as { versions: Array<{ id: string }> }).versions[0]!.id;

    const edit = await app.inject({
      method: 'PUT',
      url: `/api/v1/forms/${formId}/versions/${versionId}`,
      headers: { cookie: viewer.cookie },
      payload: { definition: validDefinition },
    });
    expect(edit.statusCode, edit.body).toBe(403);
    expect(edit.json()).toMatchObject({ error: 'forbidden' });
  });
});

describe('authoring, publishing and the XLSForm round trip', () => {
  it('blocks publishing an unanalysable definition and allows a valid one', async () => {
    const owner = await signIn(`pub-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Publishing Org');
    const formId = await createForm(owner, orgId, 'Broken then fixed', validDefinition);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;

    const saveBroken = await app.inject({
      method: 'PUT',
      url: `/api/v1/forms/${formId}/versions/${versionId}`,
      headers: { cookie: owner.cookie },
      payload: { definition: brokenDefinition },
    });
    expect(saveBroken.statusCode, saveBroken.body).toBe(200);
    // Saving a half-built form is normal; the errors come back for the builder to show.
    expect((saveBroken.json() as { errors: string[] }).errors.join(' ')).toMatch(/unknown question/);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
      headers: { cookie: owner.cookie },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: 'invalid_definition' });

    await app.inject({
      method: 'PUT',
      url: `/api/v1/forms/${formId}/versions/${versionId}`,
      headers: { cookie: owner.cookie },
      payload: { definition: validDefinition },
    });
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
      headers: { cookie: owner.cookie },
    });
    expect(published.statusCode, published.body).toBe(200);
    expect((published.json() as { version: { status: string } }).version.status).toBe('published');
  });

  it('keeps a published version immutable and restores it as a new draft', async () => {
    const owner = await signIn(`imm-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Immutable Org');
    const formId = await createForm(owner, orgId, 'Frozen', validDefinition);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;
    await app.inject({ method: 'POST', url: `/api/v1/forms/${formId}/versions/${versionId}/publish`, headers: { cookie: owner.cookie } });

    const rewrite = await app.inject({
      method: 'PUT',
      url: `/api/v1/forms/${formId}/versions/${versionId}`,
      headers: { cookie: owner.cookie },
      payload: { definition: { ...validDefinition, title: 'Rewritten' } },
    });
    expect(rewrite.statusCode).toBe(409);
    expect(rewrite.json()).toMatchObject({ error: 'version_immutable' });

    const restore = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/versions/${versionId}/restore`,
      headers: { cookie: owner.cookie },
    });
    expect(restore.statusCode, restore.body).toBe(201);
    const restored = (restore.json() as { version: { version: number; status: string } }).version;
    expect(restored.status).toBe('draft');
    expect(restored.version).toBeGreaterThan(1);
  });

  it('exports XLSForm and re-imports it into a new form without loss', async () => {
    const owner = await signIn(`xlsform-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Spreadsheet Org');
    const formId = await createForm(owner, orgId, 'Round trip', validDefinition);

    const downloaded = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/xlsform`, headers: { cookie: owner.cookie } });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.headers['content-type']).toMatch(/spreadsheetml/);
    const base64 = Buffer.from(downloaded.rawPayload).toString('base64');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { orgId, name: 'Imported', xlsformBase64: base64 },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedDefinition = (imported.json() as { version: { definition: FormDefinition } }).version.definition;

    // The canonical model survives the trip: same questions, same logic, same labels.
    expect(importedDefinition.questions.map((q) => q.name)).toEqual(validDefinition.questions.map((q) => q.name));
    expect(importedDefinition.questions.map((q) => q.type)).toEqual(validDefinition.questions.map((q) => q.type));
    expect(importedDefinition.questions[1]?.rules?.visibleIf).toBe("${consent} = 'no'");
    expect(importedDefinition.questions[2]?.validation?.constraint).toBe('. >= 0 and . <= 10');
    expect(importedDefinition.choiceLists['yesno']?.map((c) => c.value)).toEqual(['yes', 'no']);
    // Nothing was dropped on the way through the spreadsheet — that is the point of
    // the passthrough. Normalisation notes (yes/no encoding, say) are expected.
    const notes = (imported.json() as { notes: Array<{ kind: string; message: string }> }).notes;
    expect(notes.filter((n) => n.kind === 'dropped')).toEqual([]);
  });
});

describe('collection, live data and exports', () => {
  interface Scenario {
    owner: Session;
    formId: string;
    token: string;
  }

  async function publishFreshForm(prefix: string): Promise<Scenario> {
    const owner = await signIn(`${prefix}-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, `${prefix} org`);
    const formId = await createForm(owner, orgId, 'Field collection', validDefinition);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
      headers: { cookie: owner.cookie },
    });
    expect(publish.statusCode, publish.body).toBe(200);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'anonymous', label: 'public' },
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = (link.json() as { token: string }).token;
    return { owner, formId, token };
  }

  it('serves the published form from a bearer token without any session', async () => {
    const { formId, token } = await publishFreshForm('collect');
    const served = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(served.statusCode, served.body).toBe(200);
    const payload = served.json() as { form: { id: string; definition: FormDefinition }; link: { kind: string } };
    expect(payload.form.id).toBe(formId);
    expect(payload.link.kind).toBe('anonymous');
    expect(payload.form.definition.questions).toHaveLength(3);
  });

  it('does not serve an unknown token, and never exposes the token itself', async () => {
    const { owner, formId } = await publishFreshForm('token');
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/collect/not-a-real-token' });
    expect(unknown.statusCode).toBe(404);

    const listed = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/links`, headers: { cookie: owner.cookie } });
    const links = (listed.json() as { links: Array<Record<string, unknown>> }).links;
    expect(links).toHaveLength(1);
    // Only the hash is stored, so the token cannot be recovered — not even by the owner.
    expect(Object.keys(links[0]!)).not.toContain('token');
    expect(Object.keys(links[0]!)).not.toContain('token_hash');
  });

  it('tells a respondent the survey is not open when nothing is published', async () => {
    const owner = await signIn(`unpublished-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Unpublished org');
    const formId = await createForm(owner, orgId, 'Not ready', validDefinition);

    // The console warns before handing out a link, but the API still lets one
    // exist. Opening it must be a clear, non-technical dead end for the person
    // holding it, not a 500 and not an authoring concept leaking through.
    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'anonymous' },
    });
    expect(link.statusCode, link.body).toBe(201);
    const token = (link.json() as { token: string }).token;

    const served = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(served.statusCode).toBe(409);
    expect(served.json()).toMatchObject({ error: 'not_published' });
    expect((served.json() as { message: string }).message).toMatch(/not open yet/i);
    expect((served.json() as { message: string }).message).not.toMatch(/not_published|publish a version/i);

    // An unknown token is friendly too, and indistinguishable from a typo.
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/collect/definitely-not-a-token' });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { message: string }).message).toMatch(/not valid/i);
  });

  it('runs a full response lifecycle: partial save, blocked submit, submission, live analytics', async () => {
    const { owner, formId, token } = await publishFreshForm('lifecycle');

    const started = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: {} });
    expect(started.statusCode, started.body).toBe(201);
    const responseId = (started.json() as { responseId: string }).responseId;

    const partial = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collect/${token}/responses/${responseId}`,
      payload: { answers: { consent: 'yes' } },
    });
    expect(partial.statusCode, partial.body).toBe(200);
    expect((partial.json() as { missing: string[] }).missing).toContain('score');

    const resumed = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}/responses/${responseId}` });
    expect((resumed.json() as { answers: Record<string, unknown> }).answers).toMatchObject({ consent: 'yes' });

    const incomplete = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'yes' } },
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json()).toMatchObject({ error: 'incomplete' });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'yes', score: 99 } },
    });
    expect(invalid.statusCode).toBe(422);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'yes', score: 7, reason: 'should be ignored: the question is hidden' } },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((submitted.json() as { status: string }).status).toBe('submitted');

    const doubleSubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'yes', score: 7 } },
    });
    expect(doubleSubmit.statusCode).toBe(409);

    // Live analytics: computed on request from the rows just written.
    const analytics = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/analytics`, headers: { cookie: owner.cookie } });
    expect(analytics.headers['cache-control']).toBe('private, no-store');
    const live = analytics.json() as { byStatus: Array<{ status: string; count: number }>; tallies: Array<{ question_id: string; count: number }> };
    expect(live.byStatus).toEqual([{ status: 'submitted', count: 1 }]);
    expect(live.tallies.some((t) => t.question_id === 'score')).toBe(true);

    const responses = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}/responses`, headers: { cookie: owner.cookie } });
    const stored = (responses.json() as { responses: Array<{ answers: Record<string, unknown> }> }).responses[0]!;
    // The server is the authority on logic: the hidden question is stored as null
    // rather than keeping an answer the respondent was never asked for.
    expect(stored.answers['reason']).toBeNull();
    expect(stored.answers['score']).toBe(7);
  });

  it('exports a real bundle whose data matches the responses, and refuses .sav honestly', async () => {
    const { owner, formId, token } = await publishFreshForm('export');
    const started = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: {} });
    const responseId = (started.json() as { responseId: string }).responseId;
    await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'no', reason: '=cmd|calc', score: 4 } },
    });

    const refused = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses/export?format=sav`,
      headers: { cookie: owner.cookie },
    });
    expect(refused.statusCode).toBe(501);
    expect(refused.json()).toMatchObject({ error: 'format_not_available' });

    const csv = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses/export?format=csv`,
      headers: { cookie: owner.cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toBe('application/zip');

    const files = unzipSync(new Uint8Array(csv.rawPayload));
    const names = Object.keys(files).sort();
    expect(names.some((n) => n.endsWith('data.csv'))).toBe(true);
    expect(names.some((n) => n.endsWith('codebook.csv'))).toBe(true);
    expect(names.some((n) => n.endsWith('missing.csv'))).toBe(true);

    // The metadata names the published version it descends from, including when
    // it went live: a null published_at used to make "published" and "never
    // published" look identical in the export.
    const meta = JSON.parse(strFromU8(files[names.find((n) => n.endsWith('meta.json'))!]!)) as {
      formVersion: number | null;
      publishedAt: string | null;
    };
    expect(meta.formVersion).toBeGreaterThan(0);
    expect(meta.publishedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(meta.publishedAt!))).toBe(false);

    const data = strFromU8(files[names.find((n) => n.endsWith('data.csv'))!]!);
    expect(data).toContain('response_id');
    expect(data).toContain(responseId);
    // The canonical data file keeps the raw value; the spreadsheet view is the one
    // that is sanitised, so the archive can carry both without corrupting either.
    expect(data).toContain('=cmd|calc');
    const safeName = names.find((n) => n.endsWith('spreadsheet-view.csv'))!;
    expect(strFromU8(files[safeName]!)).toContain('\t=cmd|calc');

    const xlsx = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses/export?format=xlsx`,
      headers: { cookie: owner.cookie },
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);

    const json = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses/export?format=json`,
      headers: { cookie: owner.cookie },
    });
    const parsed = JSON.parse(strFromU8(new Uint8Array(json.rawPayload))) as { data: Array<Record<string, unknown>> };
    expect(parsed.data[0]?.['score']).toBe(4);
    expect(parsed.data[0]?.['reason']).toBe('=cmd|calc');
  });

  it('honours a single-use link exactly once', async () => {
    const owner = await signIn(`single-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Single use org');
    const formId = await createForm(owner, orgId, 'One shot', validDefinition);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;
    await app.inject({ method: 'POST', url: `/api/v1/forms/${formId}/versions/${versionId}/publish`, headers: { cookie: owner.cookie } });

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'single_use' },
    });
    const token = (link.json() as { token: string }).token;

    const first = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: {} });
    const responseId = (first.json() as { responseId: string }).responseId;
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'yes', score: 1 } },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    expect((submit.json() as { status: string }).status).toBe('submitted');

    const second = await app.inject({ method: 'GET', url: `/api/v1/collect/${token}` });
    expect(second.statusCode).toBe(410);
    expect(second.json()).toMatchObject({ error: 'link_already_used' });
  });

  it('marks a response screened_out when a complete trigger fires', async () => {
    const owner = await signIn(`screen-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Screening org');
    const definition: FormDefinition = {
      ...validDefinition,
      // Qualtrics calls this an end-of-survey branch: the respondent completes the
      // flow early and is recorded as screened out rather than as a full response.
      triggers: [{ type: 'complete', when: "${consent} = 'no'" }],
    };
    const formId = await createForm(owner, orgId, 'Screened', definition);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/forms/${formId}`, headers: { cookie: owner.cookie } });
    const versionId = (detail.json() as { versions: Array<{ id: string }> }).versions[0]!.id;
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/versions/${versionId}/publish`,
      headers: { cookie: owner.cookie },
    });
    expect(publish.statusCode, publish.body).toBe(200);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${formId}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'panel' },
    });
    const token = (link.json() as { token: string }).token;

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses`,
      payload: { embedded: { pid: 'panel-123' } },
    });
    const responseId = (started.json() as { responseId: string }).responseId;
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: { answers: { consent: 'no', reason: 'not eligible', score: 2 } },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    expect((submit.json() as { status: string }).status).toBe('screened_out');

    const responses = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formId}/responses?status=screened_out`,
      headers: { cookie: owner.cookie },
    });
    expect((responses.json() as { responses: unknown[] }).responses).toHaveLength(1);
  });
});

describe('templates: the school ranking survey is content, not the product', () => {
  it('lists the starter templates', async () => {
    const owner = await signIn(`tpl-${Date.now()}@example.com`);
    const res = await app.inject({ method: 'GET', url: '/api/v1/templates', headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const templates = (res.json() as { templates: Array<{ id: string; questionCount: number }> }).templates;
    expect(templates.map((t) => t.id)).toContain('school-ranking-2026');
    expect(templates[0]?.questionCount).toBeGreaterThan(0);
  });

  it('creates a working form from the school ranking template and publishes it', async () => {
    const owner = await signIn(`tpl2-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Template Org');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { orgId, name: 'Ranking 2026', templateId: 'school-ranking-2026' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { form, version } = created.json() as { form: { id: string }; version: { id: string; definition: FormDefinition } };
    expect(version.definition.title).toBe('School Ranking Survey 2026');
    expect(version.definition.languages).toEqual(['en', 'hi']);

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${form.id}/versions/${version.id}/publish`,
      headers: { cookie: owner.cookie },
    });
    // A template that could not be published would be a broken template.
    expect(publish.statusCode, publish.body).toBe(200);

    // ...and it survives the trip out to a spreadsheet and back in.
    const exported = await app.inject({ method: 'GET', url: `/api/v1/forms/${form.id}/xlsform`, headers: { cookie: owner.cookie } });
    expect(exported.statusCode).toBe(200);
    const reimported = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: {
        orgId,
        name: 'Ranking 2026 (spreadsheet)',
        xlsformBase64: Buffer.from(exported.rawPayload).toString('base64'),
      },
    });
    expect(reimported.statusCode, reimported.body).toBe(201);
    const roundTripped = (reimported.json() as { version: { definition: FormDefinition } }).version.definition;
    expect(roundTripped.questions.map((q) => q.name)).toEqual(version.definition.questions.map((q) => q.name));
    expect(roundTripped.choiceLists['districts']?.find((c) => c.value === 'ka_blr')?.extra).toEqual({ state: 'ka' });
  });

  it('collects a real response against the template and computes the score server-side', async () => {
    const owner = await signIn(`tpl3-${Date.now()}@example.com`);
    const orgId = await createOrg(owner, 'Ranking Org');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { orgId, name: 'Ranking 2026', templateId: 'school-ranking-2026' },
    });
    const { form, version } = created.json() as { form: { id: string }; version: { id: string } };
    await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${form.id}/versions/${version.id}/publish`,
      headers: { cookie: owner.cookie },
    });
    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/forms/${form.id}/links`,
      headers: { cookie: owner.cookie },
      payload: { kind: 'anonymous' },
    });
    const token = (link.json() as { token: string }).token;

    const started = await app.inject({ method: 'POST', url: `/api/v1/collect/${token}/responses`, payload: {} });
    const responseId = (started.json() as { responseId: string }).responseId;
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/collect/${token}/responses/${responseId}/submit`,
      payload: {
        answers: {
          school_name: 'Govt Higher Primary School, Mysuru',
          school_type: 'govt',
          state: 'ka',
          district: 'ka_blr',
          enrolment: 412,
          teacher_quality: 4,
          infrastructure: 3,
          facilities: ['library', 'ramp'],
          // Ignored: the fee question is hidden for a government school.
          fee_annual: 99999,
          contact_name: 'Head Teacher',
          contact_phone: '9876543210',
        },
      },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    expect((submit.json() as { status: string }).status).toBe('submitted');

    const responses = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${form.id}/responses`,
      headers: { cookie: owner.cookie },
    });
    const stored = (responses.json() as { responses: Array<{ answers: Record<string, unknown> }> }).responses[0]!.answers;
    // The server re-evaluated the definition: the hidden fee is null and the
    // calculation is filled in even though the client never sent it.
    expect(stored['fee_annual']).toBeNull();
    expect(stored['composite_score']).toBe(70);
    expect(stored['facilities']).toEqual(['library', 'ramp']);

    // And the multi-select lands in the export as explicit 0/1 columns.
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${form.id}/responses/export?format=csv`,
      headers: { cookie: owner.cookie },
    });
    const files = unzipSync(new Uint8Array(exportRes.rawPayload));
    const dataName = Object.keys(files).find((n) => n.endsWith('data.csv'))!;
    const data = strFromU8(files[dataName]!);
    expect(data).toContain('facilities__library');
    expect(data).toContain('facilities__lab');
    expect(data).toContain('location_latitude');
    const row = data.split('\r\n').find((line) => line.includes('Govt Higher Primary School'))!;
    expect(row).toContain('70');
  });
});
