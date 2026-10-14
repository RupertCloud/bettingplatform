import { randomUUID } from 'node:crypto';
import {
  AppError, lineCount, parseOdds,
  type AccountRef, type BetRecord, type BetStatus, type BetStore, type Currency, type Ledger,
  type Minor, type PostedEntry, type PostingRequest,
} from '@bp/common';

const pause = () => new Promise<void>((r) => setTimeout(r, 2));

export const accountKey = (a: AccountRef): string =>
  a.owner === 'PLAYER' ? `P:${a.playerId}:${a.kind}:${a.currency}` : `O:${a.kind}:${a.currency}`;

/** In-memory ledger with the real contract: idempotent keys, zero-sum lines, no negative player balances. */
export class FakeLedger implements Ledger {
  readonly entries = new Map<string, { entry: PostedEntry; request: PostingRequest }>();
  readonly balances = new Map<string, Minor>();
  calls = 0;

  async post(request: PostingRequest): Promise<PostedEntry> {
    this.calls++;
    await pause();
    const existing = this.entries.get(request.idempotencyKey);
    if (existing) return { ...existing.entry, replayed: true };
    const sum = request.lines.reduce((s, l) => s + l.amount, 0n);
    if (sum !== 0n) throw new AppError('unbalanced', 400, 'Lines must sum to zero');
    for (const l of request.lines) {
      if (l.account.owner === 'PLAYER' && (this.balances.get(accountKey(l.account)) ?? 0n) + l.amount < 0n) {
        throw new AppError('insufficient_funds', 422, 'Insufficient funds');
      }
    }
    for (const l of request.lines) {
      const k = accountKey(l.account);
      this.balances.set(k, (this.balances.get(k) ?? 0n) + l.amount);
    }
    const entry: PostedEntry = {
      entryId: randomUUID(), idempotencyKey: request.idempotencyKey, reason: request.reason,
      reference: request.reference, postedAt: new Date(0), replayed: false,
    };
    this.entries.set(request.idempotencyKey, { entry, request });
    return entry;
  }

  async balance(account: AccountRef): Promise<Minor> {
    return this.balances.get(accountKey(account)) ?? 0n;
  }

  cash(playerId: string, currency: Currency = 'XAF'): Minor {
    return this.balances.get(`P:${playerId}:CASH:${currency}`) ?? 0n;
  }

  op(kind: string, currency: Currency = 'XAF'): Minor {
    return this.balances.get(`O:${kind}:${currency}`) ?? 0n;
  }
}

export class FakeBetStore implements BetStore {
  readonly bets = new Map<string, BetRecord>();

  add(bet: BetRecord): BetRecord {
    this.bets.set(bet.betId, bet);
    return bet;
  }

  async openBetsForSelections(selectionIds: string[]): Promise<BetRecord[]> {
    const ids = new Set(selectionIds);
    return [...this.bets.values()]
      .filter((b) => b.status === 'OPEN' && b.legs.some((l) => ids.has(l.selectionId)))
      .map((b) => structuredClone(b));
  }

  async getBet(betId: string): Promise<BetRecord | null> {
    const bet = this.bets.get(betId);
    return bet ? structuredClone(bet) : null;
  }

  async markStatus(betId: string, status: BetStatus): Promise<void> {
    const bet = this.bets.get(betId);
    if (!bet) throw new AppError('bet_not_found', 404, 'no bet');
    bet.status = status;
  }
}

let seq = 0;

/** Builds a bet; legs as [selectionId, decimal odds]. */
export const makeBet = (opts: {
  legs: [string, string][];
  unitStake: Minor;
  sizes?: number[];
  playerId?: string;
  currency?: Currency;
  acceptedAt?: Date;
  betId?: string;
}): BetRecord => {
  const sizes = opts.sizes ?? [opts.legs.length];
  return {
    betId: opts.betId ?? `bet-${++seq}-${randomUUID().slice(0, 8)}`,
    playerId: opts.playerId ?? randomUUID(),
    currency: opts.currency ?? 'XAF',
    combinationSizes: sizes,
    unitStake: opts.unitStake,
    totalStake: opts.unitStake * lineCount(opts.legs.length, sizes),
    legs: opts.legs.map(([selectionId, odds]) => ({
      selectionId, marketId: `m-${selectionId}`, eventId: `e-${selectionId}`, odds: parseOdds(odds), line: null,
    })),
    acceptedAt: opts.acceptedAt ?? new Date('2026-10-01T12:00:00Z'),
    status: 'OPEN',
  };
};

/** Records what settlement reported to RG, by ref. */
export class FakeRg {
  readonly settled = new Map<string, { stake: Minor; returned: Minor }>();
  async recordSettlement(_p: string, _c: string, stake: Minor, returned: Minor, ref: string): Promise<boolean> {
    this.settled.set(ref, { stake, returned });
    return true;
  }
}
