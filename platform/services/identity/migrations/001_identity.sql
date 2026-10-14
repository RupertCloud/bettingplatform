-- Identity service schema (SRS 4.1 FR-ACC, 7.1 SEC-AUTH).
-- All business timestamps are written by the service from its injected clock.

CREATE TABLE players (
  id               uuid PRIMARY KEY,
  email            text NOT NULL,          -- normalised: trimmed, lower case (FR-ACC-004)
  email_verified_at timestamptz,
  phone            text,                   -- normalised E.164
  username         text NOT NULL,          -- normalised: trimmed, lower case
  password_hash    text NOT NULL,          -- argon2id (SEC-AUTH-001)
  legal_name       text NOT NULL,
  date_of_birth    date NOT NULL,
  nationality      text NOT NULL,
  address_line1    text NOT NULL,
  address_line2    text,
  address_city     text NOT NULL,
  address_postcode text,
  country          text NOT NULL,          -- residence, ISO 3166-1 alpha-2
  jurisdiction     text NOT NULL,          -- rules set (FR-JUR-002)
  currency         text NOT NULL,
  terms_version    text NOT NULL,
  state            text NOT NULL CHECK (state IN ('PENDING_VERIFICATION','ACTIVE','RESTRICTED','SUSPENDED',
                                                  'SELF_EXCLUDED','TIMED_OUT','CLOSED','DORMANT')),
  state_until      timestamptz,            -- end of time-out / self-exclusion; NULL = permanent
  kyc_level        text NOT NULL CHECK (kyc_level IN ('NONE','BASIC','FULL','ENHANCED')),
  stake_factor     numeric(5,2) NOT NULL DEFAULT 1.00 CHECK (stake_factor BETWEEN 0.01 AND 10.00),
  mfa_secret       bytea,                  -- AES-256-GCM: iv(12) | tag(16) | ciphertext
  mfa_pending      bytea,                  -- enrolment not yet confirmed
  mfa_last_step    bigint,                 -- last accepted TOTP time step (replay protection)
  created_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX players_email_uq ON players (email);
CREATE UNIQUE INDEX players_username_uq ON players (username);
CREATE UNIQUE INDEX players_phone_uq ON players (phone) WHERE phone IS NOT NULL;

-- FR-ACC-002: rejected registrations are recorded.
CREATE TABLE registration_rejections (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL,
  date_of_birth date NOT NULL,
  jurisdiction  text NOT NULL,
  reason        text NOT NULL,
  ip            text,
  at            timestamptz NOT NULL
);

-- SEC-AUTH-006: login attempts per subject (player id, or the identifier when no account matches) and per IP.
CREATE TABLE login_attempts (
  id        bigserial PRIMARY KEY,
  subject   text NOT NULL,
  player_id uuid REFERENCES players(id),
  ip        text NOT NULL,
  success   boolean NOT NULL,
  at        timestamptz NOT NULL
);
CREATE INDEX login_attempts_subject_idx ON login_attempts (subject, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at) WHERE NOT success;

-- One row per login session (SEC-AUTH-003/005, FR-ACC-018).
CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  player_id       uuid NOT NULL REFERENCES players(id),
  created_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,   -- absolute limit
  mfa_verified_at timestamptz,
  mfa_failures    int NOT NULL DEFAULT 0,
  revoked_at      timestamptz,
  revoke_reason   text,
  ip              text,
  user_agent      text
);
CREATE INDEX sessions_player_idx ON sessions (player_id) WHERE revoked_at IS NULL;

-- Each refresh issues a new token pair; old pairs stay as rotated so reuse is detectable.
CREATE TABLE session_tokens (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id),
  access_hash  bytea NOT NULL UNIQUE,     -- SHA-256 of the opaque token
  refresh_hash bytea NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL,
  rotated_at   timestamptz
);
CREATE INDEX session_tokens_session_idx ON session_tokens (session_id);

-- Login MFA challenges (FR-ACC-008).
CREATE TABLE mfa_challenges (
  token_hash bytea PRIMARY KEY,
  player_id  uuid NOT NULL REFERENCES players(id),
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  used_at    timestamptz,
  ip         text,
  user_agent text
);

-- Single-use tokens: email verification (FR-ACC-003) and password reset (FR-ACC-010).
CREATE TABLE one_time_tokens (
  token_hash bytea PRIMARY KEY,
  purpose    text NOT NULL CHECK (purpose IN ('EMAIL_VERIFY','PASSWORD_RESET')),
  player_id  uuid NOT NULL REFERENCES players(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX one_time_tokens_player_idx ON one_time_tokens (player_id, purpose) WHERE used_at IS NULL;

-- Append-only, hash-chained audit of state and KYC changes (FR-BO-010, SEC-LOG-002).
CREATE TABLE account_audit (
  seq       bigserial PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id),
  actor     text NOT NULL,
  action    text NOT NULL,
  before    jsonb NOT NULL,
  after     jsonb NOT NULL,
  reason    text NOT NULL CHECK (length(reason) > 0),
  ip        text,
  at        timestamptz NOT NULL,
  prev_hash bytea,
  hash      bytea NOT NULL
);

CREATE FUNCTION account_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account_audit is append-only';
END $$;
CREATE TRIGGER account_audit_no_update BEFORE UPDATE OR DELETE ON account_audit
  FOR EACH ROW EXECUTE FUNCTION account_audit_immutable();
CREATE TRIGGER account_audit_no_truncate BEFORE TRUNCATE ON account_audit
  FOR EACH STATEMENT EXECUTE FUNCTION account_audit_immutable();
