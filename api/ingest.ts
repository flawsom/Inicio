/**
 * Vercel serverless entry point for the Inicio API.
 *
 * Vercel only discovers serverless functions in the project's root `api/`
 * directory, and the real application is a Fastify app in `apps/api`. This file
 * is therefore a translator, not a second router: it restores the original
 * request URL and hands the request to the application, so there is exactly one
 * copy of the routes, the validation and the tenancy rules.
 *
 * How the URL is restored: `vercel.json` rewrites `/api/*`, `/auth/*` and
 * `/health` onto this function, because a rewrite to a function otherwise
 * replaces the path. Two parameters arrive here and both are platform
 * bookkeeping, removed before Fastify ever sees them:
 *
 *   inicio_route  which prefix the request came in on (api, auth or health)
 *   path          the remaining segments, forwarded by Vercel for the `:path*`
 *                 source segment (this API has no `path` query parameter of its
 *                 own, which is what makes this unambiguous)
 *
 * Anything else in the query string travelled with the request and is preserved:
 * `?format=csv`, `?limit=200` and the rest reach the application untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import handler from '../apps/api/src/serverless.js';

const ROUTE_PARAM = 'inicio_route';
const TAIL_PARAM = 'path';

const PREFIX: Record<string, string> = { api: '/api', auth: '/auth', health: '/health' };

export default async function vercelEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [pathname, search] = (req.url ?? '/').split('?');
  const params = new URLSearchParams(search ?? '');
  const route = params.get(ROUTE_PARAM);

  if (route === null) {
    // Not one of our rewrites (a direct hit on /api/ingest). Leave it alone.
    req.url = pathname ?? '/';
  } else {
    const prefix = PREFIX[route] ?? '/api';
    const tail = params.get(TAIL_PARAM) ?? '';
    params.delete(ROUTE_PARAM);
    params.delete(TAIL_PARAM);
    const query = params.toString();
    const path = route === 'health' ? '/health' : tail ? `${prefix}/${tail}` : prefix;
    req.url = `${path}${query ? `?${query}` : ''}`;
  }

  await handler(req, res);
}
