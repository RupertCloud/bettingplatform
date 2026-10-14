// Wires the real Release 1 services together, each on its own throwaway schema with its own
// migrations, talking only through the ports in @bp/common (plus the thin adapters below).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  testDb,
  type AccountRef,
  type Currency,
  type Minor,
  type Odds,
  type PlayerId,
  type Pool,
  type PostedEntry,
} from '@bp/common';
import { BettingService, type PlaceBetRequest, type PlaceBetResult } from '@bp/betting';
import { CatalogueService, b365Adapter } from '@bp/catalogue';
import { Identity, RG_ACTOR } from '@bp/identity';
import { ResponsibleGambling, type Clock, type PlayerStateSink } from '@bp/rg';
import { Settlement } from '@bp/settlement';
import { Wallet } from '@bp/wallet';

const migrations = (service: string): string =>
  fileURLToPath(new URL(`../../../services/${service}/migrations`, import.meta.url));

export const FEED_PRIMARY = 'betsapi';
export const TRADER = { actor: 'trader-e2e', reason: 'e2e test action' };

/**
 * Adapter: rg pushes time-outs and self-exclusions through PlayerStateSink; identity takes
 * them through its audited setState as the responsible-gambling service actor.
 */
export const identityStateSink = (identity: Identity): PlayerStateSink => ({
  async setState(playerId, state, until) {
    await identity.setState(playerId, state, RG_ACTOR, `rg:${state.toLowerCase()}`, { until });
  },
});

export interface Harness {
  pools: Record<'identity' | 'wallet' | 'catalogue' | 'rg' | 'betting' | 'settlement', Pool>;
  clock: Clock;
  identity: Identity;
  wallet: Wallet;
  catalogue: CatalogueService;
  rg: ResponsibleGambling;
  betting: BettingService;
  settlement: Settlement;
  /** Called in place of the in-play delay sleep (FR-RSK-008); tests swap it to act during the delay. */
  hooks: { duringInPlayDelay: (ms: number) => Promise<void> };
  drop: () => Promise<void>;
}

export const setup = async (): Promise<Harness> => {
  const dbs = {
    identity: await testDb('e2e_identity', migrations('identity')),
    wallet: await testDb('e2e_wallet', migrations('wallet')),
    catalogue: await testDb('e2e_catalogue', migrations('catalogue')),
    rg: await testDb('e2e_rg', migrations('rg')),
    betting: await testDb('e2e_betting', migrations('betting')),
    settlement: await testDb('e2e_settlement', migrations('settlement')),
  };
  const clock: Clock = { now: () => new Date() };
  const now = () => clock.now();

  const identity = new Identity({ pool: dbs.identity.pool, now, mfaKey: randomBytes(32) });
  const wallet = new Wallet(dbs.wallet.pool, { now });
  // Margin 0 so offered prices equal the feed prices and the SRS appendix A numbers hold exactly.
  const catalogue = new CatalogueService(dbs.catalogue.pool, { primarySource: FEED_PRIMARY, now, defaultMarginBp: 0 });
  const rg = new ResponsibleGambling({
    pool: dbs.rg.pool,
    players: identity,
    stateSink: identityStateSink(identity),
    clock,
  });
  const hooks: Harness['hooks'] = { duringInPlayDelay: async () => undefined };
  const betting = new BettingService({
    pool: dbs.betting.pool,
    players: identity,
    catalogue,
    rg,
    ledger: wallet,
    clock,
    config: {
      limits: { XAF: { global: { minStake: 100n, maxStake: 5_000_000n, maxPayout: 100_000_000n } } },
    },
    sleep: (ms) => hooks.duringInPlayDelay(ms),
  });
  const settlement = new Settlement({ pool: dbs.settlement.pool, bets: betting, ledger: wallet, rg, now });

  return {
    pools: {
      identity: dbs.identity.pool,
      wallet: dbs.wallet.pool,
      catalogue: dbs.catalogue.pool,
      rg: dbs.rg.pool,
      betting: dbs.betting.pool,
      settlement: dbs.settlement.pool,
    },
    clock,
    identity,
    wallet,
    catalogue,
    rg,
    betting,
    settlement,
    hooks,
    drop: async () => {
      for (const db of Object.values(dbs)) await db.drop();
    },
  };
};

// ---------- Accounts and money ----------

export const cash = (playerId: PlayerId, currency: Currency = 'XAF'): AccountRef => ({
  owner: 'PLAYER',
  playerId,
  kind: 'CASH',
  currency,
});
export const operator = (kind: 'PSP_CLEARING' | 'BETS_OPEN' | 'GGR', currency: Currency = 'XAF'): AccountRef => ({
  owner: 'OPERATOR',
  kind,
  currency,
});

let playerSeq = 0;

/** Registers a Cameroon XAF player and activates them with full KYC through identity's audited methods. */
export const registerActivePlayer = async (h: Harness): Promise<PlayerId> => {
  const n = `${Date.now().toString(36)}${++playerSeq}`;
  const reg = await h.identity.register({
    email: `player${n}@example.cm`,
    username: `player${n}`,
    password: 'correct horse battery staple',
    legalName: 'Test Player',
    dateOfBirth: '1990-05-17',
    nationality: 'CM',
    address: { line1: '1 Rue de la Joie', city: 'Douala' },
    country: 'CM',
    jurisdiction: 'CM',
    currency: 'XAF',
    termsVersion: '2026-01',
    acceptedPrivacyNotice: true,
    ageDeclaration: true,
  });
  if (!reg.created) throw new Error('registration did not create a player');
  await h.identity.setState(reg.playerId, 'ACTIVE', 'staff:kyc-officer', 'Email verified, documents checked');
  await h.identity.setKycLevel(reg.playerId, 'FULL', 'staff:kyc-officer', 'Identity documents verified');
  return reg.playerId;
};

/** Deposit flow: rg deposit gate first, then the ledger PSP_CLEARING -> CASH, then rg activity. */
export const deposit = async (h: Harness, playerId: PlayerId, amount: Minor): Promise<PostedEntry> => {
  const at = h.clock.now();
  const gate = await h.rg.checkDeposit(playerId, 'XAF', amount, at);
  if (!gate.allowed) throw new AppError(gate.code, 403, gate.detail);
  const pspRef = `psp:${randomUUID()}`;
  const entry = await h.wallet.post({
    idempotencyKey: `deposit:${pspRef}`,
    reason: 'DEPOSIT',
    reference: pspRef,
    lines: [
      { account: operator('PSP_CLEARING'), amount: -amount },
      { account: cash(playerId), amount },
    ],
  });
  await h.rg.recordDeposit(playerId, 'XAF', amount, pspRef, at);
  return entry;
};

// ---------- Catalogue ----------

export interface FixtureSpec {
  home: string;
  away: string;
  /** Decimal odds as the feed sends them. */
  odds: { home: string; draw: string; away: string };
  /** BetsAPI time_status: '0' pre-match (default), '1' live. */
  timeStatus?: '0' | '1';
  startsAt?: Date;
}

export interface Fixture {
  eventId: string;
  marketId: string;
  selections: { HOME: string; DRAW: string; AWAY: string };
  odds: { HOME: Odds; DRAW: Odds; AWAY: Odds };
}

let feedSeq = 0n;
let feedId = 0;

/** Sends raw BetsAPI payloads through the catalogue's feed normaliser and ingestion. */
export const ingestFixtures = async (h: Harness, specs: FixtureSpec[]): Promise<Fixture[]> => {
  const adapter = b365Adapter(FEED_PRIMARY);
  const ids = specs.map(() => `e2e-${process.pid}-${++feedId}`);
  const raw = {
    results: specs.map((s, i) => ({
      id: ids[i],
      sport_id: '1',
      time: String(Math.floor((s.startsAt ?? new Date(h.clock.now().getTime() + 2 * 86_400_000)).getTime() / 1000)),
      time_status: s.timeStatus ?? '0',
      league: { id: 'cm-elite-one', name: 'Elite One' },
      home: { id: `p-${s.home}`, name: s.home },
      away: { id: `p-${s.away}`, name: s.away },
      odds: { '1_1': [{ home_od: s.odds.home, draw_od: s.odds.draw, away_od: s.odds.away }] },
    })),
  };
  const events = adapter.normalise(raw, ++feedSeq);
  if (events.length !== specs.length) throw new Error('feed normaliser dropped an event');
  const result = await h.catalogue.ingest(FEED_PRIMARY, events);
  if (result.applied !== specs.length) throw new Error(`ingest applied ${result.applied} of ${specs.length}`);

  const fixtures: Fixture[] = [];
  for (const s of specs) {
    const summary = (await h.catalogue.listEvents({ sport: 'soccer', limit: 1000 })).find(
      (e) => e.name === `${s.home} v ${s.away}`,
    );
    if (!summary) throw new Error(`event ${s.home} v ${s.away} not in catalogue`);
    const detail = (await h.catalogue.getEvent(summary.eventId))!;
    const market = detail.markets.find((m) => m.type === '1X2');
    if (!market) throw new Error('no 1X2 market');
    const pick = (key: 'HOME' | 'DRAW' | 'AWAY') => market.selections.find((x) => x.key === key)!;
    fixtures.push({
      eventId: summary.eventId,
      marketId: market.marketId,
      selections: { HOME: pick('HOME').selectionId, DRAW: pick('DRAW').selectionId, AWAY: pick('AWAY').selectionId },
      odds: { HOME: pick('HOME').odds!, DRAW: pick('DRAW').odds!, AWAY: pick('AWAY').odds! },
    });
  }
  return fixtures;
};

// ---------- Betting and settlement ----------

export const betRequest = (
  playerId: PlayerId,
  legs: { selectionId: string; odds: Odds }[],
  combinationSizes: number[],
  unitStake: Minor,
): PlaceBetRequest => ({
  playerId,
  requestId: randomUUID(),
  currency: 'XAF',
  legs,
  combinationSizes,
  unitStake,
  channel: 'WEB',
  ip: '198.51.100.7',
  device: 'e2e-test',
});

export const placeBet = (h: Harness, req: PlaceBetRequest): Promise<PlaceBetResult> => h.betting.placeBet(req);

/** Both feeds report the same result, so settlement confirms it (FR-STL-001). Returns the confirmed result ID. */
export const confirmResult = async (
  h: Harness,
  selectionId: string,
  outcome: 'WON' | 'LOST' | 'VOID',
  resultVersion = 1,
): Promise<string> => {
  await h.settlement.recordResult({ selectionId, outcome, resultVersion, source: 'feed:primary' });
  const intake = await h.settlement.recordResult({ selectionId, outcome, resultVersion, source: 'feed:secondary' });
  if (intake.status !== 'CONFIRMED') throw new Error(`result for ${selectionId} not confirmed: ${intake.status}`);
  return intake.resultId;
};

/** Number of ledger entries with the given reason (reads the wallet's own schema). */
export const entryCount = async (h: Harness, reason: string): Promise<number> => {
  const r = await h.pools.wallet.query<{ n: string }>('SELECT count(*)::text AS n FROM entries WHERE reason = $1', [reason]);
  return Number(r.rows[0]!.n);
};

export const negativePlayerAccounts = async (h: Harness): Promise<number> => {
  const r = await h.pools.wallet.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM accounts WHERE owner = 'PLAYER' AND balance < 0`,
  );
  return Number(r.rows[0]!.n);
};
