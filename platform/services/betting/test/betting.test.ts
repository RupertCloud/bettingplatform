import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@bp/common';
import { betLines, effectiveLimits, type PlaceBetRequest } from '../src/index.js';
import { setup, T0, type Env } from './fakes.js';

let env: Env;
beforeAll(async () => {
  env = await setup({
    liabilityCap: (selectionId) => (selectionId.startsWith('capped') ? 10_000n : null),
  });
});
afterAll(async () => {
  await env.db.drop();
});
beforeEach(() => {
  env.clock.t = T0;
  env.rg.refuse = null;
  env.ledger.outage = false;
  env.hooks.duringSleep = async () => undefined;
});

let seq = 0;
const sel = (odds: bigint, over: Parameters<Env['catalogue']['add']>[2] = {}) =>
  env.catalogue.add(`s${++seq}`, odds, over).selectionId;

const player = (funds = 1_000_000n, over: Parameters<Env['players']['add']>[0] = {}) => {
  const id = env.players.add(over);
  env.ledger.fund(id, funds, over.currency ?? 'XAF');
  return id;
};

const req = (playerId: string, legs: [string, bigint][], over: Partial<PlaceBetRequest> = {}): PlaceBetRequest => ({
  playerId,
  requestId: randomUUID(),
  currency: 'XAF',
  legs: legs.map(([selectionId, odds]) => ({ selectionId, odds })),
  combinationSizes: [legs.length],
  unitStake: 1000n,
  channel: 'WEB',
  ip: '203.0.113.7',
  device: 'test-device',
  ...over,
});

const rejection = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
};

describe('placement', () => {
  it('FR-BET-005 accepts a single, debits the stake once and stores legs, timestamps, channel, ip and device', async () => {
    const p = player();
    const s = sel(25_000n, { line: '2.5', marketType: 'TOTALS' });
    env.hooks.duringSleep = async () => undefined;
    const { bet, replayed } = await env.betting.placeBet(req(p, [[s, 25_000n]]));
    expect(replayed).toBe(false);
    expect(bet.status).toBe('OPEN');
    expect(bet.totalStake).toBe(1000n);
    expect(bet.potentialReturn).toBe(2500n);
    expect(bet.legs[0]).toMatchObject({ selectionId: s, odds: 25_000n, line: '2.5', marketId: `m-${s}` });
    expect(bet.submittedAt).toEqual(T0);
    expect(bet.acceptedAt).toEqual(T0);
    expect(bet.channel).toBe('WEB');
    const row = await env.db.pool.query('SELECT ip, device FROM bets WHERE bet_id = $1', [bet.betId]);
    expect(row.rows[0]).toEqual({ ip: '203.0.113.7', device: 'test-device' });
    expect(env.ledger.cash(p)).toBe(999_000n);
    expect(env.ledger.entries.get(`bet:${bet.betId}:stake`)?.reason).toBe('BET_STAKE');
    const record = await env.betting.getBet(bet.betId);
    expect(record).toMatchObject({ betId: bet.betId, status: 'OPEN', unitStake: 1000n, combinationSizes: [1] });
  });

  it('FR-BET-006 concurrent submissions of one requestId post the stake once and return the same bet', async () => {
    const p = player();
    const s = sel(20_000n);
    const r = req(p, [[s, 20_000n]]);
    const postsBefore = env.ledger.posts;
    const results = await Promise.all(Array.from({ length: 8 }, () => env.betting.placeBet({ ...r })));
    expect(new Set(results.map((x) => x.bet.betId)).size).toBe(1);
    expect(results.filter((x) => !x.replayed).length).toBe(1);
    expect(env.ledger.posts - postsBefore).toBe(1);
    expect(env.ledger.cash(p)).toBe(999_000n);
    const count = await env.db.pool.query('SELECT count(*)::int AS n FROM bets WHERE player_id = $1', [p]);
    expect(count.rows[0].n).toBe(1);
    expect(await env.betting.liability(s, 'XAF')).toBe(1000n);
  });

  it('FR-BET-006 a replayed rejected request returns the original rejection; a different bet under the same ID conflicts', async () => {
    const p = player();
    const s = sel(20_000n);
    const r = req(p, [[s, 21_000n]]);
    expect((await rejection(env.betting.placeBet(r))).code).toBe('price_changed');
    env.catalogue.update(s, { odds: 30_000n }); // would now pass
    expect((await rejection(env.betting.placeBet(r))).code).toBe('price_changed');
    expect((await rejection(env.betting.placeBet({ ...r, unitStake: 2000n }))).code).toBe('idempotency_conflict');
  });

  it('FR-BET-004 HIGHER policy rejects a price that moved down', async () => {
    const p = player();
    const s = sel(18_000n);
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]])));
    expect(err.code).toBe('price_changed');
    expect(err.extra).toMatchObject({ selectionId: s, requestedOdds: '2', currentOdds: '1.8' });
    expect(env.ledger.cash(p)).toBe(1_000_000n);
  });

  it('FR-BET-004 HIGHER accepts a better price at the current odds; NONE rejects any change; ANY accepts a worse one', async () => {
    const p = player();
    const s = sel(22_000n);
    const { bet } = await env.betting.placeBet(req(p, [[s, 20_000n]]));
    expect(bet.legs[0]!.odds).toBe(22_000n);
    expect(bet.legs[0]!.requestedOdds).toBe(20_000n);
    expect(
      (await rejection(env.betting.placeBet(req(p, [[s, 20_000n]], { oddsChangePolicy: 'NONE' })))).code,
    ).toBe('price_changed');
    const any = await env.betting.placeBet(req(p, [[s, 30_000n]], { oddsChangePolicy: 'ANY' }));
    expect(any.bet.legs[0]!.odds).toBe(22_000n);
  });

  it('FR-RSK-009 rejects two legs on the same event in a multiple', async () => {
    const p = player();
    const a = sel(20_000n, { eventId: 'ev-x' });
    const b = sel(30_000n, { eventId: 'ev-x' });
    const err = await rejection(env.betting.placeBet(req(p, [[a, 20_000n], [b, 30_000n]])));
    expect(err.code).toBe('correlated_selections');
  });

  it('FR-BET-002 a Yankee costs 11 x the unit stake and returns the sum of its 11 lines', async () => {
    const p = player();
    const legs: [string, bigint][] = [20_000n, 30_000n, 15_000n, 25_000n].map((o) => [sel(o), o]);
    const { bet } = await env.betting.placeBet(req(p, legs, { combinationSizes: [2, 3, 4], unitStake: 500n }));
    expect(bet.totalStake).toBe(5500n);
    expect(env.ledger.cash(p)).toBe(1_000_000n - 5500n);
    const expected = betLines(
      legs.map((l) => l[1]),
      [2, 3, 4],
      500n,
    ).reduce((s, l) => s + l.fullWinReturn, 0n);
    expect(bet.potentialReturn).toBe(expected);
    // doubles 6+... computed by hand: 2*3,2*1.5,2*2.5,3*1.5,3*2.5,1.5*2.5 = 6+3+5+4.5+7.5+3.75 = 29.75
    // trebles 9+15+7.5+11.25 = 42.75, four-fold 22.5 -> 95 x 500
    expect(expected).toBe(47_500n);
  });

  it('FR-RSK-008 re-validates after the in-play delay and rejects a market suspended during it', async () => {
    const p = player();
    const s = sel(20_000n, { inPlay: true, sport: 'soccer' });
    env.hooks.duringSleep = async () => env.catalogue.update(s, { marketState: 'SUSPENDED' });
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]])));
    expect(err.code).toBe('market_not_open');
    expect(env.sleeps.at(-1)).toBe(7000);
    expect(env.ledger.cash(p)).toBe(1_000_000n);
  });

  it('FR-RSK-008 uses the longest per-sport delay and timestamps acceptance after it', async () => {
    const p = player();
    const a = sel(20_000n, { inPlay: true, sport: 'tennis' });
    const b = sel(20_000n, { inPlay: false });
    const { bet } = await env.betting.placeBet(req(p, [[a, 20_000n], [b, 20_000n]]));
    expect(env.sleeps.at(-1)).toBe(5000);
    expect(bet.submittedAt).toEqual(T0);
    expect(bet.acceptedAt).toEqual(new Date(T0.getTime() + 5000));
  });

  it('FR-BET-003 FR-BET-007 rejects with a specific code for each validation failure', async () => {
    const s = sel(20_000n);
    const ok = player();
    const cases: [string, PlaceBetRequest][] = [
      ['account_not_active', req(player(1_000_000n, { state: 'SUSPENDED' }), [[s, 20_000n]])],
      ['kyc_required', req(player(1_000_000n, { kycLevel: 'BASIC' }), [[s, 20_000n]])],
      ['currency_mismatch', req(ok, [[s, 20_000n]], { currency: 'EUR' })],
      ['duplicate_selection', req(ok, [[s, 20_000n], [s, 20_000n]])],
      ['invalid_bet', req(ok, [[s, 20_000n]], { combinationSizes: [2] })],
      ['selection_not_found', req(ok, [['nope', 20_000n]])],
      ['stake_below_min', req(ok, [[s, 20_000n]], { unitStake: 99n })],
      ['player_not_found', req(randomUUID(), [[s, 20_000n]])],
    ];
    for (const [code, r] of cases) expect((await rejection(env.betting.placeBet(r))).code).toBe(code);

    const started = sel(20_000n, { eventStartsAt: new Date(T0.getTime() - 1000) });
    expect((await rejection(env.betting.placeBet(req(ok, [[started, 20_000n]])))).code).toBe('event_started');

    const susp = sel(20_000n, { marketState: 'SUSPENDED' });
    expect((await rejection(env.betting.placeBet(req(ok, [[susp, 20_000n]])))).code).toBe('market_not_open');

    env.rg.refuse = { allowed: false, code: 'loss_limit_reached', detail: 'Daily loss limit reached' };
    expect((await rejection(env.betting.placeBet(req(ok, [[s, 20_000n]])))).code).toBe('loss_limit_reached');
    expect(env.ledger.cash(ok)).toBe(1_000_000n);
  });

  it('FR-BET-007 rejects for insufficient funds and releases the reserved liability', async () => {
    const p = player(500n);
    const s = sel(20_000n);
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]])));
    expect(err.code).toBe('insufficient_funds');
    expect(err.extra).toEqual({ shortfall: '500' });
    expect(await env.betting.liability(s, 'XAF')).toBe(0n);
    const [bet] = await env.betting.listBets(p);
    expect(bet).toMatchObject({ status: 'REJECTED', rejection: { code: 'insufficient_funds' } });
    expect(await env.betting.getBet(bet!.betId)).toBeNull();
  });
});

describe('limits', () => {
  it('FR-RSK-004 the lowest max across global, sport and market type wins and is reported', async () => {
    const lim = effectiveLimits(
      {
        global: { minStake: 100n, maxStake: 100_000n, maxPayout: 1_000_000n },
        sport: { tennis: { maxStake: 50_000n, minStake: 200n } },
        marketType: { TOTALS: { maxStake: 70_000n, maxPayout: 400_000n } },
      },
      [env.catalogue.add('lim1', 20_000n, { sport: 'tennis', marketType: 'TOTALS' })],
      1,
    );
    expect(lim).toEqual({ minStake: 200n, maxStake: 50_000n, maxPayout: 400_000n });

    const p = player(10_000_000n);
    const s = sel(20_000n);
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 1_000_001n })));
    expect(err.code).toBe('stake_above_max');
    expect(err.extra).toEqual({ maxStake: '1000000' });
  });

  it('FR-RSK-005 the player stake factor scales the maximum stake', async () => {
    const p = player(10_000_000n, { stakeFactor: 0.25 });
    const s = sel(20_000n);
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 250_001n })));
    expect(err.extra).toEqual({ maxStake: '250000' });
    const { bet } = await env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 250_000n }));
    expect(bet.status).toBe('OPEN');
  });

  it('FR-RSK-004 rejects a bet whose full-win return over all lines exceeds max payout', async () => {
    const p = player(10_000_000n);
    const legs: [string, bigint][] = [1_000_000n, 1_000_000n].map((o) => [sel(o), o]); // 100.0 each
    const err = await rejection(env.betting.placeBet(req(p, legs, { unitStake: 6000n })));
    expect(err.code).toBe('payout_above_max'); // 6000 x 10,000 = 60,000,000 > 50,000,000
    expect(err.extra).toEqual({ maxPayout: '50000000' });
  });
});

describe('liability', () => {
  it('FR-RSK-003 accumulates potential net payout per selection across bets', async () => {
    const a = sel(20_000n);
    const b = sel(30_000n);
    const p = player();
    await env.betting.placeBet(req(p, [[a, 20_000n]])); // net 1000
    await env.betting.placeBet(req(p, [[a, 20_000n], [b, 30_000n]])); // 6x: net 5000 on both
    expect(await env.betting.liability(a, 'XAF')).toBe(6000n);
    expect(await env.betting.liability(b, 'XAF')).toBe(5000n);
  });

  it('FR-RSK-006 rejects a bet that would push liability past the cap and reports the breach', async () => {
    const s = env.catalogue.add('capped-1', 20_000n).selectionId;
    const p = player();
    await env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 9000n })); // liability 9000
    const err = await rejection(env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 2000n })));
    expect(err.code).toBe('liability_limit');
    expect(env.breaches.at(-1)).toEqual({ selectionId: s, liability: 11_000n });
    expect(await env.betting.liability(s, 'XAF')).toBe(9000n);
    expect(env.ledger.cash(p)).toBe(1_000_000n - 9000n);
  });

  it('FR-RSK-006 concurrent bets never take liability past the cap', async () => {
    const s = env.catalogue.add('capped-2', 20_000n).selectionId;
    const p = player(10_000_000n);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => env.betting.placeBet(req(p, [[s, 20_000n]], { unitStake: 3000n }))),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(3);
    expect(await env.betting.liability(s, 'XAF')).toBe(9000n);
    expect(env.ledger.cash(p)).toBe(10_000_000n - 9000n);
  });
});

describe('recovery and BetStore', () => {
  it('FR-BET-005 a ledger outage leaves the bet PENDING; recoverPending posts the same stake once and opens it', async () => {
    const p = player();
    const s = sel(20_000n);
    env.ledger.outage = true;
    const r = req(p, [[s, 20_000n]]);
    await expect(env.betting.placeBet(r)).rejects.toThrow('ledger unreachable');
    const [pending] = await env.betting.listBets(p);
    expect(pending!.status).toBe('PENDING');
    expect(await env.betting.getBet(pending!.betId)).toBeNull();

    env.ledger.outage = false;
    expect(await env.betting.recoverPending(new Date(T0.getTime() + 30_000))).toEqual({ opened: 0, rejected: 0, failed: 0 });
    env.clock.t = new Date(T0.getTime() + 61_000);
    expect(await env.betting.recoverPending(env.clock.t)).toEqual({ opened: 1, rejected: 0, failed: 0 });
    const replay = await env.betting.placeBet(r);
    expect(replay).toMatchObject({ replayed: true, bet: { betId: pending!.betId, status: 'OPEN' } });
    expect(env.ledger.cash(p)).toBe(999_000n);
  });

  it('FR-BET-005 recoverPending rejects a PENDING bet the ledger refuses and releases its liability', async () => {
    const p = player(1000n);
    const s = sel(20_000n);
    env.ledger.outage = true;
    await expect(env.betting.placeBet(req(p, [[s, 20_000n]]))).rejects.toThrow();
    env.ledger.outage = false;
    env.ledger.fund(p, -1000n); // money left in the meantime
    const res = await env.betting.recoverPending(new Date(T0.getTime() + 61_000));
    expect(res.rejected).toBe(1);
    expect((await env.betting.listBets(p))[0]!.status).toBe('REJECTED');
    expect(await env.betting.liability(s, 'XAF')).toBe(0n);
  });

  it('FR-STL-011 openBetsForSelections and markStatus move bets out of OPEN and release liability', async () => {
    const p = player();
    const s = sel(20_000n);
    const { bet } = await env.betting.placeBet(req(p, [[s, 20_000n]]));
    expect((await env.betting.openBetsForSelections([s])).map((b) => b.betId)).toEqual([bet.betId]);
    await env.betting.markStatus(bet.betId, 'SETTLED');
    await env.betting.markStatus(bet.betId, 'SETTLED'); // idempotent
    expect(await env.betting.openBetsForSelections([s])).toEqual([]);
    expect(await env.betting.liability(s, 'XAF')).toBe(0n);
    expect((await env.betting.getBet(bet.betId))!.status).toBe('SETTLED');
    await expect(env.betting.markStatus(randomUUID(), 'SETTLED')).rejects.toMatchObject({ code: 'bet_not_found' });
  });

  it('FR-BET-011 lists only the player\'s bets with status and date filters', async () => {
    const p = player();
    const s = sel(20_000n);
    const first = (await env.betting.placeBet(req(p, [[s, 20_000n]]))).bet;
    env.clock.t = new Date(T0.getTime() + 3_600_000);
    const second = (await env.betting.placeBet(req(p, [[s, 20_000n]]))).bet;
    await env.betting.markStatus(first.betId, 'SETTLED');
    await env.betting.placeBet(req(player(), [[s, 20_000n]]));
    expect((await env.betting.listBets(p)).map((b) => b.betId)).toEqual([second.betId, first.betId]);
    expect((await env.betting.listBets(p, { status: ['SETTLED'] })).map((b) => b.betId)).toEqual([first.betId]);
    expect((await env.betting.listBets(p, { from: new Date(T0.getTime() + 1) })).map((b) => b.betId)).toEqual([
      second.betId,
    ]);
  });
});

describe('booking codes', () => {
  it('FR-BET-009 saves selections as an 8-character unambiguous code and loads them with current prices', async () => {
    const a = sel(20_000n);
    const b = sel(30_000n);
    const saved = await env.betting.saveBookingCode('someone', [a, b, a]);
    expect(saved.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    env.catalogue.update(a, { odds: 21_000n });
    const loaded = await env.betting.loadBookingCode(saved.code.toLowerCase());
    expect(loaded!.selections.map((q) => [q.selectionId, q.odds])).toEqual([
      [a, 21_000n],
      [b, 30_000n],
    ]);
    expect(await env.betting.loadBookingCode('ZZZZZZZZ')).toBeNull();
    await expect(env.betting.saveBookingCode('x', ['missing'])).rejects.toMatchObject({ code: 'selection_not_found' });
  });
});
