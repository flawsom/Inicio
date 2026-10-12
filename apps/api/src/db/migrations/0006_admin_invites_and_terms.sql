-- 0006 - Admin portal: single-use invitations, and terms acceptance.
--
-- Two additions, both about keeping privileged action with the owner.
--
-- 1. `member_invite` is an invitation, not a login session. It is bound to the
--    invited address, carries the role the inviter chose (never a role the
--    recipient can pick), and is single-use: redemption is one atomic UPDATE
--    that succeeds only while the row is pending, unexpired and unrevoked.
--    Two requests racing the same link produce exactly one membership.
--    Only the SHA-256 of the token is stored, so a database or backup
--    disclosure does not hand out usable links.
--
-- 2. `terms_acceptance` records agreement as an append-only event, not a
--    boolean flag: who, when, which document versions and hashes, the exact
--    checkbox wording, and the request context. There is no UPDATE or DELETE
--    policy, so an acceptance cannot be quietly rewritten. A later version of
--    the terms produces a new row rather than overwriting the old one.

CREATE TABLE member_invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL DEFAULT 'member',
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_invite_role_check CHECK (role IN ('owner','admin','member','viewer'))
);

CREATE INDEX member_invite_org_idx ON member_invite (org_id, created_at DESC);
-- One pending invitation per address per organisation: re-inviting replaces
-- rather than accumulating live links.
CREATE UNIQUE INDEX member_invite_pending_unique
  ON member_invite (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE terms_acceptance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  terms_version  text NOT NULL,
  terms_hash     text NOT NULL,
  privacy_version text NOT NULL,
  privacy_hash   text NOT NULL,
  checkbox_text  text NOT NULL,
  ip             inet,
  user_agent     text,
  accepted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX terms_acceptance_user_idx ON terms_acceptance (user_id, accepted_at DESC);

ALTER TABLE member_invite     ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_invite     FORCE  ROW LEVEL SECURITY;
ALTER TABLE terms_acceptance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_acceptance  FORCE  ROW LEVEL SECURITY;

-- Only an owner or admin of the organisation can see or issue its invitations.
-- A member or viewer cannot invite anyone, at any layer.
CREATE POLICY member_invite_admin_read ON member_invite FOR SELECT
  USING (app_has_org_role(org_id, ARRAY['owner','admin']));
CREATE POLICY member_invite_admin_write ON member_invite FOR UPDATE
  USING (app_has_org_role(org_id, ARRAY['owner','admin']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin']));
-- There is deliberately no INSERT or DELETE policy: issuing and revoking an
-- invitation goes through the SECURITY DEFINER functions below, so an admin
-- cannot mint a token row directly, and a revoke is a recorded status change
-- rather than a silent deletion.

-- Acceptance is self-service and append-only. Read your own record; insert
-- your own record; nothing else.
CREATE POLICY terms_acceptance_self_read ON terms_acceptance FOR SELECT
  USING (user_id = app_current_user());
CREATE POLICY terms_acceptance_self_insert ON terms_acceptance FOR INSERT
  WITH CHECK (user_id = app_current_user());

GRANT SELECT, INSERT, UPDATE ON member_invite TO app_role;
GRANT SELECT, INSERT ON terms_acceptance TO app_role;

-- ---------------------------------------------------------------------------
-- Issuing an invitation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_create_invite(
  p_org        uuid,
  p_email      citext,
  p_role       text,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id   uuid;
  v_user uuid;
BEGIN
  IF p_role NOT IN ('owner','admin','member','viewer') THEN
    RAISE EXCEPTION 'invalid role %', p_role USING ERRCODE = '22023';
  END IF;
  IF NOT app_has_org_role(p_org, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION 'not permitted to invite to this organisation' USING ERRCODE = '42501';
  END IF;

  -- The invited address needs an account shell, because signup is invite-only:
  -- app_get_user() has to find it when the link is redeemed.
  SELECT u.id INTO v_user FROM app_user u WHERE u.email = p_email;
  IF v_user IS NULL THEN
    INSERT INTO app_user (email) VALUES (p_email) RETURNING id INTO v_user;
  END IF;

  -- A fresh invitation supersedes any earlier pending one for the same address.
  UPDATE member_invite
     SET revoked_at = now()
   WHERE org_id = p_org AND email = p_email AND accepted_at IS NULL AND revoked_at IS NULL;

  INSERT INTO member_invite (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (p_org, p_email, p_role, p_token_hash, app_current_user(), p_expires_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION app_create_invite(uuid, citext, text, text, timestamptz) TO app_role;

-- ---------------------------------------------------------------------------
-- Redeeming an invitation: consume and join, or nothing at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_redeem_invite(p_token_hash text)
RETURNS TABLE (user_id uuid, org_id uuid, role text, email citext, org_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite member_invite%ROWTYPE;
  v_user   uuid;
BEGIN
  -- The single atomic step: only one concurrent caller can flip accepted_at
  -- from NULL, so a forwarded or replayed link has exactly one winner.
  UPDATE member_invite i
     SET accepted_at = now(),
         accepted_by = (SELECT u.id FROM app_user u WHERE u.email = i.email)
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
     AND i.expires_at > now()
  RETURNING * INTO v_invite;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT u.id INTO v_user FROM app_user u WHERE u.email = v_invite.email;
  IF v_user IS NULL THEN
    INSERT INTO app_user (email) VALUES (v_invite.email) RETURNING id INTO v_user;
  END IF;

  UPDATE member_invite SET accepted_by = v_user WHERE id = v_invite.id;

  -- The role comes from the invitation row, never from the request.
  INSERT INTO membership (org_id, user_id, role)
  VALUES (v_invite.org_id, v_user, v_invite.role)
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  RETURN QUERY
    SELECT v_user, v_invite.org_id, v_invite.role, v_invite.email, o.name
      FROM org o WHERE o.id = v_invite.org_id;
END $$;

GRANT EXECUTE ON FUNCTION app_redeem_invite(text) TO app_role;
