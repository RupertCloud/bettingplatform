import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@bp/common';
import {
  betRequest,
  cash,
  deposit,
  entryCount,
  ingestFixtures,
  negativePlayerAccounts,
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
afterAll(async () => {
  await h?.drop();
});

describe('concurrent bets against one balance', () => {
  it('FR-WAL-003 FR-WAL-004 FR-BET-005 FR-BET-007 NFR-DI-001: 20 parallel bets of 10,000 from 100,000 accept exactly 10', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, 100_000n);
    const [fixture] = await ingestFixtures(h, [
      { home: 'Stade Renard', away: 'Yong Sports', odds: { home: '2.00', draw: '3.00', away: '3.80' } },
    ]);
    const leg = { selectionId: fixture!.selections.HOME, odds: fixture!.odds.HOME };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => placeBet(h, betRequest(playerId, [leg], [1], 10_000n))),
    );

    const accepted = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as unknown] : []));
    expect(accepted).toHaveLength(10);
    expect(refused).toHaveLength(10);
    for (const err of refused) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'insufficient_funds', status: 422 });
    }

    expect(await h.wallet.balance(cash(playerId))).toBe(0n);
    expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(100_000n);
    expect(await negativePlayerAccounts(h)).toBe(0);
    expect(await entryCount(h, 'BET_STAKE')).toBe(10);

    const bets = await h.betting.listBets(playerId, { limit: 200 });
    expect(bets.filter((b) => b.status === 'OPEN')).toHaveLength(10);
    expect(bets.filter((b) => b.status === 'REJECTED')).toHaveLength(10);
    expect(bets.filter((b) => b.status === 'PENDING')).toHaveLength(0);
    // Liability counts only the 10 accepted bets: 10 x (20,000 - 10,000).
    expect(await h.betting.liability(leg.selectionId, 'XAF')).toBe(100_000n);

    const report = await h.wallet.reconcile();
    expect(report).toMatchObject({ ok: true, mismatches: [], unbalancedEntries: [] });
  });
});
