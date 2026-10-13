import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { createOrgFor, signInPlatform, uniqueEmail, type PlatformSession } from './helpers/fixtures.js';

/**
 * API keys over the real HTTP surface.
 *
 * The interesting question about a machine credential is not "does it work" but
 * "what does it *not* reach", so most of what follows is a refusal: a route that
 * declares no scope, a scope the key does not carry, another organisation's path,
 * a key that has been revoked, a key whose owner is only a member. Each one is
 * asserted against the API as a caller would see it.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** Owner connection, for the two facts the API deliberately cannot tell us. */
async function adminQuery<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

interface IssuedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

async function mintKey(
  session: PlatformSession,
  orgId: string,
  body: Record<string, unknown>,
): Promise<{ key: IssuedKey; secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/api-keys`,
    headers: { cookie: session.cookie },
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { key: IssuedKey; secret: string };
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe('API keys', () => {
  it('mints a key whose secret is shown once, stored as a hash, and never returned again', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-owner'));
    const orgId = await createOrgFor(app, owner, 'Keys org');

    const { key, secret } = await mintKey(owner, orgId, {
      name: 'Nightly pipeline',
      scopes: ['forms:read', 'responses:read'],
    });

    expect(secret).toMatch(/^ik_[0-9a-f]{64}$/);
    expect(key.prefix).toBe(secret.slice(0, 11));
    expect(key.prefix).toMatch(/^ik_[0-9a-f]{8}$/);
    expect(key.scopes).toEqual(['forms:read', 'responses:read']);
    expect(key.active).toBe(true);

    // The database holds a hash and not the secret, which is what makes every
    // later "we cannot show it again" claim true rather than a policy.
    const stored = await adminQuery<{ key_hash: string; label: string }>(
      `SELECT key_hash, label FROM api_key WHERE id = $1`,
      [key.id],
    );
    expect(stored[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.key_hash).not.toBe(secret);
    expect(stored[0]!.label).toBe('Nightly pipeline');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: owner.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const keys = (listed.json() as { keys: IssuedKey[] }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: key.id, prefix: key.prefix, active: true });
    // Not merely "no secret field": the secret is not anywhere in the body.
    expect(listed.body).not.toContain(secret);
  });

  it('lets a key with the right scope through, and refuses one without it by name', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-scope'));
    const orgId = await createOrgFor(app, owner, 'Scope org');

    const scoped = await mintKey(owner, orgId, { name: 'queue reader', scopes: ['flags:read'] });
    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(scoped.secret),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({ flags: [] });

    const unscoped = await mintKey(owner, orgId, { name: 'no scopes', scopes: [] });
    const refused = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(unscoped.secret),
    });
    expect(refused.statusCode).toBe(403);
    // The missing capability is named, so an integrator does not have to read our
    // source to find out what to ask for.
    expect(refused.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(refused.body).toContain('flags:read');
  });

  it('denies a key at a route that declares no scope, and a session-only route ignores it entirely', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-default'));
    const orgId = await createOrgFor(app, owner, 'Default org');
    const { secret } = await mintKey(owner, orgId, { name: 'catch all', scopes: ['forms:read', 'flags:read'] });

    // Declares no scope => session only. The key is valid; the route is not for it.
    const consoleOnly = await app.inject({ method: 'GET', url: '/api/v1/api-scopes', headers: bearer(secret) });
    expect(consoleOnly.statusCode).toBe(403);
    expect(consoleOnly.json()).toMatchObject({ error: 'key_not_permitted' });

    // A route written before API keys existed never looks at the header, so a key
    // is simply not a session there. Default-deny is the property being asserted:
    // the console routes stay console-only, and a key is not a way into them.
    const orgs = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: bearer(secret) });
    expect(orgs.statusCode).toBe(401);

    // The same route works for the session that owns the key.
    const asSession = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: { cookie: owner.cookie } });
    expect(asSession.statusCode).toBe(200);
  });

  it('says which scopes a route enforces, so nobody mints a key that can do nothing', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-catalogue'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/api-scopes', headers: { cookie: owner.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { scopes: Array<{ scope: string; detail: string; enforced: boolean }> };

    // Every scope in the vocabulary names a route that declares it. The list is kept
    // separate from the vocabulary because the next scope may be published before its
    // route is wired — and a key carrying only vocabulary is a key that can call
    // nothing, which the console would otherwise offer as if it worked.
    expect(body.scopes.map((entry) => entry.scope).sort()).toEqual(
      ['analytics:read', 'flags:read', 'flags:write', 'forms:read', 'responses:export', 'responses:read'].sort(),
    );
    expect(body.scopes.every((entry) => entry.enforced)).toBe(true);
    expect(body.scopes.every((entry) => entry.detail.length > 0)).toBe(true);

    // And the marking is true rather than decorative: the key it says can read forms
    // reads forms, and the key that does not carry the scope is refused *by name*.
    const orgId = await createOrgFor(app, owner, 'Catalogue org');
    const reader = await mintKey(owner, orgId, { name: 'form reader', scopes: ['forms:read'] });
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/forms', headers: bearer(reader.secret) });
    expect(allowed.statusCode, allowed.body).toBe(200);

    const analyst = await mintKey(owner, orgId, { name: 'response reader', scopes: ['responses:read'] });
    const refused = await app.inject({ method: 'GET', url: '/api/v1/forms', headers: bearer(analyst.secret) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(refused.body).toContain('forms:read');
  });

  it('lets a read key reach the route its scope names, and only its own organisation', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-read'));
    const orgA = await createOrgFor(app, owner, 'Read org A');
    const orgB = await createOrgFor(app, owner, 'Read org B');

    // One form in A and one in B, both authored by the same person — which is exactly
    // the case where a key could accidentally inherit its creator's whole reach.
    const formInA = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { orgId: orgA, name: 'Household survey A' },
    });
    expect(formInA.statusCode, formInA.body).toBe(201);
    const formA = (formInA.json() as { form: { id: string } }).form.id;

    const formInB = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: { cookie: owner.cookie },
      payload: { orgId: orgB, name: 'Household survey B' },
    });
    expect(formInB.statusCode, formInB.body).toBe(201);
    const formB = (formInB.json() as { form: { id: string } }).form.id;

    const reader = await mintKey(owner, orgA, {
      name: 'org A analyst',
      scopes: ['forms:read', 'responses:read', 'analytics:read'],
    });

    // The list is narrowed to the key's organisation in SQL, so a key for A does not
    // see B's form even though its creator can.
    const list = await app.inject({ method: 'GET', url: '/api/v1/forms', headers: bearer(reader.secret) });
    expect(list.statusCode, list.body).toBe(200);
    const listed = (list.json() as { forms: Array<{ id: string }> }).forms;
    expect(listed.map((form) => form.id)).toEqual([formA]);

    // Reads that resolve the organisation from the row check it once it is known.
    const ownForm = await app.inject({ method: 'GET', url: `/api/v1/forms/${formA}`, headers: bearer(reader.secret) });
    expect(ownForm.statusCode, ownForm.body).toBe(200);

    const ownResponses = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formA}/responses`,
      headers: bearer(reader.secret),
    });
    expect(ownResponses.statusCode, ownResponses.body).toBe(200);

    const ownAnalytics = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formA}/analytics`,
      headers: bearer(reader.secret),
    });
    expect(ownAnalytics.statusCode, ownAnalytics.body).toBe(200);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formB}/analytics`,
      headers: bearer(reader.secret),
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: 'key_org_mismatch' });

    // An export is its own scope: reading responses does not imply downloading them.
    const exportWithReader = await app.inject({
      method: 'GET',
      url: `/api/v1/forms/${formA}/responses/export?format=csv`,
      headers: bearer(reader.secret),
    });
    expect(exportWithReader.statusCode).toBe(403);
    expect(exportWithReader.body).toContain('responses:export');
  });

  it('refuses a key pointed at an organisation it was not issued for', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-orgs'));
    const orgA = await createOrgFor(app, owner, 'Org A');
    const orgB = await createOrgFor(app, owner, 'Org B');
    const { secret } = await mintKey(owner, orgA, { name: 'org A reader', scopes: ['flags:read'] });

    // The owner is a member of both organisations, so this would succeed if the key
    // inherited its creator's whole reach. It must not: a key belongs to one org.
    const wrongOrg = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgB}/flags`,
      headers: bearer(secret),
    });
    expect(wrongOrg.statusCode).toBe(403);
    expect(wrongOrg.json()).toMatchObject({ error: 'key_org_mismatch' });

    const rightOrg = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgA}/flags`,
      headers: bearer(secret),
    });
    expect(rightOrg.statusCode).toBe(200);
  });

  it('stops a revoked key on the next request, and a revoked key cannot be revoked twice', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-revoke'));
    const orgId = await createOrgFor(app, owner, 'Revoke org');
    const { key, secret } = await mintKey(owner, orgId, { name: 'short lived', scopes: ['flags:read'] });

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(secret),
    });
    expect(before.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/api-keys/${key.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(secret),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ error: 'invalid_api_key' });

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/api-keys/${key.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(again.statusCode).toBe(404);

    // The row survives so the audit trail keeps its target.
    const rows = await adminQuery<{ active: boolean; revoked_at: Date | null }>(
      `SELECT active, revoked_at FROM api_key WHERE id = $1`,
      [key.id],
    );
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('refuses an expired key without revoking it', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-expiry'));
    const orgId = await createOrgFor(app, owner, 'Expiry org');
    const { key, secret } = await mintKey(owner, orgId, {
      name: 'study window',
      scopes: ['flags:read'],
      expiresInDays: 30,
    });

    const live = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(secret),
    });
    expect(live.statusCode).toBe(200);

    // Move the clock past the expiry rather than weakening the check.
    await adminQuery(`UPDATE api_key SET expires_at = now() - interval '1 hour' WHERE id = $1`, [key.id]);

    const expired = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/flags`,
      headers: bearer(secret),
    });
    expect(expired.statusCode).toBe(401);

    // Expiry is not revocation: the row is still active, and an owner can see why
    // the key stopped working.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: owner.cookie },
    });
    const view = (listed.json() as { keys: IssuedKey[] }).keys.find((k) => k.id === key.id)!;
    expect(view.active).toBe(false);
    expect(view.revokedAt).toBeNull();
  });

  it('lets a member read the keys but not mint or revoke one', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-roles'));
    const orgId = await createOrgFor(app, owner, 'Roles org');
    const { key } = await mintKey(owner, orgId, { name: 'owner made this', scopes: ['flags:read'] });

    const memberEmail = uniqueEmail('keys-member');
    const invited = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { cookie: owner.cookie },
      payload: { email: memberEmail, role: 'member' },
    });
    expect(invited.statusCode, invited.body).toBe(201);

    const member = await signInPlatform(app, memberEmail);

    const readable = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: member.cookie },
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect((readable.json() as { keys: IssuedKey[] }).keys).toHaveLength(1);

    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: member.cookie },
      payload: { name: 'member made this', scopes: ['flags:read'] },
    });
    expect(minted.statusCode).toBe(403);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/api-keys/${key.id}`,
      headers: { cookie: member.cookie },
    });
    expect(revoked.statusCode).toBe(403);
  });

  it('rejects an unknown, malformed or non-existent key the same way', async () => {
    const owner = await signInPlatform(app, uniqueEmail('keys-invalid'));
    const orgId = await createOrgFor(app, owner, 'Invalid org');

    for (const candidate of [
      `Bearer ik_${'0'.repeat(64)}`, // well-formed, never issued
      'Bearer not-a-key', // not the shape at all
      'Bearer ', // present but empty
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/flags`,
        headers: { authorization: candidate },
      });
      expect(res.statusCode, candidate).toBe(401);
    }
  });
});
