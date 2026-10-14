import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env } from './env.js';
import { assertTenancyEnforced, pool } from './db/pool.js';
import { registerDurableLimit } from './lib/rate-limit.js';
import { recordAudit } from './audit/audit.js';
import type { RefusedActor } from './platform/db.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './auth/routes.js';
import { platformRoutes } from './platform/index.js';

/**
 * App factory shared by the long-running node server and the serverless entry
 * (Vercel function / Netlify function), so both run identical wiring.
 *
 * The rate limiter is durable: its counters are rows in PostgreSQL (migration
 * 0011, `src/lib/rate-limit.ts`), so a ceiling holds across instances and across
 * the process recycling a serverless function does between requests. This used to
 * be `@fastify/rate-limit`'s built-in per-process store, which meant every fresh
 * process started counting at zero. REDIS_URL is still reserved, for the queue and
 * the cross-instance push fan-out rather than for this.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // Refuse to serve on a connection that cannot enforce tenancy (see pool.ts).
  await assertTenancyEnforced();

  await app.register(helmet);
  // The console and the API are served from one origin, so CORS never applies
  // to a normal request. It still matters for a custom domain and for the
  // per-deployment preview URLs Vercel mints, so those are allowed explicitly
  // rather than by opening the door to every origin.
  const allowedOrigins = new Set<string>([env.APP_ORIGIN]);
  if (process.env.VERCEL_URL) allowedOrigins.add(`https://${process.env.VERCEL_URL}`);
  await app.register(cors, { origin: [...allowedOrigins], credentials: true });
  await app.register(cookie);
  // Per address, for every route. Public collection adds a second, independent
  // ceiling keyed on the distribution link (see platform/collect.ts); both count.
  await registerDurableLimit(app, { max: env.RATE_LIMIT_MAX, namespace: 'ip' });

  // The error handler is installed *before* the route plugins: a Fastify child
  // context inherits the handler that was current when it was registered, so
  // setting it afterwards would leave every route on the default serialiser.
  app.setErrorHandler(async (error: FastifyError, req, reply) => {
    // A row-level-security refusal is the database enforcing tenancy, so it is a
    // 403 rather than the 500 it would otherwise look like. Likewise a unique
    // violation is a conflict the caller can fix (a duplicate slug, say).
    const pgCode = (error as unknown as { code?: string }).code;
    if (pgCode === '42501') {
      return reply.code(403).send({ error: 'forbidden', message: 'not permitted on this organisation' });
    }
    if (pgCode === '23505') {
      return reply.code(409).send({ error: 'conflict', message: 'that name or slug is already in use' });
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) app.log.error(error);

    // A refusal by an actor the code could name is recorded; an anonymous one is not.
    // A machine credential that is missing a scope, a viewer attempting a write and a
    // key pointed at another organisation are all security-relevant events, and the
    // requirement is that a refused write leaves an audit entry as well as a `403`.
    const refused = (error as { audit?: RefusedActor }).audit;
    if (refused && status < 500) {
      try {
        await recordAudit(pool, {
          actor: refused.actor,
          action: 'access.denied',
          target: req.url,
          meta: { code: error.code ?? 'request_error', method: req.method, ...refused.meta },
          ip: req.ip,
        });
      } catch (auditFailure) {
        // The row is bookkeeping. The refusal the caller is owed must still be sent,
        // and an audit-table problem must not turn a `403` into a `500`.
        app.log.error({ err: auditFailure }, 'could not record a refusal in the audit trail');
      }
    }

    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : error.code ?? 'request_error',
      message: status >= 500 ? 'An unexpected error occurred.' : error.message,
    });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(platformRoutes, { prefix: '/api/v1' });

  return app;
}
