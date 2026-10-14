-- Double-entry ledger (FR-WAL-001 to FR-WAL-004, FR-WAL-007, FR-WAL-011).

-- One account per owner + player + kind + currency (FR-WAL-002). balance is a projection
-- of the sum of the account's entry lines, updated in the same transaction (FR-WAL-003).
CREATE TABLE accounts (
  id bigserial PRIMARY KEY,
  owner text NOT NULL CHECK (owner IN ('PLAYER', 'OPERATOR')),
  player_id uuid,
  kind text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('XAF', 'EUR', 'USD')),
  balance bigint NOT NULL DEFAULT 0,
  CHECK ((owner = 'PLAYER') = (player_id IS NOT NULL)),
  CHECK (
    (owner = 'PLAYER' AND kind IN ('CASH', 'BONUS', 'PENDING_WITHDRAWAL'))
    OR (owner = 'OPERATOR' AND kind IN ('PSP_CLEARING', 'BETS_OPEN', 'GGR', 'BONUS_COST', 'ADJUSTMENTS', 'WITHDRAWALS_PAYABLE'))
  ),
  -- Defence in depth for FR-WAL-004; the service checks first and reports insufficient_funds.
  CHECK (owner = 'OPERATOR' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_player_key ON accounts (player_id, kind, currency) WHERE owner = 'PLAYER';
CREATE UNIQUE INDEX accounts_operator_key ON accounts (kind, currency) WHERE owner = 'OPERATOR';

CREATE TABLE entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  reference text NOT NULL,
  actor text,
  -- Free-text reason for corrections and adjustments (FR-WAL-007, FR-WAL-011).
  note text,
  -- An entry can be reversed at most once (FR-WAL-007).
  reverses uuid UNIQUE REFERENCES entries (id),
  request_hash text NOT NULL,
  posted_at timestamptz NOT NULL
);

CREATE TABLE entry_lines (
  id bigserial PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES entries (id),
  account_id bigint NOT NULL REFERENCES accounts (id),
  amount bigint NOT NULL CHECK (amount <> 0)
);
CREATE INDEX entry_lines_entry ON entry_lines (entry_id);
CREATE INDEX entry_lines_account ON entry_lines (account_id);

-- Manual adjustments (FR-WAL-011). Both tables are append-only: a request is approved by
-- inserting an approval row, never by updating the request.
CREATE TABLE adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CASH', 'BONUS', 'PENDING_WITHDRAWAL')),
  currency text NOT NULL CHECK (currency IN ('XAF', 'EUR', 'USD')),
  amount bigint NOT NULL CHECK (amount <> 0),
  reason_text text NOT NULL CHECK (length(reason_text) > 0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL
);

CREATE TABLE adjustment_approvals (
  request_id uuid PRIMARY KEY REFERENCES adjustment_requests (id),
  approved_by text NOT NULL,
  entry_id uuid NOT NULL REFERENCES entries (id),
  approved_at timestamptz NOT NULL
);

-- Posted entries and the staff audit trail can never be edited or deleted (FR-WAL-007).
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the ledger is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entry_lines_immutable BEFORE UPDATE OR DELETE ON entry_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entry_lines_no_truncate BEFORE TRUNCATE ON entry_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER adjustment_requests_immutable BEFORE UPDATE OR DELETE ON adjustment_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER adjustment_requests_no_truncate BEFORE TRUNCATE ON adjustment_requests
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER adjustment_approvals_immutable BEFORE UPDATE OR DELETE ON adjustment_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER adjustment_approvals_no_truncate BEFORE TRUNCATE ON adjustment_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

REVOKE UPDATE, DELETE, TRUNCATE ON entries, entry_lines, adjustment_requests, adjustment_approvals FROM PUBLIC;
