import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { HttpError, withOrg } from './db.js';
import { currentIdentity, requireIdentity } from './guards.js';
import { termsSatisfied } from './terms.js';
import { resolveApiKey, type ApiScope } from './keys.js';

/**
 * Who is making this request: a browser session or an API key.
 *
 * The default is deny for keys, and that default is the point. `requireActor`
 * without a `scope` is session-only, so every route written before this file
 * existed — and every route written after it by someone who has not thought about
 * machine access — keeps rejecting `Authorization: Bearer`. A key reaches a route
 * only when that route names the capability it needs, which makes the machine
 * surface a list you can read rather than the absence of a check you cannot see.
 *
 * A session is unrestricted (`scopes: null`) because the console is the product;
 * a key carries an explicit list, and a scope the code no longer recognises is
 * dropped at resolution rather than trusted.
 */
export interface ApiActor {
  userId: string;
  via: 'session' | 'api_key';
  /** Null for a session: a person is not scope-limited inside their own account. */
  scopes: readonly ApiScope[] | null;
  /** Set for a key: the one organisation it may act in. */
  orgId?: string;
  keyId?: string;
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Resolve the actor, enforcing the scope when one is named.
 *
 *  - a key on a route that declares no scope is refused, with the reason stated
 *    (`key_not_permitted`), because "your key cannot call this" is a different
 *    problem from "your key is wrong";
 *  - a key missing the declared scope is refused with the *missing* scope named,
 *    so an integrator can fix it without reading our source;
 *  - the terms gate applies to a person, not to a key: a key can only exist
 *    because its creator had accepted the terms when they minted it.
 */
export async function requireActor(
  req: FastifyRequest,
  options: { scope?: ApiScope } = {},
): Promise<ApiActor> {
  const token = bearer(req);
  if (token) {
    const key = await resolveApiKey(token);
    if (!key) throw new HttpError(401, 'invalid_api_key', 'that API key is unknown, expired or revoked');
    if (!options.scope) {
      throw new HttpError(
        403,
        'key_not_permitted',
        'this endpoint is session-only; it is not part of the machine API',
        { actor: `key:${key.keyId}`, meta: { orgId: key.orgId, grantedScopes: key.scopes } },
      );
    }
    if (!key.scopes.includes(options.scope)) {
      throw new HttpError(403, 'insufficient_scope', `this key does not have ${options.scope}`, {
        actor: `key:${key.keyId}`,
        meta: {
          orgId: key.orgId,
          requiredScope: options.scope,
          grantedScopes: key.scopes,
        },
      });
    }
    return { userId: key.userId, via: 'api_key', scopes: key.scopes, orgId: key.orgId, keyId: key.keyId };
  }

  const identity = await requireIdentity(req);
  if (!(await termsSatisfied(identity.userId))) {
    throw new HttpError(403, 'terms_required', 'accept the current terms to continue');
  }
  return { userId: identity.userId, via: 'session', scopes: null };
}

/**
 * Run `fn` with `app.org_id` set, refusing a key that is being pointed at another
 * organisation.
 *
 * Without this check a key issued for organisation A would still work against a
 * form in organisation B whenever its creator happens to be a member of both —
 * technically the creator's own authority, but not what "a key for this
 * organisation" means to the person who issued it. A session is unaffected: the
 * path's organisation is checked by the membership lookup inside `withOrg`.
 */
/**
 * Refuse a key pointed at another organisation, in one place.
 *
 * Call this on every route that resolves its organisation from a path value or from
 * a loaded row rather than from the request: the read routes below load a form and
 * only then know its organisation, and a key issued for organisation A must not read
 * organisation B's form just because its creator happens to be a member of both.
 * That is technically the creator's own authority, but it is not what "a key for this
 * organisation" means to the person who issued it. A session is unaffected — the
 * membership lookup inside `withOrg` is the check there.
 */
export function assertActorOrg(actor: ApiActor, orgId: string): void {
  if (actor.via === 'api_key' && actor.orgId !== orgId) {
    throw new HttpError(403, 'key_org_mismatch', 'this key belongs to another organisation', {
      actor: `key:${actor.keyId}`,
      // The organisation the key was issued for, which is the interesting half: the
      // refused one is in the request path the handler records as the target.
      meta: { keyOrgId: actor.orgId },
    });
  }
}

export async function withActorOrg<T>(
  actor: ApiActor,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { roles?: ReadonlyArray<'owner' | 'admin' | 'member' | 'viewer'>; write?: boolean } = {},
): Promise<T> {
  assertActorOrg(actor, orgId);
  return withOrg(actor.userId, orgId, fn, options);
}

/** Identity in the shape the older handlers expect, for routes that also take keys. */
export async function currentActorIfPresent(req: FastifyRequest): Promise<ApiActor | null> {
  const token = bearer(req);
  if (token) {
    const key = await resolveApiKey(token);
    if (!key) return null;
    return { userId: key.userId, via: 'api_key', scopes: key.scopes, orgId: key.orgId, keyId: key.keyId };
  }
  const identity = await currentIdentity(req);
  if (!identity) return null;
  return { userId: identity.userId, via: 'session', scopes: null };
}
