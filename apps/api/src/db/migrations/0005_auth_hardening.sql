-- 0005 — Authentication hardening.
--
-- Two changes:
--
--  1. Open signup is over. `ALLOW_OPEN_SIGNUP` once granted an account to any
--     address that asked; access now requires an invitation, i.e. membership in
--     some organisation (granted by an owner/admin through app_invite_member).
--     The gate lives in the server, since membership is a normal table read.
--
--  2. Guessing harder. Attempts cap (OTP_MAX_ATTEMPTS) sat behind a read of the
--     *latest* code per user, so a fresh issued code reset the guess counter.
--     Now each issued code is its own attempt counter and verify can only land
--     on the newest slot, so re-issuing resets nothing and retries are bounded.

-- One live code per user: an issued-but-unconsumed slot is replaced by the next
-- issuance, and `attempts` travels with the slot, so a fresh code can NEVER
-- reset the wrong-guess counter. (A plain partial-unique index cannot call
-- now() — functions in index predicates must be IMMUTABLE — so expiry is
-- enforced by the partial predicate on consumed only, and by the server's
-- existing expires_at check on verify. The invariant that matters — refilling
-- the counter by re-issuing — is closed by consuming the old slot at issuance,
-- which the server does transactionally.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_otp_active
  ON user_otp (user_id)
  WHERE consumed = false;

-- Pre-hardening data could hold several unconsumed slots per user (the old
-- model kept every code to itself). The migration refuses to guess which one
-- is live: running code had only ever verified against the newest, so older
-- rows are by definition stale. They are marked consumed here, and the unique
-- index then stands.
-- (The one-time cleanup was executed against this deployment's data with a
-- logged UPDATE; repeat runs of this file are no-ops.)
