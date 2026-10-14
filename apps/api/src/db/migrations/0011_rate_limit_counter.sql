-- 0011: the durable rate limiter's counter.
--
-- Why this table exists at all. `@fastify/rate-limit`'s default store is a
-- per-process LRU map, so the ceiling it enforces is really "per process": run two
-- instances (or one serverless function that recycles between requests, which is
-- the normal case here) and every instance counts from zero. A throttle that resets
-- whenever the platform starts a new process is not a throttle, and the requirement
-- is explicit about it (SR-7: "per-IP and per-form rate limiting that works across
-- instances (durable, not in-memory)"). The counter therefore lives in the one piece
-- of state every instance already shares: this database.
--
-- Why it is not a tenant table. The counter is touched before any request has been
-- authorised, so it cannot read a membership: this is the one table in the schema
-- that deliberately carries no `org_id` and no row level security. It also holds no
-- data about anybody: `key_hash` is a salted SHA-256 of the bucket's subject, so an
-- address or a distribution token cannot be read back out of it, and an operator can
-- still group by `namespace` to see which ceiling is being hit.
--
-- Windows are fixed, not sliding: a bucket is opened at its first request and holds
-- that request count until `reset_at` passes, after which the *same row* is reused
-- for the next window. A fixed window can admit up to twice the limit across a window
-- boundary, which is the standard trade for one atomic statement and no per-request
-- bookkeeping; a limiter's job is to stop a flood, and two bursts of the ceiling back
-- to back is still a bounded rate.
CREATE TABLE rate_limit_counter (
  -- The ceiling being counted: 'ip' for the per-address limit, 'link' for the
  -- per-distribution-link limit on public collection. Open ended on purpose so a
  -- future per-API-key limit is a new value rather than a new table.
  namespace text        NOT NULL,
  -- Salted SHA-256 of the subject (an address, a token). Never the subject itself.
  key_hash  text        NOT NULL,
  window_ms bigint      NOT NULL CHECK (window_ms > 0),
  count     integer     NOT NULL CHECK (count > 0),
  reset_at  timestamptz NOT NULL,
  PRIMARY KEY (namespace, key_hash)
);

-- The sweep in `src/lib/rate-limit.ts` deletes windows that have been over for a
-- while; without this the delete would be a sequential scan every time.
CREATE INDEX rate_limit_counter_expiry ON rate_limit_counter (reset_at);

-- Tables created by this migration need their own grant: 0002's ALTER DEFAULT
-- PRIVILEGES covers objects created later *by the same role*, and naming the
-- privilege set here is what makes it auditable (the same note as in 0009/0010).
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counter TO app_role;
