-- ============================================================================
-- Inicio School Ranking Survey 2026 — Postgres schema
-- Target: PostgreSQL 15+
-- Tenancy model: shared schema + Row-Level Security (denormalised school_id)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE school_status   AS ENUM ('invited','active','disabled');
CREATE TYPE rs_status       AS ENUM ('draft','submitted','locked');
CREATE TYPE att_status      AS ENUM ('uploaded','pending','not_applicable','deleted');
CREATE TYPE admin_role      AS ENUM ('super_admin','admin','reviewer','viewer');
CREATE TYPE export_format   AS ENUM ('csv','xlsx','json','xml','sav','do','kml','geojson','pdf');
CREATE TYPE job_status      AS ENUM ('queued','running','done','failed');

-- ---------------------------------------------------------------------------
-- Core: schools, OTP, sessions
-- ---------------------------------------------------------------------------
CREATE TABLE school (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  region           text,
  udise_code       text,
  registered_email citext UNIQUE NOT NULL,
  status           school_status NOT NULL DEFAULT 'invited',
  activated        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES school(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,               -- sha256(code + pepper)
  expires_at  timestamptz NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  consumed    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_school_idx ON otp (school_id, expires_at DESC);

CREATE TABLE session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,               -- school:<uuid> | admin:<uuid>
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_subject_idx ON session (subject);

CREATE TABLE admin_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          admin_role NOT NULL DEFAULT 'admin',
  totp_secret   text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Questionnaire (config-driven; JSON is source of truth)
-- ---------------------------------------------------------------------------
CREATE TABLE questionnaire (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version    text NOT NULL,
  status     text NOT NULL DEFAULT 'draft',   -- draft|active|archived
  title      text NOT NULL,
  languages  text[] NOT NULL DEFAULT '{en}',
  config     jsonb NOT NULL,                  -- full sections+questions tree
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX questionnaire_active_idx ON questionnaire (status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Responses
-- ---------------------------------------------------------------------------
CREATE TABLE response_set (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid NOT NULL REFERENCES school(id) ON DELETE CASCADE,
  questionnaire_id     uuid NOT NULL REFERENCES questionnaire(id),
  status               rs_status NOT NULL DEFAULT 'draft',
  completion_pct       numeric(5,2) NOT NULL DEFAULT 0,
  last_section_id      text,
  unique_submission_id text UNIQUE,
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, questionnaire_id)
);
CREATE INDEX rs_school_idx  ON response_set (school_id, status);
CREATE INDEX rs_status_idx  ON response_set (status);

CREATE TABLE answer (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_set_id uuid NOT NULL REFERENCES response_set(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES school(id),   -- denormalised for RLS
  question_id     text NOT NULL,
  value_json      jsonb,
  device_value    jsonb,                                  -- pre-server-validation snapshot
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_set_id, question_id)
);
CREATE INDEX answer_rs_idx     ON answer (response_set_id);
CREATE INDEX answer_school_idx ON answer (school_id);

CREATE TABLE attachment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_set_id uuid NOT NULL REFERENCES response_set(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES school(id),   -- denormalised for RLS
  question_id     text NOT NULL,
  filename        text NOT NULL,
  mime            text NOT NULL,
  size_bytes      integer NOT NULL,
  storage_key     text NOT NULL,
  sha256          text,
  status          att_status NOT NULL DEFAULT 'pending',
  version         integer NOT NULL DEFAULT 1,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX att_school_idx ON attachment (school_id, question_id);
CREATE INDEX att_rs_idx     ON attachment (response_set_id);

-- ---------------------------------------------------------------------------
-- Ops: audit, email, exports, webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id     bigserial PRIMARY KEY,
  actor  text NOT NULL,
  action text NOT NULL,
  target text,
  meta   jsonb NOT NULL DEFAULT '{}',
  ts     timestamptz NOT NULL DEFAULT now(),
  ip     inet
);
CREATE INDEX audit_ts_idx ON audit_log (ts DESC);

CREATE TABLE email_log (
  id        bigserial PRIMARY KEY,
  school_id uuid REFERENCES school(id) ON DELETE SET NULL,
  template  text NOT NULL,
  status    text NOT NULL,                  -- queued|sent|failed
  ts        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE export_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  format      export_format NOT NULL,
  scope       text NOT NULL DEFAULT 'all',  -- all | school:<uuid>
  status      job_status NOT NULL DEFAULT 'queued',
  storage_key text,
  requested_by text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE webhook (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url        text NOT NULL,
  secret     text NOT NULL,
  events     text[] NOT NULL DEFAULT '{submission.created}',
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE webhook_delivery (
  id            bigserial PRIMARY KEY,
  webhook_id    uuid NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending', -- pending|delivered|failed
  attempts      smallint NOT NULL DEFAULT 0,
  ts            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER school_touch       BEFORE UPDATE ON school       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER response_set_touch BEFORE UPDATE ON response_set FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- Session GUCs (set per request from JWT): app.role, app.school_id
-- ---------------------------------------------------------------------------
ALTER TABLE response_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_set FORCE  ROW LEVEL SECURITY;
ALTER TABLE answer       ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer       FORCE  ROW LEVEL SECURITY;
ALTER TABLE attachment   ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment   FORCE  ROW LEVEL SECURITY;

-- Admins: full access
CREATE POLICY rs_admin ON response_set FOR ALL
  USING (current_setting('app.role', true) IN ('super_admin','admin'));
CREATE POLICY an_admin ON answer FOR ALL
  USING (current_setting('app.role', true) IN ('super_admin','admin'));
CREATE POLICY at_admin ON attachment FOR ALL
  USING (current_setting('app.role', true) IN ('super_admin','admin'));

-- Reviewers/viewers: read-only across all schools
CREATE POLICY rs_read ON response_set FOR SELECT
  USING (current_setting('app.role', true) IN ('reviewer','viewer'));
CREATE POLICY an_read ON answer FOR SELECT
  USING (current_setting('app.role', true) IN ('reviewer','viewer'));
CREATE POLICY at_read ON attachment FOR SELECT
  USING (current_setting('app.role', true) IN ('reviewer','viewer'));

-- Schools: only their own rows
CREATE POLICY rs_school ON response_set FOR ALL
  USING (school_id = current_setting('app.school_id', true)::uuid);
CREATE POLICY an_school ON answer FOR ALL
  USING (school_id = current_setting('app.school_id', true)::uuid);
CREATE POLICY at_school ON attachment FOR ALL
  USING (school_id = current_setting('app.school_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- App role (least privilege)
-- ---------------------------------------------------------------------------
-- CREATE ROLE app_role LOGIN PASSWORD '...';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;

-- ---------------------------------------------------------------------------
-- RLS verification (must return 0)
-- ---------------------------------------------------------------------------
-- SET app.role='school'; SET app.school_id='<A>';
-- SELECT count(*) FROM response_set WHERE school_id='<B>';   -- expect 0
