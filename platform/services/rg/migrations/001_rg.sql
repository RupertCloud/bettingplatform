-- Responsible gambling and jurisdiction rules (SRS 4.9, 4.12).
-- Money columns are bigint minor units (CON-01); times are timestamptz in UTC (CON-03).

CREATE FUNCTION rg_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

-- FR-JUR-001, FR-JUR-003: versioned rules sets. Content never changes after creation;
-- only the approval columns are set once, from PENDING to APPROVED.
CREATE TABLE rules_versions (
  jurisdiction   text        NOT NULL,
  version        integer     NOT NULL,
  rules          jsonb       NOT NULL,
  effective_from timestamptz NOT NULL,
  author         text        NOT NULL,
  created_at     timestamptz NOT NULL,
  status         text        NOT NULL CHECK (status IN ('PENDING', 'APPROVED')),
  approved_by    text,
  approved_at    timestamptz,
  PRIMARY KEY (jurisdiction, version),
  CHECK (status = 'PENDING' OR (approved_by IS NOT NULL AND approved_by <> author))
);

CREATE FUNCTION rg_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rules_versions is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.rules IS DISTINCT FROM OLD.rules
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.author IS DISTINCT FROM OLD.author
     OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'rules version content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rules_versions_guard BEFORE UPDATE OR DELETE ON rules_versions
  FOR EACH ROW EXECUTE FUNCTION rg_rules_guard();

-- Seed: launch jurisdiction Cameroon with the SRS bracketed defaults (AS-01).
-- Affordability: EUR 500 / 30 days equivalent at the fixed CFA peg (655.957) is XAF 327,979, rounded to 328,000.
INSERT INTO rules_versions (jurisdiction, version, rules, effective_from, author, created_at, status, approved_by, approved_at)
VALUES ('CM', 1, '{
  "currency": "XAF",
  "minAge": 18,
  "realityCheckMinutes": 60,
  "limitIncreaseCoolingHours": 24,
  "mandatoryDepositLimitPrompt": true,
  "creditCardBan": true,
  "affordabilityNetDepositThreshold": "328000",
  "withdrawalReversalAllowed": false,
  "timeOutOptions": ["24h", "7d", "42d"],
  "selfExclusionOptions": ["6m", "1y", "5y", "permanent"],
  "utcOffsetMinutes": 60
}'::jsonb, '2000-01-01T00:00:00Z', 'system:seed', '2000-01-01T00:00:00Z', 'APPROVED', 'system:seed-approval', '2000-01-01T00:00:00Z');

-- Person identity key, shared across brands (FR-RG-007, FR-JUR-004).
CREATE TABLE players (
  player_id               uuid PRIMARY KEY,
  person_key              text,
  marketing_opt_out       boolean NOT NULL DEFAULT false,
  reality_check_minutes   integer CHECK (reality_check_minutes BETWEEN 15 AND 120)
);
CREATE INDEX players_person_idx ON players (person_key);

-- FR-RG-001..003: active limits. Money kinds are minor units; SESSION_MINUTES is minutes.
CREATE TABLE limits (
  player_id uuid   NOT NULL,
  kind      text   NOT NULL,
  value     bigint NOT NULL CHECK (value > 0),
  PRIMARY KEY (player_id, kind)
);

-- Every limit change request (history). Decreases are APPLIED at once; increases and removals
-- are PENDING until confirmed after available_at. new_value NULL means removal.
CREATE TABLE limit_changes (
  id           bigserial PRIMARY KEY,
  player_id    uuid        NOT NULL,
  kind         text        NOT NULL,
  old_value    bigint,
  new_value    bigint,
  requested_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  status       text        NOT NULL CHECK (status IN ('APPLIED', 'PENDING', 'CONFIRMED', 'SUPERSEDED')),
  closed_at    timestamptz
);
CREATE UNIQUE INDEX limit_changes_one_pending ON limit_changes (player_id, kind) WHERE status = 'PENDING';
CREATE INDEX limit_changes_player_idx ON limit_changes (player_id, requested_at);

-- Activity feeding rolling windows and harm markers. Unique per (player, kind, ref) so records are idempotent.
CREATE TABLE activity (
  id          bigserial PRIMARY KEY,
  player_id   uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('DEPOSIT', 'DEPOSIT_DECLINED', 'STAKE', 'SETTLEMENT', 'WITHDRAWAL', 'WITHDRAWAL_CANCELLED')),
  currency    text        NOT NULL,
  amount      bigint      NOT NULL CHECK (amount >= 0),
  stake       bigint      CHECK (stake >= 0),
  ref         text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (player_id, kind, ref)
);
CREATE INDEX activity_window_idx ON activity (player_id, kind, occurred_at);
CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity
  FOR EACH ROW EXECUTE FUNCTION rg_forbid_change();

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  player_id   uuid        NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  last_ack_at timestamptz
);
CREATE INDEX sessions_player_idx ON sessions (player_id, started_at);

-- FR-RG-004, FR-RG-007: time-outs and self-exclusions. Append-only: irreversible by anyone before expiry.
CREATE TABLE exclusions (
  id         bigserial PRIMARY KEY,
  person_key text        NOT NULL,
  player_id  uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('TIME_OUT', 'SELF_EXCLUSION')),
  period     text        NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz,
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (kind = 'SELF_EXCLUSION' OR ends_at IS NOT NULL)
);
CREATE INDEX exclusions_person_idx ON exclusions (person_key);
CREATE INDEX exclusions_player_idx ON exclusions (player_id);
CREATE TRIGGER exclusions_append_only BEFORE UPDATE OR DELETE ON exclusions
  FOR EACH ROW EXECUTE FUNCTION rg_forbid_change();

-- FR-RG-010: score history.
CREATE TABLE risk_scores (
  id          bigserial PRIMARY KEY,
  player_id   uuid        NOT NULL,
  score       integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  level       text        NOT NULL,
  markers     jsonb       NOT NULL,
  computed_at timestamptz NOT NULL
);
CREATE INDEX risk_scores_player_idx ON risk_scores (player_id, computed_at DESC, id DESC);
CREATE TRIGGER risk_scores_append_only BEFORE UPDATE OR DELETE ON risk_scores
  FOR EACH ROW EXECUTE FUNCTION rg_forbid_change();

-- FR-RG-011: interventions and their outcome. An intervention is open until its outcome is recorded.
CREATE TABLE interventions (
  id          uuid PRIMARY KEY,
  player_id   uuid        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('MESSAGE', 'QUESTIONNAIRE', 'CALL_TASK', 'DEPOSIT_CAP', 'SUSPEND')),
  source      text        NOT NULL,
  score       integer,
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL,
  outcome     text,
  outcome_note text,
  outcome_by  text,
  outcome_at  timestamptz
);
CREATE UNIQUE INDEX interventions_one_open ON interventions (player_id, type) WHERE outcome IS NULL;

-- FR-RG-012: affordability cases. One open case per player caps deposits.
CREATE TABLE affordability_cases (
  id               uuid PRIMARY KEY,
  player_id        uuid        NOT NULL,
  currency         text        NOT NULL,
  net_deposits     bigint      NOT NULL,
  threshold        bigint      NOT NULL,
  opened_at        timestamptz NOT NULL,
  status           text        NOT NULL CHECK (status IN ('OPEN', 'CLEARED')),
  approved_amount  bigint      CHECK (approved_amount > 0),
  resolved_by      text,
  resolved_at      timestamptz
);
CREATE UNIQUE INDEX affordability_one_open ON affordability_cases (player_id) WHERE status = 'OPEN';

-- FR-BO-010, SEC-LOG-002: append-only, hash-chained audit of staff actions.
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  actor     text        NOT NULL,
  ip        text,
  action    text        NOT NULL,
  subject   text        NOT NULL,
  before    jsonb,
  after     jsonb,
  reason    text        NOT NULL,
  at        timestamptz NOT NULL,
  prev_hash text        NOT NULL,
  hash      text        NOT NULL
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION rg_forbid_change();
