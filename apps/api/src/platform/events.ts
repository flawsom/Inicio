import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, withUser } from './db.js';
import { requireAcceptedTerms } from './terms.js';

/**
 * The push channel.
 *
 * What this replaces: every screen in the console used to poll. The responses
 * table asked every 5 seconds, analytics every 10, the forms list every 10, the
 * link table every 15. Four screens open on one form meant four timers per browser
 * and a query per timer whether or not anything had changed, and a number that
 * could still be up to fifteen seconds stale.
 *
 * What it is instead: one server-sent events stream per form. The browser opens it
 * once, and the server tells the client *which aggregate changed* rather than
 * sending data, so the client refetches exactly the one thing that moved with the
 * query it already had. A quiet form costs nothing beyond the tick; a busy one
 * produces one event per aggregate per tick no matter how many responses landed in
 * that tick. That coalescing is the point: twenty responses in one second is one
 * `responses` event, not twenty.
 *
 * Why SSE and not WebSockets: the traffic is one-directional, it is already behind
 * the same session cookie and origin, and EventSource reconnects on its own with a
 * retry delay. A socket would add a protocol, a dependency and a second auth path
 * to get the same result.
 *
 * Why the change signal is a revision read rather than Postgres LISTEN/NOTIFY: the
 * API runs as a serverless function, where each invocation is its own process and a
 * LISTEN connection does not survive between them, so a NOTIFY fired by a write on
 * one instance would reach nobody. The revision read is one round trip inside the
 * tenant transaction, which is also what makes it correct: it can only ever see the
 * rows the caller is allowed to see. A long-lived process gets the same behaviour
 * with one extra query per tick. A broker (Valkey or pg-boss) is the upgrade that
 * makes fan-out free across instances, and it is not needed to remove the poll.
 */

/** Aggregates a client can subscribe to. One event per name, coalesced per tick. */
export const AGGREGATES = ['responses', 'analytics', 'links', 'versions'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/**
 * Per-aggregate revision vector.
 *
 * Each aggregate gets a signature built only from things that actually change the
 * answer its screen shows:
 *   - responses: rows exist, and the newest row edit
 *   - analytics: tallies come from answers, so an answer edit moves it even when the
 *     response row does not; conflicts are a live count in the same panel
 *   - links: a link was added, revoked or spent
 *   - versions: a draft saved, a version published, the form renamed
 *
 * Counts are not enough on their own: editing an answer changes no count at all,
 * which is exactly the case a poll would have caught and a naive "did the count
 * change" watcher would have missed.
 */
export interface Revision {
  responses: string;
  analytics: string;
  links: string;
  versions: string;
}

function readRevision(client: import('pg').PoolClient, formId: string): Promise<Revision> {
  return client
    .query<{
      response_count: number;
      response_updated: string;
      answer_updated: string;
      conflict_count: number;
      link_count: number;
      link_uses: number;
      link_created: string;
      version_count: number;
      version_created: string;
      published_at: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM response WHERE form_id = $1)                                   AS response_count,
         coalesce((SELECT max(updated_at)::text FROM response WHERE form_id = $1), '')             AS response_updated,
         coalesce((SELECT max(a.updated_at)::text FROM response_answer a
                     JOIN response r ON r.id = a.response_id WHERE r.form_id = $1), '')            AS answer_updated,
         (SELECT count(*)::int FROM response_conflict c
            JOIN response r ON r.id = c.response_id WHERE r.form_id = $1)                          AS conflict_count,
         (SELECT count(*)::int FROM dist_link WHERE form_id = $1)                                  AS link_count,
         coalesce((SELECT sum(uses)::int FROM dist_link WHERE form_id = $1), 0)                    AS link_uses,
         coalesce((SELECT max(created_at)::text FROM dist_link WHERE form_id = $1), '')            AS link_created,
         (SELECT count(*)::int FROM form_version WHERE form_id = $1)                               AS version_count,
         coalesce((SELECT max(created_at)::text FROM form_version WHERE form_id = $1), '')         AS version_created,
         coalesce((SELECT max(published_at)::text FROM form_version WHERE form_id = $1), '')       AS published_at`,
      [formId],
    )
    .then(({ rows }) => {
      const r = rows[0];
      if (!r) throw new Error('revision query returned no rows');
      return {
        responses: `${r.response_count}|${r.response_updated}`,
        analytics: `${r.response_count}|${r.response_updated}|${r.answer_updated}|${r.conflict_count}`,
        links: `${r.link_count}|${r.link_uses}|${r.link_created}`,
        versions: `${r.version_count}|${r.version_created}|${r.published_at}`,
      };
    });
}

/**
 * Which aggregates moved between two snapshots.
 *
 * Pure, and exported so the coalescing rule is a test rather than a claim: an
 * unchanged snapshot produces an empty array, so a tick that finds nothing new
 * writes no event at all.
 */
export function diffRevisions(previous: Revision | null, next: Revision): Aggregate[] {
  if (!previous) return [...AGGREGATES];
  return AGGREGATES.filter((name) => previous[name] !== next[name]);
}

/** How often the stream re-reads the revision vector. */
const TICK_MS = 1500;
/** Heartbeat interval, so an idle stream is not reaped by an intermediary. */
const HEARTBEAT_MS = 15_000;
/**
 * A serverless function is capped (60s in vercel.json), so the stream ends itself
 * first and tells the client, which lets EventSource reconnect on a clean boundary
 * instead of being killed mid-write and treating it as a failure.
 */
const MAX_STREAM_MS = 50_000;

export const platformEventRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/forms/:formId/events',
    async (req: FastifyRequest<{ Params: { formId: string } }>, reply: FastifyReply) => {
      // Same gate as the REST routes: the session cookie decides, and the terms
      // gate applies here too, or the stream would be a way around it.
      const identity = await requireAcceptedTerms(req);

      const form = await withUser(identity.userId, async (client) => {
        const { rows } = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM form WHERE id = $1`,
          [req.params.formId],
        );
        return rows[0] ?? null;
      });
      // A form belonging to somebody else is not a row, so it is a 404, not a
      // permission argument. Closing the stream is the only honest answer.
      if (!form) throw new HttpError(404, 'not_found');

      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // no-transform stops a proxy from buffering the stream into a single blob,
        // which is the classic reason an SSE endpoint appears to do nothing.
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();

      // Fastify must not write a response of its own now that the socket is ours.
      reply.hijack();

      const send = (event: string, data: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const comment = (text: string): void => {
        if (!res.writableEnded) res.write(`: ${text}\n\n`);
      };

      let closed = false;
      let previous: Revision | null = null;
      let lastHeartbeat = Date.now();

      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearTimeout(deadline);
        if (!res.writableEnded) res.end();
      };

      const tick = setInterval(() => {
        if (closed) return;
        void (async () => {
          let next: Revision;
          try {
            next = await withUser(identity.userId, (client) => readRevision(client, form.id));
          } catch (err) {
            // A transient database problem is not a reason to tear the stream down:
            // say nothing this tick and let the next one try, so the client keeps the
            // last good data it has and its fallback timer covers a long outage. It is
            // logged rather than swallowed, because a stream that has gone quiet for a
            // real reason must be visible to whoever operates the deployment.
            req.log.warn({ err }, 'realtime: revision read failed, stream stays open');
            return;
          }
          if (closed) return;

          const changed = diffRevisions(previous, next);
          const first = previous === null;
          previous = next;

          if (first) {
            send('ready', { formId: form.id, name: form.name, at: new Date().toISOString() });
            return;
          }
          // Nothing moved: send no event at all. This is what makes a quiet form
          // free, and it is why the client no longer needs a timer to stay current.
          if (changed.length === 0) {
            if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
              lastHeartbeat = Date.now();
              comment('keep-alive');
            }
            return;
          }
          send('change', { aggregates: changed, at: new Date().toISOString() });
          lastHeartbeat = Date.now();
        })();
      }, TICK_MS);

      const deadline = setTimeout(() => {
        send('recycle', { reason: 'stream_lifetime', at: new Date().toISOString() });
        finish();
      }, MAX_STREAM_MS);

      // The tab closed, navigated away, or lost the network.
      req.raw.on('close', finish);
      req.raw.on('error', finish);
    },
  );
};
