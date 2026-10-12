-- 0008 - Fix: app_redeem_invite was ambiguous, so redeeming never worked.
--
-- What was wrong: the function's own OUT parameters were named user_id, org_id,
-- role, email and org_name. Inside a PL/pgSQL body those names are variables, so
-- `INSERT INTO membership (org_id, user_id, role)` became an ambiguous column
-- reference and the whole redemption failed with a 500. The tests caught it on
-- first run, which is the reason invitations are exercised end to end rather
-- than only created.
--
-- The fix: prefix the OUT names so they cannot collide with any column, and have
-- the API alias them back to the names it expects. Migration 0006 is left exactly
-- as it ran; this file replaces the function definition.

DROP FUNCTION IF EXISTS app_redeem_invite(text);

CREATE OR REPLACE FUNCTION app_redeem_invite(p_token_hash text)
RETURNS TABLE (out_user_id uuid, out_org_id uuid, out_role text, out_email citext, out_org_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite member_invite%ROWTYPE;
  v_user   uuid;
BEGIN
  -- The single atomic step: only one concurrent caller can flip accepted_at from
  -- NULL, so a forwarded or replayed link has exactly one winner.
  UPDATE member_invite i
     SET accepted_at = now()
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
      FROM org o
     WHERE o.id = v_invite.org_id;
END $$;

GRANT EXECUTE ON FUNCTION app_redeem_invite(text) TO app_role;
