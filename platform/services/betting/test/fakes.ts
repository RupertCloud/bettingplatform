import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  testDb,
  type AccountRef,
  type Catalogue,
  type Currency,
  type GateDecision,
  type Ledger,
  type Minor,
  type PlayerDirectory,
  type PlayerStatus,
  type PostedEntry,
  type PostingRequest,
  type RgGate,
  type SelectionQuote,
} from '@bp/common';
import { BettingService, type BettingConfig } from '../src/index.js';

export const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export class FakePlayers implements PlayerDirectory {
  readonly players = new Map<string, PlayerStatus>();
  add(over: Partial<PlayerStatus> = {}): string {
    const playerId = over.playerId ?? randomUUID();
    this.players.set(playerId, {
      playerId,
      state: 'ACTIVE',
      kycLevel: 'FULL',
      jurisdiction: 'CM',
      currency: 'XAF',
      stakeFactor: 1,
      ...over,
    });
    return playerId;
  }
  async getStatus(playerId: string) {
    return this.players.get(playerId) ?? null;
  }
}

export class FakeCatalogue implements Catalogue {
  readonly quotes = new Map<string, SelectionQuote>();
  add(selectionId: string, odds: bigint, over: Partial<SelectionQuote> = {}): SelectionQuote {
    const q: SelectionQuote = {
      selectionId,
      marketId: `m-${selectionId}`,
      eventId: `e-${selectionId}`,
      sport: 'soccer',
      competitionId: 'c1',
      marketType: '1X2',
      line: null,
      odds,
      marketState: 'OPEN',
      eventStartsAt: new Date('2026-10-14T18:00:00Z'),
      inPlay: false,
      priceVersion: 1,
      ...over,
    };
    this.quotes.set(selectionId, q);
    return q;
  }
  update(selectionId: string, over: Partial<SelectionQuote>) {
    const q = this.quotes.get(selectionId)!;
    this.quotes.set(selectionId, { ...q, ...over, priceVersion: q.priceVersion + 1 });
  }
  async getQuotes(ids: string[]) {
    return ids.flatMap((id) => {
      const q = this.quotes.get(id);
      return q ? [{ ...q }] : [];
    });
  }
}

export class FakeRg implements RgGate {
  refuse: GateDecision | null = null;
  async checkStake(): Promise<GateDecision> {
    return this.refuse ?? { allowed: true };
  }
  async checkDeposit(): Promise<GateDecision> {
    return { allowed: true };
  }
}

const accountKey = (a: AccountRef) =>
  a.owner === 'PLAYER' ? `P:${a.playerId}:${a.kind}:${a.currency}` : `O:${a.kind}:${a.currency}`;

/** In-memory ledger with idempotency keys and a no-negative rule for player accounts. */
export class FakeLedger implements Ledger {
  readonly entries = new Map<string, PostedEntry>();
  readonly balances = new Map<string, Minor>();
  posts = 0;
  outage = false;
  async post(req: PostingRequest): Promise<PostedEntry> {
    await new Promise((r) => setTimeout(r, 5)); // widen race windows
    if (this.outage) throw new Error('ledger unreachable');
    const prior = this.entries.get(req.idempotencyKey);
    if (prior) return { ...prior, replayed: true };
    for (const l of req.lines) {
      const next = (this.balances.get(accountKey(l.account)) ?? 0n) + l.amount;
      if (l.account.owner === 'PLAYER' && next < 0n) throw new AppError('insufficient_funds', 409, 'Insufficient funds', { shortfall: -next });
    }
    for (const l of req.lines) {
      const k = accountKey(l.account);
      this.balances.set(k, (this.balances.get(k) ?? 0n) + l.amount);
    }
    this.posts++;
    const entry: PostedEntry = {
      entryId: randomUUID(),
      idempotencyKey: req.idempotencyKey,
      reason: req.reason,
      reference: req.reference,
      postedAt: new Date(),
      replayed: false,
    };
    this.entries.set(req.idempotencyKey, entry);
    return entry;
  }
  async balance(a: AccountRef) {
    return this.balances.get(accountKey(a)) ?? 0n;
  }
  fund(playerId: string, amount: Minor, currency: Currency = 'XAF') {
    const k = accountKey({ owner: 'PLAYER', playerId, kind: 'CASH', currency });
    this.balances.set(k, (this.balances.get(k) ?? 0n) + amount);
  }
  cash(playerId: string, currency: Currency = 'XAF') {
    return this.balances.get(accountKey({ owner: 'PLAYER', playerId, kind: 'CASH', currency })) ?? 0n;
  }
}

export const T0 = new Date('2026-10-13T12:00:00Z');

export const setup = async (config: Partial<BettingConfig> = {}) => {
  const db = await testDb('betting', MIGRATIONS);
  const players = new FakePlayers();
  const catalogue = new FakeCatalogue();
  const rg = new FakeRg();
  const ledger = new FakeLedger();
  const clock = { t: T0, now: () => clock.t };
  const sleeps: number[] = [];
  const breaches: { selectionId: string; liability: Minor }[] = [];
  const hooks = { duringSleep: async (): Promise<void> => undefined };
  const betting = new BettingService({
    pool: db.pool,
    players,
    catalogue,
    rg,
    ledger,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t = new Date(clock.t.getTime() + ms);
      await hooks.duringSleep();
    },
    onLiabilityBreach: (selectionId, liability) => {
      breaches.push({ selectionId, liability });
    },
    config: { limits: { XAF: { global: { minStake: 100n, maxStake: 1_000_000n, maxPayout: 50_000_000n } } }, ...config },
  });
  return { db, players, catalogue, rg, ledger, clock, sleeps, breaches, hooks, betting };
};

export type Env = Awaited<ReturnType<typeof setup>>;
