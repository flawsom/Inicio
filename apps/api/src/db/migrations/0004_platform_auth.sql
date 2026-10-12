-- ============================================================================
-- 0004 — platform identity and roster
--
-- Phase 1's `otp` table is keyed to `school(id) NOT NULL`, and its sessions are
-- `school:<uuid>`. The platform's identity is `app_user`, so sign-in needs its
-- own code store. This is additive: the school flow keeps working.
-- ============================================================================

-- Sign-in codes are issued to a person, not to an organisation. Like `otp`, this
-- table is written before any session exists, so it is deliberately not under
-- RLS — the auth path is the only writer, and it never exposes another user's row.
CREATE TABLE user_otp (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   smallint NOT NULL DEFAULT 0,
  consumed   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_otp_user_idx ON user_otp (user_id, expires_at DESC);

-- Adding a teammate means naming someone who is not yet a teammate, and
-- `app_user`'s read policy only exposes yourself and your teammates. Without a
-- SECURITY DEFINER helper an owner literally cannot invite anyone. The role check
-- lives inside the function, so it is not a way around the policies.
CREATE OR REPLACE FUNCTION app_invite_member(p_org uuid, p_email citext, p_role text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
BEGIN
  IF p_role NOT IN ('owner','admin','member','viewer') THEN
    RAISE EXCEPTION 'invalid role %', p_role USING ERRCODE = '22023';
  END IF;
  IF NOT app_has_org_role(p_org, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION 'not permitted to manage this organisation' USING ERRCODE = '42501';
  END IF;

  SELECT u.id INTO v_user FROM app_user u WHERE u.email = p_email;
  IF v_user IS NULL THEN
    INSERT INTO app_user (email) VALUES (p_email) RETURNING id INTO v_user;
  END IF;

  INSERT INTO membership (org_id, user_id, role) VALUES (p_org, v_user, p_role)
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  RETURN v_user;
END $$;

GRANT EXECUTE ON FUNCTION app_invite_member(uuid, citext, text) TO app_role;

-- Public collection cannot read `dist_link` under RLS: a respondent is not a member.
-- Resolving the bearer token to its organisation is therefore done here, and only
-- this: the function is a lookup of exactly the row whose token hash was presented,
-- so it cannot be walked to enumerate other links or organisations.
CREATE OR REPLACE FUNCTION app_resolve_dist_link(p_token_hash text)
RETURNS TABLE (id uuid, org_id uuid, form_id uuid, kind text, expires_at timestamptz, max_uses integer, uses integer, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.org_id, l.form_id, l.kind, l.expires_at, l.max_uses, l.uses, l.active
    FROM dist_link l
   WHERE l.token_hash = p_token_hash
$$;

-- Concurrency-safe use counting: two respondents submitting at once must not both
-- slip past `max_uses`. Counting happens on submission, as the upstream docs say.
CREATE OR REPLACE FUNCTION app_consume_dist_link(p_link_id uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE dist_link
     SET uses = uses + 1
   WHERE id = p_link_id
     AND active
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_uses IS NULL OR uses < max_uses)
     -- A single-use link is single-use even when no explicit cap was set.
     AND (kind <> 'single_use' OR uses < 1)
  RETURNING uses
$$;

GRANT EXECUTE ON FUNCTION app_resolve_dist_link(text), app_consume_dist_link(uuid) TO app_role;

-- ---------------------------------------------------------------------------
-- A respondent has to be able to *read the survey they are answering*. The
-- tenant policy on form_version requires membership, which a collector is not,
-- so public collection saw "no published version" and refused every submission.
-- The narrow grant here is: the published version, in the organisation the token
-- resolved to. Drafts, other organisations and other versions stay invisible.
-- ---------------------------------------------------------------------------
CREATE POLICY form_version_collect ON form_version FOR SELECT
  USING (app_is_collector() AND org_id = app_current_org() AND status = 'published');
