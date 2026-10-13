-- Four-eyes cannot be bypassed by splitting (FR-STL-009, FR-BO-011): the threshold check adds the
-- requester's own unapproved actions of the last 24 hours. Rows inserted to execute without approval
-- count from the moment they are inserted, before they reach EXECUTED.
ALTER TABLE manual_actions ADD COLUMN needs_approval boolean NOT NULL DEFAULT true;
CREATE INDEX manual_actions_requester_recent ON manual_actions (requested_by, created_at) WHERE approved_by IS NULL;
