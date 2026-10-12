import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/**
 * Serverless entry (Vercel Node function / Netlify function via an adapter).
 * One warm instance = one Fastify app, reused across invocations.
 *
 * Vercel : set the function entry to this file; Vercel injects (req, res).
 * Netlify: wrap with @netlify/aws-lambda-compat + @fastify/aws-lambda.
 *
 * Migrations are NOT run here — `pnpm db:migrate` is a deploy step.
 */
let appPromise: Promise<FastifyInstance> | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}

export const config = { runtime: 'nodejs' };
