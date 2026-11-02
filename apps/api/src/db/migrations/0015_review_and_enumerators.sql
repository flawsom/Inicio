-- ============================================================================
-- 0015 - review ownership and enumerator identity.
--
-- 0012 created the append-only review log and the review state, but a queue
-- without a claim is a list two supervisors can work at once. These columns make
-- the claim explicit: who is looking at it, when they took it, and when somebody
-- last decided.
--
-- The dataset kind grows by one value. An enumerator list is a server dataset
-- with the same import, attachment and version-pinning rules as a case list; it
-- is not a second identity system with its own table and its own holes.
-- ============================================================================

ALTER TABLE response
  ADD COLUMN review_claimed_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN review_claimed_at timestamptz,
  ADD COLUMN reviewed_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at       timestamptz,
  ADD COLUMN review_note       text;

CREATE INDEX response_review_claim_idx
  ON response (org_id, form_id, review_claimed_by)
  WHERE review_claimed_by IS NOT NULL;

-- The review queue reads pending responses oldest first. The partial index keeps
-- that read proportional to the queue, not to every response the organisation
-- has ever collected.
CREATE INDEX response_review_queue_idx
  ON response (org_id, form_id, started_at)
  WHERE review_state = 'pending';

ALTER TABLE server_dataset
  DROP CONSTRAINT server_dataset_kind_check;
ALTER TABLE server_dataset
  ADD CONSTRAINT server_dataset_kind_check
  CHECK (kind IN ('data','cases','enumerators'));

-- The statistical checks are flags with evidence, not a separate quality score.
-- Keeping them in the same table means the queue, the review link and the decision
-- log apply to an outlier exactly as they apply to a speeding interview.
ALTER TABLE response_flag
  DROP CONSTRAINT response_flag_kind_check;
ALTER TABLE response_flag
  ADD CONSTRAINT response_flag_kind_check
  CHECK (kind IN (
    'speeding','straight_lining','duplicate','manual',
    'outlier','too_frequent','too_infrequent','group_mean','group_distribution'
  ));
