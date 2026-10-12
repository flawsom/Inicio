import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now');
    return { status: 'ok', dbTime: rows[0]?.now ?? null };
  });
};
