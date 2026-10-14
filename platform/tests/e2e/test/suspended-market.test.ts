import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TRADER,
  betRequest,
  cash,
  deposit,
  entryCount,
  ingestFixtures,
  operator,
  placeBet,
  registerActivePlayer,
  setup,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterEach(() => {
  h.hooks.duringInPlayDelay = async () => undefined;
});
afterAll(async () => {
  await h?.drop();
});

const DEPOSIT = 40_000n;

describe('suspended market', () => {
  it('FR-SPD-005 FR-RSK-002 FR-BET-003 FR-BET-007: market suspended between quote and placement is refused with no ledger entry', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, DEPOSIT);
    const [fixture] = await ingestFixtures(h, [
      { home: 'PWD Bamenda', away: 'Aigle Royal', odds: { home: '2.40', draw: '3.10', away: '2.90' } },
    ]);
    const [quote] = await h.catalogue.getQuotes([fixture!.selections.HOME]);
    expect(quote?.marketState).toBe('OPEN');
    const stakesBefore = await entryCount(h, 'BET_STAKE');

    await h.catalogue.suspendMarket(fixture!.marketId, TRADER);

    await expect(
      placeBet(h, betRequest(playerId, [{ selectionId: quote!.selectionId, odds: quote!.odds }], [1], 5_000n)),
    ).rejects.toMatchObject({ code: 'market_not_open', status: 409, extra: { marketState: 'SUSPENDED' } });

    expect(await entryCount(h, 'BET_STAKE')).toBe(stakesBefore);
    expect(await h.wallet.balance(cash(playerId))).toBe(DEPOSIT);
    expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(0n);
    expect(await h.betting.liability(quote!.selectionId, 'XAF')).toBe(0n);
    const bets = await h.betting.listBets(playerId);
    expect(bets.map((b) => [b.status, b.rejection?.code])).toEqual([['REJECTED', 'market_not_open']]);
  });

  it('FR-RSK-008 FR-SPD-005 FR-BET-003: in-play market suspended during the bet delay is refused on re-validation with no ledger entry', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, DEPOSIT);
    const [fixture] = await ingestFixtures(h, [
      {
        home: 'Dynamo Douala',
        away: 'Fortuna Mfou',
        odds: { home: '1.90', draw: '3.30', away: '4.00' },
        timeStatus: '1',
        startsAt: new Date(h.clock.now().getTime() - 20 * 60_000),
      },
    ]);
    const [quote] = await h.catalogue.getQuotes([fixture!.selections.HOME]);
    expect(quote).toMatchObject({ inPlay: true, marketState: 'OPEN' });
    const stakesBefore = await entryCount(h, 'BET_STAKE');

    const delays: number[] = [];
    h.hooks.duringInPlayDelay = async (ms) => {
      delays.push(ms);
      await h.catalogue.suspendMarket(fixture!.marketId, { ...TRADER, reason: 'goal in progress' });
    };

    await expect(
      placeBet(h, betRequest(playerId, [{ selectionId: quote!.selectionId, odds: quote!.odds }], [1], 5_000n)),
    ).rejects.toMatchObject({ code: 'market_not_open', status: 409 });
    expect(delays).toEqual([7000]); // soccer in-play delay

    expect(await entryCount(h, 'BET_STAKE')).toBe(stakesBefore);
    expect(await h.wallet.balance(cash(playerId))).toBe(DEPOSIT);
    expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(0n);
    expect((await h.wallet.reconcile()).ok).toBe(true);
  });
});
