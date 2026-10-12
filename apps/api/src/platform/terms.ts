import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PRIVACY, TERMS, ACCEPTANCE_CHECKBOX_TEXT } from '../legal/documents.js';
import { HttpError, withUser } from './db.js';
import { audit, requireIdentity, type PlatformIdentity } from './guards.js';

/**
 * Terms acceptance.
 *
 * The product gate is deliberate: an account that has not accepted the current
 * terms can authenticate but cannot do anything else. `/me` and the acceptance
 * endpoint stay reachable, so the client can always discover the requirement and
 * satisfy it. Everything else answers 403 `terms_required`.
 *
 * Acceptance is recorded as an event with the document version and the hash of
 * the exact text that was served, which is what makes it worth anything as
 * evidence later. A new version of the terms produces a new event rather than
 * editing the old one.
 */

export async function acceptedTermsVersion(userId: string): Promise<string | null> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<{ terms_version: string }>(
      `SELECT terms_version
         FROM terms_acceptance
        WHERE user_id = $1
        ORDER BY accepted_at DESC
        LIMIT 1`,
      [userId],
    );
    return rows[0]?.terms_version ?? null;
  });
}

export async function termsSatisfied(userId: string): Promise<boolean> {
  const version = await acceptedTermsVersion(userId);
  return version === TERMS.version && TERMS.version === PRIVACY.version;
}

/** Identity, plus the requirement that the current terms are accepted. */
export async function requireAcceptedTerms(req: FastifyRequest): Promise<PlatformIdentity> {
  const identity = await requireIdentity(req);
  if (!(await termsSatisfied(identity.userId))) {
    throw new HttpError(403, 'terms_required', 'accept the current terms to continue');
  }
  return identity;
}

const acceptSchema = z.object({
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  // Enforced as a literal true: a missing, false or "yes" value is a failure,
  // because a record of acceptance must reflect a deliberate act.
  accepted: z.literal(true),
});

export const platformTermsRoutes: FastifyPluginAsync = async (app) => {
  /** Public: the exact text and hashes the client must display. */
  app.get('/legal/acceptance', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      terms: { version: TERMS.version, hash: TERMS.hash, effectiveDate: TERMS.effectiveDate },
      privacy: { version: PRIVACY.version, hash: PRIVACY.hash, effectiveDate: PRIVACY.effectiveDate },
      checkboxText: ACCEPTANCE_CHECKBOX_TEXT,
    });
  });

  /** Does the signed in account still need to accept? */
  app.get('/auth/terms/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireIdentity(req);
    const acceptedVersion = await acceptedTermsVersion(identity.userId);
    return reply.send({
      required: !(await termsSatisfied(identity.userId)),
      currentVersion: TERMS.version,
      acceptedVersion,
      checkboxText: ACCEPTANCE_CHECKBOX_TEXT,
      terms: { version: TERMS.version, hash: TERMS.hash },
      privacy: { version: PRIVACY.version, hash: PRIVACY.hash },
    });
  });

  app.post('/auth/terms/accept', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireIdentity(req);
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'acceptance_required', detail: 'accepted must be true' });
    }
    // The served versions must match what is on the server right now: accepting
    // a stale version would record agreement to a text nobody is being shown.
    if (parsed.data.termsVersion !== TERMS.version || parsed.data.privacyVersion !== PRIVACY.version) {
      return reply.code(409).send({ error: 'terms_version_changed', currentVersion: TERMS.version });
    }

    await withUser(identity.userId, async (client) => {
      await client.query(
        `INSERT INTO terms_acceptance
           (user_id, terms_version, terms_hash, privacy_version, privacy_hash, checkbox_text, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          identity.userId,
          TERMS.version,
          TERMS.hash,
          PRIVACY.version,
          PRIVACY.hash,
          ACCEPTANCE_CHECKBOX_TEXT,
          req.ip,
          req.headers['user-agent'] ?? null,
        ],
      );
    });

    await audit(req, `user:${identity.userId}`, 'user.terms_accepted', identity.userId, {
      termsVersion: TERMS.version,
      privacyVersion: PRIVACY.version,
    });

    return reply.send({ accepted: true, termsVersion: TERMS.version });
  });
};
