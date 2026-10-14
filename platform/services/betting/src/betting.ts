import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  AppError,
  formatOdds,
  fromMinor,
  isCurrency,
  validateSizes,
  withTx,
  type BetLeg,
  type BetRecord,
  type BetStatus,
  type BetStore,
  type Catalogue,
  type Client,
  type Currency,
  type KycLevel,
  type Ledger,
  type Minor,
  type Odds,
  type PlayerDirectory,
  type PlayerId,
  type Pool,
  type PostingRequest,
  type RgGate,
  type SelectionQuote,
} from '@bp/common';
import {
  betLines,
  checkedLineCount,
  effectiveLimits,
  legLiabilities,
  type CurrencyLimits,
} from './pricing.js';

export type OddsChangePolicy = 'NONE' | 'HIGHER' | 'ANY';
/** Port statuses plus the internal PENDING (stake not yet confirmed) and REJECTED. */
export type StoredBetStatus = BetStatus | 'PENDING' | 'REJECTED';

export interface PlaceBetRequest {
  playerId: PlayerId;
  /** Client-generated request ID; resubmitting it returns the original outcome (FR-BET-006). */
  requestId: string;
  currency: Currency;
  legs: { selectionId: string; odds: Odds }[];
  combinationSizes: number[];
  unitStake: Minor;
  /** FR-BET-004, default HIGHER. */
  oddsChangePolicy?: OddsChangePolicy;
  channel: string;
  ip: string;
  device: string;
}

export interface PlacedLeg extends BetLeg {
  requestedOdds: Odds;
}

export interface PlayerBet {
  betId: string;
  playerId: PlayerId;
  currency: Currency;
  combinationSizes: number[];
  unitStake: Minor;
  totalStake: Minor;
  potentialReturn: Minor;
  oddsChangePolicy: OddsChangePolicy;
  legs: PlacedLeg[];
  status: StoredBetStatus;
  rejection: { code: string; detail: string } | null;
  channel: string;
  submittedAt: Date;
  acceptedAt: Date | null;
}

export interface PlaceBetResult {
  bet: PlayerBet;
  /** True when requestId had been seen before and the original outcome was returned. */
  replayed: boolean;
}

export interface ListBetsFilters {
  status?: StoredBetStatus[];
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface BookingCode {
  code: string;
  /** Current quotes for the saved selections still in the catalogue (FR-BET-009). */
  selections: SelectionQuote[];
}

export interface BettingConfig {
  /** Lowest KYC level allowed to bet (FR-BET-003). Default FULL. */
  minKycLevel?: KycLevel;
  /** Layered limits per currency; a currency without limits cannot be bet in (FR-RSK-004). */
  limits: Partial<Record<Currency, CurrencyLimits>>;
  /** In-play delay per sport in ms (FR-RSK-008); merged over the defaults. */
  inPlayDelayMs?: Record<string, number>;
  /** Delay for sports not listed. Default 5000 ms. */
  defaultInPlayDelayMs?: number;
  /** Liability cap per selection and currency; null means uncapped (FR-RSK-006). */
  liabilityCap?: (selectionId: string, currency: Currency) => Minor | null;
  /** Largest number of lines one bet may have. Default 2000. */
  maxLines?: number;
  /** Age after which recoverPending completes a PENDING bet. Default 60,000 ms. */
  pendingTimeoutMs?: number;
}

export interface BettingDeps {
  pool: Pool;
  players: PlayerDirectory;
  catalogue: Catalogue;
  rg: RgGate;
  ledger: Ledger;
  clock: { now: () => Date };
  config: BettingConfig;
  sleep?: (ms: number) => Promise<void>;
  /** Called when a bet would push a selection's liability past its cap (FR-RSK-006). */
  onLiabilityBreach?: (selectionId: string, liability: Minor) => void | Promise<void>;
}

export const DEFAULT_IN_PLAY_DELAY_MS: Readonly<Record<string, number>> = {
  soccer: 7000,
  tennis: 5000,
  basketball: 5000,
};

const KYC_ORDER: KycLevel[] = ['NONE', 'BASIC', 'FULL', 'ENHANCED'];
const BOOKING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
const MAX_BOOKING_SELECTIONS = 30;

interface Plan {
  quotes: SelectionQuote[];
  totalStake: Minor;
  potentialReturn: Minor;
  liabilities: Minor[];
  inPlayDelayMs: number;
}

interface BetRow {
  bet_id: string;
  player_id: string;
  request_hash: string;
  currency: Currency;
  combination_sizes: number[];
  unit_stake: bigint;
  total_stake: bigint;
  potential_return: bigint;
  odds_policy: OddsChangePolicy;
  status: StoredBetStatus;
  reject_code: string | null;
  reject_status: number | null;
  reject_detail: string | null;
  reject_extra: Record<string, unknown> | null;
  channel: string;
  submitted_at: Date;
  accepted_at: Date | null;
}

interface LegRow {
  bet_id: string;
  selection_id: string;
  market_id: string;
  event_id: string;
  odds: bigint;
  requested_odds: bigint;
  line: string | null;
}

/** A refusal the caller can act on, as opposed to an outage. */
const isRefusal = (err: unknown): err is AppError => err instanceof AppError && err.status < 500;

/** Problem extras from other services may hold bigints; store them as strings. */
const jsonExtra = (extra: Record<string, unknown>): string =>
  JSON.stringify(extra, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const fingerprint = (r: PlaceBetRequest): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        r.currency,
        r.legs.map((l) => [l.selectionId, l.odds.toString()]),
        r.combinationSizes,
        r.unitStake.toString(),
        r.oddsChangePolicy ?? 'HIGHER',
      ]),
    )
    .digest('hex');

export const stakePosting = (betId: string, playerId: PlayerId, currency: Currency, total: Minor): PostingRequest => ({
  idempotencyKey: `bet:${betId}:stake`,
  reason: 'BET_STAKE',
  reference: betId,
  lines: [
    { account: { owner: 'PLAYER', playerId, kind: 'CASH', currency }, amount: -total },
    { account: { owner: 'OPERATOR', kind: 'BETS_OPEN', currency }, amount: total },
  ],
});

export class BettingService implements BetStore {
  private readonly pool: Pool;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: Record<string, number>;

  constructor(private readonly deps: BettingDeps) {
    this.pool = deps.pool;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.delays = { ...DEFAULT_IN_PLAY_DELAY_MS, ...deps.config.inPlayDelayMs };
  }

  // ---------- Placement (FR-BET-003 to -007, FR-RSK-003 to -009) ----------

  async placeBet(req: PlaceBetRequest): Promise<PlaceBetResult> {
    const hash = fingerprint(req);
    const existing = await this.findByRequest(req.playerId, req.requestId);
    if (existing) return this.replay(existing, hash);

    const submittedAt = this.deps.clock.now();
    let plan: Plan;
    try {
      plan = await this.validate(req, submittedAt);
      if (plan.inPlayDelayMs > 0) {
        // FR-RSK-008: wait, then re-fetch quotes and validate everything again.
        await this.sleep(plan.inPlayDelayMs);
        plan = await this.validate(req, this.deps.clock.now());
      }
    } catch (err) {
      if (!isRefusal(err)) throw err;
      return this.recordRejection(req, hash, submittedAt, err);
    }

    const betId = randomUUID();
    const reserved = await this.reserve(betId, req, hash, submittedAt, plan);
    if (reserved.kind === 'duplicate') {
      const row = await this.findByRequest(req.playerId, req.requestId);
      if (!row) throw new Error('bet row vanished after conflict');
      return this.replay(row, hash);
    }
    if (reserved.kind === 'breach') {
      await this.deps.onLiabilityBreach?.(reserved.selectionId, reserved.liability);
      throw reserved.error;
    }
    return { bet: await this.complete(betId), replayed: false };
  }

  private async validate(req: PlaceBetRequest, at: Date): Promise<Plan> {
    const { config } = this.deps;
    const player = await this.deps.players.getStatus(req.playerId);
    if (!player) throw new AppError('player_not_found', 403, 'Unknown player');
    if (player.state !== 'ACTIVE') {
      throw new AppError('account_not_active', 403, `Account is ${player.state}`, { state: player.state });
    }
    const minKyc = config.minKycLevel ?? 'FULL';
    if (KYC_ORDER.indexOf(player.kycLevel) < KYC_ORDER.indexOf(minKyc)) {
      throw new AppError('kyc_required', 403, `KYC level ${minKyc} is required to bet`, { required: minKyc });
    }
    if (!isCurrency(req.currency) || req.currency !== player.currency) {
      throw new AppError('currency_mismatch', 400, `Bets must be in ${player.currency}`);
    }
    const limits = config.limits[req.currency];
    if (!limits) throw new AppError('currency_not_supported', 422, `Betting in ${req.currency} is not configured`);
    if (req.unitStake <= 0n) throw new AppError('invalid_stake', 400, 'Stake must be positive');

    validateSizes(req.legs.length, req.combinationSizes);
    const lines = checkedLineCount(req.legs.length, req.combinationSizes, config.maxLines ?? 2000);

    const ids = req.legs.map((l) => l.selectionId);
    if (new Set(ids).size !== ids.length) throw new AppError('duplicate_selection', 400, 'A selection appears twice');

    const byId = new Map((await this.deps.catalogue.getQuotes(ids)).map((q) => [q.selectionId, q]));
    const quotes = ids.map((id) => {
      const q = byId.get(id);
      if (!q) throw new AppError('selection_not_found', 422, `Unknown selection ${id}`, { selectionId: id });
      return q;
    });

    // FR-RSK-009: block correlated (same-event) legs in any combination of two or more legs.
    if (Math.max(...req.combinationSizes) > 1) {
      const events = new Set<string>();
      for (const q of quotes) {
        if (events.has(q.eventId)) {
          throw new AppError('correlated_selections', 422, 'Two legs are on the same event', { eventId: q.eventId });
        }
        events.add(q.eventId);
      }
    }

    const policy = req.oddsChangePolicy ?? 'HIGHER';
    req.legs.forEach((leg, i) => {
      const q = quotes[i]!;
      if (q.marketState !== 'OPEN') {
        throw new AppError('market_not_open', 409, `Market ${q.marketId} is ${q.marketState}`, {
          selectionId: q.selectionId,
          marketState: q.marketState,
        });
      }
      if (!q.inPlay && q.eventStartsAt.getTime() <= at.getTime()) {
        throw new AppError('event_started', 409, `Event ${q.eventId} has started`, { selectionId: q.selectionId });
      }
      const ok = policy === 'ANY' || (policy === 'NONE' ? q.odds === leg.odds : q.odds >= leg.odds);
      if (!ok) {
        throw new AppError('price_changed', 409, `Price of ${q.selectionId} changed`, {
          selectionId: q.selectionId,
          requestedOdds: formatOdds(leg.odds),
          currentOdds: formatOdds(q.odds),
        });
      }
    });

    const totalStake = req.unitStake * lines;
    const accepted = quotes.map((q) => q.odds); // accepted at current odds (FR-BET-004)
    const allLines = betLines(accepted, req.combinationSizes, req.unitStake);
    const potentialReturn = allLines.reduce((s, l) => s + l.fullWinReturn, 0n);

    const eff = effectiveLimits(limits, quotes, player.stakeFactor);
    const money = (v: Minor) => fromMinor(v, req.currency);
    if (eff.minStake !== null && req.unitStake < eff.minStake) {
      throw new AppError('stake_below_min', 422, `Minimum stake per line is ${money(eff.minStake)}`, {
        minStake: money(eff.minStake),
      });
    }
    if (eff.maxStake !== null && totalStake > eff.maxStake) {
      throw new AppError('stake_above_max', 422, `Maximum stake is ${money(eff.maxStake)}`, {
        maxStake: money(eff.maxStake),
      });
    }
    if (eff.maxPayout !== null && potentialReturn > eff.maxPayout) {
      throw new AppError('payout_above_max', 422, `Maximum payout is ${money(eff.maxPayout)}`, {
        maxPayout: money(eff.maxPayout),
      });
    }

    const gate = await this.deps.rg.checkStake(req.playerId, req.currency, totalStake, at);
    if (!gate.allowed) throw new AppError(gate.code, 403, gate.detail);

    const inPlayDelayMs = Math.max(
      0,
      ...quotes.filter((q) => q.inPlay).map((q) =>
          Object.hasOwn(this.delays, q.sport) ? this.delays[q.sport]! : (config.defaultInPlayDelayMs ?? 5000),
        ),
    );
    return {
      quotes,
      totalStake,
      potentialReturn,
      liabilities: legLiabilities(allLines, quotes.length, req.unitStake),
      inPlayDelayMs,
    };
  }

  /**
   * Writes the PENDING bet keyed by (player, requestId) and reserves liability in one
   * transaction. A concurrent duplicate blocks on the unique key and then sees 'duplicate'.
   */
  private async reserve(
    betId: string,
    req: PlaceBetRequest,
    hash: string,
    submittedAt: Date,
    plan: Plan,
  ): Promise<
    | { kind: 'ok' }
    | { kind: 'duplicate' }
    | { kind: 'breach'; selectionId: string; liability: Minor; error: AppError }
  > {
    return withTx(this.pool, async (c) => {
      const inserted = await c.query(
        `INSERT INTO bets (bet_id, player_id, request_id, request_hash, currency, combination_sizes, unit_stake,
           total_stake, potential_return, odds_policy, status, channel, ip, device, submitted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13,$14,$14)
         ON CONFLICT (player_id, request_id) DO NOTHING RETURNING bet_id`,
        [
          betId,
          req.playerId,
          req.requestId,
          hash,
          req.currency,
          req.combinationSizes,
          req.unitStake,
          plan.totalStake,
          plan.potentialReturn,
          req.oddsChangePolicy ?? 'HIGHER',
          req.channel,
          req.ip,
          req.device,
          submittedAt,
        ],
      );
      if (inserted.rowCount === 0) return { kind: 'duplicate' as const };

      for (const [i, q] of plan.quotes.entries()) {
        await c.query(
          `INSERT INTO bet_legs (bet_id, leg_no, selection_id, market_id, event_id, odds, requested_odds, line,
             price_version, liability) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [betId, i, q.selectionId, q.marketId, q.eventId, q.odds, req.legs[i]!.odds, q.line, q.priceVersion, plan.liabilities[i]],
        );
      }

      // Lock liability rows in a fixed order so concurrent bets cannot deadlock or overshoot.
      const order = plan.quotes.map((q, i) => ({ id: q.selectionId, add: plan.liabilities[i]! }));
      order.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      await c.query(
        `INSERT INTO selection_liability (selection_id, currency) SELECT unnest($1::text[]), $2
         ON CONFLICT DO NOTHING`,
        [order.map((o) => o.id), req.currency],
      );
      const current = new Map<string, bigint>();
      for (const o of order) {
        const r = await c.query<{ liability: bigint }>(
          'SELECT liability FROM selection_liability WHERE selection_id = $1 AND currency = $2 FOR UPDATE',
          [o.id, req.currency],
        );
        current.set(o.id, r.rows[0]!.liability);
      }
      for (const o of order) {
        const cap = this.deps.config.liabilityCap?.(o.id, req.currency) ?? null;
        const next = current.get(o.id)! + o.add;
        if (cap !== null && next > cap) {
          const error = new AppError('liability_limit', 409, `Selection ${o.id} is not taking more bets at this stake`, {
            selectionId: o.id,
          });
          await this.markRejected(c, betId, error);
          return { kind: 'breach' as const, selectionId: o.id, liability: next, error };
        }
      }
      for (const o of order) {
        await c.query(
          'UPDATE selection_liability SET liability = liability + $3 WHERE selection_id = $1 AND currency = $2',
          [o.id, req.currency, o.add],
        );
      }
      return { kind: 'ok' as const };
    });
  }

  /**
   * Records the stake with RG, posts it and marks the bet OPEN, or REJECTED if RG or the ledger refuses.
   * The row lock serialises completers (request, duplicate, sweeper); the ledger key makes the
   * debit happen at most once (FR-BET-005, FR-WAL-003).
   */
  private async complete(betId: string): Promise<PlayerBet> {
    const refusal = await withTx(this.pool, async (c) => {
      const r = await c.query<BetRow>('SELECT * FROM bets WHERE bet_id = $1 FOR UPDATE', [betId]);
      const row = r.rows[0];
      if (!row || row.status !== 'PENDING') return null;
      // Count the stake against period limits before taking it; idempotent per bet (FR-RG-002).
      const rgRef = `bet:${betId}`;
      const gate = await this.deps.rg.checkAndRecordStake(row.player_id, row.currency, row.total_stake, rgRef, this.deps.clock.now());
      if (!gate.allowed) {
        const err = new AppError(gate.code, 403, gate.detail);
        await this.releaseLiability(c, betId, row.currency);
        await this.markRejected(c, betId, err);
        return err;
      }
      try {
        await this.deps.ledger.post(stakePosting(row.bet_id, row.player_id, row.currency, row.total_stake));
      } catch (err) {
        if (!isRefusal(err)) throw err; // outage: leave PENDING for retry or the sweeper
        await this.deps.rg.releaseStake(row.player_id, row.currency, row.total_stake, rgRef, this.deps.clock.now());
        await this.releaseLiability(c, betId, row.currency);
        await this.markRejected(c, betId, err);
        return err;
      }
      const now = this.deps.clock.now();
      await c.query(`UPDATE bets SET status = 'OPEN', accepted_at = $2, updated_at = $2 WHERE bet_id = $1`, [betId, now]);
      return null;
    });
    if (refusal) {
      // Same shape a replay returns, with any bigint extras as strings.
      throw new AppError(refusal.code, refusal.status, refusal.detail, JSON.parse(jsonExtra(refusal.extra)) as Record<string, unknown>);
    }
    const r = await this.pool.query<BetRow>('SELECT * FROM bets WHERE bet_id = $1', [betId]);
    const row = r.rows[0];
    if (!row) throw new Error('bet missing after completion');
    if (row.status === 'REJECTED') throw this.toRejection(row);
    return (await this.hydrate([row]))[0]!;
  }

  private async replay(row: BetRow, hash: string): Promise<PlaceBetResult> {
    if (row.request_hash !== hash) {
      throw new AppError('idempotency_conflict', 409, 'This request ID was used for a different bet');
    }
    if (row.status === 'REJECTED') throw this.toRejection(row);
    const bet = row.status === 'PENDING' ? await this.complete(row.bet_id) : await this.getPlayerBet(row.bet_id);
    if (!bet) throw new Error('bet missing on replay');
    return { bet, replayed: true };
  }

  /** Stores a validation refusal under the request ID so a replay returns the same answer. */
  private async recordRejection(req: PlaceBetRequest, hash: string, at: Date, err: AppError): Promise<PlaceBetResult> {
    const r = await this.pool.query(
      `INSERT INTO bets (bet_id, player_id, request_id, request_hash, currency, combination_sizes, unit_stake,
         total_stake, potential_return, odds_policy, status, reject_code, reject_status, reject_detail, reject_extra,
         channel, ip, device, submitted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8,'REJECTED',$9,$10,$11,$12,$13,$14,$15,$16,$16)
       ON CONFLICT (player_id, request_id) DO NOTHING`,
      [
        randomUUID(),
        req.playerId,
        req.requestId,
        hash,
        req.currency,
        req.combinationSizes,
        req.unitStake > 0n ? req.unitStake : 0n,
        req.oddsChangePolicy ?? 'HIGHER',
        err.code,
        err.status,
        err.detail,
        jsonExtra(err.extra),
        req.channel,
        req.ip,
        req.device,
        at,
      ],
    );
    if (r.rowCount === 0) {
      const row = await this.findByRequest(req.playerId, req.requestId);
      if (row) return this.replay(row, hash); // a concurrent duplicate won: return its outcome
    }
    throw err;
  }

  private async markRejected(c: Client, betId: string, err: AppError): Promise<void> {
    await c.query(
      `UPDATE bets SET status = 'REJECTED', reject_code = $2, reject_status = $3, reject_detail = $4,
         reject_extra = $5, updated_at = $6 WHERE bet_id = $1`,
      [betId, err.code, err.status, err.detail, jsonExtra(err.extra), this.deps.clock.now()],
    );
  }

  private async releaseLiability(c: Client, betId: string, currency: Currency, sign: 1n | -1n = -1n): Promise<void> {
    const legs = await c.query<{ selection_id: string; liability: bigint }>(
      'SELECT selection_id, liability FROM bet_legs WHERE bet_id = $1 ORDER BY selection_id',
      [betId],
    );
    for (const l of legs.rows) {
      await c.query(
        'UPDATE selection_liability SET liability = liability + $3 WHERE selection_id = $1 AND currency = $2',
        [l.selection_id, currency, sign * l.liability],
      );
    }
  }

  private toRejection(row: BetRow): AppError {
    return new AppError(
      row.reject_code ?? 'rejected',
      row.reject_status ?? 422,
      row.reject_detail ?? 'Bet rejected',
      row.reject_extra ?? {},
    );
  }

  /**
   * Completes PENDING bets older than the timeout (crash between row and ledger post):
   * re-posts the same idempotent stake request and marks OPEN, or REJECTED if refused.
   */
  async recoverPending(now: Date): Promise<{ opened: number; rejected: number; failed: number }> {
    const cutoff = new Date(now.getTime() - (this.deps.config.pendingTimeoutMs ?? 60_000));
    const r = await this.pool.query<{ bet_id: string }>(
      `SELECT bet_id FROM bets WHERE status = 'PENDING' AND submitted_at < $1 ORDER BY submitted_at`,
      [cutoff],
    );
    const result = { opened: 0, rejected: 0, failed: 0 };
    for (const { bet_id } of r.rows) {
      try {
        await this.complete(bet_id);
        result.opened++;
      } catch (err) {
        if (isRefusal(err)) result.rejected++;
        else result.failed++;
      }
    }
    return result;
  }

  // ---------- BetStore port ----------

  async openBetsForSelections(selectionIds: string[]): Promise<BetRecord[]> {
    if (selectionIds.length === 0) return [];
    const r = await this.pool.query<BetRow>(
      `SELECT * FROM bets WHERE status = 'OPEN' AND bet_id IN
         (SELECT bet_id FROM bet_legs WHERE selection_id = ANY($1::text[])) ORDER BY accepted_at, bet_id`,
      [selectionIds],
    );
    const bets = await this.hydrate(r.rows);
    return bets.map(toRecord);
  }

  async getBet(betId: string): Promise<BetRecord | null> {
    const bet = await this.getPlayerBet(betId);
    return bet && isPortStatus(bet.status) ? toRecord(bet) : null;
  }

  /** Moves an accepted bet between OPEN, SETTLED and CASHED_OUT, keeping liability in step. */
  async markStatus(betId: string, status: BetStatus): Promise<void> {
    await withTx(this.pool, async (c) => {
      const r = await c.query<BetRow>('SELECT * FROM bets WHERE bet_id = $1 FOR UPDATE', [betId]);
      const row = r.rows[0];
      if (!row || !isPortStatus(row.status)) throw new AppError('bet_not_found', 404, 'No accepted bet with that ID');
      if (row.status === status) return;
      if (row.status === 'OPEN') await this.releaseLiability(c, betId, row.currency, -1n);
      if (status === 'OPEN') await this.releaseLiability(c, betId, row.currency, 1n);
      await c.query('UPDATE bets SET status = $2, updated_at = $3 WHERE bet_id = $1', [
        betId,
        status,
        this.deps.clock.now(),
      ]);
    });
  }

  // ---------- Player views (FR-BET-011) ----------

  async getPlayerBet(betId: string): Promise<PlayerBet | null> {
    const r = await this.pool.query<BetRow>('SELECT * FROM bets WHERE bet_id = $1', [betId]);
    return (await this.hydrate(r.rows))[0] ?? null;
  }

  async listBets(playerId: PlayerId, filters: ListBetsFilters = {}): Promise<PlayerBet[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const r = await this.pool.query<BetRow>(
      `SELECT * FROM bets WHERE player_id = $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
         AND ($3::timestamptz IS NULL OR submitted_at >= $3)
         AND ($4::timestamptz IS NULL OR submitted_at < $4)
       ORDER BY submitted_at DESC, bet_id LIMIT $5`,
      [playerId, filters.status ?? null, filters.from ?? null, filters.to ?? null, limit],
    );
    return this.hydrate(r.rows);
  }

  liability(selectionId: string, currency: Currency): Promise<Minor> {
    return this.pool
      .query<{ liability: bigint }>(
        'SELECT liability FROM selection_liability WHERE selection_id = $1 AND currency = $2',
        [selectionId, currency],
      )
      .then((r) => r.rows[0]?.liability ?? 0n);
  }

  private async findByRequest(playerId: PlayerId, requestId: string): Promise<BetRow | null> {
    const r = await this.pool.query<BetRow>('SELECT * FROM bets WHERE player_id = $1 AND request_id = $2', [
      playerId,
      requestId,
    ]);
    return r.rows[0] ?? null;
  }

  private async hydrate(rows: BetRow[]): Promise<PlayerBet[]> {
    if (rows.length === 0) return [];
    const legs = await this.pool.query<LegRow>(
      'SELECT * FROM bet_legs WHERE bet_id = ANY($1::uuid[]) ORDER BY bet_id, leg_no',
      [rows.map((r) => r.bet_id)],
    );
    const byBet = new Map<string, PlacedLeg[]>();
    for (const l of legs.rows) {
      const list = byBet.get(l.bet_id) ?? [];
      list.push({
        selectionId: l.selection_id,
        marketId: l.market_id,
        eventId: l.event_id,
        odds: l.odds,
        requestedOdds: l.requested_odds,
        line: l.line,
      });
      byBet.set(l.bet_id, list);
    }
    return rows.map((r) => ({
      betId: r.bet_id,
      playerId: r.player_id,
      currency: r.currency,
      combinationSizes: r.combination_sizes,
      unitStake: r.unit_stake,
      totalStake: r.total_stake,
      potentialReturn: r.potential_return,
      oddsChangePolicy: r.odds_policy,
      legs: byBet.get(r.bet_id) ?? [],
      status: r.status,
      rejection: r.reject_code ? { code: r.reject_code, detail: r.reject_detail ?? '' } : null,
      channel: r.channel,
      submittedAt: r.submitted_at,
      acceptedAt: r.accepted_at,
    }));
  }

  // ---------- Booking codes (FR-BET-009) ----------

  async saveBookingCode(createdBy: string, selectionIds: string[]): Promise<BookingCode> {
    const ids = [...new Set(selectionIds)];
    if (ids.length === 0 || ids.length > MAX_BOOKING_SELECTIONS) {
      throw new AppError('invalid_booking', 400, `1 to ${MAX_BOOKING_SELECTIONS} selections allowed`);
    }
    const quotes = await this.deps.catalogue.getQuotes(ids);
    const known = new Set(quotes.map((q) => q.selectionId));
    const missing = ids.find((id) => !known.has(id));
    if (missing) throw new AppError('selection_not_found', 422, `Unknown selection ${missing}`, { selectionId: missing });
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 8 }, () => BOOKING_ALPHABET[randomInt(BOOKING_ALPHABET.length)]).join('');
      const r = await this.pool.query(
        `INSERT INTO booking_codes (code, selection_ids, created_by, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [code, ids, createdBy, this.deps.clock.now()],
      );
      if (r.rowCount === 1) return { code, selections: orderQuotes(ids, quotes) };
    }
    throw new Error('could not allocate a booking code');
  }

  async loadBookingCode(code: string): Promise<BookingCode | null> {
    const r = await this.pool.query<{ selection_ids: string[] }>(
      'SELECT selection_ids FROM booking_codes WHERE code = $1',
      [code.toUpperCase()],
    );
    const row = r.rows[0];
    if (!row) return null;
    const quotes = await this.deps.catalogue.getQuotes(row.selection_ids);
    return { code: code.toUpperCase(), selections: orderQuotes(row.selection_ids, quotes) };
  }
}

export const BOOKING_CODE_PATTERN = new RegExp(`^[${BOOKING_ALPHABET}]{8}$`);

const orderQuotes = (ids: string[], quotes: SelectionQuote[]): SelectionQuote[] => {
  const byId = new Map(quotes.map((q) => [q.selectionId, q]));
  return ids.flatMap((id) => byId.get(id) ?? []);
};

const isPortStatus = (s: StoredBetStatus): s is BetStatus => s === 'OPEN' || s === 'SETTLED' || s === 'CASHED_OUT';

const toRecord = (b: PlayerBet): BetRecord => ({
  betId: b.betId,
  playerId: b.playerId,
  currency: b.currency,
  combinationSizes: b.combinationSizes,
  unitStake: b.unitStake,
  totalStake: b.totalStake,
  legs: b.legs.map(({ selectionId, marketId, eventId, odds, line }) => ({ selectionId, marketId, eventId, odds, line })),
  acceptedAt: b.acceptedAt ?? b.submittedAt,
  status: b.status as BetStatus,
});
