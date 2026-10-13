import type { FastifyPluginAsync } from 'fastify';
import { platformAuthRoutes } from './auth.js';
import { platformAdminRoutes } from './admin.js';
import { platformLegalRoutes } from './legal.js';
import { platformOrgRoutes } from './orgs.js';
import { platformFormRoutes } from './forms.js';
import { platformCollectRoutes } from './collect.js';
import { platformTermsRoutes } from './terms.js';
import { platformEventRoutes } from './events.js';
import { platformPublicRoutes } from './public.js';
import { platformKeyRoutes } from './keys.js';
import { platformWebhookRoutes } from './webhooks/routes.js';
import { platformFlagRoutes } from './flags.js';

/**
 * The platform API, mounted at /api/v1.
 *
 * Phase 1's school endpoints stay where they were (`/auth/*`) so nothing that was
 * verified stops working; this is the general-purpose surface that supersedes it —
 * open signup, organisations, authoring, collection, exports.
 */
export const platformRoutes: FastifyPluginAsync = async (app) => {
  await app.register(platformAuthRoutes, { prefix: '/auth' });
  // Legal documents and acceptance are public or self-service: a reader must be
  // able to open the exact text before agreeing to it, and the gate must be
  // reachable by an account that has not agreed yet.
  await app.register(platformLegalRoutes);
  await app.register(platformTermsRoutes);
  await app.register(platformAdminRoutes);
  await app.register(platformOrgRoutes);
  await app.register(platformFormRoutes);
  // Live change notifications for a form. Registered beside the form routes so the
  // stream lives at the same level as the reads it is telling the client to repeat.
  await app.register(platformEventRoutes);
  await app.register(platformCollectRoutes, { prefix: '/collect' });
  // Integrations and quality control. Registered here rather than behind their own
  // prefix because both are org-scoped resources, exactly like members and forms.
  await app.register(platformKeyRoutes);
  await app.register(platformWebhookRoutes);
  await app.register(platformFlagRoutes);
  // The one unauthenticated route. It reports how the software is doing and
  // nothing about who is using it (see public.ts).
  await app.register(platformPublicRoutes);
};
