-- ============================================================================
-- 0012 — market research console: client groups, version identity, quota matrix,
-- submission review and paradata.
--
-- The 0003 model is a tenant-safe authoring and collection core: an org owns
-- forms, a form owns immutable versions, and a version owns responses. That is
-- the right spine, and none of it is replaced here. What a market research
-- programme needs beyond it is *grouping*, *identity of the instrument across
-- versions*, *counting by cell rather than by total*, and a *record of the
-- judgement a supervisor made*. Each of those is additive.
--
-- Three decisions worth stating:
--
--   * The XLSForm `form_id` lives on `form`, not on `form_version`. It names the
--     instrument, which survives revisions; the version integer names the
--     revision. Putting both on the version would make "this form already
--     exists" a question with as many answers as there are versions.
--
--   * Quota counters are maintained by `app_count_quota_cell`, a SECURITY
--     DEFINER function, rather than by a trigger. A submission runs in the
--     collector's transaction, where the collector policies allow writing only
--     its own response; a trigger updating `quota_cell` would run as that same
--     restricted role and be refused. The function is the same pattern as
--     `app_consume_dist_link` in 0004: the counting rule is in the database, and
--     the caller can only ask for it.
--
--   * `review_log` is append-only at the privilege level, not only by
--     convention. A correction that can be edited later is not a record of what
--     happened; it is a second version of the truth with no history.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Client groups
-- ---------------------------------------------------------------------------
-- The console's top level. `GDN_ORION`, `RND_TESTING`, and so on. Groups never
-- cross an organisation: RLS is on this table exactly as it is on `form`, so a
-- group id from another tenant is a row that does not exist rather than one that
-- returns somebody else's forms.
CREATE TABLE client_group (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  code         citext NOT NULL,
  name         text NOT NULL,
  description  text,
  collapsed    boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE TRIGGER client_group_touch BEFORE UPDATE ON client_group
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX client_group_org_idx ON client_group (org_id, archived_at);

ALTER TABLE form
  ADD COLUMN client_group_id uuid REFERENCES client_group(id) ON DELETE SET NULL,
  -- The workbook's own identity. Unique per organisation so the upload guard is a
  -- unique index rather than a read-then-write race: two people uploading the same
  -- new form at once cannot both succeed.
  ADD COLUMN xlsform_form_id citext,
  ADD COLUMN default_language text NOT NULL DEFAULT 'en';

CREATE UNIQUE INDEX form_xlsform_form_id_idx
  ON form (org_id, xlsform_form_id)
  WHERE xlsform_form_id IS NOT NULL;
CREATE INDEX form_group_idx ON form (org_id, client_group_id);

-- ---------------------------------------------------------------------------
-- What a version was, as a file
-- ---------------------------------------------------------------------------
-- The definition is the authority at runtime. These columns describe the
-- spreadsheet it came from, so an operator can answer "which upload is this"
-- without opening the JSON.
ALTER TABLE form_version
  ADD COLUMN xlsform_version  text,
  -- RSA public key from `settings.public_key`, kept where an export can find it
  -- rather than parsed back out of free-form settings on every request.
  ADD COLUMN public_key       text,
  ADD COLUMN submission_url   text,
  ADD COLUMN source_filename  text,
  ADD COLUMN source_sha256    text,
  ADD COLUMN uploaded_by      uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- A version identity that is all digits is the YYMMDDHHmm stamp the workbook's
-- own `version` formula writes. Other strings are legal because a hand-authored
-- workbook may use `1`, `v3` or a date; the monotonic comparison is a property of
-- the ordered text, and it is enforced at upload (see the compiler's
-- `checkUpload`), not by a CHECK here.
CREATE INDEX form_version_xlsform_version_idx
  ON form_version (form_id, xlsform_version);

-- ---------------------------------------------------------------------------
-- Quota matrix
-- ---------------------------------------------------------------------------
-- 0003 modelled a quota as one condition with a target. That covers "300
-- completed interviews"; it cannot express "blr x female x 25-34 = 40", which is
-- the cell a market research quota is actually about. The row stays, gains a
-- kind, and cells carry the cross-tab.
ALTER TABLE quota
  ADD COLUMN kind              text NOT NULL DEFAULT 'simple'
                               CHECK (kind IN ('simple','crosstab')),
  ADD COLUMN status            text NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open','paused','closed')),
  -- The question that names the enumerator, when per-interviewer caps apply.
  ADD COLUMN enumerator_field  text,
  ADD COLUMN per_enumerator_limit integer CHECK (per_enumerator_limit IS NULL OR per_enumerator_limit > 0),
  ADD COLUMN created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER quota_touch BEFORE UPDATE ON quota
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE quota_cell (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  quota_id    uuid NOT NULL REFERENCES quota(id) ON DELETE CASCADE,
  -- The dimension values, e.g. {"city":"blr","gender":"female","age_band":"25_34"}.
  -- A jsonb object rather than a text tuple because the console renders the
  -- dimensions by name, and a stringly-typed key cannot be un-rendered.
  key         jsonb NOT NULL,
  label       text NOT NULL,
  target      integer NOT NULL CHECK (target > 0),
  -- Kept in step by app_count_quota_cell in the submission's transaction. It can
  -- exceed `target` under concurrency: 0003's note is explicit that counts are
  -- taken on submission rather than reserved at entry, so a target is a ceiling
  -- that the next arrival is refused against, not a lock.
  count       integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  closed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quota_id, label)
);
CREATE INDEX quota_cell_org_idx   ON quota_cell (org_id, quota_id);
CREATE INDEX quota_cell_open_idx  ON quota_cell (quota_id) WHERE closed_at IS NULL;

-- One row per response per cell. This is what makes counting idempotent: a
-- retried submit, a synced save, or a quota path that runs twice cannot count the
-- same interview twice, because the unique index refuses the second row and the
-- function only increments when it actually inserted one.
CREATE TABLE quota_count (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  quota_id      uuid NOT NULL REFERENCES quota(id) ON DELETE CASCADE,
  quota_cell_id uuid NOT NULL REFERENCES quota_cell(id) ON DELETE CASCADE,
  response_id   uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  enumerator    text,
  counted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quota_cell_id, response_id)
);
CREATE INDEX quota_count_quota_idx ON quota_count (quota_id, counted_at DESC);
CREATE INDEX quota_count_enumerator_idx
  ON quota_count (quota_id, enumerator)
  WHERE enumerator IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Submissions: termination, assignment, review state
-- ---------------------------------------------------------------------------
-- `response` already has the statuses that matter (screened_out, quota_full).
-- What is missing is *why* it ended and *who has looked at it*.
ALTER TABLE response
  ADD COLUMN review_state            text NOT NULL DEFAULT 'none'
                                     CHECK (review_state IN ('none','pending','approved','rejected')),
  -- The screener code that ended the interview, e.g. `SQ5A_NOT_SHOPPER`. Stored
  -- as text because it is the client's coding frame, not ours.
  ADD COLUMN termination_code        text,
  ADD COLUMN terminated_at_question  text,
  ADD COLUMN quota_cell_id           uuid REFERENCES quota_cell(id) ON DELETE SET NULL,
  -- `?caseid=` from the collection link, or a case id chosen offline.
  ADD COLUMN caseid                  text,
  ADD COLUMN enumerator_ref          text,
  ADD COLUMN device_id               text,
  -- The server's own measurement, not the device's claim. Written at submit from
  -- the response's own timestamps.
  ADD COLUMN duration_seconds        numeric(12,3);

CREATE INDEX response_review_idx
  ON response (org_id, form_id, review_state)
  WHERE review_state <> 'none';
CREATE INDEX response_caseid_idx
  ON response (org_id, caseid)
  WHERE caseid IS NOT NULL;
CREATE INDEX response_quota_cell_idx
  ON response (quota_cell_id)
  WHERE quota_cell_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Review log
-- ---------------------------------------------------------------------------
-- Every judgement about a response, in order. `corrections` is a JSON array of
-- {questionId, from, to, reason}: the original value is copied into the log, not
-- overwritten out of existence. An approve/reject is also a row, so the queue can
-- answer "who cleared this and what did they say" months later.
CREATE TABLE review_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id      uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  response_id  uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN
                 ('claim','comment','correction','approve','reject','reopen','assign')),
  from_state   text,
  to_state     text,
  note         text,
  corrections  jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_log_response_idx ON review_log (response_id, created_at);
CREATE INDEX review_log_org_idx      ON review_log (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION app_review_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_log is append-only: % is not permitted', TG_OP;
END $$;

CREATE TRIGGER review_log_no_update BEFORE UPDATE OR DELETE ON review_log
  FOR EACH ROW EXECUTE FUNCTION app_review_log_append_only();

-- ---------------------------------------------------------------------------
-- Paradata
-- ---------------------------------------------------------------------------
-- `text audit` produces one row per field per response: how long it was on
-- screen in total, when it first appeared, and how many times it was revisited.
-- A field that was shown for 0.4 seconds is evidence; a per-response total is
-- only a suspicion.
CREATE TABLE response_field_timing (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  response_id       uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  field_name        text NOT NULL,
  total_seconds     numeric(12,3) NOT NULL CHECK (total_seconds >= 0),
  first_seen_seconds numeric(12,3) CHECK (first_seen_seconds IS NULL OR first_seen_seconds >= 0),
  visits            integer NOT NULL DEFAULT 1 CHECK (visits >= 1),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, field_name)
);
CREATE INDEX response_field_timing_response_idx ON response_field_timing (response_id);
CREATE INDEX response_field_timing_org_idx      ON response_field_timing (org_id, field_name);

-- An `audio audit` clip is an object in the same store as any other attachment,
-- with the same scan status vocabulary. It is attached to a *response*, not to a
-- question's answer, because the respondent never chose to record it.
CREATE TABLE response_audit_clip (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  response_id       uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  field_name        text NOT NULL,
  storage_key       text NOT NULL,
  mime              text NOT NULL DEFAULT 'audio/webm',
  size_bytes        integer NOT NULL CHECK (size_bytes > 0),
  duration_seconds  numeric(12,3),
  sha256            text,
  scan_status       text NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','infected','error','skipped')),
  started_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, field_name)
);
CREATE INDEX response_audit_clip_org_idx ON response_audit_clip (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Counting a cell
-- ---------------------------------------------------------------------------
-- Returns the cell's state after the attempt. `counted` is false when this
-- response was already in the cell, which is what makes a replayed submission
-- harmless. `full` is computed after the increment so the caller can end the
-- interview on the arrival that filled the last place.
CREATE OR REPLACE FUNCTION app_count_quota_cell(
  p_quota_id uuid,
  p_cell_id  uuid,
  p_response uuid,
  p_enumerator text DEFAULT NULL
)
RETURNS TABLE (counted boolean, cell_count integer, cell_target integer, cell_closed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      uuid;
  v_inserted boolean := false;
BEGIN
  SELECT q.org_id INTO v_org FROM quota q WHERE q.id = p_quota_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'quota % does not exist', p_quota_id;
  END IF;

  INSERT INTO quota_count (org_id, quota_id, quota_cell_id, response_id, enumerator)
  VALUES (v_org, p_quota_id, p_cell_id, p_response, p_enumerator)
  ON CONFLICT (quota_cell_id, response_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted THEN
    UPDATE quota_cell c SET count = c.count + 1 WHERE c.id = p_cell_id;
    UPDATE quota q SET count = q.count + 1 WHERE q.id = p_quota_id;
  END IF;

  RETURN QUERY
    SELECT v_inserted, c.count, c.target, (c.closed_at IS NOT NULL OR c.count >= c.target)
      FROM quota_cell c
     WHERE c.id = p_cell_id;
END $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE client_group          ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_group          FORCE  ROW LEVEL SECURITY;
ALTER TABLE quota_cell            ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_cell            FORCE  ROW LEVEL SECURITY;
ALTER TABLE quota_count           ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_count           FORCE  ROW LEVEL SECURITY;
ALTER TABLE review_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_log            FORCE  ROW LEVEL SECURITY;
ALTER TABLE response_field_timing ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_field_timing FORCE  ROW LEVEL SECURITY;
ALTER TABLE response_audit_clip   ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_audit_clip   FORCE  ROW LEVEL SECURITY;

CREATE POLICY client_group_read ON client_group FOR SELECT USING (app_is_member(org_id));
CREATE POLICY client_group_write ON client_group FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY quota_cell_read ON quota_cell FOR SELECT USING (app_is_member(org_id));
CREATE POLICY quota_cell_write ON quota_cell FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY quota_count_read ON quota_count FOR SELECT USING (app_is_member(org_id));
CREATE POLICY quota_count_write ON quota_count FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY review_log_read ON review_log FOR SELECT USING (app_is_member(org_id));
CREATE POLICY review_log_write ON review_log FOR INSERT
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY response_field_timing_read ON response_field_timing FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY response_field_timing_write ON response_field_timing FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY response_audit_clip_read ON response_audit_clip FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY response_audit_clip_write ON response_audit_clip FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

-- A respondent's device writes the paradata for its own response, and nothing
-- else. These mirror the collector policies in 0003 and 0009 exactly.
CREATE POLICY response_field_timing_collect ON response_field_timing FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

CREATE POLICY response_audit_clip_collect ON response_audit_clip FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  client_group, quota_cell, quota_count,
  response_field_timing, response_audit_clip
  TO app_role;

-- Append-only, and the grant says so: there is no UPDATE or DELETE to revoke
-- because neither is ever given.
GRANT SELECT, INSERT ON review_log TO app_role;

GRANT EXECUTE ON FUNCTION app_count_quota_cell(uuid, uuid, uuid, text) TO app_role;
