import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './auth/routes.js';
import { platformRoutes } from './platform/index.js';

/**
 * App factory shared by the long-running node server and the serverless entry
 * (Vercel function / Netlify function), so both run identical wiring.
 *
 * NOTE: @fastify/rate-limit's default store is per-process in memory. That is
 * adequate for a single instance but not for horizontally scaled serverless;
 * Phase 8 moves it to Valkey/Redis (REDIS_URL is already reserved).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet);
  await app.register(cors, { origin: env.APP_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  // The error handler is installed *before* the route plugins: a Fastify child
  // context inherits the handler that was current when it was registered, so
  // setting it afterwards would leave every route on the default serialiser.
  app.setErrorHandler((error: FastifyError, _req, reply) => {
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
