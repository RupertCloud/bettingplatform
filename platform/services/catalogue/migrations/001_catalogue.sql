-- Sports catalogue, market lifecycle and pricing (FR-SPD, FR-RSK-001/002).

-- FR-SPD-003: launch sports; more can be inserted without code changes.
CREATE TABLE sports (
  key text PRIMARY KEY,
  name text NOT NULL,
  -- Default for new feed events: offered in-play or closed at the start (FR-SPD-007).
  in_play_default boolean NOT NULL DEFAULT true,
  -- Feed source currently pricing this sport; NULL means the primary (FR-SPD-013).
  active_source text
);

INSERT INTO sports (key, name) VALUES
  ('soccer', 'Soccer'),
  ('basketball', 'Basketball'),
  ('tennis', 'Tennis'),
  ('table-tennis', 'Table Tennis'),
  ('volleyball', 'Volleyball'),
  ('ice-hockey', 'Ice Hockey'),
  ('mma', 'MMA/UFC'),
  ('boxing', 'Boxing'),
  ('cricket', 'Cricket'),
  ('esports', 'eSports');

CREATE TABLE competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL REFERENCES sports(key),
  name text NOT NULL
);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL REFERENCES sports(key),
  name text NOT NULL
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL REFERENCES sports(key),
  competition_id uuid NOT NULL REFERENCES competitions(id),
  home_id uuid REFERENCES participants(id),
  away_id uuid REFERENCES participants(id),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PREMATCH' CHECK (status IN ('PREMATCH', 'LIVE', 'ENDED')),
  in_play_offered boolean NOT NULL,
  origin text NOT NULL CHECK (origin IN ('feed', 'manual')),
  -- Independent suspension reasons; the event is suspended while any is set.
  feed_suspended boolean NOT NULL DEFAULT false,   -- FR-SPD-006 feed signal
  stale boolean NOT NULL DEFAULT false,            -- FR-SPD-006/013 heartbeat lost
  review_required boolean NOT NULL DEFAULT false,  -- FR-SPD-008 start time / participants changed
  trader_suspended boolean NOT NULL DEFAULT false, -- FR-RSK-002
  updated_at timestamptz NOT NULL
);
CREATE INDEX events_listing ON events (sport, status, starts_at);

-- FR-SPD-002: external feed ids mapped to stable internal ids, per source.
CREATE TABLE feed_mappings (
  source text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('competition', 'participant', 'event')),
  external_id text NOT NULL,
  internal_id uuid NOT NULL,
  -- Highest sequence number applied from this source (IF-SW-001); older updates are ignored.
  last_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (source, entity_type, external_id),
  UNIQUE (source, entity_type, internal_id)
);

CREATE TABLE source_heartbeats (
  source text PRIMARY KEY,
  last_seen timestamptz NOT NULL
);

CREATE TABLE markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  type text NOT NULL,
  line text,
  -- FR-SPD-005
  state text NOT NULL CHECK (state IN ('OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED', 'VOIDED')),
  -- Who suspended it: the feed may only reopen what the feed suspended.
  suspended_by text CHECK (suspended_by IN ('feed', 'trader')),
  origin text NOT NULL CHECK (origin IN ('feed', 'manual')),
  UNIQUE NULLS NOT DISTINCT (event_id, type, line)
);

CREATE TABLE selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES markets(id),
  key text NOT NULL,
  name text NOT NULL,
  feed_odds bigint CHECK (feed_odds > 10000),       -- raw feed price
  odds bigint CHECK (odds > 10000),                 -- after margin and ladder (FR-RSK-001)
  override_odds bigint CHECK (override_odds > 10000), -- trader override (FR-RSK-002)
  suspended boolean NOT NULL DEFAULT false,         -- trader selection suspension
  -- What is offered right now, derived from the columns above and the market/event state.
  eff_state text,
  eff_odds bigint,
  price_version integer NOT NULL DEFAULT 0,
  UNIQUE (market_id, key)
);

-- FR-SPD-009: every price and state change, append-only.
CREATE TABLE price_history (
  id bigserial PRIMARY KEY,
  selection_id uuid NOT NULL REFERENCES selections(id),
  odds bigint,
  state text NOT NULL,
  price_version integer NOT NULL,
  source text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX price_history_selection ON price_history (selection_id, at);

-- FR-RSK-001: margin in basis points (500 = 5 %); the most specific row wins.
CREATE TABLE margins (
  id bigserial PRIMARY KEY,
  sport text NOT NULL REFERENCES sports(key),
  competition_id uuid REFERENCES competitions(id),
  market_type text,
  in_play boolean,
  margin_bp integer NOT NULL CHECK (margin_bp BETWEEN 0 AND 5000),
  UNIQUE NULLS NOT DISTINCT (sport, competition_id, market_type, in_play)
);

-- FR-RSK-002, FR-BO-010, SEC-LOG-002: append-only, hash-chained trader audit.
CREATE TABLE trader_actions (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  ip text,
  before jsonb,
  after jsonb,
  prev_hash text,
  hash text NOT NULL UNIQUE
);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER price_history_append_only BEFORE UPDATE OR DELETE ON price_history
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER price_history_no_truncate BEFORE TRUNCATE ON price_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER trader_actions_append_only BEFORE UPDATE OR DELETE ON trader_actions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER trader_actions_no_truncate BEFORE TRUNCATE ON trader_actions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
