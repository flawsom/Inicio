import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { readLiveOtp, uniqueEmail } from './helpers/fixtures.js';
import { TERMS, PRIVACY } from '../src/legal/documents.js';

/**
 * The administration surface: invitations that work exactly once, roles that
 * cannot be escalated from below, and a terms gate that closes everything except
 * the route that satisfies it.
 */

let app: FastifyInstance;

interface Session {
  cookie: string;
  userId: string;
  email: string;
}

async function signIn(email: string): Promise<Session> {
  const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { email } });
  expect(requested.statusCode, requested.body).toBe(200);
  const code = await readLiveOtp(email);
  if (!code) throw new Error(`no live OTP for ${email}`);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { email, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  return { cookie, userId: (me.json() as { user: { id: string } }).user.id, email };
}

async function acceptTerms(cookie: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/terms/accept',
    headers: { cookie },
    payload: { termsVersion: TERMS.version, privacyVersion: PRIVACY.version, accepted: true },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function ownerWithOrg(): Promise<{ session: Session; orgId: string }> {
  const session = await signIn(uniqueEmail('admin-owner'));
  await acceptTerms(session.cookie);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/orgs',
    headers: { cookie: session.cookie },
    payload: { name: `Admin Org ${Date.now()}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  return { session, orgId: (created.json() as { organisation: { id: string } }).organisation.id };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('terms gate', () => {
  it('blocks everything else until the current terms are accepted, then opens', async () => {
    const session = await signIn(uniqueEmail('terms'));

    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/terms/status', headers: { cookie: session.cookie } });
    expect(status.json()).toMatchObject({ required: true, currentVersion: TERMS.version, acceptedVersion: null });

    // Authenticated, but not yet usable.
    const blocked = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie: session.cookie } });
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'terms_required' });

    // A half-hearted acceptance is not an acceptance.
    const notReally = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms/accept',
      headers: { cookie: session.cookie },
      payload: { termsVersion: TERMS.version, privacyVersion: PRIVACY.version, accepted: false },
    });
    expect(notReally.statusCode).toBe(400);

    // A stale version is refused rather than recorded.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/terms/accept',
      headers: { cookie: session.cookie },
      payload: { termsVersion: '1999-01-01', privacyVersion: PRIVACY.version, accepted: true },
    });
    expect(stale.statusCode).toBe(409);

    await acceptTerms(session.cookie);
    const opened = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie: session.cookie } });
    expect(opened.statusCode, opened.body).toBe(200);
  });

  it('stores acceptance as an append only event with the document hashes', async () => {
    const session = await signIn(uniqueEmail('evidence'));
    await acceptTerms(session.cookie);

    const admin = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.connect();
    const { rows } = await admin.query(
      `SELECT terms_version, terms_hash, privacy_version, privacy_hash, checkbox_text, ip, user_agent
         FROM terms_acceptance WHERE user_id = $1`,
      [session.userId],
    );
    await admin.end();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      terms_version: TERMS.version,
      terms_hash: TERMS.hash,
      privacy_version: PRIVACY.version,
      privacy_hash: PRIVACY.hash,
    });
    expect(String(rows[0]!.checkbox_text)).toContain('Terms of Service');
  });
});

describe('invitations', () => {
  it('creates a single use link, joins once, and refuses the second attempt', async () => {
    const { session, orgId } = await ownerWithOrg();
    const invited = uniqueEmail('invitee');

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: session.cookie },
      payload: { email: invited, role: 'member', expiresInDays: 7 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { url: string; singleUse: boolean; invite: { id: string; email: string } };
    expect(body.singleUse).toBe(true);
    const token = body.url.split('/invite/')[1]!;
    expect(token.length).toBeGreaterThan(30);

    // The listing never returns the token, only the state of the invitation.
    const listed = await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/invites`, headers: { cookie: session.cookie } });
    expect(listed.body).not.toContain(token);
    expect((listed.json() as { invites: Array<{ pending: boolean }> }).invites[0]!.pending).toBe(true);

    // Preview: a GET must not spend the invitation (mail scanners fetch links).
    const preview = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${token}` });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ invite: { email: invited, role: 'member' } });
    const previewAgain = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${token}` });
    expect(previewAgain.statusCode).toBe(200);

    // Redeem: joins, with a session, and the role from the invitation.
    const redeem = await app.inject({ method: 'POST', url: '/api/v1/auth/invite/redeem', payload: { token } });
    expect(redeem.statusCode, redeem.body).toBe(200);
    const joined = redeem.json() as { organisation: { id: string }; role: string; termsRequired: boolean };
    expect(joined.organisation.id).toBe(orgId);
    expect(joined.role).toBe('member');
    expect(joined.termsRequired).toBe(true);
    const inviteeCookie = String(redeem.headers['set-cookie']).split(';')[0] ?? '';

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: inviteeCookie } });
    expect((me.json() as { organisations: unknown[] }).organisations).toHaveLength(1);

    // Second use: gone, and indistinguishable from a link that never existed.
    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/invite/redeem', payload: { token } });
    expect(replay.statusCode).toBe(410);
    const afterUse = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${token}` });
    expect(afterUse.statusCode).toBe(404);
  });

  it('lets a member use the product but never reach the admin surface', async () => {
    const { session, orgId } = await ownerWithOrg();
    const invited = uniqueEmail('member');

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: session.cookie },
      payload: { email: invited, role: 'member' },
    });
    const token = (created.json() as { url: string }).url.split('/invite/')[1]!;
    const redeem = await app.inject({ method: 'POST', url: '/api/v1/auth/invite/redeem', payload: { token } });
    const memberCookie = String(redeem.headers['set-cookie']).split(';')[0] ?? '';
    await acceptTerms(memberCookie);

    // Can work.
    const own = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie: memberCookie } });
    expect(own.statusCode).toBe(200);

    // Cannot invite, cannot list invitations, cannot read the diagnostics, and
    // cannot promote itself.
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: memberCookie },
      payload: { email: uniqueEmail('sneaky'), role: 'owner' },
    });
    expect(invite.statusCode, invite.body).toBe(403);

    const list = await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/invites`, headers: { cookie: memberCookie } });
    expect(list.statusCode).toBe(403);

    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/diagnostics/mail`,
      headers: { cookie: memberCookie },
    });
    expect(diagnostics.statusCode).toBe(403);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: memberCookie } });
    const userId = (me.json() as { user: { id: string } }).user.id;
    const selfPromote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/members/${userId}`,
      headers: { cookie: memberCookie },
      payload: { role: 'owner' },
    });
    expect(selfPromote.statusCode, selfPromote.body).toBe(403);
  });

  it('refuses to leave an organisation without an owner', async () => {
    const { session, orgId } = await ownerWithOrg();
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/members/${session.userId}`,
      headers: { cookie: session.cookie },
      payload: { role: 'admin' },
    });
    expect(demote.statusCode, demote.body).toBe(409);
  });

  it('revokes an invitation so it can never be used', async () => {
    const { session, orgId } = await ownerWithOrg();
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: session.cookie },
      payload: { email: uniqueEmail('revoked') },
    });
    const body = created.json() as { url: string; invite: { id: string } };
    const token = body.url.split('/invite/')[1]!;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${body.invite.id}`,
      headers: { cookie: session.cookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    const preview = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${token}` });
    expect(preview.statusCode).toBe(404);
    const redeem = await app.inject({ method: 'POST', url: '/api/v1/auth/invite/redeem', payload: { token } });
    expect(redeem.statusCode).toBe(410);
  });

  it('issues a new link when the same address is invited again', async () => {
    const { session, orgId } = await ownerWithOrg();
    const invited = uniqueEmail('re-invite');
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: session.cookie },
      payload: { email: invited },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/invites`,
      headers: { cookie: session.cookie },
      payload: { email: invited, role: 'viewer' },
    });
    expect(second.statusCode, second.body).toBe(201);

    // The superseded link is dead, the newest one works, and it carries the
    // role from the latest invitation.
    const oldToken = (first.json() as { url: string }).url.split('/invite/')[1]!;
    const newToken = (second.json() as { url: string }).url.split('/invite/')[1]!;
    expect((await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${oldToken}` })).statusCode).toBe(404);

    const redeem = await app.inject({ method: 'POST', url: '/api/v1/auth/invite/redeem', payload: { token: newToken } });
    expect(redeem.statusCode, redeem.body).toBe(200);
    expect((redeem.json() as { role: string }).role).toBe('viewer');
  });
});

describe('legal documents', () => {
  it('serves the exact text and hash that acceptance refers to', async () => {
    const terms = await app.inject({ method: 'GET', url: '/api/v1/legal/terms' });
    expect(terms.statusCode).toBe(200);
    const doc = (terms.json() as { document: { version: string; hash: string; sections: unknown[] } }).document;
    expect(doc.version).toBe(TERMS.version);
    expect(doc.hash).toBe(TERMS.hash);
    expect(doc.sections.length).toBeGreaterThan(5);

    const privacy = await app.inject({ method: 'GET', url: '/api/v1/legal/privacy' });
    expect((privacy.json() as { document: { hash: string } }).document.hash).toBe(PRIVACY.hash);
  });
});
