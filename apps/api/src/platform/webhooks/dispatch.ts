import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withCollector, withOrg } from '../db.js';

/**
 * Webhook delivery.
 *
 * The shape of the guarantee, stated once:
 *
 *  * **An event and its delivery row are written in the same transaction as the
 *    change that caused them.** A publish that committed has a delivery row; a
 *    publish that rolled back has none. That is what makes the event stream
 *    reproducible from the database rather than from a best-effort in-memory queue.
 *  * **Delivery is at-least-once.** Every attempt carries the same delivery id, so
 *    a receiver that has seen `d1` can ignore it a second time: the id is the
 *    idempotency key, and no signature scheme makes a retry unnecessary.
 *  * **The payload is the notification, not the data.** It carries what moved and
 *    the ids needed to fetch it, so a receiver that misses one can still be right
 *    after the next request, and we never ship another tenant's rows to a URL.
 *  * **Delivery never blocks the request that produced it.** The drain runs after
 *    the response, and the cross-organisation sweep is a CLI (or, later, a
 *    scheduler) rather than a thread inside the API.
 */

export const WEBHOOK_EVENTS = [
  'form.published',
  'response.submitted',
  'response.flagged',
  'flag.resolved',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_DETAIL: Record<WebhookEvent, string> = {
  'form.published': 'A version was published and the form began collecting.',
  'response.submitted': 'A respondent submitted a response.',
  'response.flagged': 'A quality flag was raised on a response.',
  'flag.resolved': 'A quality flag was resolved or dismissed.',
};

export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

/** Five attempts, then the delivery is failed and left visible for an operator. */
export const MAX_ATTEMPTS = 5;
/** Waits before attempt 2, 3, 4 and 5. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200];
/** Consecutive failures after which an endpoint disables itself. */
export const DISABLE_AFTER_FAILURES = 25;
const TIMEOUT_MS = 5_000;
const BODY_LIMIT = 4_096;

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * `sha256=<hex hmac>` over `${timestamp}.${body}`, the same construction Stripe and
 * GitHub use, for the same reason: including the timestamp in the signed material
 * is what lets a receiver reject a replay of an old, validly-signed body.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

export interface DueDelivery {
  /** bigint in 0001's delivery log, which pg returns as a string. */
  id: string;
  org_id: string;
  /** The endpoint the delivery belongs to (`webhook_id` in the schema). */
  webhook_id: string;
  event: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Enqueue one event for every active endpoint in the organisation that subscribes
 * to it. Runs on the caller's client, inside the caller's transaction — see the
 * invariant above.
 *
 * Returns the number of deliveries queued, which is what the tests assert on and
 * what a future UI uses to answer "did anything even want this event".
 */
export async function emitWebhook(
  client: PoolClient,
  orgId: string,
  event: WebhookEvent | 'webhook.test',
  data: Record<string, unknown>,
): Promise<number> {
  // One id per *event*, shared by every endpoint it fans out to: that is what
  // makes the delivery log's unique key (0001's `idempotency_key`) mean something
  // — an event emitted twice cannot be enqueued twice for the same endpoint.
  const eventId = randomUUID();
  const payload = {
    id: eventId,
    event,
    organisation: orgId,
    createdAt: new Date().toISOString(),
    data,
  };
  // One statement, through the SECURITY DEFINER enqueue in 0010: a respondent's
  // transaction may not read which endpoints exist, and a public link that could
  // would leak where the organisation's data goes. The function re-checks the
  // caller's standing before writing anything.
  const { rows } = await client.query<{ queued: number }>(
    `SELECT app_enqueue_webhook($1, $2, $3::jsonb, $4) AS queued`,
    [orgId, event, JSON.stringify(payload), eventId],
  );
  return rows[0]?.queued ?? 0;
}

/**
 * Deliveries that are pending and due, oldest first.
 *
 * `orgId = null` means "whatever this connection can see", which is how the
 * owner-side sweep works: the owner connection has no tenant context and no RLS to
 * satisfy. With an org id it goes through the guarded definer function, because a
 * member's ordinary read policy cannot see an endpoint's signing secret — and a
 * materialised view of "which URLs do we POST tenant data to" is exactly the thing
 * a public link must not be able to read.
 */
export async function dueDeliveries(
  client: PoolClient,
  orgId: string | null,
  limit = 20,
): Promise<DueDelivery[]> {
  if (orgId) {
    const { rows } = await client.query<DueDelivery>(`SELECT * FROM app_due_deliveries($1, $2)`, [
      orgId,
      limit,
    ]);
    return rows;
  }
  const { rows } = await client.query<DueDelivery>(
    `SELECT d.id, d.org_id, d.webhook_id, d.event, d.payload, d.attempts, e.url, e.secret
       FROM webhook_delivery d
       JOIN webhook e ON e.id = d.webhook_id
      WHERE d.status = 'pending'
        AND d.next_attempt_at <= now()
        AND e.active
      ORDER BY d.next_attempt_at
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
}

/**
 * One HTTP attempt. Never throws: a timeout, a DNS failure and a 500 are all the
 * same kind of fact to the queue, which is "not delivered, try again later".
 */
export async function deliver(row: DueDelivery): Promise<DeliveryResult> {
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const response = await fetch(row.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Inicio-Webhooks/1.0',
        // The delivery id is the idempotency key: a receiver that has already
        // processed this id can answer 200 and do nothing. The payload's own `id`
        // is the *event* id, which is what ties two deliveries of the same event
        // to the same thing having happened.
        'x-inicio-delivery': String(row.id),
        'x-inicio-event': row.event,
        'x-inicio-timestamp': timestamp,
        'x-inicio-signature': signPayload(row.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body: text.slice(0, BODY_LIMIT),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      body: null,
      error: (err as Error).name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS} ms` : (err as Error).message,
    };
  }
}

/**
 * Record the outcome and schedule the next attempt. The endpoint's failure count
 * is what eventually disables a receiver that has gone away; it resets on any
 * success, so an endpoint that is merely flaky is never punished for being flaky.
 */
export async function recordDeliveryOutcome(
  client: PoolClient,
  row: DueDelivery,
  result: DeliveryResult,
): Promise<{ attempts: number; status: 'delivered' | 'failed' | 'pending' }> {
  const attempts = row.attempts + 1;

  if (result.ok) {
    await client.query(
      `UPDATE webhook_delivery
          SET status = 'delivered', attempts = $2, delivered_at = now(),
              response_status = $3, response_body = $4, error = NULL
        WHERE id = $1`,
      [row.id, attempts, result.status, result.body],
    );
    await client.query(
      `UPDATE webhook
          SET last_success_at = now(), failure_count = 0
        WHERE id = $1`,
      [row.webhook_id],
    );
    return { attempts, status: 'delivered' };
  }

  const exhausted = attempts >= MAX_ATTEMPTS;
  if (exhausted) {
    await client.query(
      `UPDATE webhook_delivery
          SET status = 'failed', attempts = $2, response_status = $3, response_body = $4, error = $5
        WHERE id = $1`,
      [row.id, attempts, result.status, result.body, result.error],
    );
  } else {
    const delay = RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)]!;
    await client.query(
      `UPDATE webhook_delivery
          SET attempts = $2, response_status = $3, response_body = $4, error = $5,
              next_attempt_at = now() + make_interval(secs => $6)
        WHERE id = $1`,
      [row.id, attempts, result.status, result.body, result.error, delay],
    );
  }

  // The counter and the self-disable are decided in SQL against the row itself, so
  // two workers failing the same endpoint at once cannot both read a stale count and
  // leave it active one failure past the limit.
  await client.query(
    `UPDATE webhook
        SET last_failure_at = now(), failure_count = failure_count + 1,
            active = CASE WHEN failure_count + 1 >= $2 THEN false ELSE active END,
            disabled_at = CASE WHEN failure_count + 1 >= $2 THEN now() ELSE disabled_at END
      WHERE id = $1`,
    [row.webhook_id, DISABLE_AFTER_FAILURES],
  );
  return { attempts, status: exhausted ? 'failed' : 'pending' };
}

/**
 * Attempt everything due for one organisation.
 *
 * Three short transactions instead of one long one: read (in the tenant context,
 * so RLS does the scoping), *release the connection*, then make the HTTP calls,
 * then write the outcomes. Holding a pooled connection open across someone else's
 * HTTP endpoint is how a slow receiver becomes our outage.
 *
 * Returns a summary, which is what the CLI prints and the tests assert.
 */
export async function drainOrg(
  userId: string,
  orgId: string,
  limit = 20,
): Promise<{ attempted: number; delivered: number; failed: number; retrying: number }> {
  const due = await withOrg(userId, orgId, (client) => dueDeliveries(client, orgId, limit));
  if (due.length === 0) return { attempted: 0, delivered: 0, failed: 0, retrying: 0 };

  const results: Array<{ row: DueDelivery; result: DeliveryResult }> = [];
  for (const row of due) {
    results.push({ row, result: await deliver(row) });
  }

  const tally = { attempted: due.length, delivered: 0, failed: 0, retrying: 0 };
  await withOrg(userId, orgId, async (client) => {
    for (const { row, result } of results) {
      const outcome = await recordDeliveryOutcome(client, row, result);
      if (outcome.status === 'delivered') tally.delivered += 1;
      else if (outcome.status === 'failed') tally.failed += 1;
      else tally.retrying += 1;
    }
  });
  return tally;
}

/**
 * Drain one organisation in a respondent's context, for the events a submission
 * produces. A public link has no user id and therefore nothing to run `withOrg`
 * with, but it does have `app.org_id` — which is exactly what the guarded
 * functions in 0010 accept, and nothing more.
 */
export async function drainAsCollector(
  orgId: string,
  limit = 20,
): Promise<{ attempted: number; delivered: number; failed: number; retrying: number }> {
  const due = await withCollector(orgId, null, (client) => dueDeliveries(client, orgId, limit));
  if (due.length === 0) return { attempted: 0, delivered: 0, failed: 0, retrying: 0 };

  const results: Array<{ row: DueDelivery; result: DeliveryResult }> = [];
  for (const row of due) results.push({ row, result: await deliver(row) });

  const tally = { attempted: due.length, delivered: 0, failed: 0, retrying: 0 };
  await withCollector(orgId, null, async (client) => {
    for (const { row, result } of results) {
      const outcome = await recordDeliveryOutcome(client, row, result);
      if (outcome.status === 'delivered') tally.delivered += 1;
      else if (outcome.status === 'failed') tally.failed += 1;
      else tally.retrying += 1;
    }
  });
  return tally;
}

/**
 * Record an outcome on any client — used by the sweep, which owns its own
 * connection because it runs outside a request.
 */
export async function drainWith(client: PoolClient, orgId: string | null, limit = 50) {
  const due = await dueDeliveries(client, orgId, limit);
  const tally = { attempted: due.length, delivered: 0, failed: 0, retrying: 0 };
  for (const row of due) {
    const result = await deliver(row);
    const outcome = await recordDeliveryOutcome(client, row, result);
    if (outcome.status === 'delivered') tally.delivered += 1;
    else if (outcome.status === 'failed') tally.failed += 1;
    else tally.retrying += 1;
  }
  return tally;
}
