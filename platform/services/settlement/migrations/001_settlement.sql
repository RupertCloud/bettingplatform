-- Result intake (FR-STL-001): every submission from every source, as received.
CREATE TABLE result_submissions (
  selection_id   text NOT NULL,
  source         text NOT NULL CHECK (source IN ('feed:primary', 'feed:secondary')),
  result_version integer NOT NULL CHECK (result_version > 0),
  outcome        text NOT NULL CHECK (outcome IN ('WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'DEAD_HEAT')),
  dh_num         integer,
  dh_den         integer,
  received_at    timestamptz NOT NULL,
  PRIMARY KEY (selection_id, source, result_version)
);

-- Results that may be used for settlement. The highest version per selection is current.
CREATE TABLE confirmed_results (
  result_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id     text NOT NULL,
  result_version   integer NOT NULL CHECK (result_version > 0),
  outcome          text NOT NULL CHECK (outcome IN ('WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'DEAD_HEAT')),
  dh_num           integer,
  dh_den           integer,
  confirmed_by     text NOT NULL, -- 'feeds' or 'trader:<staffId>'
  manual_action_id uuid,
  confirmed_at     timestamptz NOT NULL,
  UNIQUE (selection_id, result_version)
);

-- Primary and secondary disagree: both versions wait for a trader (FR-STL-001).
CREATE TABLE result_mismatches (
  mismatch_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id     text NOT NULL,
  result_version   integer NOT NULL,
  primary_result   jsonb NOT NULL,
  secondary_result jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at       timestamptz NOT NULL,
  resolved_by      text,
  resolved_at      timestamptz,
  UNIQUE (selection_id, result_version)
);

-- Late-bet cutoff per selection: event start or last material event (FR-STL-007).
CREATE TABLE selection_cutoffs (
  selection_id text PRIMARY KEY,
  cutoff_at    timestamptz NOT NULL
);

-- One row per settlement version of a bet (FR-STL-005, -006, -010, -012).
-- PENDING rows are intents written before the ledger call so a retry re-posts the same amounts.
CREATE TABLE settlements (
  bet_id          text NOT NULL,
  version         integer NOT NULL CHECK (version > 0),
  kind            text NOT NULL CHECK (kind IN ('SETTLE', 'RESETTLE')),
  status          text NOT NULL CHECK (status IN ('PENDING', 'POSTED', 'REVIEW')),
  player_id       text NOT NULL,
  currency        text NOT NULL,
  total_stake     bigint NOT NULL,
  gross_return    bigint NOT NULL CHECK (gross_return >= 0),
  tax             bigint NOT NULL CHECK (tax >= 0 AND tax <= gross_return),
  net_return      bigint NOT NULL,
  delta_gross     bigint NOT NULL,
  delta_tax       bigint NOT NULL,
  delta_net       bigint NOT NULL,
  ledger_key      text UNIQUE,
  ledger_entry_id text,
  source          text NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
  actor           text,
  created_at      timestamptz NOT NULL,
  posted_at       timestamptz,
  PRIMARY KEY (bet_id, version),
  CHECK (net_return = gross_return - tax)
);

CREATE TABLE settlement_legs (
  bet_id         text NOT NULL,
  version        integer NOT NULL,
  leg_index      integer NOT NULL,
  selection_id   text NOT NULL,
  outcome        text NOT NULL,
  late           boolean NOT NULL,
  result_id      uuid REFERENCES confirmed_results (result_id),
  result_version integer,
  result_source  text,
  PRIMARY KEY (bet_id, version, leg_index),
  FOREIGN KEY (bet_id, version) REFERENCES settlements (bet_id, version)
);
CREATE INDEX settlement_legs_selection ON settlement_legs (selection_id);

-- Resettlements the ledger refused (player already spent the money) (FR-STL-006).
CREATE TABLE manual_review (
  review_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id             text NOT NULL,
  settlement_version integer NOT NULL,
  player_id          text NOT NULL,
  currency           text NOT NULL,
  delta_net          bigint NOT NULL,
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at         timestamptz NOT NULL,
  UNIQUE (bet_id, settlement_version)
);

-- Trader manual settle or void, four-eyes above threshold (FR-STL-009, FR-BO-011).
CREATE TABLE manual_actions (
  action_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action          text NOT NULL CHECK (action IN ('SETTLE', 'VOID')),
  results         jsonb NOT NULL,
  reason          text NOT NULL CHECK (length(reason) > 0),
  requested_by    text NOT NULL,
  idempotency_key text NOT NULL,
  affected_stake  jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'EXECUTED')),
  approved_by     text,
  created_at      timestamptz NOT NULL,
  executed_at     timestamptz,
  UNIQUE (requested_by, idempotency_key),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- Append-only, hash-chained audit of staff actions (FR-BO-010, SEC-LOG-002).
CREATE TABLE staff_audit (
  seq        bigserial PRIMARY KEY,
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  ip         text,
  action     text NOT NULL,
  target     text NOT NULL,
  reason     text,
  before     jsonb,
  after      jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);

CREATE FUNCTION staff_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit is append-only';
END;
$$;

CREATE TRIGGER staff_audit_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON staff_audit
  FOR EACH STATEMENT EXECUTE FUNCTION staff_audit_append_only();
