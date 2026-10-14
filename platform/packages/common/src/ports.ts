// Contracts between services. A service depends on another only through these
// interfaces, so each one can be built and tested alone with a fake.
import type { Currency, Minor } from './money.js';
import type { Odds } from './odds.js';

export type PlayerId = string; // UUID

// ---------- Identity (FR-ACC, FR-KYC) ----------

export type AccountState =
  | 'PENDING_VERIFICATION'
  | 'ACTIVE'
  | 'RESTRICTED'
  | 'SUSPENDED'
  | 'SELF_EXCLUDED'
  | 'TIMED_OUT'
  | 'CLOSED'
  | 'DORMANT';

export type KycLevel = 'NONE' | 'BASIC' | 'FULL' | 'ENHANCED';

export interface PlayerStatus {
  playerId: PlayerId;
  state: AccountState;
  kycLevel: KycLevel;
  jurisdiction: string; // e.g. 'CM' (Cameroon), selects the rules set (FR-JUR-002)
  currency: Currency;
  /** Stake factor from the player's risk profile, 0.01 to 10.0 (FR-RSK-005). */
  stakeFactor: number;
}

export interface PlayerDirectory {
  getStatus(playerId: PlayerId): Promise<PlayerStatus | null>;
}

// ---------- Wallet and ledger (FR-WAL) ----------

/** Player-owned kinds can never go below zero (FR-WAL-004). */
export type PlayerAccountKind = 'CASH' | 'BONUS' | 'PENDING_WITHDRAWAL';
/** Operator control accounts; these may go negative. */
export type OperatorAccountKind =
  | 'PSP_CLEARING' // money in flight with payment providers
  | 'BETS_OPEN' // stakes of accepted, unsettled bets
  | 'GGR' // gaming revenue: lost stakes in, net winnings out
  | 'BONUS_COST'
  | 'ADJUSTMENTS'
  | 'WITHDRAWALS_PAYABLE';

export type AccountRef =
  | { owner: 'PLAYER'; playerId: PlayerId; kind: PlayerAccountKind; currency: Currency }
  | { owner: 'OPERATOR'; kind: OperatorAccountKind; currency: Currency };

export type LedgerReason =
  | 'DEPOSIT'
  | 'WITHDRAWAL_REQUEST'
  | 'WITHDRAWAL_PAID'
  | 'WITHDRAWAL_CANCELLED'
  | 'BET_STAKE'
  | 'BET_SETTLEMENT'
  | 'BET_RESETTLEMENT'
  | 'CASH_OUT'
  | 'BONUS_AWARD'
  | 'BONUS_FORFEIT'
  | 'ADJUSTMENT'
  | 'REVERSAL';

export interface PostingLine {
  account: AccountRef;
  /** Positive increases the account balance, negative decreases it. */
  amount: Minor;
}

export interface PostingRequest {
  /** Same key = same entry. A retry returns the original entry and posts nothing (FR-WAL-003). */
  idempotencyKey: string;
  reason: LedgerReason;
  /** Business reference, e.g. a bet ID or PSP transaction ID. */
  reference: string;
  /** Lines must sum to zero per currency (FR-WAL-001). */
  lines: PostingLine[];
  /** Back-office user ID for manual entries (FR-WAL-011). */
  actor?: string;
}

export interface PostedEntry {
  entryId: string;
  idempotencyKey: string;
  reason: LedgerReason;
  reference: string;
  postedAt: Date;
  /** True when this call found an existing entry with the same key. */
  replayed: boolean;
}

export interface Ledger {
  post(request: PostingRequest): Promise<PostedEntry>;
  balance(account: AccountRef): Promise<Minor>;
}

// ---------- Sports catalogue (FR-SPD) ----------

export type MarketState = 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'SETTLED' | 'VOIDED';

export interface SelectionQuote {
  selectionId: string;
  marketId: string;
  eventId: string;
  sport: string; // e.g. 'soccer'
  competitionId: string;
  marketType: string; // e.g. '1X2', 'ASIAN_HANDICAP', 'TOTALS'
  line: string | null; // e.g. '-0.25', '2.5'
  odds: Odds; // price after margin (FR-RSK-001)
  marketState: MarketState;
  eventStartsAt: Date;
  inPlay: boolean;
  /** Increments on every price or state change. */
  priceVersion: number;
}

export interface Catalogue {
  getQuotes(selectionIds: string[]): Promise<SelectionQuote[]>;
}

export type LegOutcome = 'WON' | 'LOST' | 'VOID' | 'HALF_WON' | 'HALF_LOST' | 'DEAD_HEAT';

export interface SelectionResult {
  selectionId: string;
  outcome: LegOutcome;
  /** For DEAD_HEAT: the stake share that stands, e.g. 1/2 for a two-way tie. */
  deadHeat?: { numerator: number; denominator: number };
  /** Increments when a result is corrected (FR-STL-006). */
  resultVersion: number;
  source: string; // 'feed:primary', 'trader:<userId>', ...
}

// ---------- Responsible gambling (FR-RG) ----------

export type GateDecision =
  | { allowed: true }
  | { allowed: false; code: string; detail: string };

export interface RgGate {
  /** Read-only check; use for early refusal. Does not count the stake. */
  checkStake(playerId: PlayerId, currency: Currency, stake: Minor, at: Date): Promise<GateDecision>;
  checkDeposit(playerId: PlayerId, currency: Currency, amount: Minor, at: Date): Promise<GateDecision>;
  /**
   * Checks the stake against period limits and, when allowed, records it under ref in the
   * same transaction, so parallel bets cannot both pass a limit (FR-RG-002). Idempotent per ref.
   */
  checkAndRecordStake(playerId: PlayerId, currency: Currency, stake: Minor, ref: string, at: Date): Promise<GateDecision>;
  /** The stake recorded under ref was never taken (bet refused after recording); stop counting it. */
  releaseStake(playerId: PlayerId, currency: Currency, stake: Minor, ref: string, at: Date): Promise<unknown>;
  /** A settled bet: what was staked and what was returned, so loss limits net out wins. Idempotent per ref. */
  recordSettlement(playerId: PlayerId, currency: Currency, stake: Minor, returned: Minor, ref: string, at: Date): Promise<unknown>;
}

// ---------- Bets (FR-BET, FR-STL) ----------

export interface BetLeg {
  selectionId: string;
  marketId: string;
  eventId: string;
  odds: Odds; // price accepted for this leg
  line: string | null;
}

export type BetStatus = 'OPEN' | 'SETTLED' | 'CASHED_OUT';

export interface BetRecord {
  betId: string;
  playerId: PlayerId;
  currency: Currency;
  /**
   * Which combination sizes the bet covers. Single = [1], treble = [3],
   * Trixie on 3 legs = [2, 3], Yankee on 4 legs = [2, 3, 4], Patent = [1, 2, 3].
   */
  combinationSizes: number[];
  /** Stake per line (per combination). */
  unitStake: Minor;
  /** unitStake × number of lines. */
  totalStake: Minor;
  legs: BetLeg[];
  acceptedAt: Date;
  status: BetStatus;
}

export interface BetStore {
  openBetsForSelections(selectionIds: string[]): Promise<BetRecord[]>;
  getBet(betId: string): Promise<BetRecord | null>;
  markStatus(betId: string, status: BetStatus): Promise<void>;
}
