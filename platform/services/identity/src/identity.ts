import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import {
  AppError, withTx,
  type AccountState, type Client, type KycLevel, type PlayerDirectory, type PlayerId, type PlayerStatus, type Pool,
  type Currency,
} from '@bp/common';
import { decrypt, encrypt, hashToken, newToken } from './crypto.js';
import { ageOn, parseIdentifier, normaliseEmail, registrationSchema, type RegistrationInput } from './normalise.js';
import { RG_ACTOR, RG_STATES, REVOKING_STATES, TRANSITIONS, isAllowed } from './state.js';

const MINUTE = 60_000;
export const IDLE_TIMEOUT_MS = 30 * MINUTE; // FR-ACC-018
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * MINUTE; // FR-ACC-018
export const LOCKOUT_WINDOW_MS = 15 * MINUTE; // SEC-AUTH-006
export const ACCOUNT_FAILURE_LIMIT = 5; // SEC-AUTH-006
export const RESET_TOKEN_TTL_MS = 30 * MINUTE; // FR-ACC-010
export const EMAIL_TOKEN_TTL_MS = 15 * MINUTE; // FR-ACC-003
export const MFA_CHALLENGE_TTL_MS = 5 * MINUTE;
export const MFA_MAX_ATTEMPTS = 5;
export const RECENT_MFA_MS = 5 * MINUTE; // FR-ACC-009 step-up window
export const MIN_PASSWORD_LENGTH = 10; // SEC-AUTH-002

/** SEC-AUTH-001: Argon2id, 64 MiB, 3 passes. */
const ARGON2 = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Notification =
  | { kind: 'EMAIL_VERIFICATION'; playerId: PlayerId; email: string; token: string }
  | { kind: 'PASSWORD_RESET'; playerId: PlayerId; email: string; token: string }
  /** Sent to the address used in a registration that clashed with an existing account (SEC-AUTH-008). */
  | { kind: 'REGISTRATION_CONFLICT'; email: string };

export interface IdentityOptions {
  pool: Pool;
  now?: () => Date;
  /** 32-byte key for TOTP secrets at rest (AES-256-GCM). */
  mfaKey: Buffer;
  notify?: (n: Notification) => Promise<void>;
  /** SEC-AUTH-002 breached-password list lookup. */
  isBreachedPassword?: (password: string) => Promise<boolean>;
  /** FR-ACC-002 / FR-JUR-001 minimum age per jurisdiction. Defaults to 18. */
  minimumAge?: (jurisdiction: string) => number;
  /** SEC-AUTH-006 failed logins per IP per window. */
  ipFailureLimit?: number;
  totpIssuer?: string;
}

export interface RequestMeta {
  ip: string;
  userAgent?: string | null;
}

export interface SessionTokens {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute end of the session. */
  expiresAt: Date;
}

export type LoginResult =
  | { status: 'ok'; tokens: SessionTokens }
  | { status: 'mfa_required'; challenge: string; expiresAt: Date };

export type RegisterResult = { created: true; playerId: PlayerId } | { created: false };

export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditRecord {
  seq: bigint;
  playerId: PlayerId;
  actor: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string;
  ip: string | null;
  at: Date;
}

const invalidCredentials = () => new AppError('invalid_credentials', 401, 'Invalid credentials.');
const unauthenticated = () => new AppError('unauthenticated', 401, 'Authentication required.');
const tooManyAttempts = () => new AppError('too_many_attempts', 429, 'Too many failed attempts. Try again later.');

type PlayerRow = {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  state: AccountState;
  state_until: Date | null;
  kyc_level: KycLevel;
  jurisdiction: string;
  currency: Currency;
  stake_factor: string;
  mfa_secret: Buffer | null;
  mfa_pending: Buffer | null;
  mfa_last_step: bigint | null;
};

/** Identity domain: accounts, credentials, sessions, MFA and account state (SRS 4.1, 7.1). */
export class Identity implements PlayerDirectory {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly mfaKey: Buffer;
  private readonly notify: (n: Notification) => Promise<void>;
  private readonly isBreached: (password: string) => Promise<boolean>;
  private readonly minimumAge: (jurisdiction: string) => number;
  private readonly ipFailureLimit: number;
  private readonly issuer: string;
  private dummyHash: Promise<string> | undefined;

  constructor(opts: IdentityOptions) {
    if (opts.mfaKey.length !== 32) throw new Error('mfaKey must be 32 bytes');
    this.pool = opts.pool;
    this.now = opts.now ?? (() => new Date());
    this.mfaKey = opts.mfaKey;
    this.notify = opts.notify ?? (async () => undefined);
    this.isBreached = opts.isBreachedPassword ?? (async () => false);
    this.minimumAge = opts.minimumAge ?? (() => 18);
    this.ipFailureLimit = opts.ipFailureLimit ?? 20;
    this.issuer = opts.totpIssuer ?? 'Betting Platform';
  }

  // ---------- Registration (FR-ACC-001..004) ----------

  async register(input: RegistrationInput, meta?: RequestMeta): Promise<RegisterResult> {
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const r = parsed.data;
    const now = this.now();

    const minAge = this.minimumAge(r.jurisdiction);
    if (ageOn(r.dateOfBirth, now) < minAge) {
      // FR-ACC-002: the attempt is recorded even though no account is created.
      await this.pool.query(
        `INSERT INTO registration_rejections (email, date_of_birth, jurisdiction, reason, ip, at)
         VALUES ($1, $2, $3, 'UNDERAGE', $4, $5)`,
        [r.email, r.dateOfBirth, r.jurisdiction, meta?.ip ?? null, now],
      );
      throw new AppError('underage', 422, `You must be at least ${minAge} to register.`);
    }
    const passwordHash = await this.hashNewPassword(r.password);

    const playerId = randomUUID();
    const token = newToken();
    try {
      await withTx(this.pool, async (c) => {
        await c.query(
          `INSERT INTO players (id, email, phone, username, password_hash, legal_name, date_of_birth, nationality,
             address_line1, address_line2, address_city, address_postcode, country, jurisdiction, currency,
             terms_version, state, kyc_level, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PENDING_VERIFICATION','NONE',$17)`,
          [
            playerId, r.email, r.phone ?? null, r.username, passwordHash, r.legalName, r.dateOfBirth, r.nationality,
            r.address.line1, r.address.line2 ?? null, r.address.city, r.address.postcode ?? null, r.country,
            r.jurisdiction, r.currency, r.termsVersion, now,
          ],
        );
        await c.query(
          `INSERT INTO one_time_tokens (token_hash, purpose, player_id, expires_at) VALUES ($1, 'EMAIL_VERIFY', $2, $3)`,
          [hashToken(token), playerId, new Date(now.getTime() + EMAIL_TOKEN_TTL_MS)],
        );
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // FR-ACC-004 uniqueness; the caller sees the same response as a success (SEC-AUTH-008).
        await this.notify({ kind: 'REGISTRATION_CONFLICT', email: r.email });
        return { created: false };
      }
      throw err;
    }
    await this.notify({ kind: 'EMAIL_VERIFICATION', playerId, email: r.email, token });
    return { created: true, playerId };
  }

  /** FR-ACC-003: single-use link token, valid 15 minutes. */
  async verifyEmail(token: string): Promise<void> {
    const now = this.now();
    await withTx(this.pool, async (c) => {
      const playerId = await consumeToken(c, token, 'EMAIL_VERIFY', now);
      if (!playerId) throw new AppError('invalid_token', 400, 'The link is invalid or has expired.');
      await c.query('UPDATE players SET email_verified_at = $2 WHERE id = $1 AND email_verified_at IS NULL', [playerId, now]);
    });
  }

  // ---------- Login (FR-ACC-008, SEC-AUTH-006/008) ----------

  async login(identifier: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const id = parseIdentifier(identifier);
    const now = this.now();
    const outcome = await withTx(this.pool, async (c): Promise<LoginResult | AppError> => {
      const player = (
        await c.query<PlayerRow>(`SELECT * FROM players WHERE ${id.column} = $1`, [id.value])
      ).rows[0];
      // Unknown identifiers get their own counter, so lockout behaves the same whether or not the account exists.
      const subject = player ? `p:${player.id}` : `i:${id.column}:${id.value}`;
      if (await this.isThrottled(c, subject, meta.ip, now)) return tooManyAttempts();

      const ok = await argon2.verify(player?.password_hash ?? (await this.getDummyHash()), password).catch(() => false);
      if (!player || !ok) {
        await recordAttempt(c, subject, player?.id ?? null, meta.ip, false, now);
        return invalidCredentials();
      }
      if (!isAllowed(player.state, 'login')) {
        return new AppError('account_unavailable', 403, 'This account cannot be used. Contact support.');
      }
      if (player.mfa_secret) {
        // Success is recorded only once the second factor passes, so TOTP guesses count towards lockout.
        const challenge = newToken();
        const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_TTL_MS);
        await c.query(
          `INSERT INTO mfa_challenges (token_hash, player_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
          [hashToken(challenge), player.id, expiresAt, meta.ip, meta.userAgent ?? null],
        );
        return { status: 'mfa_required', challenge, expiresAt };
      }
      await recordAttempt(c, subject, player.id, meta.ip, true, now);
      return { status: 'ok', tokens: await createSession(c, player.id, meta, now, false) };
    });
    if (outcome instanceof AppError) throw outcome;
    return outcome;
  }

  /** Completes a login that returned mfa_required. */
  async completeMfaLogin(challenge: string, code: string, meta: RequestMeta): Promise<SessionTokens> {
    const now = this.now();
    const outcome = await withTx(this.pool, async (c): Promise<SessionTokens | AppError> => {
      const ch = (
        await c.query<{ player_id: string; expires_at: Date; attempts: number; used_at: Date | null }>(
          'SELECT player_id, expires_at, attempts, used_at FROM mfa_challenges WHERE token_hash = $1 FOR UPDATE',
          [hashToken(challenge)],
        )
      ).rows[0];
      if (!ch || ch.used_at || ch.expires_at <= now || ch.attempts >= MFA_MAX_ATTEMPTS) return invalidCredentials();
      const subject = `p:${ch.player_id}`;
      if (await this.isThrottled(c, subject, meta.ip, now)) return tooManyAttempts();
      const player = await lockPlayer(c, ch.player_id);
      if (!player.mfa_secret || !isAllowed(player.state, 'login')) return invalidCredentials();
      if (!(await this.checkTotp(c, player, player.mfa_secret, code, now))) {
        await c.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [hashToken(challenge)]);
        await recordAttempt(c, subject, player.id, meta.ip, false, now);
        return new AppError('invalid_code', 401, 'Invalid code.');
      }
      await c.query('UPDATE mfa_challenges SET used_at = $2 WHERE token_hash = $1', [hashToken(challenge), now]);
      await recordAttempt(c, subject, player.id, meta.ip, true, now);
      return createSession(c, player.id, meta, now, true);
    });
    if (outcome instanceof AppError) throw outcome;
    return outcome;
  }

  // ---------- Sessions (SEC-AUTH-003/005, FR-ACC-018) ----------

  /** Resolves an access token and records activity. Throws 401 when the session is gone, idle or expired. */
  async authenticateAccess(accessToken: string): Promise<{ playerId: PlayerId; sessionId: string }> {
    const now = this.now();
    const { rows } = await this.pool.query<{ id: string; player_id: string }>(
      `UPDATE sessions s SET last_seen_at = $2
         FROM session_tokens t
        WHERE t.access_hash = $1 AND t.session_id = s.id AND t.rotated_at IS NULL
          AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3
        RETURNING s.id, s.player_id`,
      [hashToken(accessToken), now, new Date(now.getTime() - IDLE_TIMEOUT_MS)],
    );
    const row = rows[0];
    if (!row) throw unauthenticated();
    return { playerId: row.player_id, sessionId: row.id };
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const now = this.now();
    const outcome = await withTx(this.pool, async (c): Promise<SessionTokens | AppError> => {
      const row = (
        await c.query<{ token_id: bigint; rotated_at: Date | null; session_id: string; revoked_at: Date | null; expires_at: Date; last_seen_at: Date }>(
          `SELECT t.id AS token_id, t.rotated_at, s.id AS session_id, s.revoked_at, s.expires_at, s.last_seen_at
             FROM session_tokens t JOIN sessions s ON s.id = t.session_id
            WHERE t.refresh_hash = $1 FOR UPDATE OF s, t`,
          [hashToken(refreshToken)],
        )
      ).rows[0];
      if (!row || row.revoked_at) return unauthenticated();
      if (row.rotated_at) {
        await revoke(c, 'id = $1', [row.session_id], 'refresh_token_reuse', now);
        return unauthenticated();
      }
      if (row.expires_at <= now || row.last_seen_at.getTime() <= now.getTime() - IDLE_TIMEOUT_MS) {
        await revoke(c, 'id = $1', [row.session_id], 'expired', now);
        return unauthenticated();
      }
      await c.query('UPDATE session_tokens SET rotated_at = $2 WHERE id = $1', [row.token_id, now]);
      await c.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
      const pair = await issueTokens(c, row.session_id, now);
      return { sessionId: row.session_id, ...pair, expiresAt: row.expires_at };
    });
    if (outcome instanceof AppError) throw outcome;
    return outcome;
  }

  async logout(sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) return;
    await revoke(this.pool, 'id = $1', [sessionId], 'logout', this.now());
  }

  async listSessions(playerId: PlayerId): Promise<SessionInfo[]> {
    const now = this.now();
    const { rows } = await this.pool.query<{
      id: string; created_at: Date; last_seen_at: Date; expires_at: Date; ip: string | null; user_agent: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions
        WHERE player_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_seen_at > $3
        ORDER BY created_at DESC`,
      [playerId, now, new Date(now.getTime() - IDLE_TIMEOUT_MS)],
    );
    return rows.map((r) => ({
      sessionId: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent,
    }));
  }

  /** Revokes one of the player's own sessions. Returns false when no such session belongs to the player. */
  async revokeSession(playerId: PlayerId, sessionId: string): Promise<boolean> {
    if (!UUID.test(sessionId)) return false;
    return (await revoke(this.pool, 'id = $1 AND player_id = $2', [sessionId, playerId], 'revoked_by_player', this.now())) > 0;
  }

  async revokeAll(playerId: PlayerId, reason = 'revoke_all'): Promise<number> {
    return revoke(this.pool, 'player_id = $1', [playerId], reason, this.now());
  }

  // ---------- MFA (FR-ACC-008/009) ----------

  /** Starts TOTP enrolment. The secret is stored encrypted until confirmed. */
  async enrolMfa(playerId: PlayerId): Promise<{ secret: string; otpauthUri: string }> {
    return withTx(this.pool, async (c) => {
      const player = await lockPlayer(c, playerId);
      if (player.mfa_secret) throw new AppError('mfa_already_enrolled', 409, 'MFA is already enrolled.');
      const secret = authenticator.generateSecret(20);
      await c.query('UPDATE players SET mfa_pending = $2 WHERE id = $1', [playerId, encrypt(this.mfaKey, secret, playerId)]);
      return { secret, otpauthUri: authenticator.keyuri(player.username, this.issuer, secret) };
    });
  }

  /** Confirms enrolment with a first code; the current session counts as freshly MFA-verified. */
  async confirmMfa(playerId: PlayerId, sessionId: string, code: string): Promise<void> {
    const now = this.now();
    const outcome = await withTx(this.pool, async (c): Promise<AppError | null> => {
      const player = await lockPlayer(c, playerId);
      if (!player.mfa_pending) return new AppError('mfa_not_pending', 409, 'No MFA enrolment in progress.');
      if (!(await this.checkTotp(c, player, player.mfa_pending, code, now))) return new AppError('invalid_code', 401, 'Invalid code.');
      await c.query('UPDATE players SET mfa_secret = mfa_pending, mfa_pending = NULL WHERE id = $1', [playerId]);
      await c.query('UPDATE sessions SET mfa_verified_at = $3 WHERE id = $1 AND player_id = $2', [sessionId, playerId, now]);
      return null;
    });
    if (outcome) throw outcome;
  }

  /** Step-up verification on an existing session. Repeated failures end the session. */
  async verifyMfa(sessionId: string, code: string): Promise<void> {
    if (!UUID.test(sessionId)) throw unauthenticated();
    const now = this.now();
    const outcome = await withTx(this.pool, async (c): Promise<AppError | null> => {
      // Player row first, then session: the same lock order as setState, so the two cannot deadlock.
      const owner = (await c.query<{ player_id: string }>('SELECT player_id FROM sessions WHERE id = $1', [sessionId])).rows[0];
      if (!owner) return unauthenticated();
      const player = await lockPlayer(c, owner.player_id);
      const s = (
        await c.query<{ mfa_failures: number }>(
          `SELECT mfa_failures FROM sessions
            WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_seen_at > $3 FOR UPDATE`,
          [sessionId, now, new Date(now.getTime() - IDLE_TIMEOUT_MS)],
        )
      ).rows[0];
      if (!s) return unauthenticated();
      if (!player.mfa_secret) return new AppError('mfa_not_enrolled', 409, 'MFA is not enrolled.');
      if (await this.checkTotp(c, player, player.mfa_secret, code, now)) {
        await c.query('UPDATE sessions SET mfa_verified_at = $2, mfa_failures = 0 WHERE id = $1', [sessionId, now]);
        return null;
      }
      await c.query('UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id = $1', [sessionId]);
      if (s.mfa_failures + 1 >= MFA_MAX_ATTEMPTS) await revoke(c, 'id = $1', [sessionId], 'mfa_failures', now);
      return new AppError('invalid_code', 401, 'Invalid code.');
    });
    if (outcome) throw outcome;
  }

  /** FR-ACC-009: throws unless the session passed MFA within maxAgeMs. */
  async requireRecentMfa(sessionId: string, maxAgeMs: number = RECENT_MFA_MS): Promise<void> {
    if (!UUID.test(sessionId)) throw unauthenticated();
    const now = this.now();
    const s = (
      await this.pool.query<{ mfa_verified_at: Date | null; enrolled: boolean }>(
        `SELECT s.mfa_verified_at, p.mfa_secret IS NOT NULL AS enrolled
           FROM sessions s JOIN players p ON p.id = s.player_id
          WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3`,
        [sessionId, now, new Date(now.getTime() - IDLE_TIMEOUT_MS)],
      )
    ).rows[0];
    if (!s) throw unauthenticated();
    if (!s.enrolled) throw new AppError('mfa_enrolment_required', 403, 'Set up two-factor authentication first.');
    if (!s.mfa_verified_at || now.getTime() - s.mfa_verified_at.getTime() > maxAgeMs) {
      throw new AppError('mfa_required', 403, 'Confirm with your authenticator code.');
    }
  }

  // ---------- Password reset (FR-ACC-010) ----------

  /** Always resolves the same way whether or not the email matches an account (SEC-AUTH-008). */
  async requestPasswordReset(email: string): Promise<void> {
    const now = this.now();
    const player = (
      await this.pool.query<{ id: string; email: string }>('SELECT id, email FROM players WHERE email = $1', [normaliseEmail(email)])
    ).rows[0];
    if (!player) return;
    const token = newToken();
    await this.pool.query(
      `INSERT INTO one_time_tokens (token_hash, purpose, player_id, expires_at) VALUES ($1, 'PASSWORD_RESET', $2, $3)`,
      [hashToken(token), player.id, new Date(now.getTime() + RESET_TOKEN_TTL_MS)],
    );
    await this.notify({ kind: 'PASSWORD_RESET', playerId: player.id, email: player.email, token });
  }

  /** Single use; sets the new password, burns every other reset token and ends all sessions. */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hashNewPassword(newPassword);
    const now = this.now();
    await withTx(this.pool, async (c) => {
      const playerId = await consumeToken(c, token, 'PASSWORD_RESET', now);
      if (!playerId) throw new AppError('invalid_token', 400, 'The reset link is invalid or has expired.');
      await c.query('UPDATE players SET password_hash = $2 WHERE id = $1', [playerId, passwordHash]);
      await c.query(
        `UPDATE one_time_tokens SET used_at = $2 WHERE player_id = $1 AND purpose = 'PASSWORD_RESET' AND used_at IS NULL`,
        [playerId, now],
      );
      await revoke(c, 'player_id = $1', [playerId], 'password_reset', now);
    });
  }

  // ---------- Account state and KYC (FR-ACC-014, FR-KYC-010, FR-RG-004) ----------

  /**
   * Changes account state with an audit row. SELF_EXCLUDED and TIMED_OUT are set only by "rg-service"
   * and cannot be lifted by anyone before `until` (null = permanent self-exclusion).
   */
  async setState(
    playerId: PlayerId,
    state: AccountState,
    actor: string,
    reason: string,
    opts: { until?: Date | null; ip?: string } = {},
  ): Promise<PlayerStatus> {
    requireReason(actor, reason);
    const now = this.now();
    return withTx(this.pool, async (c) => {
      const p = await lockPlayer(c, playerId);
      const until = opts.until ?? null;

      if (RG_STATES.has(state)) {
        if (actor !== RG_ACTOR) throw new AppError('forbidden', 403, `${state} can only be set by the responsible-gambling service.`);
        if (state === 'TIMED_OUT' && !until) throw new AppError('invalid_request', 400, 'A time-out needs an end time.');
        if (until && until <= now) throw new AppError('invalid_request', 400, 'The end time must be in the future.');
      } else if (opts.until) {
        throw new AppError('invalid_request', 400, `${state} does not take an end time.`);
      }
      if (!TRANSITIONS[p.state].includes(state)) {
        throw new AppError('invalid_transition', 409, `Cannot move from ${p.state} to ${state}.`);
      }
      if (RG_STATES.has(p.state)) {
        const expired = p.state_until !== null && p.state_until <= now;
        // Extending or escalating is allowed; anything that ends or shortens the restriction waits for expiry.
        const extends_ =
          RG_STATES.has(state) && p.state_until !== null && (until === null || until >= p.state_until) &&
          !(p.state === 'SELF_EXCLUDED' && state === 'TIMED_OUT');
        if (!expired && !extends_) {
          throw new AppError('restriction_active', 409, `The ${p.state} period has not ended.`, {
            until: p.state_until?.toISOString() ?? null,
          });
        }
      }

      await c.query('UPDATE players SET state = $2, state_until = $3 WHERE id = $1', [playerId, state, until]);
      await appendAudit(c, {
        playerId, actor, action: 'SET_STATE', reason, ip: opts.ip ?? null, at: now,
        before: { state: p.state, until: p.state_until?.toISOString() ?? null },
        after: { state, until: until?.toISOString() ?? null },
      });
      if (REVOKING_STATES.has(state)) await revoke(c, 'player_id = $1', [playerId], `state_${state.toLowerCase()}`, now);
      return toStatus({ ...p, state });
    });
  }

  async setKycLevel(playerId: PlayerId, level: KycLevel, actor: string, reason: string, opts: { ip?: string } = {}): Promise<void> {
    requireReason(actor, reason);
    const now = this.now();
    await withTx(this.pool, async (c) => {
      const p = await lockPlayer(c, playerId);
      await c.query('UPDATE players SET kyc_level = $2 WHERE id = $1', [playerId, level]);
      await appendAudit(c, {
        playerId, actor, action: 'SET_KYC_LEVEL', reason, ip: opts.ip ?? null, at: now,
        before: { kycLevel: p.kyc_level }, after: { kycLevel: level },
      });
    });
  }

  /** FR-RSK-005: factor as a decimal string, 0.01 to 10.00. */
  async setStakeFactor(playerId: PlayerId, factor: string, actor: string, reason: string, opts: { ip?: string } = {}): Promise<void> {
    requireReason(actor, reason);
    const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(factor);
    const hundredths = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : 0;
    if (hundredths < 1 || hundredths > 1000) throw new AppError('invalid_request', 400, 'Stake factor must be 0.01 to 10.00.');
    const normalised = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
    const now = this.now();
    await withTx(this.pool, async (c) => {
      const p = await lockPlayer(c, playerId);
      await c.query('UPDATE players SET stake_factor = $2 WHERE id = $1', [playerId, normalised]);
      await appendAudit(c, {
        playerId, actor, action: 'SET_STAKE_FACTOR', reason, ip: opts.ip ?? null, at: now,
        before: { stakeFactor: p.stake_factor }, after: { stakeFactor: normalised },
      });
    });
  }

  async auditTrail(playerId: PlayerId): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query<{
      seq: bigint; player_id: string; actor: string; action: string; before: unknown; after: unknown; reason: string; ip: string | null; at: Date;
    }>('SELECT seq, player_id, actor, action, before, after, reason, ip, at FROM account_audit WHERE player_id = $1 ORDER BY seq', [playerId]);
    return rows.map((r) => ({
      seq: r.seq, playerId: r.player_id, actor: r.actor, action: r.action, before: r.before, after: r.after, reason: r.reason, ip: r.ip, at: r.at,
    }));
  }

  /** SEC-LOG-002: recomputes the hash chain; returns the first broken seq, or null when intact. */
  async verifyAuditChain(): Promise<bigint | null> {
    const { rows } = await this.pool.query<AuditRow>('SELECT * FROM account_audit ORDER BY seq');
    let prev: Buffer | null = null;
    for (const r of rows) {
      const expected = auditHash(prev, {
        playerId: r.player_id, actor: r.actor, action: r.action, before: r.before, after: r.after, reason: r.reason, ip: r.ip, at: r.at,
      });
      if ((r.prev_hash === null) !== (prev === null) || (prev && r.prev_hash && !prev.equals(r.prev_hash)) || !expected.equals(r.hash)) {
        return r.seq;
      }
      prev = r.hash;
    }
    return null;
  }

  // ---------- PlayerDirectory ----------

  async getStatus(playerId: PlayerId): Promise<PlayerStatus | null> {
    if (!UUID.test(playerId)) return null;
    const row = (await this.pool.query<PlayerRow>('SELECT * FROM players WHERE id = $1', [playerId])).rows[0];
    return row ? toStatus(row) : null;
  }

  // ---------- internals ----------

  private async hashNewPassword(password: string): Promise<string> {
    if ([...password].length < MIN_PASSWORD_LENGTH) {
      throw new AppError('weak_password', 422, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password.length > 256) throw new AppError('weak_password', 422, 'Password is too long.');
    if (await this.isBreached(password)) {
      throw new AppError('breached_password', 422, 'This password has appeared in a data breach. Choose another.');
    }
    return argon2.hash(password, ARGON2);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(newToken(), ARGON2);
    return this.dummyHash;
  }

  private async isThrottled(c: Client, subject: string, ip: string, now: Date): Promise<boolean> {
    // Serialise attempts per subject and per IP so parallel guesses cannot overrun the limits.
    await c.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [subject]);
    await c.query('SELECT pg_advisory_xact_lock(2, hashtext($1))', [ip]);
    const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
    const acct = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE subject = $1 AND NOT success AND at > $2
          AND at > COALESCE((SELECT max(at) FROM login_attempts WHERE subject = $1 AND success), '-infinity')`,
      [subject, since],
    );
    if ((acct.rows[0]?.n ?? 0) >= ACCOUNT_FAILURE_LIMIT) return true;
    const byIp = await c.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM login_attempts WHERE ip = $1 AND NOT success AND at > $2',
      [ip, since],
    );
    return (byIp.rows[0]?.n ?? 0) >= this.ipFailureLimit;
  }

  /** Verifies a TOTP code (±1 step) and rejects replays of an already-used step. Caller holds the player lock. */
  private async checkTotp(c: Client, player: PlayerRow, encrypted: Buffer, code: string, now: Date): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const secret = decrypt(this.mfaKey, encrypted, player.id);
    const delta = authenticator.clone({ epoch: now.getTime(), window: 1 }).checkDelta(code, secret);
    if (delta === null) return false;
    const step = BigInt(Math.floor(now.getTime() / 30_000) + delta);
    if (player.mfa_last_step !== null && step <= player.mfa_last_step) return false;
    await c.query('UPDATE players SET mfa_last_step = $2 WHERE id = $1', [player.id, step]);
    player.mfa_last_step = step;
    return true;
  }
}

// ---------- helpers ----------

type Queryable = Pick<Pool, 'query'> | Client;

const validationError = (issues: { path: (string | number)[]; message: string }[]): AppError =>
  new AppError('validation_error', 400, 'The request is invalid.', {
    errors: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

const requireReason = (actor: string, reason: string): void => {
  if (!actor.trim() || !reason.trim()) throw new AppError('invalid_request', 400, 'Actor and reason are required.');
};

const lockPlayer = async (c: Client, playerId: string): Promise<PlayerRow> => {
  if (!UUID.test(playerId)) throw new AppError('not_found', 404, 'Player not found.');
  const row = (await c.query<PlayerRow>('SELECT * FROM players WHERE id = $1 FOR UPDATE', [playerId])).rows[0];
  if (!row) throw new AppError('not_found', 404, 'Player not found.');
  return row;
};

const toStatus = (r: PlayerRow): PlayerStatus => ({
  playerId: r.id,
  state: r.state,
  kycLevel: r.kyc_level,
  jurisdiction: r.jurisdiction,
  currency: r.currency,
  stakeFactor: Number(r.stake_factor),
});

const recordAttempt = async (c: Client, subject: string, playerId: string | null, ip: string, success: boolean, at: Date) => {
  await c.query('INSERT INTO login_attempts (subject, player_id, ip, success, at) VALUES ($1,$2,$3,$4,$5)', [
    subject, playerId, ip, success, at,
  ]);
};

/** Marks a single-use token used, atomically. Returns its player, or null if unknown, used or expired. */
const consumeToken = async (c: Client, token: string, purpose: string, now: Date): Promise<string | null> => {
  const { rows } = await c.query<{ player_id: string }>(
    `UPDATE one_time_tokens SET used_at = $3
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
      RETURNING player_id`,
    [hashToken(token), purpose, now],
  );
  return rows[0]?.player_id ?? null;
};

const issueTokens = async (c: Client, sessionId: string, now: Date) => {
  const accessToken = newToken();
  const refreshToken = newToken();
  await c.query('INSERT INTO session_tokens (session_id, access_hash, refresh_hash, issued_at) VALUES ($1,$2,$3,$4)', [
    sessionId, hashToken(accessToken), hashToken(refreshToken), now,
  ]);
  return { accessToken, refreshToken };
};

const createSession = async (c: Client, playerId: string, meta: RequestMeta, now: Date, mfa: boolean): Promise<SessionTokens> => {
  const sessionId = randomUUID();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
  await c.query(
    `INSERT INTO sessions (id, player_id, created_at, last_seen_at, expires_at, mfa_verified_at, ip, user_agent)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7)`,
    [sessionId, playerId, now, expiresAt, mfa ? now : null, meta.ip, meta.userAgent?.slice(0, 256) ?? null],
  );
  return { sessionId, ...(await issueTokens(c, sessionId, now)), expiresAt };
};

const revoke = async (q: Queryable, where: string, params: unknown[], reason: string, now: Date): Promise<number> => {
  const n = params.length;
  const res = await q.query(
    `UPDATE sessions SET revoked_at = $${n + 1}, revoke_reason = $${n + 2} WHERE ${where} AND revoked_at IS NULL`,
    [...params, now, reason],
  );
  return res.rowCount ?? 0;
};

type AuditRow = {
  seq: bigint; player_id: string; actor: string; action: string; before: unknown; after: unknown;
  reason: string; ip: string | null; at: Date; prev_hash: Buffer | null; hash: Buffer;
};

type AuditEntry = {
  playerId: string; actor: string; action: string; before: unknown; after: unknown; reason: string; ip: string | null; at: Date;
};

const auditHash = (prev: Buffer | null, e: AuditEntry): Buffer =>
  createHash('sha256')
    .update(prev ?? Buffer.alloc(0))
    .update(
      JSON.stringify([e.playerId, e.actor, e.action, canonical(e.before), canonical(e.after), e.reason, e.ip, e.at.toISOString()]),
    )
    .digest();

/** jsonb reorders keys, so hash a key-sorted copy. */
const canonical = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]))
    : v;

/** Append-only, hash-chained (SEC-LOG-002). The advisory lock keeps the chain linear under concurrency. */
const appendAudit = async (c: Client, e: AuditEntry): Promise<void> => {
  await c.query("SELECT pg_advisory_xact_lock(3, hashtext('account_audit'))");
  const prev = (await c.query<{ hash: Buffer }>('SELECT hash FROM account_audit ORDER BY seq DESC LIMIT 1')).rows[0]?.hash ?? null;
  await c.query(
    `INSERT INTO account_audit (player_id, actor, action, before, after, reason, ip, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.playerId, e.actor, e.action, JSON.stringify(e.before), JSON.stringify(e.after), e.reason, e.ip, e.at, prev, auditHash(prev, e)],
  );
};
