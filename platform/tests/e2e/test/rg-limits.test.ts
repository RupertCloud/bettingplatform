// Contract gap found while wiring the services: the RgGate port only has checkStake, so
// betting never records stakes with rg and settlement never records returns. Period stake
// and loss limits (FR-RG-002) therefore never accumulate across bets in the integrated system.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betRequest,
  cash,
  deposit,
  ingestFixtures,
  placeBet,
  registerActivePlayer,
  setup,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.drop();
});

describe('responsible gambling period limits across services', () => {
  it('FR-RG-002 FR-RG-003 FR-BET-003: a per-bet stake limit set in rg refuses a larger bet', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, 50_000n);
    const [fixture] = await ingestFixtures(h, [
      { home: 'Avion Nkam', away: 'Feutcheu', odds: { home: '2.00', draw: '3.00', away: '3.50' } },
    ]);
    expect(await h.rg.setLimit(playerId, 'STAKE_PER_BET', 5_000n)).toEqual({ status: 'APPLIED' });
    const leg = { selectionId: fixture!.selections.HOME, odds: fixture!.odds.HOME };
    await expect(placeBet(h, betRequest(playerId, [leg], [1], 6_000n))).rejects.toMatchObject({
      code: 'stake_limit_exceeded',
      status: 403,
    });
    expect(await h.wallet.balance(cash(playerId))).toBe(50_000n);
  });

  // Confirmed contract mismatch (see commit body): BettingService calls RgGate.checkStake and never
  // records the stake, so rg's daily stake sum stays 0 and the second bet is accepted.
  it.fails('FR-RG-002 FR-BET-003: a daily stake limit counts stakes already placed today', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, 50_000n);
    const [fixture] = await ingestFixtures(h, [
      { home: 'Ngaoundere', away: 'Bafang', odds: { home: '2.00', draw: '3.00', away: '3.50' } },
    ]);
    expect(await h.rg.setLimit(playerId, 'STAKE_DAY', 15_000n)).toEqual({ status: 'APPLIED' });
    const leg = { selectionId: fixture!.selections.HOME, odds: fixture!.odds.HOME };

    await placeBet(h, betRequest(playerId, [leg], [1], 10_000n));
    // 10,000 already staked today + 10,000 > 15,000: must be refused.
    await expect(placeBet(h, betRequest(playerId, [leg], [1], 10_000n))).rejects.toMatchObject({
      code: 'stake_limit_exceeded',
    });
  });
});
