-- Exits for states that had none.
-- FR-BO-011: a manual action can be rejected, and expires if nobody approves it within 24 hours.
ALTER TABLE manual_actions DROP CONSTRAINT manual_actions_status_check;
ALTER TABLE manual_actions ADD CONSTRAINT manual_actions_status_check
  CHECK (status IN ('PENDING_APPROVAL', 'EXECUTED', 'REJECTED', 'EXPIRED'));
ALTER TABLE manual_actions ADD COLUMN closed_by text;
ALTER TABLE manual_actions ADD COLUMN closed_at timestamptz;
ALTER TABLE manual_actions ADD COLUMN close_reason text;

-- FR-STL-010: finance closes a review item by retrying the clawback or waiving it; a later
-- resettlement closes it as superseded.
ALTER TABLE manual_review ADD COLUMN resolution text CHECK (resolution IN ('RETRIED', 'WAIVED', 'SUPERSEDED'));
ALTER TABLE manual_review ADD COLUMN resolved_by text;
ALTER TABLE manual_review ADD COLUMN resolved_at timestamptz;

-- FR-STL-001: feed results that disagree with a trader's manual result wait for a trader.
ALTER TABLE result_mismatches ADD COLUMN kind text NOT NULL DEFAULT 'FEEDS_DISAGREE'
  CHECK (kind IN ('FEEDS_DISAGREE', 'FEED_VS_MANUAL'));
