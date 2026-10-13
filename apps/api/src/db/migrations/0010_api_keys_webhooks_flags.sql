-- ============================================================================
-- 0010 — integrations and quality control: API keys, webhooks, flags
--
-- Three tables sets, one reason each:
--
--   api_key            a machine credential for one organisation. It is bound to
--                      a *user*, not just an organisation, and that is the whole
--                      design: every policy in 0003 authorises through
--                      `membership`, so a key that carried only an org id would
--                      either need a parallel policy branch (more surface, and a
--                      second place to get tenancy wrong) or would have to bypass
--                      RLS. Bound to its creator, the key inherits exactly the
--                      tenant boundary a browser session has, removing that
--                      person from the team kills the key, and nothing in the
--                      policy set changes.
--
--   webhook_endpoint   where an organisation wants its events delivered.
--   webhook_delivery   one row per attempt-to-make, written in the same
--                      transaction as the event it describes. That is what makes
--                      an event exactly-once with the data: a publish that
--                      committed has a delivery row, and a publish that rolled
--                      back has none. Delivery itself is at-least-once with a
--                      stable delivery id, which is the only honest promise an
--                      HTTP client can make.
--
--   response_flag      a small, explicit vocabulary for "this response deserves a
--                      look" — computed at submission time where it can be
--                      computed, and raisable by a person where judgement is
--                      required. A queue, not a score: the point is that
--                      somebody can work through it and that the decision is
--                      recorded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------
-- 0001 already declares an `api_key` table, and it is a stub: label, key_hash,
-- scopes, active — no owner, no organisation, nothing a policy could authorise
-- against, and nothing in the codebase reading it. It is *extended* rather than
-- duplicated, because two tables called "api key" is precisely how a schema ends
-- up with two answers to "who may act as this tenant".
--
-- The columns that already meant the right thing are reused as they are:
--   label     -> the operator-supplied name
--   key_hash  -> sha256(secret), never the secret
--   scopes    -> the vocabulary in platform/keys.ts
--   active    -> liveness (a revoke sets it false and records who and when)
ALTER TABLE api_key
  ADD COLUMN org_id       uuid REFERENCES org(id) ON DELETE CASCADE,
  ADD COLUMN user_id      uuid REFERENCES app_user(id) ON DELETE CASCADE,
  -- The visible half. Shown in the console and in the audit trail so a key can be
  -- identified without ever handling the secret again.
  ADD COLUMN prefix       text,
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN expires_at   timestamptz,
  ADD COLUMN revoked_at   timestamptz,
  ADD COLUMN revoked_by   uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- NOT VALID on purpose: it constrains every row written or updated from here on,
-- and does not pretend to know anything about rows that predate the tenancy model.
-- (There are none in a deployment that never used the stub, and a scan of an empty
-- table costs nothing: `pnpm db:migrate` validates it as soon as it is honest to.)
ALTER TABLE api_key
  ADD CONSTRAINT api_key_tenant_required
  CHECK (org_id IS NOT NULL AND user_id IS NOT NULL AND prefix IS NOT NULL) NOT VALID;

CREATE INDEX api_key_org_idx ON api_key (org_id, created_at DESC);
CREATE INDEX api_key_live_idx ON api_key (org_id) WHERE active AND revoked_at IS NULL;

ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key FORCE  ROW LEVEL SECURITY;

-- Everyone in the organisation can see that a key exists and what it may do;
-- nobody can read a secret back, because there is nothing to read back.
CREATE POLICY api_key_read ON api_key FOR SELECT USING (app_is_member(org_id));
-- Only owners and admins mint or revoke one: a member can act through a key, but
-- issuing a long-lived credential for the organisation is an administrative act.
CREATE POLICY api_key_admin_write ON api_key FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin']));

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------
-- 0001 declares `webhook` (url, secret, events, active) and `webhook_delivery`
-- (webhook_id, event, payload, idempotency_key, status, attempts, ts) as part of
-- the frozen spec schema — again with no organisation, so nothing in them can be
-- authorised. Extended in place, and the columns that already mean the right
-- thing are reused: url, secret, events, active, payload, status, attempts, ts.
ALTER TABLE webhook
  ADD COLUMN org_id          uuid REFERENCES org(id) ON DELETE CASCADE,
  ADD COLUMN description     text,
  ADD COLUMN created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_failure_at timestamptz,
  -- Consecutive failures, reset by a success. At the cap the endpoint disables
  -- itself, because an endpoint that has failed two dozen times in a row is
  -- usually a deleted receiver, and retrying it forever is how a queue turns into
  -- a backlog nobody looks at.
  ADD COLUMN failure_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN disabled_at     timestamptz;

-- HTTPS only, enforced here rather than in the route: a signature sent over
-- plaintext is decoration, and a rule the database owns cannot be forgotten by the
-- second route that adds an endpoint. NOT VALID for the same reason as api_key's:
-- it binds every row from now on without claiming to know about rows that predate
-- the tenancy model.
ALTER TABLE webhook
  ADD CONSTRAINT webhook_tenant_required CHECK (org_id IS NOT NULL) NOT VALID;
ALTER TABLE webhook
  ADD CONSTRAINT webhook_https_only CHECK (url ~ '^https://[^[:space:]]+$') NOT VALID;

CREATE INDEX webhook_org_idx ON webhook (org_id, created_at DESC);

ALTER TABLE webhook ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook FORCE  ROW LEVEL SECURITY;

-- Everyone in the organisation may see where its events go; only owners and
-- admins change it, because an endpoint is an egress channel and whoever controls
-- it decides where the organisation's data is sent.
CREATE POLICY webhook_read ON webhook FOR SELECT USING (app_is_member(org_id));
CREATE POLICY webhook_admin_write ON webhook FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin']));

-- A delivery is created inside the transaction that created the event, which is
-- the only way an event and its delivery cannot disagree. The response body is
-- truncated by the writer (4 kB): a receiver's 500 page is diagnostic, not an
-- archive. `idempotency_key` (0001, NOT NULL UNIQUE) is finally doing its job:
-- one row per (event, endpoint), so an event emitted twice cannot be delivered
-- twice by the enqueue path itself.
ALTER TABLE webhook_delivery
  ADD COLUMN org_id          uuid REFERENCES org(id) ON DELETE CASCADE,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN response_status integer,
  ADD COLUMN response_body   text,
  ADD COLUMN error           text,
  ADD COLUMN delivered_at    timestamptz;

ALTER TABLE webhook_delivery
  ADD CONSTRAINT webhook_delivery_tenant CHECK (org_id IS NOT NULL) NOT VALID;

-- The drain reads exactly this: what is pending and due, oldest first.
CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_delivery_org_idx ON webhook_delivery (org_id, ts DESC);
CREATE INDEX webhook_delivery_webhook_idx ON webhook_delivery (webhook_id, ts DESC);

ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery FORCE  ROW LEVEL SECURITY;

CREATE POLICY webhook_delivery_read ON webhook_delivery FOR SELECT USING (app_is_member(org_id));
-- Member level for writes: the dispatcher enqueues and records outcomes as events
-- happen, which is ordinary data work rather than administration. Deleting an
-- endpoint (and its history) stays owner/admin, on the webhook table itself.
CREATE POLICY webhook_delivery_write ON webhook_delivery FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

-- ---------------------------------------------------------------------------
-- Quality flags
-- ---------------------------------------------------------------------------
CREATE TABLE response_flag (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id     uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  response_id uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  -- Null for a flag about the whole response; set for one about a single answer.
  question_id text,
  kind        text NOT NULL CHECK (kind IN ('speeding','straight_lining','duplicate','manual')),
  severity    text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','severe')),
  -- What made the detector fire: the observed duration, the question ids that were
  -- identical, the id of the response it duplicates. Evidence, not a verdict.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  note        text,
  created_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  resolved_at timestamptz
);
CREATE INDEX response_flag_org_idx ON response_flag (org_id, status, created_at DESC);
CREATE INDEX response_flag_form_idx ON response_flag (form_id, status);
CREATE INDEX response_flag_response_idx ON response_flag (response_id);
-- A detector re-running (a re-submit, a sync retry) must not produce a second copy
-- of the same finding. coalesce() because a per-response flag has a NULL question.
CREATE UNIQUE INDEX response_flag_once_idx
  ON response_flag (response_id, kind, coalesce(question_id, ''));

CREATE POLICY response_flag_read ON response_flag FOR SELECT USING (app_is_member(org_id));
CREATE POLICY response_flag_write ON response_flag FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

ALTER TABLE response_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_flag FORCE  ROW LEVEL SECURITY;

-- The detectors run in the respondent's own transaction (a submission is the only
-- moment the duration, the answers and the timestamp are all in one place), so the
-- collector context needs write access to exactly its own response's flags —
-- mirrored on the collector policies in 0003 and 0009.
CREATE POLICY response_flag_collect ON response_flag FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

-- ---------------------------------------------------------------------------
-- Grants. 0002's ALTER DEFAULT PRIVILEGES covers tables created later by the same
-- role, but being explicit here is what makes the privilege set auditable.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key, webhook, webhook_delivery, response_flag TO app_role;
-- bigserial sequences: 0001 granted app_role USAGE on the sequences that existed
-- then, but not on the ones it will use for new rows in its own tables.
GRANT USAGE, SELECT ON SEQUENCE webhook_delivery_id_seq TO app_role;

-- ---------------------------------------------------------------------------
-- Resolving a key happens *before* any session exists, so it cannot satisfy a
-- policy keyed to app.user_id — the same chicken-and-egg that made signup and
-- invite redemption SECURITY DEFINER in 0003/0008. The function is the lookup and
-- nothing else: it returns the key's owner and organisation, and the caller then
-- runs every subsequent query in the ordinary tenant context, where the
-- membership policies still apply. Possession of a 256-bit hash is the only thing
-- that makes this useful, and the hash is never logged or returned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_resolve_api_key(p_hash text)
RETURNS TABLE (
  id uuid, user_id uuid, org_id uuid, scopes text[], active boolean,
  expires_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.user_id, k.org_id, k.scopes, k.active, k.expires_at, k.revoked_at
    FROM api_key k
   WHERE k.key_hash = p_hash
$$;

-- Mark a key as used, at most once a minute per key. A write on every request
-- would make the hottest credential in the system the busiest row in the
-- database for no extra information: "when was this last used" does not need
-- second precision.
CREATE OR REPLACE FUNCTION app_touch_api_key(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE api_key
     SET last_used_at = now()
   WHERE id = p_id
     AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;

REVOKE ALL ON FUNCTION app_resolve_api_key(text), app_touch_api_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_api_key(text), app_touch_api_key(uuid) TO app_role;

-- ---------------------------------------------------------------------------
-- Enqueuing an event needs to write a delivery row *and* read which endpoints
-- subscribe — and a respondent's transaction may do neither, on purpose: the
-- collector policies confine a public link to its own response, and a link that
-- could enumerate an organisation's webhook endpoints would be a link that leaks
-- where the data goes. So the enqueue is the one SECURITY DEFINER function in this
-- file, and it re-checks the caller's standing itself:
--
--   * from a submission, `app.org_id` is the link's organisation, so the first
--     branch passes and *only* that organisation can be enqueued for;
--   * from the console, `app.user_id` is a member, so the second branch passes;
--   * anything else raises 42501, which the error handler already reports as 403
--     rather than as a server fault.
--
-- This is a widening, and it is stated rather than implied: it is the only way an
-- anonymous submission can honestly produce a `response.submitted` event without
-- teaching a public link to read the organisation's integration settings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_enqueue_webhook(p_org uuid, p_event text, p_payload jsonb, p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT ((p_org IS NOT NULL AND p_org = app_current_org()) OR app_is_member(p_org)) THEN
    RAISE EXCEPTION 'not permitted to enqueue webhooks for this organisation' USING ERRCODE = '42501';
  END IF;

  INSERT INTO webhook_delivery (org_id, webhook_id, event, payload, idempotency_key)
  SELECT p_org, e.id, p_event, p_payload, p_event_id::text || ':' || e.id::text
    FROM webhook e
   WHERE e.org_id = p_org AND e.active AND p_event = ANY(e.events)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION app_enqueue_webhook(uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_enqueue_webhook(uuid, text, jsonb, uuid) TO app_role;

-- The same argument applies to *reading* what is due: the drain needs the endpoint
-- URL and signing secret, and a respondent's transaction may read neither (the
-- `_read` policy on webhook_endpoint is membership-based). Guarded by the identical
-- check, and reachable only from the dispatcher, which takes the organisation from
-- the distribution link rather than from anything a respondent can type.
CREATE OR REPLACE FUNCTION app_due_deliveries(p_org uuid, p_limit integer DEFAULT 20)
RETURNS TABLE (
  id bigint, org_id uuid, webhook_id uuid, event text, payload jsonb, attempts smallint,
  url text, secret text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT ((p_org IS NOT NULL AND p_org = app_current_org()) OR app_is_member(p_org)) THEN
    RAISE EXCEPTION 'not permitted to read deliveries for this organisation' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT d.id, d.org_id, d.webhook_id, d.event, d.payload, d.attempts, e.url, e.secret
      FROM webhook_delivery d
      JOIN webhook e ON e.id = d.webhook_id
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= now()
       AND e.active
       AND d.org_id = p_org
     ORDER BY d.next_attempt_at
     LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION app_due_deliveries(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_deliveries(uuid, integer) TO app_role;

-- ---------------------------------------------------------------------------
-- There is deliberately NO helper function for reading due deliveries.
--
-- The first draft of this migration added a SECURITY DEFINER "due deliveries"
-- function so a drain could sweep across organisations. It is not needed, and
-- granting EXECUTE to app_role would have handed every tenant a way to read
-- another tenant's payloads by passing a foreign org id: the escape hatch would
-- have been wider than the thing it was escaping. Instead:
--
--   * the in-request drain reads its own organisation's due deliveries inside a
--     normal tenant transaction (the `_read` policy above is all it needs), commits
--     to release the connection, then makes the HTTP calls, then records the
--     outcome in a second short transaction. No definer function, no escaping RLS;
--   * the cross-organisation sweep in `scripts/webhooks-drain.ts` runs on the
--     owner connection, which is the connection that already has authority and is
--     never the one serving requests.
-- ---------------------------------------------------------------------------
