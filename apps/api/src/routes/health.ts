import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { APP_VERSION } from '../version.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    try {
      const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now');
      return { status: 'ok', dbTime: rows[0]?.now ?? null, version: APP_VERSION };
    } catch (err) {
      // A health check exists to fail when the thing it checks is broken, so this is a
      // **503**, not a 200 carrying bad news: a 200 here would tell every probe and load
      // balancer that a deployment with no database is healthy. What it adds over the
      // bare 500 this used to produce is the reason and, above all, the version, because
      // "which build is serving this?" must not depend on the database that just died.
      return reply.code(503).send({
        status: 'degraded',
        dbTime: null,
        reason: err instanceof Error ? err.message : 'the database did not answer',
        version: APP_VERSION,
      });
    }
  });
};
