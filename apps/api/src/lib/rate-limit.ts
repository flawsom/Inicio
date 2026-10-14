import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { env } from '../env.js';
import { pool } from '../db/pool.js';

/**
 * The durable rate limiter (SR-7, RO-1).
 *
 * `@fastify/rate-limit`'s default store is a per-process LRU map, which is the one
 * thing a limit must not be here. The API runs as a serverless function, where a
 * recycled process is normal, and it already has a horizontally scaled profile; either
 * way each instance would count from zero, so the "120 requests a minute" a client is
 * told about would be "120 per process that happens to be holding the counter", and a
 * flood would simply spread across instances. Nothing about that is a limit.
 *
 * So the counter is a row (migration 0011). One atomic upsert per request answers both
 * "how many so far" and "when does this window end", which is exactly the contract the
 * plugin asks a store for, and it is answered from state every instance shares. That is
 * what makes the ceiling hold across a rolling restart: there is no in-process state to
 * lose.
 *
 * Three consequences worth stating rather than discovering later:
 *
 *   - A limiter outage fails open, not closed. If PostgreSQL cannot answer, the request
 *     is allowed and the failure is logged. The limiter is a throttle; the authorisation
 *     boundary is the session, the scope and the row-level policies, and a throttle that
 *     turns a database hiccup into a total outage is worse than the flood it prevents.
 *   - The subject is never stored. A bucket key is `<namespace>|<subject>` where the
 *     subject is an address or a distribution token, and the row holds a *salted hash*
 *     of the subject, so the table cannot be read as a log of who was throttled. The
 *     namespace stays in the clear because it is a fixed word ('ip', 'link') and it is
 *     what an operator needs to group by.
 *   - Windows are fixed. A counter opens on its first request and holds until it expires;
 *     `continueExceeding` and `exponentialBackoff` are deliberately not implemented, so
 *     the `ttl` reported is always the remaining time in the current window.
 */

/**
 * The ceilings this deployment counts under. Open ended in the database; named here so
 * a key's namespace is a word rather than a guess.
 */
export type RateLimitNamespace = 'ip' | 'link';

/** One minute, the same window the limiter's own default header arithmetic assumes. */
const DEFAULT_WINDOW_MS = 60_000;

/** Sweep expired windows roughly every this many requests, per process. */
const SWEEP_EVERY = 500;

/** How long an expired window is kept before the sweep removes it. */
const EXPIRED_RETENTION_MS = 6 * 60 * 60 * 1000;

/** A database that cannot answer must not fill the log at request rate. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * The key the store hashes: `<namespace>|<subject>`.
 *
 * Building it in one place is what keeps the namespace vocabulary honest and what lets
 * the store hold a hash instead of the subject.
 */
export function rateLimitKey(namespace: RateLimitNamespace, subject: string): string {
  return `${namespace}|${subject}`;
}

/**
 * The bucket a subject is counted in: salted SHA-256, so the table holds a pseudonym.
 *
 * The salt is the deployment's existing OTP pepper rather than a new secret, because a
 * new required variable would mean every running deployment had to be reconfigured
 * before the limiter worked — and the alternative to a salt is a table of raw addresses.
 * Anyone who can read this table can also read the pepper file, so the salt is not a
 * claim about a hostile database administrator; it is what keeps an address, a token and
 * an API key from being *enumerable* out of a counter row, and it is domain separated so
 * the same secret cannot be correlated between its two uses.
 */
export function rateLimitSubjectHash(subject: string): string {
  return createHash('sha256').update(`inicio:rate-limit:v1:${env.OTP_PEPPER}:${subject}`, 'utf8').digest('hex');
}

/** What the plugin expects back: the count in this window and its remaining milliseconds. */
export interface RateLimitCount {
  current: number;
  ttl: number;
}

type IncrCallback = (error: Error | null, result?: RateLimitCount) => void;

/**
 * The params the plugin hands a store constructor: its merged settings, whose
 * `timeWindow` is already resolved to milliseconds.
 */
interface StoreParams {
  timeWindow?: number | ((req: FastifyRequest, key: string) => number | Promise<number>);
}

/** Injectable so a test can point the store at a connection that fails. */
export interface RateLimitStoreDeps {
  db?: Pick<Pool, 'query'>;
}

/**
 * The store: one statement per request, and it is the same statement for a new window
 * and an expired one.
 *
 * `DO UPDATE ... CASE WHEN counter.reset_at > clock_timestamp()` is what makes expiry
 * work without a transaction and without a second round trip: a live window increments,
 * an expired window restarts from one and takes a fresh `reset_at`, and either way the
 * statement returns the row, so there is no "did the row exist" branch to get wrong.
 * The clock is the database's on both sides, so two instances cannot disagree about when
 * a window ended.
 */
export class PostgresRateLimitStore {
  private readonly db: Pick<Pool, 'query'>;
  private readonly deps: RateLimitStoreDeps;
  private readonly fallbackWindowMs: number;
  private calls = 0;
  private lastFailureAt = 0;

  /**
   * `params` is typed `unknown` because that is what the plugin passes: its own
   * settings object, which it types as an empty interface. Narrowing it here is the
   * one cast this seam needs, and it is where `timeWindow` is read.
   */
  constructor(params: unknown = {}, deps: RateLimitStoreDeps = {}) {
    this.db = deps.db ?? pool;
    this.deps = deps;
    const window = (params as StoreParams | undefined)?.timeWindow;
    this.fallbackWindowMs = typeof window === 'number' && window > 0 ? window : DEFAULT_WINDOW_MS;
  }

  /**
   * Count this request.
   *
   * `max` is deliberately unused: the store counts and the plugin decides whether the
   * count is over the ceiling (`current > max`), which is the same division the built-in
   * store makes and keeps one definition of "exceeded" in the plugin's headers.
   */
  incr(key: string, callback: IncrCallback, timeWindow?: number, _max?: number): void {
    const windowMs = typeof timeWindow === 'number' && timeWindow > 0 ? timeWindow : this.fallbackWindowMs;
    const { namespace, bucket } = bucketOf(key);
    void this.bump(namespace, bucket, windowMs).then(
      (count) => callback(null, count),
      (error: unknown) => {
        this.report(error, namespace);
        // Fail open: `current` below any ceiling, and a full window reported so a
        // client's own retry arithmetic is not told to come back in zero seconds.
        callback(null, { current: 0, ttl: windowMs });
      },
    );
    this.maybeSweep();
  }

  /**
   * `@fastify/rate-limit` clones a store for a route that overrides the limit. The clone
   * shares nothing but configuration: the counters are in the table, so a clone in
   * another instance and this one count the same bucket.
   */
  child(params: unknown): PostgresRateLimitStore {
    return new PostgresRateLimitStore(params ?? {}, this.deps);
  }

  /**
   * Delete windows that have been over for a while. Bounded work, and safe to call at
   * any time: a row that is still live is inside its own window by definition.
   */
  async purgeExpired(olderThanMs = EXPIRED_RETENTION_MS): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM rate_limit_counter
        WHERE reset_at < clock_timestamp() - make_interval(secs => $1::double precision / 1000)`,
      [olderThanMs],
    );
    return rowCount ?? 0;
  }

  private async bump(namespace: string, bucket: string, windowMs: number): Promise<RateLimitCount> {
    const { rows } = await this.db.query<{ count: number; ttl: string | number }>(
      `INSERT INTO rate_limit_counter AS counter (namespace, key_hash, window_ms, count, reset_at)
       VALUES ($1, $2, $3::bigint, 1, clock_timestamp() + make_interval(secs => $4::double precision / 1000))
       ON CONFLICT (namespace, key_hash) DO UPDATE
          SET count = CASE WHEN counter.reset_at > clock_timestamp() THEN counter.count + 1 ELSE 1 END,
              window_ms = CASE WHEN counter.reset_at > clock_timestamp() THEN counter.window_ms ELSE EXCLUDED.window_ms END,
              reset_at = CASE WHEN counter.reset_at > clock_timestamp() THEN counter.reset_at
                              ELSE clock_timestamp() + make_interval(secs => $4::double precision / 1000) END
       RETURNING count,
                 GREATEST(0, CEIL(EXTRACT(EPOCH FROM (counter.reset_at - clock_timestamp())) * 1000))::bigint AS ttl`,
      // The window travels as two parameters because one of them is a bigint column and
      // the other a double precision interval: reusing one placeholder in both places
      // would leave PostgreSQL deducing two types for it.
      [namespace, bucket, windowMs, windowMs],
    );
    const row = rows[0];
    if (!row) throw new Error('the rate limit counter statement returned no row');
    return { current: Number(row.count), ttl: Number(row.ttl) };
  }

  private maybeSweep(): void {
    this.calls += 1;
    if (this.calls % SWEEP_EVERY !== 0) return;
    void this.purgeExpired().catch(() => {
      // Housekeeping, and nothing depends on it: a failed sweep leaves rows behind.
    });
  }

  /**
   * Say what happened, once a minute rather than once a request.
   *
   * The plugin swallows a store error silently when `skipOnError` is on (which is how a
   * limiter is configured to fail open), so if the store does not log, a database problem
   * becomes invisible while every ceiling quietly stops being enforced.
   */
  private report(error: unknown, namespace: string): void {
    const now = Date.now();
    if (now - this.lastFailureAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureAt = now;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[rate-limit] the durable counter could not be read (namespace "${namespace}"), so this request ` +
        `was allowed without being counted: ${detail}. The limiter fails open on purpose (it is a ` +
        'throttle, not an authorisation boundary); repeated lines here mean the limits are not being enforced.',
    );
  }
}

function bucketOf(key: string): { namespace: string; bucket: string } {
  const separator = key.indexOf('|');
  if (separator === -1) return { namespace: 'unclassified', bucket: rateLimitSubjectHash(key) };
  return {
    namespace: key.slice(0, separator),
    bucket: rateLimitSubjectHash(key.slice(separator + 1)),
  };
}

export interface DurableLimitOptions {
  /** Requests allowed per window for one subject. */
  max: number;
  namespace: RateLimitNamespace;
  /** What a bucket is kept for. Defaults to the request's address. */
  subject?: (req: FastifyRequest) => string;
  /** Defaults to one minute, the same window as the plugin's own default. */
  timeWindow?: number | string;
}

/**
 * Register a durable ceiling.
 *
 * Registered at the root it covers every route (`ip`); registered inside a plugin it
 * covers that plugin's routes and nothing else, which is what makes the per-link ceiling
 * in `platform/collect.ts` a second, independent limit rather than a replacement for the
 * per-address one. Two registrations keep two counters, and both run for a request that
 * is inside both scopes.
 */
export async function registerDurableLimit(
  app: FastifyInstance,
  options: DurableLimitOptions,
): Promise<void> {
  const subject = options.subject ?? ((req: FastifyRequest) => req.ip ?? 'unknown');
  await app.register(rateLimit, {
    max: options.max,
    timeWindow: options.timeWindow ?? '1 minute',
    store: PostgresRateLimitStore,
    keyGenerator: (req) => rateLimitKey(options.namespace, subject(req)),
    // Fail open (see the class comment): an unreachable counter must not take the API
    // down, and the store logs the failure so this is visible rather than silent.
    skipOnError: true,
  });
}
