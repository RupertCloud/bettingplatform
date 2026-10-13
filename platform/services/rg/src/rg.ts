import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  withTx,
  type Client,
  type Currency,
  type GateDecision,
  type Minor,
  type PlayerDirectory,
  type PlayerId,
  type PlayerStatus,
  type Pool,
  type RgGate,
} from '@bp/common';
import {
  assertJurisdiction,
  rulesFromJson,
  rulesToJson,
  type RulesSet,
  type RulesVersion,
  type SelfExclusionPeriod,
  type TimeOutPeriod,
} from './rules.js';
import {
  DEFAULT_INTERVENTION_THRESHOLDS,
  INTERVENTION_TYPES,
  markerPoints,
  riskLevel,
  scoreMarkers,
  triggeredInterventions,
  type InterventionThresholds,
  type InterventionType,
  type RiskLevel,
  type RiskMarkers,
} from './risk.js';
import { MAX_REALITY_CHECK_MINUTES, MIN_REALITY_CHECK_MINUTES, nextRealityCheck } from './reality.js';

// ---------- Ports and types ----------

export type ExclusionState = 'SELF_EXCLUDED' | 'TIMED_OUT';

/** Pushes time-out / self-exclusion to the account service (proposed for @bp/common ports). */
export interface PlayerStateSink {
  /** until null means permanent. */
  setState(playerId: PlayerId, state: ExclusionState, until: Date | null): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** A back-office actor; every staff write is audited with it (FR-BO-010). */
export interface Actor {
  staffId: string;
  ip?: string;
}

export const LIMIT_KINDS = [
  'DEPOSIT_DAY',
  'DEPOSIT_WEEK',
  'DEPOSIT_MONTH',
  'LOSS_DAY',
  'LOSS_WEEK',
  'LOSS_MONTH',
  'STAKE_PER_BET',
  'STAKE_DAY',
  'SESSION_MINUTES',
] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];
/** Kinds whose value is money in minor units; SESSION_MINUTES is minutes. */
export const isMoneyLimit = (k: LimitKind): boolean => k !== 'SESSION_MINUTES';

export interface LimitView {
  kind: LimitKind;
  value: bigint | null;
  pending: { value: bigint | null; availableAt: Date } | null;
}

export type LimitChangeResult =
  | { status: 'APPLIED' | 'UNCHANGED' }
  | { status: 'PENDING'; availableAt: Date };

export interface Exclusion {
  state: ExclusionState;
  until: Date | null;
}

export const INTERVENTION_OUTCOMES = ['COMPLETED', 'NO_RESPONSE', 'ESCALATED', 'LIFTED'] as const;
export type InterventionOutcome = (typeof INTERVENTION_OUTCOMES)[number];

export interface Intervention {
  id: string;
  playerId: PlayerId;
  type: InterventionType;
  source: string;
  score: number | null;
  reason: string;
  createdAt: Date;
  outcome: InterventionOutcome | null;
  outcomeNote: string | null;
  outcomeBy: string | null;
  outcomeAt: Date | null;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  markers: RiskMarkers;
  points: Record<string, number>;
  computedAt: Date;
  interventionsCreated: InterventionType[];
}

export interface RealityCheckView {
  sessionId: string;
  sessionMinutes: number;
  /** Returns minus stakes during the session, minor units of the player's currency. */
  netResult: Minor;
  currency: Currency;
  intervalMinutes: number;
  nextAt: Date;
  due: boolean;
}

export interface AffordabilityCase {
  id: string;
  playerId: PlayerId;
  currency: Currency;
  netDeposits: Minor;
  threshold: Minor;
  openedAt: Date;
  status: 'OPEN' | 'CLEARED';
  approvedAmount: Minor | null;
}

export interface RgDeps {
  pool: Pool;
  players: PlayerDirectory;
  stateSink: PlayerStateSink;
  clock: Clock;
  interventionThresholds?: InterventionThresholds;
}

export type PaymentMethod = 'CREDIT_CARD' | 'DEBIT_CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'E_WALLET' | 'CRYPTO';

type ActivityKind =
  | 'DEPOSIT'
  | 'DEPOSIT_DECLINED'
  | 'STAKE'
  | 'STAKE_RELEASED'
  | 'SETTLEMENT'
  | 'WITHDRAWAL'
  | 'WITHDRAWAL_CANCELLED';

// ---------- Helpers ----------

const HOUR = 3_600_000;
const allow: GateDecision = { allowed: true };
const deny = (code: string, detail: string): GateDecision => ({ allowed: false, code, detail });

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** JSON with object keys sorted, so a hash survives a jsonb round trip. */
const canonical = (v: unknown): string =>
  JSON.stringify(JSON.parse(json(v) ?? 'null'), (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

const addMonthsUtc = (at: Date, months: number): Date => {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

const exclusionEnd = (period: TimeOutPeriod | SelfExclusionPeriod, at: Date): Date | null => {
  switch (period) {
    case '24h':
      return new Date(at.getTime() + 24 * HOUR);
    case '7d':
      return new Date(at.getTime() + 7 * 24 * HOUR);
    case '42d':
      return new Date(at.getTime() + 42 * 24 * HOUR);
    case '6m':
      return addMonthsUtc(at, 6);
    case '1y':
      return addMonthsUtc(at, 12);
    case '5y':
      return addMonthsUtc(at, 60);
    case 'permanent':
      return null;
  }
};

const assertRef = (ref: string): void => {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 200) {
    throw new AppError('invalid_reference', 400, 'Reference must be 1 to 200 characters');
  }
};

const assertPositive = (amount: Minor, name = 'amount'): void => {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new AppError('invalid_amount', 400, `${name} must be positive`);
};

/** Identity key for one person across brands: normalised email and date of birth (FR-RG-007). */
export const personKey = (email: string, dateOfBirth: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new AppError('invalid_identity', 400, 'dateOfBirth must be YYYY-MM-DD');
  const normalised = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalised)) throw new AppError('invalid_identity', 400, 'Bad email');
  return 'v1:' + createHash('sha256').update(`${normalised}|${dateOfBirth}`).digest('hex');
};

const lockPlayer = async (c: Client, playerId: PlayerId): Promise<void> => {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rg:player:${playerId}`]);
};

interface WindowSums {
  dep: Record<'DAY' | 'WEEK' | 'MONTH', bigint>;
  stake: Record<'DAY' | 'WEEK' | 'MONTH', bigint>;
  ret: Record<'DAY' | 'WEEK' | 'MONTH', bigint>;
  withdrawnMonth: bigint;
}

// Rolling windows: DAY = 24 h, WEEK = 7 days, MONTH = 30 days, ending at `at` (inclusive).
// Deposits later declined and withdrawals later cancelled (same ref) do not count.
const windowSums = async (c: Client, playerId: PlayerId, currency: Currency, at: Date): Promise<WindowSums> => {
  const r = await c.query<Record<string, bigint>>(
    `WITH a AS (
       SELECT kind, amount, occurred_at FROM activity x
        WHERE x.player_id = $1 AND x.currency = $2
          AND x.occurred_at > $3::timestamptz - interval '30 days' AND x.occurred_at <= $3::timestamptz
          AND NOT (x.kind IN ('DEPOSIT', 'WITHDRAWAL', 'STAKE') AND EXISTS (
                SELECT 1 FROM activity d WHERE d.player_id = x.player_id AND d.ref = x.ref
                   AND d.kind = CASE x.kind WHEN 'DEPOSIT' THEN 'DEPOSIT_DECLINED'
                                            WHEN 'STAKE' THEN 'STAKE_RELEASED'
                                            ELSE 'WITHDRAWAL_CANCELLED' END))
     )
     SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'DEPOSIT' AND occurred_at > $3::timestamptz - interval '1 day'), 0)::bigint AS dep_day,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'DEPOSIT' AND occurred_at > $3::timestamptz - interval '7 days'), 0)::bigint AS dep_week,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'DEPOSIT'), 0)::bigint AS dep_month,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE' AND occurred_at > $3::timestamptz - interval '1 day'), 0)::bigint AS stake_day,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE' AND occurred_at > $3::timestamptz - interval '7 days'), 0)::bigint AS stake_week,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE'), 0)::bigint AS stake_month,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'SETTLEMENT' AND occurred_at > $3::timestamptz - interval '1 day'), 0)::bigint AS ret_day,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'SETTLEMENT' AND occurred_at > $3::timestamptz - interval '7 days'), 0)::bigint AS ret_week,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'SETTLEMENT'), 0)::bigint AS ret_month,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'WITHDRAWAL'), 0)::bigint AS wd_month
     FROM a`,
    [playerId, currency, at],
  );
  const row = r.rows[0]!;
  const g = (k: string): bigint => row[k] ?? 0n;
  return {
    dep: { DAY: g('dep_day'), WEEK: g('dep_week'), MONTH: g('dep_month') },
    stake: { DAY: g('stake_day'), WEEK: g('stake_week'), MONTH: g('stake_month') },
    ret: { DAY: g('ret_day'), WEEK: g('ret_week'), MONTH: g('ret_month') },
    withdrawnMonth: g('wd_month'),
  };
};

const WINDOW_NAME = { DAY: 'day', WEEK: 'week', MONTH: 'month' } as const;

interface InterventionRow {
  id: string;
  player_id: string;
  type: InterventionType;
  source: string;
  score: number | null;
  reason: string;
  created_at: Date;
  outcome: InterventionOutcome | null;
  outcome_note: string | null;
  outcome_by: string | null;
  outcome_at: Date | null;
}

const toIntervention = (r: InterventionRow): Intervention => ({
  id: r.id,
  playerId: r.player_id,
  type: r.type,
  source: r.source,
  score: r.score,
  reason: r.reason,
  createdAt: r.created_at,
  outcome: r.outcome,
  outcomeNote: r.outcome_note,
  outcomeBy: r.outcome_by,
  outcomeAt: r.outcome_at,
});

interface RulesRow {
  jurisdiction: string;
  version: number;
  rules: unknown;
  effective_from: Date;
  author: string;
  status: 'PENDING' | 'APPROVED';
  approved_by: string | null;
  approved_at: Date | null;
}

const toRulesVersion = (r: RulesRow): RulesVersion => ({
  jurisdiction: r.jurisdiction,
  version: r.version,
  rules: rulesFromJson(r.rules),
  effectiveFrom: r.effective_from,
  author: r.author,
  status: r.status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
});

// ---------- Service ----------

/** Responsible gambling and jurisdiction rules (SRS 4.9, 4.12). Implements the RgGate port. */
export class ResponsibleGambling implements RgGate {
  private readonly pool: Pool;
  private readonly players: PlayerDirectory;
  private readonly sink: PlayerStateSink;
  private readonly clock: Clock;
  private readonly thresholds: InterventionThresholds;

  constructor(deps: RgDeps) {
    this.pool = deps.pool;
    this.players = deps.players;
    this.sink = deps.stateSink;
    this.clock = deps.clock;
    this.thresholds = deps.interventionThresholds ?? DEFAULT_INTERVENTION_THRESHOLDS;
  }

  // ----- Jurisdiction rules (FR-JUR-001, FR-JUR-003) -----

  /** The approved rules version in force for a jurisdiction at a moment. */
  async rulesFor(jurisdiction: string, at: Date, c?: Client): Promise<RulesVersion> {
    const r = await (c ?? this.pool).query<RulesRow>(
      `SELECT * FROM rules_versions
        WHERE jurisdiction = $1 AND status = 'APPROVED' AND effective_from <= $2
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [jurisdiction, at],
    );
    const row = r.rows[0];
    if (!row) throw new AppError('no_rules', 409, `No rules in force for jurisdiction ${jurisdiction}`);
    return toRulesVersion(row);
  }

  /** Every version, newest first; old versions are never deleted (FR-JUR-003). */
  async rulesHistory(jurisdiction: string): Promise<RulesVersion[]> {
    const r = await this.pool.query<RulesRow>(
      'SELECT * FROM rules_versions WHERE jurisdiction = $1 ORDER BY version DESC',
      [jurisdiction],
    );
    return r.rows.map(toRulesVersion);
  }

  /** Drafts a new rules version; it needs approval by a different compliance officer. */
  async proposeRules(
    jurisdiction: string,
    rules: RulesSet,
    effectiveFrom: Date,
    actor: Actor,
    reason: string,
  ): Promise<RulesVersion> {
    assertJurisdiction(jurisdiction);
    const at = this.clock.now();
    if (effectiveFrom.getTime() < at.getTime()) {
      throw new AppError('effective_from_in_past', 400, 'effectiveFrom must not be in the past');
    }
    const stored = rulesToJson(rules);
    rulesFromJson(stored); // validates ranges
    return withTx(this.pool, async (c) => {
      await c.query('LOCK TABLE rules_versions IN SHARE ROW EXCLUSIVE MODE');
      const v = await c.query<{ next: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM rules_versions WHERE jurisdiction = $1',
        [jurisdiction],
      );
      const version = v.rows[0]!.next;
      const r = await c.query<RulesRow>(
        `INSERT INTO rules_versions (jurisdiction, version, rules, effective_from, author, created_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING *`,
        [jurisdiction, version, json(stored), effectiveFrom, actor.staffId, at],
      );
      await this.audit(c, actor, 'RULES_PROPOSED', `rules:${jurisdiction}:${version}`, null, { rules: stored, effectiveFrom }, reason, at);
      return toRulesVersion(r.rows[0]!);
    });
  }

  /** Four-eyes approval: approver must differ from author; takes effect at effectiveFrom. */
  async approveRules(jurisdiction: string, version: number, actor: Actor, reason: string): Promise<RulesVersion> {
    const at = this.clock.now();
    return withTx(this.pool, async (c) => {
      const cur = await c.query<RulesRow>(
        'SELECT * FROM rules_versions WHERE jurisdiction = $1 AND version = $2 FOR UPDATE',
        [jurisdiction, version],
      );
      const row = cur.rows[0];
      if (!row) throw new AppError('not_found', 404, 'No such rules version');
      if (row.status !== 'PENDING') throw new AppError('already_approved', 409, 'Rules version already approved');
      if (row.author === actor.staffId) {
        throw new AppError('four_eyes_required', 403, 'Approver must differ from the author');
      }
      if (row.effective_from.getTime() < at.getTime()) {
        throw new AppError('effective_from_passed', 409, 'effectiveFrom has passed; propose a new version');
      }
      const r = await c.query<RulesRow>(
        `UPDATE rules_versions SET status = 'APPROVED', approved_by = $3, approved_at = $4
          WHERE jurisdiction = $1 AND version = $2 RETURNING *`,
        [jurisdiction, version, actor.staffId, at],
      );
      await this.audit(c, actor, 'RULES_APPROVED', `rules:${jurisdiction}:${version}`, { status: 'PENDING' }, { status: 'APPROVED' }, reason, at);
      return toRulesVersion(r.rows[0]!);
    });
  }

  // ----- Player context -----

  private async status(playerId: PlayerId): Promise<PlayerStatus> {
    const s = await this.players.getStatus(playerId);
    if (!s) throw new AppError('unknown_player', 404, 'Unknown player');
    return s;
  }

  async currencyOf(playerId: PlayerId): Promise<Currency> {
    return (await this.status(playerId)).currency;
  }

  /** Links a player to a person identity so exclusions apply across brands (FR-RG-007). */
  async linkIdentity(playerId: PlayerId, email: string, dateOfBirth: string): Promise<void> {
    const key = personKey(email, dateOfBirth);
    const at = this.clock.now();
    const excl = await withTx(this.pool, async (c) => {
      const r = await c.query<{ person_key: string | null }>(
        `INSERT INTO players (player_id, person_key) VALUES ($1, $2)
         ON CONFLICT (player_id) DO UPDATE SET person_key = COALESCE(players.person_key, EXCLUDED.person_key)
         RETURNING person_key`,
        [playerId, key],
      );
      if (r.rows[0]!.person_key !== key) {
        throw new AppError('identity_conflict', 409, 'Player is already linked to another identity');
      }
      return this.activeExclusion(c, playerId, at);
    });
    // An excluded person opening an account on another brand is excluded at once.
    if (excl) await this.sink.setState(playerId, excl.state, excl.until);
  }

  async setMarketingOptOut(playerId: PlayerId, optOut: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO players (player_id, marketing_opt_out) VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET marketing_opt_out = EXCLUDED.marketing_opt_out`,
      [playerId, optOut],
    );
  }

  // ----- Limits (FR-RG-001, FR-RG-002, FR-RG-003) -----

  async getLimits(playerId: PlayerId): Promise<LimitView[]> {
    const active = await this.pool.query<{ kind: LimitKind; value: bigint }>(
      'SELECT kind, value FROM limits WHERE player_id = $1',
      [playerId],
    );
    const pending = await this.pool.query<{ kind: LimitKind; new_value: bigint | null; available_at: Date }>(
      `SELECT kind, new_value, available_at FROM limit_changes WHERE player_id = $1 AND status = 'PENDING'`,
      [playerId],
    );
    return LIMIT_KINDS.map((kind) => {
      const a = active.rows.find((r) => r.kind === kind);
      const p = pending.rows.find((r) => r.kind === kind);
      return {
        kind,
        value: a ? a.value : null,
        pending: p ? { value: p.new_value, availableAt: p.available_at } : null,
      };
    });
  }

  /**
   * Sets a limit. value null removes it. A decrease (or a new limit) applies at once;
   * an increase or removal waits for the cooling-off and then an explicit confirmation.
   */
  async setLimit(playerId: PlayerId, kind: LimitKind, value: bigint | null): Promise<LimitChangeResult> {
    if (!LIMIT_KINDS.includes(kind)) throw new AppError('invalid_limit', 400, 'Unknown limit kind');
    if (value !== null) assertPositive(value, 'Limit');
    const st = await this.status(playerId);
    const at = this.clock.now();
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      const cur = await c.query<{ value: bigint }>('SELECT value FROM limits WHERE player_id = $1 AND kind = $2', [playerId, kind]);
      const current = cur.rows[0]?.value ?? null;
      await c.query(
        `UPDATE limit_changes SET status = 'SUPERSEDED', closed_at = $3 WHERE player_id = $1 AND kind = $2 AND status = 'PENDING'`,
        [playerId, kind, at],
      );
      if (value === current) return { status: 'UNCHANGED' };
      const isDecrease = value !== null && (current === null || value < current);
      if (isDecrease) {
        await c.query(
          `INSERT INTO limits (player_id, kind, value) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, kind) DO UPDATE SET value = EXCLUDED.value`,
          [playerId, kind, value],
        );
        await c.query(
          `INSERT INTO limit_changes (player_id, kind, old_value, new_value, requested_at, available_at, status, closed_at)
           VALUES ($1, $2, $3, $4, $5, $5, 'APPLIED', $5)`,
          [playerId, kind, current, value, at],
        );
        return { status: 'APPLIED' };
      }
      const availableAt = new Date(at.getTime() + rules.limitIncreaseCoolingHours * HOUR);
      await c.query(
        `INSERT INTO limit_changes (player_id, kind, old_value, new_value, requested_at, available_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
        [playerId, kind, current, value, at, availableAt],
      );
      return { status: 'PENDING', availableAt };
    });
  }

  /** Player re-confirms a pending increase or removal after the cooling-off (FR-RG-003). */
  async confirmLimit(playerId: PlayerId, kind: LimitKind): Promise<{ kind: LimitKind; value: bigint | null }> {
    const at = this.clock.now();
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      const p = await c.query<{ id: bigint; new_value: bigint | null; available_at: Date }>(
        `SELECT id, new_value, available_at FROM limit_changes WHERE player_id = $1 AND kind = $2 AND status = 'PENDING'`,
        [playerId, kind],
      );
      const row = p.rows[0];
      if (!row) throw new AppError('no_pending_change', 404, 'No pending limit change');
      if (at.getTime() < row.available_at.getTime()) {
        throw new AppError('cooling_off_active', 409, 'The cooling-off period has not ended', {
          availableAt: row.available_at.toISOString(),
        });
      }
      if (row.new_value === null) {
        await c.query('DELETE FROM limits WHERE player_id = $1 AND kind = $2', [playerId, kind]);
      } else {
        await c.query(
          `INSERT INTO limits (player_id, kind, value) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, kind) DO UPDATE SET value = EXCLUDED.value`,
          [playerId, kind, row.new_value],
        );
      }
      await c.query(`UPDATE limit_changes SET status = 'CONFIRMED', closed_at = $2 WHERE id = $1`, [row.id, at]);
      return { kind, value: row.new_value };
    });
  }

  // ----- Activity -----

  private async record(
    kind: ActivityKind,
    playerId: PlayerId,
    currency: Currency,
    amount: Minor,
    ref: string,
    at: Date,
    stake: Minor | null = null,
  ): Promise<boolean> {
    assertRef(ref);
    if (typeof amount !== 'bigint' || amount < 0n) throw new AppError('invalid_amount', 400, 'Amount must not be negative');
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      return this.insertActivity(c, kind, playerId, currency, amount, ref, at, stake);
    });
  }

  private async insertActivity(
    c: Client,
    kind: ActivityKind,
    playerId: PlayerId,
    currency: Currency,
    amount: Minor,
    ref: string,
    at: Date,
    stake: Minor | null = null,
  ): Promise<boolean> {
    const r = await c.query(
      `INSERT INTO activity (player_id, kind, currency, amount, stake, ref, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (player_id, kind, ref) DO NOTHING`,
      [playerId, kind, currency, amount, stake, ref, at],
    );
    return r.rowCount === 1;
  }

  /** Returns false when this ref was already recorded (idempotent). */
  recordDeposit(playerId: PlayerId, currency: Currency, amount: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('DEPOSIT', playerId, currency, amount, ref, at);
  }
  /** A declined deposit; if a deposit with the same ref was recorded it stops counting toward limits. */
  recordDepositDeclined(playerId: PlayerId, currency: Currency, amount: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('DEPOSIT_DECLINED', playerId, currency, amount, ref, at);
  }
  recordStake(playerId: PlayerId, currency: Currency, stake: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('STAKE', playerId, currency, stake, ref, at);
  }
  /** The bet recorded under ref was refused after recording; its stake stops counting toward limits. */
  releaseStake(playerId: PlayerId, currency: Currency, stake: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('STAKE_RELEASED', playerId, currency, stake, ref, at);
  }
  /** Settlement of a bet: what was staked and what was returned (0 for a loss, stake for a void). */
  recordSettlement(playerId: PlayerId, currency: Currency, stake: Minor, returned: Minor, ref: string, at: Date): Promise<boolean> {
    if (typeof stake !== 'bigint' || stake < 0n) throw new AppError('invalid_amount', 400, 'Stake must not be negative');
    return this.record('SETTLEMENT', playerId, currency, returned, ref, at, stake);
  }
  recordWithdrawal(playerId: PlayerId, currency: Currency, amount: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('WITHDRAWAL', playerId, currency, amount, ref, at);
  }
  /** Use the withdrawal's ref: the cancelled amount no longer counts as withdrawn. */
  recordWithdrawalCancelled(playerId: PlayerId, currency: Currency, amount: Minor, ref: string, at: Date): Promise<boolean> {
    return this.record('WITHDRAWAL_CANCELLED', playerId, currency, amount, ref, at);
  }

  /** Starts a session; any earlier open session of the player is closed. */
  async startSession(playerId: PlayerId, at: Date): Promise<string> {
    const id = randomUUID();
    await withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      await c.query('UPDATE sessions SET ended_at = GREATEST(started_at, $2) WHERE player_id = $1 AND ended_at IS NULL', [playerId, at]);
      await c.query('INSERT INTO sessions (id, player_id, started_at) VALUES ($1, $2, $3)', [id, playerId, at]);
    });
    return id;
  }

  async endSession(playerId: PlayerId, sessionId: string, at: Date): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET ended_at = GREATEST(started_at, $3) WHERE id = $1 AND player_id = $2 AND ended_at IS NULL',
      [sessionId, playerId, at],
    );
  }

  // ----- Gate (RgGate port) -----

  checkStake(playerId: PlayerId, currency: Currency, stake: Minor, at: Date): Promise<GateDecision> {
    return this.gate('STAKE', playerId, currency, stake, at, null);
  }

  checkDeposit(playerId: PlayerId, currency: Currency, amount: Minor, at: Date): Promise<GateDecision> {
    return this.gate('DEPOSIT', playerId, currency, amount, at, null);
  }

  /**
   * Check and record in one transaction under the player lock, so parallel bets cannot
   * both pass a limit. Replaying the same ref returns allowed without counting twice.
   */
  checkAndRecordStake(playerId: PlayerId, currency: Currency, stake: Minor, ref: string, at: Date): Promise<GateDecision> {
    assertRef(ref);
    return this.gate('STAKE', playerId, currency, stake, at, ref);
  }

  /** As checkAndRecordStake for deposits; record a decline with the same ref if the PSP refuses. */
  checkAndRecordDeposit(playerId: PlayerId, currency: Currency, amount: Minor, ref: string, at: Date): Promise<GateDecision> {
    assertRef(ref);
    return this.gate('DEPOSIT', playerId, currency, amount, at, ref);
  }

  /** FR-RG-013: credit-card deposits where the jurisdiction bans them. */
  async checkPaymentMethod(playerId: PlayerId, method: PaymentMethod, at: Date): Promise<GateDecision> {
    const st = await this.players.getStatus(playerId);
    if (!st) return deny('unknown_player', 'Unknown player');
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    if (method === 'CREDIT_CARD' && rules.creditCardBan) {
      return deny('credit_card_banned', 'Credit card deposits are not allowed in this jurisdiction');
    }
    return allow;
  }

  /** FR-RG-014: whether the player may reverse a requested withdrawal. */
  async checkWithdrawalReversal(playerId: PlayerId, at: Date): Promise<GateDecision> {
    const st = await this.players.getStatus(playerId);
    if (!st) return deny('unknown_player', 'Unknown player');
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    return rules.withdrawalReversalAllowed
      ? allow
      : deny('withdrawal_reversal_blocked', 'Withdrawal reversal is not allowed in this jurisdiction');
  }

  private async gate(
    kind: 'STAKE' | 'DEPOSIT',
    playerId: PlayerId,
    currency: Currency,
    amount: Minor,
    at: Date,
    ref: string | null,
  ): Promise<GateDecision> {
    assertPositive(amount);
    const st = await this.players.getStatus(playerId);
    if (!st) return deny('unknown_player', 'Unknown player');
    if (st.currency !== currency) return deny('currency_mismatch', 'Currency differs from the player currency');
    let rules: RulesSet;
    try {
      rules = (await this.rulesFor(st.jurisdiction, at)).rules;
    } catch {
      return deny('no_rules', 'No rules in force for the player jurisdiction');
    }
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      if (ref !== null) {
        const spent = kind === 'DEPOSIT' ? 'DEPOSIT_DECLINED' : 'STAKE_RELEASED';
        const seen = await c.query<{ kind: string }>(
          'SELECT kind FROM activity WHERE player_id = $1 AND kind IN ($2, $3) AND ref = $4',
          [playerId, kind, spent, ref],
        );
        // A declined deposit's or released stake's ref is spent: a retry under it would never count toward limits.
        if (seen.rows.some((r) => r.kind === spent)) {
          return deny('reference_declined', 'This reference was declined or released; use a new reference');
        }
        if (seen.rows.some((r) => r.kind === kind)) return allow;
      }
      const excl = await this.activeExclusion(c, playerId, at, this.clock.now());
      if (excl) {
        return excl.state === 'SELF_EXCLUDED'
          ? deny('self_excluded', 'The player is self-excluded')
          : deny('timed_out', 'The player is in a time-out');
      }
      const open = await c.query<{ type: InterventionType }>(
        `SELECT type FROM interventions WHERE player_id = $1 AND outcome IS NULL AND type IN ('SUSPEND', 'DEPOSIT_CAP')`,
        [playerId],
      );
      const openTypes = new Set(open.rows.map((r) => r.type));
      if (openTypes.has('SUSPEND')) return deny('rg_suspended', 'Account suspended pending a responsible gambling review');

      const lim = await c.query<{ kind: LimitKind; value: bigint }>('SELECT kind, value FROM limits WHERE player_id = $1', [playerId]);
      const limits = new Map(lim.rows.map((r) => [r.kind, r.value]));
      const sums = await windowSums(c, playerId, currency, at);

      const decision =
        kind === 'DEPOSIT'
          ? await this.depositDecision(c, playerId, currency, amount, at, rules, limits, sums, openTypes.has('DEPOSIT_CAP'))
          : await this.stakeDecision(c, playerId, amount, at, limits, sums);
      if (decision.allowed && ref !== null) {
        await this.insertActivity(c, kind, playerId, currency, amount, ref, at);
      }
      return decision;
    });
  }

  private async stakeDecision(
    c: Client,
    playerId: PlayerId,
    stake: Minor,
    at: Date,
    limits: Map<LimitKind, bigint>,
    sums: WindowSums,
  ): Promise<GateDecision> {
    const sessionLimit = limits.get('SESSION_MINUTES');
    if (sessionLimit !== undefined) {
      const s = await c.query<{ started_at: Date }>(
        `SELECT started_at FROM sessions WHERE player_id = $1 AND ended_at IS NULL AND started_at <= $2
          ORDER BY started_at DESC LIMIT 1`,
        [playerId, at],
      );
      const started = s.rows[0]?.started_at;
      if (started && BigInt(at.getTime() - started.getTime()) >= sessionLimit * 60_000n) {
        return deny('session_limit_reached', 'Session time limit reached');
      }
    }
    const perBet = limits.get('STAKE_PER_BET');
    if (perBet !== undefined && stake > perBet) return deny('stake_limit_exceeded', 'Stake exceeds the per-bet stake limit');
    const perDay = limits.get('STAKE_DAY');
    if (perDay !== undefined && sums.stake.DAY + stake > perDay) {
      return deny('stake_limit_exceeded', 'Stake exceeds the daily stake limit');
    }
    // Net loss in the window, counting this stake as lost.
    for (const w of ['DAY', 'WEEK', 'MONTH'] as const) {
      const limit = limits.get(`LOSS_${w}`);
      if (limit !== undefined && sums.stake[w] - sums.ret[w] + stake > limit) {
        return deny('loss_limit_exceeded', `Stake would exceed the ${WINDOW_NAME[w]} loss limit`);
      }
    }
    return allow;
  }

  private async depositDecision(
    c: Client,
    playerId: PlayerId,
    currency: Currency,
    amount: Minor,
    at: Date,
    rules: RulesSet,
    limits: Map<LimitKind, bigint>,
    sums: WindowSums,
    capped: boolean,
  ): Promise<GateDecision> {
    if (capped) return deny('deposit_capped', 'Deposits are capped pending a responsible gambling review');
    for (const w of ['DAY', 'WEEK', 'MONTH'] as const) {
      const limit = limits.get(`DEPOSIT_${w}`);
      if (limit !== undefined && sums.dep[w] + amount > limit) {
        return deny('deposit_limit_exceeded', `Deposit would exceed the ${WINDOW_NAME[w]} deposit limit`);
      }
    }
    // FR-RG-012: affordability.
    const open = await c.query('SELECT 1 FROM affordability_cases WHERE player_id = $1 AND status = $2', [playerId, 'OPEN']);
    if (open.rowCount) return deny('affordability_check_pending', 'Deposits are capped until the affordability check is resolved');
    if (rules.currency !== currency) {
      return deny('affordability_currency_unsupported', 'No affordability threshold for this currency');
    }
    const cleared = await c.query<{ approved: bigint | null }>(
      `SELECT MAX(approved_amount)::bigint AS approved FROM affordability_cases
        WHERE player_id = $1 AND status = 'CLEARED' AND currency = $2`,
      [playerId, currency],
    );
    const approved = cleared.rows[0]?.approved ?? null;
    const threshold =
      approved !== null && approved > rules.affordabilityNetDepositThreshold ? approved : rules.affordabilityNetDepositThreshold;
    const net = sums.dep.MONTH - sums.withdrawnMonth;
    if (net + amount > threshold) {
      await c.query(
        `INSERT INTO affordability_cases (id, player_id, currency, net_deposits, threshold, opened_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN') ON CONFLICT DO NOTHING`,
        [randomUUID(), playerId, currency, net + amount, threshold, at],
      );
      return deny('affordability_check_required', 'An affordability check is required before further deposits');
    }
    return allow;
  }

  // ----- Affordability (FR-RG-012) -----

  async affordabilityCases(playerId: PlayerId): Promise<AffordabilityCase[]> {
    const r = await this.pool.query<{
      id: string; player_id: string; currency: Currency; net_deposits: bigint; threshold: bigint;
      opened_at: Date; status: 'OPEN' | 'CLEARED'; approved_amount: bigint | null;
    }>('SELECT * FROM affordability_cases WHERE player_id = $1 ORDER BY opened_at DESC', [playerId]);
    return r.rows.map((x) => ({
      id: x.id, playerId: x.player_id, currency: x.currency, netDeposits: x.net_deposits, threshold: x.threshold,
      openedAt: x.opened_at, status: x.status, approvedAmount: x.approved_amount,
    }));
  }

  /** A compliance officer clears a case with the net deposits per 30 days the player can afford. */
  async resolveAffordability(
    caseId: string,
    approvedAmount: Minor,
    currency: Currency,
    actor: Actor,
    reason: string,
  ): Promise<void> {
    assertPositive(approvedAmount, 'Approved amount');
    const at = this.clock.now();
    await withTx(this.pool, async (c) => {
      const r = await c.query<{ player_id: string }>(
        `UPDATE affordability_cases SET status = 'CLEARED', approved_amount = $2, resolved_by = $3, resolved_at = $4
          WHERE id = $1 AND status = 'OPEN' AND currency = $5 RETURNING player_id`,
        [caseId, approvedAmount, actor.staffId, at, currency],
      );
      if (!r.rowCount) throw new AppError('not_found', 404, 'No open affordability case');
      await this.audit(c, actor, 'AFFORDABILITY_RESOLVED', `affordability:${caseId}`, { status: 'OPEN' },
        { status: 'CLEARED', approvedAmount }, reason, at);
    });
  }

  async openAffordabilityCase(playerId: PlayerId): Promise<AffordabilityCase | null> {
    return (await this.affordabilityCases(playerId)).find((x) => x.status === 'OPEN') ?? null;
  }

  // ----- Time-out and self-exclusion (FR-RG-004, FR-RG-005, FR-RG-007) -----

  /**
   * Exclusion in force at `at`. `startedBy` (default `at`) lets a check with a back-dated `at`
   * still see an exclusion that has already started, so effect is immediate.
   */
  private async activeExclusion(c: Client | Pool, playerId: PlayerId, at: Date, startedBy: Date = at): Promise<Exclusion | null> {
    const r = await c.query<{ kind: 'TIME_OUT' | 'SELF_EXCLUSION'; ends_at: Date | null }>(
      `SELECT e.kind, e.ends_at FROM exclusions e
        WHERE e.starts_at <= GREATEST($2::timestamptz, $3::timestamptz) AND (e.ends_at IS NULL OR e.ends_at > $2)
          AND (e.player_id = $1
               OR e.person_key IN (SELECT person_key FROM players WHERE player_id = $1 AND person_key IS NOT NULL)
               OR e.player_id IN (SELECT p2.player_id FROM players p1 JOIN players p2 ON p2.person_key = p1.person_key
                                   WHERE p1.player_id = $1))
        ORDER BY (e.kind = 'SELF_EXCLUSION') DESC, e.ends_at DESC NULLS FIRST
        LIMIT 1`,
      [playerId, at, startedBy],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { state: row.kind === 'SELF_EXCLUSION' ? 'SELF_EXCLUDED' : 'TIMED_OUT', until: row.ends_at };
  }

  async exclusionStatus(playerId: PlayerId, at: Date): Promise<Exclusion | null> {
    return this.activeExclusion(this.pool, playerId, at);
  }

  timeOut(playerId: PlayerId, period: TimeOutPeriod): Promise<Exclusion> {
    return this.exclude(playerId, 'TIME_OUT', period);
  }

  selfExclude(playerId: PlayerId, period: SelfExclusionPeriod): Promise<Exclusion> {
    return this.exclude(playerId, 'SELF_EXCLUSION', period);
  }

  private async exclude(
    playerId: PlayerId,
    kind: 'TIME_OUT' | 'SELF_EXCLUSION',
    period: TimeOutPeriod | SelfExclusionPeriod,
  ): Promise<Exclusion> {
    const st = await this.status(playerId);
    const at = this.clock.now();
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    const options: readonly string[] = kind === 'TIME_OUT' ? rules.timeOutOptions : rules.selfExclusionOptions;
    if (!options.includes(period)) throw new AppError('invalid_period', 400, `Period ${period} is not offered`);
    const endsAt = exclusionEnd(period, at);
    const { state, players } = await withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      const p = await c.query<{ person_key: string | null }>('SELECT person_key FROM players WHERE player_id = $1', [playerId]);
      const key = p.rows[0]?.person_key ?? `player:${playerId}`;
      await c.query(
        'INSERT INTO exclusions (person_key, player_id, kind, period, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [key, playerId, kind, period, at, endsAt],
      );
      const linked = await c.query<{ player_id: string }>(
        'SELECT player_id FROM players WHERE person_key = $1 AND player_id <> $2',
        [key, playerId],
      );
      return {
        state: (await this.activeExclusion(c, playerId, at))!,
        players: [playerId, ...linked.rows.map((r) => r.player_id)],
      };
    });
    // Effective immediately for the gate (committed above); push the account state to every brand account.
    for (const id of players) await this.sink.setState(id, state.state, state.until);
    return state;
  }

  // ----- Reality check (FR-RG-008) -----

  async setRealityCheckInterval(playerId: PlayerId, minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < MIN_REALITY_CHECK_MINUTES || minutes > MAX_REALITY_CHECK_MINUTES) {
      throw new AppError('invalid_interval', 400, 'Interval must be 15 to 120 minutes');
    }
    await this.pool.query(
      `INSERT INTO players (player_id, reality_check_minutes) VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET reality_check_minutes = EXCLUDED.reality_check_minutes`,
      [playerId, minutes],
    );
  }

  async realityCheck(playerId: PlayerId, sessionId: string, at: Date): Promise<RealityCheckView> {
    const st = await this.status(playerId);
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    const s = await this.pool.query<{ started_at: Date; ended_at: Date | null; last_ack_at: Date | null; minutes: number | null }>(
      `SELECT s.started_at, s.ended_at, s.last_ack_at, p.reality_check_minutes AS minutes
         FROM sessions s LEFT JOIN players p ON p.player_id = s.player_id
        WHERE s.id = $1 AND s.player_id = $2`,
      [sessionId, playerId],
    );
    const row = s.rows[0];
    if (!row) throw new AppError('not_found', 404, 'No such session');
    const end = row.ended_at && row.ended_at < at ? row.ended_at : at;
    const net = await this.pool.query<{ net: bigint }>(
      `SELECT (COALESCE(SUM(amount) FILTER (WHERE kind = 'SETTLEMENT'), 0)
             - COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE'), 0)
             + COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE_RELEASED'), 0))::bigint AS net
         FROM activity WHERE player_id = $1 AND currency = $2 AND occurred_at >= $3 AND occurred_at <= $4`,
      [playerId, st.currency, row.started_at, end],
    );
    const intervalMinutes = row.minutes ?? rules.realityCheckMinutes;
    const nextAt = nextRealityCheck(row.started_at, row.last_ack_at, { intervalMinutes });
    return {
      sessionId,
      sessionMinutes: Math.max(0, Math.floor((end.getTime() - row.started_at.getTime()) / 60_000)),
      netResult: net.rows[0]!.net,
      currency: st.currency,
      intervalMinutes,
      nextAt,
      due: row.ended_at === null && at.getTime() >= nextAt.getTime(),
    };
  }

  async acknowledgeRealityCheck(playerId: PlayerId, sessionId: string, at: Date): Promise<void> {
    const r = await this.pool.query(
      'UPDATE sessions SET last_ack_at = GREATEST(COALESCE(last_ack_at, started_at), $3) WHERE id = $1 AND player_id = $2',
      [sessionId, playerId, at],
    );
    if (!r.rowCount) throw new AppError('not_found', 404, 'No such session');
  }

  // ----- Harm-risk score and interventions (FR-RG-010, FR-RG-011) -----

  private async markers(c: Client, playerId: PlayerId, at: Date, utcOffsetMinutes: number): Promise<RiskMarkers> {
    const a = await c.query<{
      deposits24h: number; declined7d: number; night: number; wcancel: number;
      stakes7d: number; sum7d: bigint; stakes_prior: number; sum_prior: bigint;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'DEPOSIT' AND occurred_at > $2::timestamptz - interval '1 day')::int AS deposits24h,
         COUNT(*) FILTER (WHERE kind = 'DEPOSIT_DECLINED' AND occurred_at > $2::timestamptz - interval '7 days')::int AS declined7d,
         COUNT(*) FILTER (WHERE kind = 'STAKE'
           AND EXTRACT(HOUR FROM (occurred_at AT TIME ZONE 'UTC') + make_interval(mins => $3::int)) < 6)::int AS night,
         COUNT(*) FILTER (WHERE kind = 'WITHDRAWAL_CANCELLED')::int AS wcancel,
         COUNT(*) FILTER (WHERE kind = 'STAKE' AND occurred_at > $2::timestamptz - interval '7 days')::int AS stakes7d,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE' AND occurred_at > $2::timestamptz - interval '7 days'), 0)::bigint AS sum7d,
         COUNT(*) FILTER (WHERE kind = 'STAKE' AND occurred_at <= $2::timestamptz - interval '7 days'
           AND occurred_at > $2::timestamptz - interval '28 days')::int AS stakes_prior,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'STAKE' AND occurred_at <= $2::timestamptz - interval '7 days'
           AND occurred_at > $2::timestamptz - interval '28 days'), 0)::bigint AS sum_prior
       FROM activity
      WHERE player_id = $1 AND occurred_at > $2::timestamptz - interval '30 days' AND occurred_at <= $2::timestamptz`,
      [playerId, at, utcOffsetMinutes],
    );
    const chase = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM activity d
        WHERE d.player_id = $1 AND d.kind = 'DEPOSIT'
          AND d.occurred_at > $2::timestamptz - interval '30 days' AND d.occurred_at <= $2::timestamptz
          AND EXISTS (SELECT 1 FROM activity s
                       WHERE s.player_id = d.player_id AND s.kind = 'SETTLEMENT' AND s.amount < s.stake
                         AND s.occurred_at <= d.occurred_at AND s.occurred_at >= d.occurred_at - interval '30 minutes')`,
      [playerId, at],
    );
    const inc = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM limit_changes
        WHERE player_id = $1 AND status <> 'APPLIED'
          AND requested_at > $2::timestamptz - interval '30 days' AND requested_at <= $2::timestamptz`,
      [playerId, at],
    );
    const sess = await c.query<{ minutes: number }>(
      `SELECT FLOOR(COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at, $2::timestamptz), $2::timestamptz) - started_at)), 0)), 0) / 60)::int AS minutes
         FROM sessions WHERE player_id = $1 AND started_at > $2::timestamptz - interval '7 days' AND started_at <= $2::timestamptz`,
      [playerId, at],
    );
    const r = a.rows[0]!;
    return {
      deposits24h: r.deposits24h,
      declinedDeposits7d: r.declined7d,
      lossChasing30d: chase.rows[0]!.n,
      nightStakes30d: r.night,
      limitIncreases30d: inc.rows[0]!.n,
      withdrawalCancels30d: r.wcancel,
      stakes7d: r.stakes7d,
      stakeSum7d: r.sum7d,
      stakesPrior: r.stakes_prior,
      stakeSumPrior: r.sum_prior,
      sessionMinutes7d: sess.rows[0]!.minutes,
    };
  }

  /** Scores one player, stores the score, and opens the interventions its level triggers. */
  async scoreRisk(playerId: PlayerId): Promise<RiskAssessment> {
    const st = await this.status(playerId);
    const at = this.clock.now();
    const { rules } = await this.rulesFor(st.jurisdiction, at);
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      const markers = await this.markers(c, playerId, at, rules.utcOffsetMinutes);
      const score = scoreMarkers(markers);
      const level = riskLevel(score);
      const points = markerPoints(markers);
      await c.query(
        'INSERT INTO risk_scores (player_id, score, level, markers, computed_at) VALUES ($1, $2, $3, $4, $5)',
        [playerId, score, level, json({ markers, points }), at],
      );
      const created: InterventionType[] = [];
      for (const type of triggeredInterventions(score, this.thresholds)) {
        const r = await c.query(
          `INSERT INTO interventions (id, player_id, type, source, score, reason, created_at)
           VALUES ($1, $2, $3, 'AUTO', $4, $5, $6)
           ON CONFLICT (player_id, type) WHERE outcome IS NULL DO NOTHING`,
          [randomUUID(), playerId, type, score, `Harm-risk score ${score} reached the ${type} threshold`, at],
        );
        if (r.rowCount) created.push(type);
      }
      return { score, level, markers, points, computedAt: at, interventionsCreated: created };
    });
  }

  /** Scores every player with activity in the last 30 days; run at least hourly (FR-RG-010). */
  async scoreAll(): Promise<number> {
    const at = this.clock.now();
    const r = await this.pool.query<{ player_id: string }>(
      `SELECT DISTINCT player_id FROM activity WHERE occurred_at > $1::timestamptz - interval '30 days'`,
      [at],
    );
    let n = 0;
    for (const { player_id } of r.rows) {
      if (!(await this.players.getStatus(player_id))) continue;
      await this.scoreRisk(player_id);
      n++;
    }
    return n;
  }

  async getRisk(playerId: PlayerId): Promise<{
    latest: { score: number; level: RiskLevel; computedAt: Date; points: Record<string, number> } | null;
    interventions: Intervention[];
  }> {
    const s = await this.pool.query<{ score: number; level: RiskLevel; computed_at: Date; markers: { points: Record<string, number> } }>(
      'SELECT score, level, computed_at, markers FROM risk_scores WHERE player_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1',
      [playerId],
    );
    const i = await this.pool.query<InterventionRow>(
      'SELECT * FROM interventions WHERE player_id = $1 ORDER BY created_at DESC',
      [playerId],
    );
    const row = s.rows[0];
    return {
      latest: row ? { score: row.score, level: row.level, computedAt: row.computed_at, points: row.markers.points } : null,
      interventions: i.rows.map(toIntervention),
    };
  }

  async createIntervention(playerId: PlayerId, type: InterventionType, actor: Actor, reason: string): Promise<Intervention> {
    if (!INTERVENTION_TYPES.includes(type)) throw new AppError('invalid_intervention', 400, 'Unknown intervention type');
    await this.status(playerId);
    const at = this.clock.now();
    return withTx(this.pool, async (c) => {
      await lockPlayer(c, playerId);
      const r = await c.query<InterventionRow>(
        `INSERT INTO interventions (id, player_id, type, source, score, reason, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)
         ON CONFLICT (player_id, type) WHERE outcome IS NULL DO NOTHING RETURNING *`,
        [randomUUID(), playerId, type, `staff:${actor.staffId}`, reason, at],
      );
      const row = r.rows[0];
      if (!row) throw new AppError('intervention_open', 409, `An open ${type} intervention already exists`);
      await this.audit(c, actor, 'INTERVENTION_CREATED', `player:${playerId}`, null, { id: row.id, type }, reason, at);
      return toIntervention(row);
    });
  }

  /** Records the outcome; this closes the intervention (and lifts a deposit cap or suspension). */
  async recordInterventionOutcome(
    interventionId: string,
    outcome: InterventionOutcome,
    actor: Actor,
    reason: string,
  ): Promise<Intervention> {
    if (!INTERVENTION_OUTCOMES.includes(outcome)) throw new AppError('invalid_outcome', 400, 'Unknown outcome');
    const at = this.clock.now();
    return withTx(this.pool, async (c) => {
      const r = await c.query<InterventionRow>(
        `UPDATE interventions SET outcome = $2, outcome_note = $3, outcome_by = $4, outcome_at = $5
          WHERE id = $1 AND outcome IS NULL RETURNING *`,
        [interventionId, outcome, reason, actor.staffId, at],
      );
      const row = r.rows[0];
      if (!row) throw new AppError('not_found', 404, 'No open intervention with that id');
      await this.audit(c, actor, 'INTERVENTION_OUTCOME', `intervention:${interventionId}`, { outcome: null }, { outcome }, reason, at);
      return toIntervention(row);
    });
  }

  // ----- Marketing (FR-RG-016) -----

  async canMarketTo(playerId: PlayerId): Promise<boolean> {
    const at = this.clock.now();
    const p = await this.pool.query<{ marketing_opt_out: boolean }>('SELECT marketing_opt_out FROM players WHERE player_id = $1', [playerId]);
    if (p.rows[0]?.marketing_opt_out) return false;
    if (await this.activeExclusion(this.pool, playerId, at)) return false;
    const risk = await this.pool.query<{ level: RiskLevel }>(
      'SELECT level FROM risk_scores WHERE player_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1',
      [playerId],
    );
    if (risk.rows[0]?.level === 'HIGH') return false;
    const susp = await this.pool.query(
      `SELECT 1 FROM interventions WHERE player_id = $1 AND type = 'SUSPEND' AND outcome IS NULL`,
      [playerId],
    );
    return !susp.rowCount;
  }

  // ----- Audit (FR-BO-010, SEC-LOG-002) -----

  private async audit(
    c: Client,
    actor: Actor,
    action: string,
    subject: string,
    before: unknown,
    after: unknown,
    reason: string,
    at: Date,
  ): Promise<void> {
    if (!reason || !reason.trim()) throw new AppError('reason_required', 400, 'A reason is required');
    await c.query('LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE');
    const prev = await c.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = prev.rows[0]?.hash ?? 'genesis';
    const body = canonical({ actor: actor.staffId, ip: actor.ip ?? null, action, subject, before, after, reason, at: at.toISOString() });
    const hash = createHash('sha256').update(prevHash + body).digest('hex');
    await c.query(
      `INSERT INTO audit_log (actor, ip, action, subject, before, after, reason, at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [actor.staffId, actor.ip ?? null, action, subject, json(before), json(after), reason, at, prevHash, hash],
    );
  }

  /** Recomputes the audit hash chain; false if any record was altered. */
  async verifyAuditChain(): Promise<boolean> {
    const r = await this.pool.query<{
      actor: string; ip: string | null; action: string; subject: string; before: unknown; after: unknown;
      reason: string; at: Date; prev_hash: string; hash: string;
    }>('SELECT * FROM audit_log ORDER BY id');
    let prev = 'genesis';
    for (const x of r.rows) {
      const body = canonical({ actor: x.actor, ip: x.ip, action: x.action, subject: x.subject, before: x.before, after: x.after, reason: x.reason, at: x.at.toISOString() });
      if (x.prev_hash !== prev || createHash('sha256').update(prev + body).digest('hex') !== x.hash) return false;
      prev = x.hash;
    }
    return true;
  }
}
