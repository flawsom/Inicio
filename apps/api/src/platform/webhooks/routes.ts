import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../db.js';
import { audit } from '../guards.js';
import { requireActor, withActorOrg } from '../actors.js';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DETAIL,
  deliver,
  drainOrg,
  generateSigningSecret,
  recordDeliveryOutcome,
  webhookEventSchema,
  type DueDelivery,
} from './dispatch.js';

/**
 * Managing webhooks, and the one place a signing secret is ever returned.
 *
 * Reading an endpoint is for any member — knowing where your organisation sends
 * its events is not privileged. Creating, editing, testing and deleting are
 * owner/admin, because an endpoint is an egress channel: whoever controls it
 * decides where the organisation's data goes.
 *
 * The secret is *not* in any read response, even for an owner. It is the one
 * credential in this schema that cannot be stored as a hash (signing needs the
 * key), so the only defence is to hand it over once and keep it out of every
 * later response body and log line.
 */

const urlSchema = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => /^https:\/\/[^\s]+$/.test(value), 'the URL must be https');

const createSchema = z.object({
  url: urlSchema,
  events: z.array(webhookEventSchema).min(1).max(WEBHOOK_EVENTS.length),
  description: z.string().trim().max(200).optional(),
});

const patchSchema = z.object({
  url: urlSchema.optional(),
  events: z.array(webhookEventSchema).min(1).max(WEBHOOK_EVENTS.length).optional(),
  description: z.string().trim().max(200).optional(),
  active: z.boolean().optional(),
});

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  created_at: Date;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  failure_count: number;
  disabled_at: Date | null;
}

/** Never includes `secret`. */
const viewEndpoint = (row: EndpointRow) => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: row.events,
  active: row.active,
  createdAt: row.created_at,
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  failureCount: row.failure_count,
  disabledAt: row.disabled_at,
  // "Why did my webhooks stop" as a field rather than a support ticket.
  reason: row.disabled_at
    ? `${row.failure_count} consecutive failures. Re-enable it once the receiver answers.`
    : null,
});

export const platformWebhookRoutes: FastifyPluginAsync = async (app) => {
  /** The event catalogue, so the console never hard-codes it. */
  app.get('/webhook-events', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req);
    return reply.send({
      events: WEBHOOK_EVENTS.map((event) => ({ event, detail: WEBHOOK_EVENT_DETAIL[event] })),
      actor: { via: actor.via },
    });
  });

  app.get(
    '/orgs/:orgId/webhooks',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const endpoints = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<EndpointRow & { pending: number; failed: number }>(
          `SELECT e.id, e.url, e.description, e.events, e.active, e.created_at, e.last_success_at,
                  e.last_failure_at, e.failure_count, e.disabled_at,
                  (SELECT count(*)::int FROM webhook_delivery d
                    WHERE d.webhook_id = e.id AND d.status = 'pending') AS pending,
                  (SELECT count(*)::int FROM webhook_delivery d
                    WHERE d.webhook_id = e.id AND d.status = 'failed') AS failed
             FROM webhook e
            WHERE e.org_id = $1
            ORDER BY e.created_at DESC`,
          [req.params.orgId],
        );
        return rows;
      });
      return reply.send({
        endpoints: endpoints.map((row) => ({ ...viewEndpoint(row), pending: row.pending, failed: row.failed })),
      });
    },
  );

  app.post(
    '/orgs/:orgId/webhooks',
    async (req: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const secret = generateSigningSecret();
      const endpoint = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<EndpointRow>(
            `INSERT INTO webhook (org_id, url, description, events, secret, created_by)
             VALUES ($1, $2, $3, $4::text[], $5, $6)
             RETURNING id, url, description, events, active, created_at, last_success_at,
                       last_failure_at, failure_count, disabled_at`,
            [
              req.params.orgId,
              parsed.data.url,
              parsed.data.description ?? null,
              parsed.data.events,
              secret,
              actor.userId,
            ],
          );
          return rows[0]!;
        },
        { roles: ['owner', 'admin'] },
      );

      await audit(req, `user:${actor.userId}`, 'webhook.created', endpoint.id, {
        orgId: req.params.orgId,
        url: endpoint.url,
        events: endpoint.events,
      });
      // The secret is returned once, here, and never by a read route.
      return reply.code(201).send({ endpoint: viewEndpoint(endpoint), secret });
    },
  );

  app.patch(
    '/orgs/:orgId/webhooks/:endpointId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; endpointId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

      const endpoint = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<EndpointRow>(
            // Re-enabling clears the failure history, because the history is what
            // the auto-disable is made of: leaving it would disable the endpoint
            // again on the next single failure.
            `UPDATE webhook
                SET url = COALESCE($3, url),
                    description = COALESCE($4, description),
                    events = COALESCE($5::text[], events),
                    active = COALESCE($6, active),
                    failure_count = CASE WHEN $6 IS TRUE THEN 0 ELSE failure_count END,
                    disabled_at = CASE WHEN $6 IS TRUE THEN NULL ELSE disabled_at END
              WHERE id = $1 AND org_id = $2
              RETURNING id, url, description, events, active, created_at, last_success_at,
                        last_failure_at, failure_count, disabled_at`,
            [
              req.params.endpointId,
              req.params.orgId,
              parsed.data.url ?? null,
              parsed.data.description ?? null,
              parsed.data.events ?? null,
              parsed.data.active ?? null,
            ],
          );
          return rows[0] ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      if (!endpoint) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, 'webhook.updated', endpoint.id, {
        orgId: req.params.orgId,
        active: endpoint.active,
      });
      return reply.send({ endpoint: viewEndpoint(endpoint) });
    },
  );

  app.delete(
    '/orgs/:orgId/webhooks/:endpointId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; endpointId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const deleted = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string; url: string }>(
            `DELETE FROM webhook WHERE id = $1 AND org_id = $2 RETURNING id, url`,
            [req.params.endpointId, req.params.orgId],
          );
          return rows[0] ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      if (!deleted) throw new HttpError(404, 'not_found');
      await audit(req, `user:${actor.userId}`, 'webhook.deleted', deleted.id, { url: deleted.url });
      return reply.code(204).send();
    },
  );

  /** Delivery history: what was sent, what came back, what is still owed. */
  app.get(
    '/orgs/:orgId/webhooks/:endpointId/deliveries',
    async (
      req: FastifyRequest<{ Params: { orgId: string; endpointId: string }; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      const deliveries = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query(
          `SELECT d.id, d.event, d.status, d.attempts, d.response_status, d.error,
                  d.ts AS created_at, d.delivered_at, d.next_attempt_at, d.payload
             FROM webhook_delivery d
             JOIN webhook e ON e.id = d.webhook_id
            WHERE d.webhook_id = $1 AND d.org_id = $2
            ORDER BY d.ts DESC
            LIMIT $3`,
          [req.params.endpointId, req.params.orgId, limit],
        );
        return rows;
      });
      return reply.send({ deliveries });
    },
  );

  /**
   * Send a deliberately synthetic event and wait for the real answer.
   *
   * A test button that only checked the URL's shape would be worse than none: the
   * question an operator has is whether *this* receiver accepts *our* signature,
   * and the only honest way to answer it is to sign something and read the reply.
   */
  app.post(
    '/orgs/:orgId/webhooks/:endpointId/test',
    async (
      req: FastifyRequest<{ Params: { orgId: string; endpointId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const queued = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string; url: string }>(
            `SELECT id, url FROM webhook WHERE id = $1 AND org_id = $2`,
            [req.params.endpointId, req.params.orgId],
          );
          const endpoint = rows[0];
          if (!endpoint) throw new HttpError(404, 'not_found');
          const eventId = randomUUID();
          const payload = {
            id: eventId,
            event: 'webhook.test',
            organisation: req.params.orgId,
            createdAt: new Date().toISOString(),
            data: { message: 'This is a test delivery from Inicio. Nothing was changed.' },
          };
          const { rows: created } = await client.query<{ id: string }>(
            `INSERT INTO webhook_delivery (org_id, webhook_id, event, payload, idempotency_key)
             VALUES ($1, $2, 'webhook.test', $3::jsonb, $4)
             RETURNING id`,
            [req.params.orgId, endpoint.id, JSON.stringify(payload), `${eventId}:${endpoint.id}`],
          );
          return { deliveryId: created[0]!.id, endpointId: endpoint.id, url: endpoint.url };
        },
        { roles: ['owner', 'admin'] },
      );

      // Delivered here and now rather than queued for the next drain: an operator
      // pressing "send test" is waiting for the answer.
      const due: DueDelivery[] = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<DueDelivery>(
          `SELECT d.id, d.org_id, d.webhook_id, d.event, d.payload, d.attempts, e.url, e.secret
             FROM webhook_delivery d
             JOIN webhook e ON e.id = d.webhook_id
            WHERE d.id = $1`,
          [queued.deliveryId],
        );
        return rows;
      });
      const row = due[0];
      if (!row) throw new HttpError(500, 'enqueue_failed');
      const result = await deliver(row);
      await withActorOrg(actor, req.params.orgId, (client) =>
        recordDeliveryOutcome(client, row, result),
      );
      await audit(req, `user:${actor.userId}`, 'webhook.tested', queued.endpointId, {
        ok: result.ok,
        status: result.status,
      });
      return reply.send({
        delivered: result.ok,
        status: result.status,
        responseBody: result.body,
        error: result.error,
        deliveryId: row.id,
      });
    },
  );

  /** Requeue a failed or stuck delivery: `next_attempt_at = now()`. */
  app.post(
    '/orgs/:orgId/webhooks/deliveries/:deliveryId/retry',
    async (
      req: FastifyRequest<{ Params: { orgId: string; deliveryId: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await requireActor(req);
      const retried = await withActorOrg(
        actor,
        req.params.orgId,
        async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `UPDATE webhook_delivery
                SET status = 'pending', next_attempt_at = now(), attempts = 0, error = NULL
              WHERE id = $1 AND org_id = $2 AND status <> 'delivered'
              RETURNING id`,
            [req.params.deliveryId, req.params.orgId],
          );
          return rows[0] ?? null;
        },
        { roles: ['owner', 'admin'] },
      );
      if (!retried) throw new HttpError(404, 'not_found');
      // Draining after the response would be invisible to the operator who just
      // pressed retry, so the answer to "did it work this time" is the reply.
      const tally = await drainOrg(actor.userId, req.params.orgId, 5);
      return reply.send({ deliveryId: retried.id, drained: tally });
    },
  );
};
