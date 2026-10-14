import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cash, confirmResult, entryCount, operator, setup, type Harness } from './harness.js';
import { DEPOSIT, UNIT_STAKE, confirmAppendixAResults, placeAppendixATreble } from './flows.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.drop();
});

describe('resettlement after a result correction', () => {
  it('FR-STL-006 FR-STL-005 FR-WAL-003 NFR-DI-001: a corrected result version moves CASH by exactly the difference', async () => {
    const { playerId, fixtures, bet } = await placeAppendixATreble(h, 'RS');
    const first = await h.settlement.settleSelections(await confirmAppendixAResults(h, fixtures));
    expect(first.results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);
    const afterSettle = await h.wallet.balance(cash(playerId));
    expect(afterSettle).toBe(DEPOSIT - UNIT_STAKE + 27_000n);

    // Leg 2 was not abandoned after all: version 2 says the home side won.
    // New return 10,000 x 1.80 x 2.10 x 1.50 = 56,700; difference 29,700.
    const corrected = await confirmResult(h, fixtures[1]!.selections.HOME, 'WON', 2);
    const second = await h.settlement.settleSelections([corrected]);
    expect(second.failed).toEqual([]);
    expect(second.results).toEqual([{ betId: bet.betId, outcome: 'RESETTLED' }]);
    expect(await h.wallet.balance(cash(playerId))).toBe(afterSettle + 29_700n);

    // Version 3 corrects it again to a loss: the whole treble loses, CASH gives back 56,700.
    const lost = await confirmResult(h, fixtures[1]!.selections.HOME, 'LOST', 3);
    const third = await h.settlement.settleSelections([lost]);
    expect(third.results).toEqual([{ betId: bet.betId, outcome: 'RESETTLED' }]);
    expect(await h.wallet.balance(cash(playerId))).toBe(afterSettle + 29_700n - 56_700n);
    expect(await h.wallet.balance(cash(playerId))).toBe(DEPOSIT - UNIT_STAKE);

    const rows = await h.settlement.settlementsFor(bet.betId);
    expect(rows.map((r) => [r.kind, r.status, r.grossReturn, r.deltaNet])).toEqual([
      ['SETTLE', 'POSTED', 27_000n, 27_000n],
      ['RESETTLE', 'POSTED', 56_700n, 29_700n],
      ['RESETTLE', 'POSTED', 0n, -56_700n],
    ]);
    expect(await entryCount(h, 'BET_RESETTLEMENT')).toBe(2);
    expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(0n);
    expect(await h.wallet.balance(operator('GGR'))).toBe(UNIT_STAKE); // the bet lost in the end

    // Replaying the correction changes nothing.
    expect((await h.settlement.settleSelections([lost])).results).toEqual([{ betId: bet.betId, outcome: 'UNCHANGED' }]);
    expect(await entryCount(h, 'BET_RESETTLEMENT')).toBe(2);
    expect((await h.wallet.reconcile()).ok).toBe(true);
  });
});
