-- Bets and legs (FR-BET-005, FR-BET-006, FR-BET-015).
-- status: PENDING (row written, stake not yet confirmed), OPEN, REJECTED, SETTLED, CASHED_OUT.
CREATE TABLE bets (
  bet_id            uuid PRIMARY KEY,
  player_id         text NOT NULL,
  request_id        text NOT NULL,
  request_hash      text NOT NULL,
  currency          text NOT NULL,
  combination_sizes integer[] NOT NULL,
  unit_stake        bigint NOT NULL CHECK (unit_stake >= 0),
  total_stake       bigint NOT NULL CHECK (total_stake >= 0),
  potential_return  bigint NOT NULL CHECK (potential_return >= 0),
  odds_policy       text NOT NULL CHECK (odds_policy IN ('NONE', 'HIGHER', 'ANY')),
  status            text NOT NULL CHECK (status IN ('PENDING', 'OPEN', 'REJECTED', 'SETTLED', 'CASHED_OUT')),
  reject_code       text,
  reject_status     integer,
  reject_detail     text,
  reject_extra      jsonb,
  channel           text NOT NULL,
  ip                text NOT NULL,
  device            text NOT NULL,
  submitted_at      timestamptz NOT NULL,
  accepted_at       timestamptz,
  updated_at        timestamptz NOT NULL,
  UNIQUE (player_id, request_id)
);

CREATE INDEX bets_player_idx ON bets (player_id, submitted_at DESC);
CREATE INDEX bets_pending_idx ON bets (submitted_at) WHERE status = 'PENDING';

CREATE TABLE bet_legs (
  bet_id        uuid NOT NULL REFERENCES bets (bet_id),
  leg_no        integer NOT NULL,
  selection_id  text NOT NULL,
  market_id     text NOT NULL,
  event_id      text NOT NULL,
  odds          bigint NOT NULL CHECK (odds > 10000),
  requested_odds bigint NOT NULL,
  line          text,
  price_version integer NOT NULL,
  -- Potential net payout this bet adds to the selection's liability (FR-RSK-003).
  liability     bigint NOT NULL,
  PRIMARY KEY (bet_id, leg_no)
);

CREATE INDEX bet_legs_selection_idx ON bet_legs (selection_id);

-- Live liability per selection and currency of OPEN and PENDING bets (FR-RSK-003).
CREATE TABLE selection_liability (
  selection_id text NOT NULL,
  currency     text NOT NULL,
  liability    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (selection_id, currency)
);

-- Booking codes (FR-BET-009).
CREATE TABLE booking_codes (
  code          text PRIMARY KEY,
  selection_ids text[] NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL
);
