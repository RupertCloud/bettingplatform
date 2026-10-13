import { createHash } from 'node:crypto';
import {
  AppError, lineCount, withTx,
  type BetRecord, type BetStore, type Client, type Currency, type Ledger, type LegOutcome,
  type Minor, type OperatorAccountKind, type Pool, type PostingLine, type RgGate, type SelectionResult,
} from '@bp/common';
import { betReturn, validateDeadHeat, type DeadHeat, type GradedLeg } from './grading.js';

export const SERVICE_SCHEMA = 'settlement';

/** Winnings tax in minor units for a settled bet (FR-STL-010). Must be between 0 and the gross return. */
export type TaxPolicy = (jurisdiction: string, stake: Minor, grossReturn: Minor) => Minor;

export interface SettlementDeps {
  pool: Pool;
  bets: BetStore;
  ledger: Ledger;
  /** Told what each bet staked and returned, so loss limits net out wins (FR-RG-002). */
  rg: Pick<RgGate, 'recordSettlement'>;
  now?: () => Date;
  /** Licence jurisdiction passed to the tax policy, default 'CM'. BetRecord carries no jurisdiction yet. */
  jurisdiction?: string;
  taxPolicy?: TaxPolicy;
  /** Operator account that receives withheld tax. Required only when the policy returns tax above zero. */
  taxAccountKind?: OperatorAccountKind;
  /** Manual actions whose affected stake is above this, per currency, need a second approver. */
  approvalThresholds?: Partial<Record<Currency, Minor>>;
}

export interface StaffContext {
  staffId: string;
  ip?: string;
}

export type ResultIntake =
  | { status: 'PENDING' }
  | { status: 'MISMATCH'; mismatchId: string }
  | { status: 'CONFIRMED'; resultId: string };

export interface ConfirmedResult {
  resultId: string;
  selectionId: string;
  resultVersion: number;
  outcome: LegOutcome;
  deadHeat?: DeadHeat;
  confirmedBy: string;
  confirmedAt: Date;
}

export interface ResultValue {
  selectionId: string;
  outcome: LegOutcome;
  deadHeat?: DeadHeat;
}

export interface Mismatch {
  mismatchId: string;
  selectionId: string;
  resultVersion: number;
  primary: ResultValue;
  secondary: ResultValue;
  createdAt: Date;
}

export type BetSettleOutcome =
  | 'SETTLED'
  | 'RESETTLED'
  | 'UNCHANGED'
  | 'PENDING_RESULTS'
  | 'MANUAL_REVIEW'
  | 'SKIPPED_CASHED_OUT';

export interface SettleOptions {
  /** Late-bet cutoff per selection ID; a leg accepted after it is void (FR-STL-007). */
  cutoffs?: Record<string, Date>;
  /** Staff ID when a trader's manual action drives this settlement (FR-STL-012). */
  actor?: string;
}

export interface BatchSummary {
  results: { betId: string; outcome: BetSettleOutcome }[];
  failed: { betId: string; code: string }[];
}

export interface SettlementRow {
  betId: string;
  version: number;
  kind: 'SETTLE' | 'RESETTLE';
  status: 'PENDING' | 'POSTED' | 'REVIEW';
  playerId: string;
  currency: Currency;
  totalStake: Minor;
  grossReturn: Minor;
  tax: Minor;
  netReturn: Minor;
  deltaGross: Minor;
  deltaTax: Minor;
  deltaNet: Minor;
  ledgerKey: string | null;
  source: 'AUTO' | 'MANUAL';
  actor: string | null;
  createdAt: Date;
  legs: {
    selectionId: string;
    outcome: LegOutcome;
    late: boolean;
    resultVersion: number | null;
    resultSource: string | null;
  }[];
}

export interface ManualReviewItem {
  reviewId: string;
  betId: string;
  settlementVersion: number;
  playerId: string;
  currency: Currency;
  deltaNet: Minor;
  reason: string;
  createdAt: Date;
}

export interface ManualActionInput {
  action: 'SETTLE' | 'VOID';
  /** For VOID the outcome is ignored and every selection is voided. */
  results: { selectionId: string; outcome?: LegOutcome; deadHeat?: DeadHeat }[];
  reason: string;
}

export interface ManualAction {
  actionId: string;
  action: 'SETTLE' | 'VOID';
  results: ResultValue[];
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  affectedStake: { currency: Currency; amount: Minor }[];
  status: 'PENDING_APPROVAL' | 'EXECUTED';
  settlement?: BatchSummary;
}

const DEFAULT_THRESHOLDS: Record<Currency, Minor> = {
  XAF: 10_000_000n,
  EUR: 1_500_000n,
  USD: 1_500_000n,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lockKey = async (client: Client, key: string): Promise<void> => {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
};

const sameValue = (a: ResultValue, b: ResultValue): boolean => {
  if (a.outcome !== b.outcome) return false;
  if (a.outcome !== 'DEAD_HEAT') return true;
  const x = a.deadHeat!;
  const y = b.deadHeat!;
  return BigInt(x.numerator) * BigInt(y.denominator) === BigInt(y.numerator) * BigInt(x.denominator);
};

const normalise = (r: ResultValue): ResultValue =>
  r.outcome === 'DEAD_HEAT'
    ? { selectionId: r.selectionId, outcome: r.outcome, deadHeat: validateDeadHeat(r.deadHeat) }
    : { selectionId: r.selectionId, outcome: r.outcome };

interface ResultDbRow {
  result_id: string;
  selection_id: string;
  result_version: number;
  outcome: LegOutcome;
  dh_num: number | null;
  dh_den: number | null;
  confirmed_by: string;
  confirmed_at: Date;
}

const toConfirmed = (r: ResultDbRow): ConfirmedResult => ({
  resultId: r.result_id,
  selectionId: r.selection_id,
  resultVersion: r.result_version,
  outcome: r.outcome,
  ...(r.dh_num !== null && r.dh_den !== null
    ? { deadHeat: { numerator: r.dh_num, denominator: r.dh_den } }
    : {}),
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
});

interface SettlementDbRow {
  bet_id: string;
  version: number;
  kind: 'SETTLE' | 'RESETTLE';
  status: 'PENDING' | 'POSTED' | 'REVIEW';
  player_id: string;
  currency: Currency;
  total_stake: bigint;
  gross_return: bigint;
  tax: bigint;
  net_return: bigint;
  delta_gross: bigint;
  delta_tax: bigint;
  delta_net: bigint;
  ledger_key: string | null;
  source: 'AUTO' | 'MANUAL';
  actor: string | null;
  created_at: Date;
}

interface LegPlan {
  selectionId: string;
  outcome: LegOutcome;
  late: boolean;
  resultId: string | null;
  resultVersion: number | null;
  resultSource: string | null;
  deadHeat?: DeadHeat;
}

const legSignature = (legs: { selectionId: string; outcome: string; late: boolean; resultVersion: number | null }[]) =>
  legs.map((l) => `${l.selectionId}|${l.outcome}|${l.late}|${l.resultVersion ?? '-'}`).join(';');

export class Settlement {
  private readonly pool: Pool;
  private readonly bets: BetStore;
  private readonly ledger: Ledger;
  private readonly rg: Pick<RgGate, 'recordSettlement'>;
  private readonly now: () => Date;
  private readonly jurisdiction: string;
  private readonly taxPolicy: TaxPolicy;
  private readonly taxAccountKind: OperatorAccountKind | undefined;
  private readonly thresholds: Record<Currency, Minor>;

  constructor(deps: SettlementDeps) {
    this.pool = deps.pool;
    this.bets = deps.bets;
    this.ledger = deps.ledger;
    this.rg = deps.rg;
    this.now = deps.now ?? (() => new Date());
    this.jurisdiction = deps.jurisdiction ?? 'CM';
    this.taxPolicy = deps.taxPolicy ?? (() => 0n);
    this.taxAccountKind = deps.taxAccountKind;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.approvalThresholds };
  }

  // ---------- Result intake (FR-STL-001) ----------

  /** Records a feed result. Confirms it when primary and secondary agree; queues a mismatch otherwise. */
  async recordResult(result: SelectionResult): Promise<ResultIntake> {
    if (result.source !== 'feed:primary' && result.source !== 'feed:secondary') {
      throw new AppError('invalid_source', 400, 'Only feed:primary and feed:secondary submit results');
    }
    if (!Number.isSafeInteger(result.resultVersion) || result.resultVersion < 1) {
      throw new AppError('invalid_result', 400, 'resultVersion must be a positive integer');
    }
    const value = normalise(result);
    const at = this.now();
    return withTx(this.pool, async (client) => {
      await lockKey(client, `sel:${value.selectionId}`);
      const existing = await client.query<{ outcome: LegOutcome; dh_num: number | null; dh_den: number | null }>(
        'SELECT outcome, dh_num, dh_den FROM result_submissions WHERE selection_id = $1 AND source = $2 AND result_version = $3',
        [value.selectionId, result.source, result.resultVersion],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (!sameValue(this.rowValue(value.selectionId, prior), value)) {
          throw new AppError('result_conflict', 409, 'This source already sent a different result for this version');
        }
      } else {
        await client.query(
          `INSERT INTO result_submissions (selection_id, source, result_version, outcome, dh_num, dh_den, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [value.selectionId, result.source, result.resultVersion, value.outcome,
            value.deadHeat?.numerator ?? null, value.deadHeat?.denominator ?? null, at],
        );
      }
      const both = await client.query<{ source: string; outcome: LegOutcome; dh_num: number | null; dh_den: number | null }>(
        'SELECT source, outcome, dh_num, dh_den FROM result_submissions WHERE selection_id = $1 AND result_version = $2',
        [value.selectionId, result.resultVersion],
      );
      const primaryRow = both.rows.find((r) => r.source === 'feed:primary');
      const secondaryRow = both.rows.find((r) => r.source === 'feed:secondary');
      const confirmed = await client.query<{ result_id: string }>(
        'SELECT result_id FROM confirmed_results WHERE selection_id = $1 AND result_version = $2',
        [value.selectionId, result.resultVersion],
      );
      if (confirmed.rows[0]) return { status: 'CONFIRMED', resultId: confirmed.rows[0].result_id };
      if (!primaryRow || !secondaryRow) return { status: 'PENDING' };
      const primary = this.rowValue(value.selectionId, primaryRow);
      const secondary = this.rowValue(value.selectionId, secondaryRow);
      if (sameValue(primary, secondary)) {
        const ins = await client.query<{ result_id: string }>(
          `INSERT INTO confirmed_results (selection_id, result_version, outcome, dh_num, dh_den, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, 'feeds', $6) RETURNING result_id`,
          [value.selectionId, result.resultVersion, primary.outcome,
            primary.deadHeat?.numerator ?? null, primary.deadHeat?.denominator ?? null, at],
        );
        return { status: 'CONFIRMED', resultId: ins.rows[0]!.result_id };
      }
      const mm = await client.query<{ mismatch_id: string }>(
        `INSERT INTO result_mismatches (selection_id, result_version, primary_result, secondary_result, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (selection_id, result_version) DO UPDATE SET selection_id = EXCLUDED.selection_id
         RETURNING mismatch_id`,
        [value.selectionId, result.resultVersion, JSON.stringify(primary), JSON.stringify(secondary), at],
      );
      return { status: 'MISMATCH', mismatchId: mm.rows[0]!.mismatch_id };
    });
  }

  async listMismatches(): Promise<Mismatch[]> {
    const { rows } = await this.pool.query<{
      mismatch_id: string; selection_id: string; result_version: number;
      primary_result: ResultValue; secondary_result: ResultValue; created_at: Date;
    }>(
      `SELECT mismatch_id, selection_id, result_version, primary_result, secondary_result, created_at
       FROM result_mismatches WHERE status = 'OPEN' ORDER BY created_at, mismatch_id`,
    );
    return rows.map((r) => ({
      mismatchId: r.mismatch_id,
      selectionId: r.selection_id,
      resultVersion: r.result_version,
      primary: r.primary_result,
      secondary: r.secondary_result,
      createdAt: r.created_at,
    }));
  }

  /** A trader confirms a result for a version, resolving any mismatch on it (FR-STL-001). */
  async confirmResult(
    input: ResultValue & { resultVersion: number },
    staff: StaffContext,
  ): Promise<ConfirmedResult> {
    if (!Number.isSafeInteger(input.resultVersion) || input.resultVersion < 1) {
      throw new AppError('invalid_result', 400, 'resultVersion must be a positive integer');
    }
    const value = normalise(input);
    const at = this.now();
    return withTx(this.pool, async (client) => {
      await lockKey(client, `sel:${value.selectionId}`);
      const existing = await client.query<ResultDbRow>(
        'SELECT * FROM confirmed_results WHERE selection_id = $1 AND result_version = $2',
        [value.selectionId, input.resultVersion],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (!sameValue(this.rowValue(value.selectionId, prior), value)) {
          throw new AppError('result_conflict', 409, 'This version is already confirmed with a different result');
        }
        return toConfirmed(prior); // idempotent repeat
      }
      // A trader confirms what a feed reported; entering a different result is a manual settle (FR-STL-009).
      const submitted = await client.query<{ outcome: LegOutcome; dh_num: number | null; dh_den: number | null }>(
        'SELECT outcome, dh_num, dh_den FROM result_submissions WHERE selection_id = $1 AND result_version = $2',
        [value.selectionId, input.resultVersion],
      );
      if (submitted.rows.length === 0) throw new AppError('result_not_found', 404, 'No feed result for this version');
      if (!submitted.rows.some((r) => sameValue(this.rowValue(value.selectionId, r), value))) {
        throw new AppError('result_not_submitted', 409, 'No feed reported this result; use a manual settle');
      }
      const ins = await client.query<ResultDbRow>(
        `INSERT INTO confirmed_results (selection_id, result_version, outcome, dh_num, dh_den, confirmed_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [value.selectionId, input.resultVersion, value.outcome, value.deadHeat?.numerator ?? null,
          value.deadHeat?.denominator ?? null, `trader:${staff.staffId}`, at],
      );
      const resolved = await client.query<{ mismatch_id: string; primary_result: unknown; secondary_result: unknown }>(
        `UPDATE result_mismatches SET status = 'RESOLVED', resolved_by = $3, resolved_at = $4
         WHERE selection_id = $1 AND result_version = $2 AND status = 'OPEN'
         RETURNING mismatch_id, primary_result, secondary_result`,
        [value.selectionId, input.resultVersion, staff.staffId, at],
      );
      await this.audit(client, staff, 'RESULT_CONFIRM', `selection:${value.selectionId}`, null,
        resolved.rows[0] ?? null, { ...value, resultVersion: input.resultVersion });
      return toConfirmed(ins.rows[0]!);
    });
  }

  // ---------- Settlement (FR-STL-002 to -007, -010 to -012) ----------

  /** Settles (or resettles) every bet affected by these confirmed results. One bad bet does not fail the batch. */
  async settleSelections(resultIds: string[], opts: SettleOptions = {}): Promise<BatchSummary> {
    const ids = [...new Set(resultIds)];
    if (ids.some((id) => !UUID.test(id))) throw new AppError('result_not_found', 404, 'Unknown result ID');
    const { rows } = await this.pool.query<{ selection_id: string }>(
      'SELECT DISTINCT selection_id FROM confirmed_results WHERE result_id = ANY($1::uuid[])',
      [ids],
    );
    const found = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM confirmed_results WHERE result_id = ANY($1::uuid[])', [ids],
    );
    if (Number(found.rows[0]!.n) !== ids.length) {
      throw new AppError('result_not_found', 404, 'Unknown result ID');
    }
    const selectionIds = rows.map((r) => r.selection_id);
    await this.saveCutoffs(opts.cutoffs);
    const open = await this.bets.openBetsForSelections(selectionIds);
    const settled = await this.pool.query<{ bet_id: string }>(
      'SELECT DISTINCT bet_id FROM settlement_legs WHERE selection_id = ANY($1)',
      [selectionIds],
    );
    const betIds = [...new Set([...open.map((b) => b.betId), ...settled.rows.map((r) => r.bet_id)])].sort();
    const summary: BatchSummary = { results: [], failed: [] };
    for (const betId of betIds) {
      try {
        summary.results.push({ betId, outcome: await this.settleOne(betId, opts.actor) });
      } catch (err) {
        summary.failed.push({ betId, code: err instanceof AppError ? err.code : 'internal' });
      }
    }
    return summary;
  }

  /** Settles one bet; safe to repeat and to run concurrently (FR-STL-005). */
  async settleBet(betId: string, opts: SettleOptions = {}): Promise<BetSettleOutcome> {
    await this.saveCutoffs(opts.cutoffs);
    return this.settleOne(betId, opts.actor);
  }

  async settlementsFor(betId: string): Promise<SettlementRow[]> {
    const { rows } = await this.pool.query<SettlementDbRow>(
      'SELECT * FROM settlements WHERE bet_id = $1 ORDER BY version', [betId],
    );
    const legs = await this.pool.query<{
      version: number; selection_id: string; outcome: LegOutcome; late: boolean;
      result_version: number | null; result_source: string | null;
    }>(
      'SELECT version, selection_id, outcome, late, result_version, result_source FROM settlement_legs WHERE bet_id = $1 ORDER BY version, leg_index',
      [betId],
    );
    return rows.map((r) => ({
      betId: r.bet_id,
      version: r.version,
      kind: r.kind,
      status: r.status,
      playerId: r.player_id,
      currency: r.currency,
      totalStake: r.total_stake,
      grossReturn: r.gross_return,
      tax: r.tax,
      netReturn: r.net_return,
      deltaGross: r.delta_gross,
      deltaTax: r.delta_tax,
      deltaNet: r.delta_net,
      ledgerKey: r.ledger_key,
      source: r.source,
      actor: r.actor,
      createdAt: r.created_at,
      legs: legs.rows.filter((l) => l.version === r.version).map((l) => ({
        selectionId: l.selection_id,
        outcome: l.outcome,
        late: l.late,
        resultVersion: l.result_version,
        resultSource: l.result_source,
      })),
    }));
  }

  async listManualReview(): Promise<ManualReviewItem[]> {
    const { rows } = await this.pool.query<{
      review_id: string; bet_id: string; settlement_version: number; player_id: string;
      currency: Currency; delta_net: bigint; reason: string; created_at: Date;
    }>(
      `SELECT review_id, bet_id, settlement_version, player_id, currency, delta_net, reason, created_at
       FROM manual_review WHERE status = 'OPEN' ORDER BY created_at, review_id`,
    );
    return rows.map((r) => ({
      reviewId: r.review_id,
      betId: r.bet_id,
      settlementVersion: r.settlement_version,
      playerId: r.player_id,
      currency: r.currency,
      deltaNet: r.delta_net,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  private async saveCutoffs(cutoffs: Record<string, Date> | undefined): Promise<void> {
    if (!cutoffs) return;
    for (const [selectionId, at] of Object.entries(cutoffs)) {
      if (Number.isNaN(at.getTime())) throw new AppError('invalid_cutoff', 400, 'Invalid cutoff time');
      await this.pool.query(
        `INSERT INTO selection_cutoffs (selection_id, cutoff_at) VALUES ($1, $2)
         ON CONFLICT (selection_id) DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at`,
        [selectionId, at],
      );
    }
  }

  private async settleOne(betId: string, actor: string | undefined): Promise<BetSettleOutcome> {
    const bet = await this.bets.getBet(betId);
    if (!bet) throw new AppError('bet_not_found', 404, 'Bet not found');
    if (bet.status === 'CASHED_OUT') return 'SKIPPED_CASHED_OUT'; // FR-STL-011
    if (lineCount(bet.legs.length, bet.combinationSizes) * bet.unitStake !== bet.totalStake || bet.unitStake <= 0n) {
      throw new AppError('inconsistent_bet', 422, 'Total stake does not match unit stake x lines');
    }
    // A leftover PENDING intent is posted first, then the bet is graded again on current results.
    let previous: BetSettleOutcome | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const step = await this.prepare(bet, actor);
      if (step.kind === 'not_ready') return previous ?? 'PENDING_RESULTS';
      if (step.kind === 'unchanged') {
        await this.markSettled(bet);
        return previous ?? 'UNCHANGED';
      }
      const outcome = await this.postIntent(bet, step.version);
      await this.markSettled(bet);
      if (!step.reused) return outcome;
      previous = outcome;
    }
    throw new AppError('settlement_busy', 503, 'Bet changed repeatedly during settlement; retry');
  }

  private async markSettled(bet: BetRecord): Promise<void> {
    if (bet.status !== 'OPEN') return;
    const posted = await this.pool.query(
      "SELECT 1 FROM settlements WHERE bet_id = $1 AND status = 'POSTED' LIMIT 1", [bet.betId],
    );
    if (posted.rowCount) await this.bets.markStatus(bet.betId, 'SETTLED');
  }

  /** Grades the bet against current confirmed results and writes a PENDING intent if money must move. */
  private prepare(
    bet: BetRecord,
    actor: string | undefined,
  ): Promise<{ kind: 'not_ready' } | { kind: 'unchanged' } | { kind: 'post'; version: number; reused: boolean }> {
    return withTx(this.pool, async (client) => {
      await lockKey(client, `bet:${bet.betId}`);
      const history = (await client.query<SettlementDbRow>(
        'SELECT * FROM settlements WHERE bet_id = $1 ORDER BY version DESC', [bet.betId],
      )).rows;
      const latest = history[0];
      if (latest?.status === 'PENDING') return { kind: 'post', version: latest.version, reused: true };

      const legs = await this.planLegs(client, bet);
      if (!legs) return { kind: 'not_ready' };
      const graded: GradedLeg[] = legs.map((l, i) => ({
        outcome: l.outcome, odds: bet.legs[i]!.odds, ...(l.deadHeat ? { deadHeat: l.deadHeat } : {}),
      }));
      const gross = betReturn(bet.unitStake, bet.combinationSizes, graded);
      const tax = this.taxPolicy(this.jurisdiction, bet.totalStake, gross);
      if (tax < 0n || tax > gross) throw new AppError('invalid_tax', 500, 'Tax policy returned an out-of-range amount');
      if (tax > 0n && !this.taxAccountKind) {
        throw new AppError('tax_account_missing', 500, 'Winnings tax is due but no tax account is configured');
      }
      const net = gross - tax;

      if (latest) {
        const latestLegs = (await client.query<{ selection_id: string; outcome: string; late: boolean; result_version: number | null }>(
          'SELECT selection_id, outcome, late, result_version FROM settlement_legs WHERE bet_id = $1 AND version = $2 ORDER BY leg_index',
          [bet.betId, latest.version],
        )).rows.map((l) => ({ selectionId: l.selection_id, outcome: l.outcome, late: l.late, resultVersion: l.result_version }));
        if (latest.gross_return === gross && latest.tax === tax && legSignature(latestLegs) === legSignature(legs)) {
          return { kind: 'unchanged' };
        }
      }

      const posted = history.find((h) => h.status === 'POSTED');
      const kind = posted ? 'RESETTLE' : 'SETTLE';
      const deltaGross = gross - (posted?.gross_return ?? 0n);
      const deltaTax = tax - (posted?.tax ?? 0n);
      const deltaNet = net - (posted?.net_return ?? 0n);
      const version = (latest?.version ?? 0) + 1;
      const moves = kind === 'SETTLE' || deltaGross !== 0n || deltaTax !== 0n;
      await client.query(
        `INSERT INTO settlements (bet_id, version, kind, status, player_id, currency, total_stake, gross_return, tax,
           net_return, delta_gross, delta_tax, delta_net, ledger_key, source, actor, created_at, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [bet.betId, version, kind, moves ? 'PENDING' : 'POSTED', bet.playerId, bet.currency, bet.totalStake,
          gross, tax, net, deltaGross, deltaTax, deltaNet,
          moves ? `bet:${bet.betId}:settle:v${version}` : null,
          actor ? 'MANUAL' : 'AUTO', actor ?? null, this.now(), moves ? null : this.now()],
      );
      for (const [i, leg] of legs.entries()) {
        await client.query(
          `INSERT INTO settlement_legs (bet_id, version, leg_index, selection_id, outcome, late, result_id, result_version, result_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [bet.betId, version, i, leg.selectionId, leg.outcome, leg.late, leg.resultId, leg.resultVersion, leg.resultSource],
        );
      }
      // Results changed but the money did not: the new versions are recorded, nothing is posted.
      return moves ? { kind: 'post', version, reused: false } : { kind: 'unchanged' };
    });
  }

  /** Per leg: void if late, otherwise the current confirmed result; null if any leg has none yet. */
  private async planLegs(client: Client, bet: BetRecord): Promise<LegPlan[] | null> {
    const selectionIds = bet.legs.map((l) => l.selectionId);
    const cutoffs = new Map(
      (await client.query<{ selection_id: string; cutoff_at: Date }>(
        'SELECT selection_id, cutoff_at FROM selection_cutoffs WHERE selection_id = ANY($1)', [selectionIds],
      )).rows.map((r) => [r.selection_id, r.cutoff_at]),
    );
    const current = new Map(
      (await client.query<ResultDbRow>(
        `SELECT DISTINCT ON (selection_id) * FROM confirmed_results
         WHERE selection_id = ANY($1) ORDER BY selection_id, result_version DESC`,
        [selectionIds],
      )).rows.map((r) => [r.selection_id, r]),
    );
    const plan: LegPlan[] = [];
    for (const leg of bet.legs) {
      const cutoff = cutoffs.get(leg.selectionId);
      if (cutoff && bet.acceptedAt.getTime() > cutoff.getTime()) {
        plan.push({ selectionId: leg.selectionId, outcome: 'VOID', late: true, resultId: null, resultVersion: null, resultSource: null });
        continue;
      }
      const r = current.get(leg.selectionId);
      if (!r) return null;
      plan.push({
        selectionId: leg.selectionId, outcome: r.outcome, late: false,
        resultId: r.result_id, resultVersion: r.result_version, resultSource: r.confirmed_by,
        ...(r.dh_num !== null && r.dh_den !== null ? { deadHeat: { numerator: r.dh_num, denominator: r.dh_den } } : {}),
      });
    }
    return plan;
  }

  /**
   * Posts a PENDING intent while holding the bet lock, so concurrent workers post it once.
   * A crash after the ledger call leaves it PENDING; the retry re-posts the same key and amounts.
   */
  private postIntent(bet: BetRecord, version: number): Promise<BetSettleOutcome> {
    return withTx(this.pool, async (client) => {
      await lockKey(client, `bet:${bet.betId}`);
      const row = (await client.query<SettlementDbRow>(
        'SELECT * FROM settlements WHERE bet_id = $1 AND version = $2', [bet.betId, version],
      )).rows[0]!;
      const done: BetSettleOutcome = row.kind === 'SETTLE' ? 'SETTLED' : 'RESETTLED';
      if (row.status === 'POSTED') return done;
      if (row.status === 'REVIEW') return 'MANUAL_REVIEW';
      try {
        const entry = await this.ledger.post({
          idempotencyKey: row.ledger_key!,
          reason: row.kind === 'SETTLE' ? 'BET_SETTLEMENT' : 'BET_RESETTLEMENT',
          reference: bet.betId,
          lines: this.postingLines(row),
          ...(row.actor ? { actor: row.actor } : {}),
        });
        await client.query(
          "UPDATE settlements SET status = 'POSTED', ledger_entry_id = $3, posted_at = $4 WHERE bet_id = $1 AND version = $2",
          [bet.betId, version, entry.entryId, this.now()],
        );
        // Idempotent per bet, so a retry after a crash here records it once.
        // Known gap: resettlements do not adjust the RG figure.
        if (row.kind === 'SETTLE') {
          await this.rg.recordSettlement(row.player_id, row.currency, row.total_stake, row.delta_net, `bet:${bet.betId}`, this.now());
        }
        return done;
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'insufficient_funds')) throw err;
        await client.query(
          "UPDATE settlements SET status = 'REVIEW' WHERE bet_id = $1 AND version = $2", [bet.betId, version],
        );
        await client.query(
          `INSERT INTO manual_review (bet_id, settlement_version, player_id, currency, delta_net, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, 'insufficient_funds', $6) ON CONFLICT DO NOTHING`,
          [bet.betId, version, row.player_id, row.currency, row.delta_net, this.now()],
        );
        return 'MANUAL_REVIEW';
      }
    });
  }

  private postingLines(row: SettlementDbRow): PostingLine[] {
    const currency = row.currency;
    const op = (kind: OperatorAccountKind, amount: Minor): PostingLine => ({ account: { owner: 'OPERATOR', kind, currency }, amount });
    const cash = (amount: Minor): PostingLine => ({
      account: { owner: 'PLAYER', playerId: row.player_id, kind: 'CASH', currency }, amount,
    });
    const lines = row.kind === 'SETTLE'
      ? [op('BETS_OPEN', -row.total_stake), cash(row.delta_net), op('GGR', row.total_stake - row.delta_gross)]
      : [cash(row.delta_net), op('GGR', -row.delta_gross)];
    if (row.delta_tax !== 0n) {
      if (!this.taxAccountKind) throw new AppError('tax_account_missing', 500, 'Winnings tax is due but no tax account is configured');
      lines.push(op(this.taxAccountKind, row.delta_tax));
    }
    return lines.filter((l) => l.amount !== 0n);
  }

  // ---------- Manual settle / void with four-eyes (FR-STL-009, FR-BO-010, FR-BO-011) ----------

  async requestManual(input: ManualActionInput, staff: StaffContext, idempotencyKey: string): Promise<ManualAction> {
    if (!input.reason.trim()) throw new AppError('reason_required', 400, 'A reason is required');
    if (input.results.length === 0) throw new AppError('invalid_request', 400, 'No selections');
    const values = input.results.map((r) => {
      if (input.action === 'VOID') return { selectionId: r.selectionId, outcome: 'VOID' as const };
      if (!r.outcome) throw new AppError('invalid_request', 400, 'SETTLE needs an outcome per selection');
      return normalise({ selectionId: r.selectionId, outcome: r.outcome, ...(r.deadHeat ? { deadHeat: r.deadHeat } : {}) });
    });
    const selectionIds = values.map((v) => v.selectionId);
    if (new Set(selectionIds).size !== selectionIds.length) {
      throw new AppError('invalid_request', 400, 'Duplicate selection');
    }
    const replay = await this.findManual(staff.staffId, idempotencyKey);
    if (replay) return this.checkReplay(replay, input.action, input.reason, values);

    const affected = await this.affectedStake(selectionIds);
    const needsApproval = affected.some((a) => a.amount > this.thresholds[a.currency]);
    const at = this.now();
    const created = await withTx(this.pool, async (client) => {
      const ins = await client.query<{ action_id: string }>(
        `INSERT INTO manual_actions (action, results, reason, requested_by, idempotency_key, affected_stake, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', $7)
         ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING action_id`,
        [input.action, JSON.stringify(values), input.reason, staff.staffId, idempotencyKey,
          JSON.stringify(affected.map((a) => ({ currency: a.currency, amount: a.amount.toString() }))), at],
      );
      const id = ins.rows[0]?.action_id;
      if (id) {
        await this.audit(client, staff, `MANUAL_${input.action}_REQUEST`, `manual_action:${id}`, input.reason, null,
          { results: values, affected: affected.map((a) => ({ currency: a.currency, amount: a.amount.toString() })) });
      }
      return id;
    });
    if (!created) return this.checkReplay((await this.findManual(staff.staffId, idempotencyKey))!, input.action, input.reason, values);
    if (needsApproval) return (await this.getManual(created))!;
    return this.execute(created, staff, null);
  }

  async approveManual(actionId: string, staff: StaffContext): Promise<ManualAction> {
    const action = await this.getManual(actionId);
    if (!action) throw new AppError('not_found', 404, 'Manual action not found');
    if (action.requestedBy === staff.staffId) {
      throw new AppError('four_eyes_required', 403, 'The approver must differ from the requester');
    }
    if (action.status === 'EXECUTED') {
      if (action.approvedBy === staff.staffId) return action; // idempotent repeat
      throw new AppError('already_executed', 409, 'Manual action already executed');
    }
    return this.execute(actionId, staff, staff.staffId);
  }

  async getManual(actionId: string): Promise<ManualAction | null> {
    if (!UUID.test(actionId)) return null;
    const { rows } = await this.pool.query<ManualDbRow>('SELECT * FROM manual_actions WHERE action_id = $1', [actionId]);
    return rows[0] ? toManual(rows[0]) : null;
  }

  private checkReplay(found: ManualAction, action: string, reason: string, results: ResultValue[]): ManualAction {
    const canon = (rs: ResultValue[]) =>
      rs.map((r) => `${r.selectionId}|${r.outcome}|${r.deadHeat?.numerator ?? ''}/${r.deadHeat?.denominator ?? ''}`).join(';');
    if (found.action !== action || found.reason !== reason || canon(found.results) !== canon(results)) {
      throw new AppError('idempotency_key_reused', 409, 'Idempotency-Key was used for a different request');
    }
    return found;
  }

  private async findManual(staffId: string, key: string): Promise<ManualAction | null> {
    const { rows } = await this.pool.query<ManualDbRow>(
      'SELECT * FROM manual_actions WHERE requested_by = $1 AND idempotency_key = $2', [staffId, key],
    );
    return rows[0] ? toManual(rows[0]) : null;
  }

  /** Writes the trader's results as new confirmed versions, then settles. Runs once per action. */
  private async execute(actionId: string, staff: StaffContext, approver: string | null): Promise<ManualAction> {
    const at = this.now();
    const executed = await withTx(this.pool, async (client) => {
      const upd = await client.query<ManualDbRow>(
        `UPDATE manual_actions SET status = 'EXECUTED', approved_by = $2, executed_at = $3
         WHERE action_id = $1 AND status = 'PENDING_APPROVAL' RETURNING *`,
        [actionId, approver, at],
      );
      const row = upd.rows[0];
      if (!row) return null;
      const resultIds: string[] = [];
      // Lock selections in a fixed order so overlapping actions cannot deadlock.
      for (const v of [...row.results].sort((a, b) => a.selectionId.localeCompare(b.selectionId))) {
        await lockKey(client, `sel:${v.selectionId}`);
        const max = await client.query<{ v: number | null }>(
          'SELECT max(result_version) AS v FROM confirmed_results WHERE selection_id = $1', [v.selectionId],
        );
        const ins = await client.query<{ result_id: string }>(
          `INSERT INTO confirmed_results (selection_id, result_version, outcome, dh_num, dh_den, confirmed_by, manual_action_id, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING result_id`,
          [v.selectionId, (max.rows[0]?.v ?? 0) + 1, v.outcome, v.deadHeat?.numerator ?? null,
            v.deadHeat?.denominator ?? null, `trader:${row.requested_by}`, actionId, at],
        );
        resultIds.push(ins.rows[0]!.result_id);
      }
      if (approver) {
        await this.audit(client, staff, `MANUAL_${row.action}_APPROVE`, `manual_action:${actionId}`, row.reason,
          { status: 'PENDING_APPROVAL' }, { status: 'EXECUTED', approvedBy: approver });
      }
      return { row, resultIds };
    });
    if (!executed) {
      const current = (await this.getManual(actionId))!;
      if (approver && current.approvedBy === approver) return current;
      throw new AppError('already_executed', 409, 'Manual action already executed');
    }
    const settlement = await this.settleSelections(executed.resultIds, { actor: executed.row.requested_by });
    return { ...toManual(executed.row), settlement };
  }

  /** Total stake of open and settled bets on these selections, per currency. */
  private async affectedStake(selectionIds: string[]): Promise<{ currency: Currency; amount: Minor }[]> {
    const totals = new Map<Currency, Minor>();
    const seen = new Set<string>();
    for (const bet of await this.bets.openBetsForSelections(selectionIds)) {
      seen.add(bet.betId);
      totals.set(bet.currency, (totals.get(bet.currency) ?? 0n) + bet.totalStake);
    }
    const { rows } = await this.pool.query<{ bet_id: string; currency: Currency; total_stake: bigint }>(
      `SELECT DISTINCT ON (s.bet_id) s.bet_id, s.currency, s.total_stake
       FROM settlements s JOIN settlement_legs l ON l.bet_id = s.bet_id AND l.version = s.version
       WHERE l.selection_id = ANY($1) ORDER BY s.bet_id, s.version DESC`,
      [selectionIds],
    );
    for (const r of rows) {
      if (seen.has(r.bet_id)) continue;
      totals.set(r.currency, (totals.get(r.currency) ?? 0n) + r.total_stake);
    }
    return [...totals].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency));
  }

  // ---------- helpers ----------

  private rowValue(selectionId: string, r: { outcome: LegOutcome; dh_num: number | null; dh_den: number | null }): ResultValue {
    return r.dh_num !== null && r.dh_den !== null
      ? { selectionId, outcome: r.outcome, deadHeat: { numerator: r.dh_num, denominator: r.dh_den } }
      : { selectionId, outcome: r.outcome };
  }

  /** Appends a hash-chained audit record in the caller's transaction. */
  private async audit(
    client: Client, staff: StaffContext, action: string, target: string,
    reason: string | null, before: unknown, after: unknown,
  ): Promise<void> {
    await lockKey(client, 'staff_audit');
    const prev = (await client.query<{ hash: string }>('SELECT hash FROM staff_audit ORDER BY seq DESC LIMIT 1')).rows[0]?.hash ?? '';
    const at = this.now();
    const record = JSON.stringify({ at: at.toISOString(), actor: staff.staffId, ip: staff.ip ?? null, action, target, reason, before, after });
    const hash = createHash('sha256').update(prev).update(record).digest('hex');
    await client.query(
      `INSERT INTO staff_audit (at, actor, ip, action, target, reason, before, after, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [at, staff.staffId, staff.ip ?? null, action, target, reason, JSON.stringify(before), JSON.stringify(after), prev, hash],
    );
  }
}

interface ManualDbRow {
  action_id: string;
  action: 'SETTLE' | 'VOID';
  results: ResultValue[];
  reason: string;
  requested_by: string;
  approved_by: string | null;
  affected_stake: { currency: Currency; amount: string }[];
  status: 'PENDING_APPROVAL' | 'EXECUTED';
}

const toManual = (r: ManualDbRow): ManualAction => ({
  actionId: r.action_id,
  action: r.action,
  results: r.results,
  reason: r.reason,
  requestedBy: r.requested_by,
  approvedBy: r.approved_by,
  affectedStake: r.affected_stake.map((a) => ({ currency: a.currency, amount: BigInt(a.amount) })),
  status: r.status,
});
