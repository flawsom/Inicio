import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { PRIVACY, TERMS } from '../legal/documents.js';

/**
 * The legal documents are public on purpose: the acceptance checkbox links to
 * them, and an invitation page may be opened by someone who has no session yet.
 * A reader must be able to open the exact text they are being asked to accept.
 */
export const platformLegalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/legal/terms', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.header('cache-control', 'public, max-age=300').send({ document: TERMS });
  });

  app.get('/legal/privacy', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.header('cache-control', 'public, max-age=300').send({ document: PRIVACY });
  });
};
