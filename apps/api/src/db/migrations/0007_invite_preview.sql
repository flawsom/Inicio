-- 0007 - Reading an invitation without spending it.
--
-- An emailed link is often fetched by a mail scanner, a link preview or a
-- corporate proxy before the person ever clicks it. If a GET consumed the
-- invitation, those tools would burn it and the human would arrive at an
-- "invalid link" page for a link that was never used.
--
-- So resolution and redemption are separated: this function only looks. It is
-- SECURITY DEFINER because it answers before any session exists, and it returns
-- nothing but the organisation name, the invited address, the role and the
-- expiry of the one row whose token hash was presented. It cannot enumerate.

CREATE OR REPLACE FUNCTION app_peek_invite(p_token_hash text)
RETURNS TABLE (email citext, role text, org_name text, expires_at timestamptz, pending boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.email,
         i.role,
         o.name,
         i.expires_at,
         (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS pending
    FROM member_invite i
    JOIN org o ON o.id = i.org_id
   WHERE i.token_hash = p_token_hash
$$;

GRANT EXECUTE ON FUNCTION app_peek_invite(text) TO app_role;
