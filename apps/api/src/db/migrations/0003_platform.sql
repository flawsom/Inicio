-- ============================================================================
-- 0003 — multi-tenant platform model
-- Additive. 0001 (the frozen spec schema) is untouched; the school tables it
-- defines are superseded by the org/form/response model here and are retained
-- so the school ranking survey survives as a platform template.
--
-- Tenant boundary: every tenant row carries org_id and is protected by RLS.
-- The API connects as the non-superuser app_role (see 0002), so these policies
-- are actually enforced — superusers and BYPASSRLS roles ignore RLS entirely.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Session helpers. app.user_id and app.org_id are set per request with
-- set_config(..., is_local => true). NULL / '' both mean "not set".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_response() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.response_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_collector() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.collector', true) = 'on'
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext UNIQUE NOT NULL,
  display_name text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE org (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       citext UNIQUE NOT NULL,
  plan       text NOT NULL DEFAULT 'free',
  brand      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER org_touch BEFORE UPDATE ON org FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX membership_user_idx ON membership (user_id);

-- ---------------------------------------------------------------------------
-- Definition
-- ---------------------------------------------------------------------------
CREATE TABLE project (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE form (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES project(id) ON DELETE SET NULL,
  name        text NOT NULL,
  slug        citext NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE TRIGGER form_touch BEFORE UPDATE ON form FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX form_org_idx ON form (org_id);

-- A published version is immutable: each `response` records the exact
-- form_version_id it answered, so editing a form never rewrites history.
-- Restoring an old version creates a NEW version (based_on) rather than
-- mutating the old one.
CREATE TABLE form_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id      uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  title        text NOT NULL,
  definition   jsonb NOT NULL,
  based_on     uuid REFERENCES form_version(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);
CREATE UNIQUE INDEX form_version_one_draft_idx     ON form_version (form_id) WHERE status = 'draft';
CREATE UNIQUE INDEX form_version_one_published_idx ON form_version (form_id) WHERE status = 'published';
CREATE INDEX form_version_org_idx ON form_version (org_id);

-- ---------------------------------------------------------------------------
-- Runtime
-- ---------------------------------------------------------------------------
CREATE TABLE response (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id         uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  form_version_id uuid NOT NULL REFERENCES form_version(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress','submitted','screened_out','quota_full','deleted')),
  respondent_ref  text,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER response_touch BEFORE UPDATE ON response FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX response_org_idx     ON response (org_id, form_id, status);
CREATE INDEX response_version_idx ON response (form_version_id);

CREATE TABLE response_answer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  response_id  uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  question_id  text NOT NULL,
  value        jsonb,
  device_value jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, question_id)
);
CREATE INDEX response_answer_org_idx ON response_answer (org_id);
CREATE INDEX response_answer_response_idx ON response_answer (response_id);

CREATE TABLE response_attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  response_id  uuid NOT NULL REFERENCES response(id) ON DELETE CASCADE,
  question_id  text NOT NULL,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   integer NOT NULL,
  storage_key  text NOT NULL,
  sha256       text,
  scan_status  text NOT NULL DEFAULT 'pending'
               CHECK (scan_status IN ('pending','clean','infected','error','skipped')),
  status       text NOT NULL DEFAULT 'uploaded'
               CHECK (status IN ('uploaded','pending','deleted')),
  version      integer NOT NULL DEFAULT 1,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX response_attachment_org_idx ON response_attachment (org_id, response_id);

-- ---------------------------------------------------------------------------
-- Distribution
-- ---------------------------------------------------------------------------
CREATE TABLE dist_link (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id    uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('anonymous','single_use','multiple','panel')),
  -- token_hash only: the token itself is a bearer credential and is never stored.
  token_hash text UNIQUE,
  label      text,
  expires_at timestamptz,
  max_uses   integer,
  uses       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dist_link_org_idx ON dist_link (org_id, form_id);

CREATE TABLE dist_invite (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id        uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  dist_link_id   uuid REFERENCES dist_link(id) ON DELETE CASCADE,
  email          citext NOT NULL,
  embedded       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','started','finished','bounced','failed')),
  reminder_count integer NOT NULL DEFAULT 0,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dist_invite_org_idx ON dist_invite (org_id, form_id, status);

-- Counted on submission, not reserved at entry — the upstream docs are explicit
-- that concurrent respondents can therefore exceed a target.
CREATE TABLE quota (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id    uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  name       text NOT NULL,
  condition  jsonb,
  target     integer NOT NULL CHECK (target > 0),
  count      integer NOT NULL DEFAULT 0,
  action     text NOT NULL DEFAULT 'end_survey'
             CHECK (action IN ('end_survey','block_entry','hide_block')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_org_idx ON quota (org_id, form_id);

-- ---------------------------------------------------------------------------
-- Ops tables gain an org scope (additive, nullable so existing rows survive).
-- These remain server-written; query-level scoping is enforced in the
-- repository layer and moving them under RLS is a hardening-phase task.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log  ADD COLUMN org_id uuid REFERENCES org(id) ON DELETE SET NULL;
ALTER TABLE email_log  ADD COLUMN org_id uuid REFERENCES org(id) ON DELETE SET NULL;
ALTER TABLE export_job ADD COLUMN org_id uuid REFERENCES org(id) ON DELETE SET NULL;
CREATE INDEX audit_org_idx  ON audit_log (org_id, ts DESC);
CREATE INDEX email_org_idx  ON email_log (org_id, ts DESC);
CREATE INDEX export_org_idx ON export_job (org_id, created_at DESC);

-- SECURITY DEFINER so these can read `membership` without tripping its own
-- policies (which would otherwise recurse). `membership` and `org` are
-- therefore ENABLE RLS without FORCE: the app_role is not their owner, so RLS
-- still applies to the API, while these helpers (owned by the migration role)
-- can look up membership. See the note on each table below.
CREATE OR REPLACE FUNCTION app_is_member(target_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM membership m
     WHERE m.org_id = target_org AND m.user_id = app_current_user()
  )
$$;

CREATE OR REPLACE FUNCTION app_has_org_role(target_org uuid, allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM membership m
     WHERE m.org_id = target_org
       AND m.user_id = app_current_user()
       AND m.role = ANY(allowed)
  )
$$;

CREATE OR REPLACE FUNCTION app_shares_org(target_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM membership mine
      JOIN membership theirs ON theirs.org_id = mine.org_id
     WHERE mine.user_id = app_current_user()
       AND theirs.user_id = target_user
  )
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE  ROW LEVEL SECURITY;
ALTER TABLE org      ENABLE ROW LEVEL SECURITY;   -- no FORCE: app_create_org is SECURITY DEFINER
ALTER TABLE membership ENABLE ROW LEVEL SECURITY; -- no FORCE: helpers read this table

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project','form','form_version','response','response_answer',
                           'response_attachment','dist_link','dist_invite','quota']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- app_user: read yourself or a teammate. There is deliberately NO insert
-- policy: identity writes go through app_find_or_create_user() below, because
-- INSERT ... RETURNING re-applies the SELECT policy and at signup there is no
-- session yet, so a direct insert could not even return its own new row.
CREATE POLICY app_user_self_read   ON app_user FOR SELECT
  USING (id = app_current_user() OR app_shares_org(id));
CREATE POLICY app_user_self_update ON app_user FOR UPDATE
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());

-- org: read any org you belong to; create only via app_create_org().
CREATE POLICY org_member_read   ON org FOR SELECT USING (app_is_member(id));
CREATE POLICY org_admin_update  ON org FOR UPDATE
  USING (app_has_org_role(id, ARRAY['owner','admin']))
  WITH CHECK (app_has_org_role(id, ARRAY['owner','admin']));
CREATE POLICY org_owner_delete  ON org FOR DELETE USING (app_has_org_role(id, ARRAY['owner']));

-- membership: see your own orgs; owners/admins manage the roster.
CREATE POLICY membership_read ON membership FOR SELECT
  USING (user_id = app_current_user() OR app_is_member(org_id));
CREATE POLICY membership_admin_write ON membership FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin']));

-- Standard tenant policies for every org-scoped table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project','form','form_version','response','response_answer',
                           'response_attachment','dist_link','dist_invite','quota']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app_is_member(org_id))', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL
         USING (app_has_org_role(org_id, ARRAY[''owner'',''admin'',''member'']))
         WITH CHECK (app_has_org_role(org_id, ARRAY[''owner'',''admin'',''member'']))', t || '_write', t);
  END LOOP;
END $$;

-- Public collection: a respondent is not a member. The API sets
-- app.collector='on' plus the single app.response_id it may touch, so a public
-- link can insert/read exactly one response and its answers, nothing else.
CREATE POLICY response_collect ON response FOR SELECT
  USING (app_is_collector() AND org_id = app_current_org() AND id = app_current_response());
CREATE POLICY response_collect_insert ON response FOR INSERT
  WITH CHECK (app_is_collector() AND org_id = app_current_org());
CREATE POLICY response_collect_update ON response FOR UPDATE
  USING (app_is_collector() AND org_id = app_current_org() AND id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND id = app_current_response());

CREATE POLICY response_answer_collect ON response_answer FOR SELECT
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());
CREATE POLICY response_answer_collect_write ON response_answer FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

CREATE POLICY response_attachment_collect ON response_attachment FOR SELECT
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());
CREATE POLICY response_attachment_collect_write ON response_attachment FOR ALL
  USING (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response())
  WITH CHECK (app_is_collector() AND org_id = app_current_org() AND response_id = app_current_response());

-- ---------------------------------------------------------------------------
-- Org creation must create the creator's owner membership in the same breath.
-- SECURITY DEFINER so it can write org + membership before any membership
-- exists (the classic bootstrap chicken-and-egg).
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Identity. Signup and login happen before any session exists, so they cannot
-- satisfy an RLS policy keyed to app.user_id. Both paths therefore run here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_find_or_create_user(p_email citext, p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id   uuid;
  v_status text;
BEGIN
  SELECT u.id, u.status INTO v_id, v_status FROM app_user u WHERE u.email = p_email;

  IF v_id IS NULL THEN
    INSERT INTO app_user (email, display_name) VALUES (p_email, p_name) RETURNING id INTO v_id;
  ELSIF v_status = 'active' THEN
    UPDATE app_user SET last_seen_at = now() WHERE id = v_id;
  END IF;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app_get_user(p_email citext)
RETURNS TABLE (id uuid, email citext, display_name text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.display_name, u.status FROM app_user u WHERE u.email = p_email
$$;

CREATE OR REPLACE FUNCTION app_create_org(p_name text, p_slug text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  uuid;
  v_user uuid := app_current_user();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'app.user_id is not set';
  END IF;
  INSERT INTO org (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_org;
  INSERT INTO membership (org_id, user_id, role) VALUES (v_org, v_user, 'owner');
  RETURN v_org;
END $$;


GRANT EXECUTE ON FUNCTION
  app_current_user(), app_current_org(), app_current_response(), app_is_collector(),
  app_is_member(uuid), app_has_org_role(uuid, text[]), app_shares_org(uuid),
  app_create_org(text, text), app_find_or_create_user(citext, text), app_get_user(citext)
  TO app_role;
