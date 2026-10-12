-- ============================================================================
-- 0009 — offline-first collection: idempotent writes and explicit conflicts
--
-- INVARIANT (SPEC §16/§17): a device that was offline must be able to sync
-- without duplicating a response and without losing an answer. Two things make
-- that true here:
--
--   1. the respondent's device owns a stable UUID for its response, so a
--      retried "start" after a network flap resolves to the *same* row instead
--      of creating a second one;
--   2. when the same response was edited in two places, both values are kept.
--      The server's value stays authoritative, the device's value is preserved
--      in `response_answer.device_value`, and the disagreement is recorded in
--      `response_conflict` so an analyst can see it instead of losing it.
-- ============================================================================

ALTER TABLE response ADD COLUMN client_uuid uuid;

-- One response per (organisation, client UUID). Partial: rows written by an
-- older client, or by the API on a respondent's behalf, have no client UUID.
CREATE UNIQUE INDEX response_client_uuid_idx
  ON response (org_id, client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE INDEX response_client_uuid_lookup_idx
  ON response (client_uuid)
  WHERE client_uuid IS NOT NULL;

-- A disagreement between what the server holds and what a device sent.
-- Never a silent overwrite: the answer keeps the server value, this table keeps
-- the evidence, and `response_answer.device_value` keeps the device's value.
CREATE TABLE response_conflict (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  response_id  uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  question_id  text NOT NULL,
  kind         text NOT NULL DEFAULT 'device_server_mismatch'
               CHECK (kind IN ('device_server_mismatch','calculation_mismatch')),
  server_value jsonb,
  device_value jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, question_id)
);
CREATE INDEX response_conflict_org_idx ON response_conflict (org_id, detected_at DESC);

ALTER TABLE response_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_conflict FORCE  ROW LEVEL SECURITY;

-- An analyst/editor of the organisation sees a conflict like any other answer.
CREATE POLICY response_conflict_read ON response_conflict FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY response_conflict_write ON response_conflict FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

-- A respondent's own sync writes exactly one response's conflicts, mirrored on
-- the collector policies in 0003.
CREATE POLICY response_conflict_collect ON response_conflict FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

-- Tables created by this migration need their own grant: ALTER DEFAULT
-- PRIVILEGES in 0002 only covers objects created after it ran *by the same
-- role*, and being explicit here keeps `app_role` least-privilege and complete.
GRANT SELECT, INSERT, UPDATE, DELETE ON response_conflict TO app_role;
