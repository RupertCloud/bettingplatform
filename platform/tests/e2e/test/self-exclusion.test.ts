import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
afterAll(async () => {
  await h?.drop();
});

describe('self-excluded player', () => {
  it('FR-RG-004 FR-RG-005 FR-ACC-014 FR-BET-003 FR-BET-007: self-exclusion reaches identity and blocks deposits and bets', async () => {
    const playerId = await registerActivePlayer(h);
    await deposit(h, playerId, 50_000n);
    const [fixture] = await ingestFixtures(h, [
      { home: 'Apejes', away: 'Colombe', odds: { home: '2.00', draw: '3.00', away: '3.50' } },
    ]);
    const stakesBefore = await entryCount(h, 'BET_STAKE');

    const exclusion = await h.rg.selfExclude(playerId, '6m');
    expect(exclusion.state).toBe('SELF_EXCLUDED');

    // Pushed to identity through the PlayerStateSink adapter, as the rg-service actor, audited.
    const status = await h.identity.getStatus(playerId);
    expect(status?.state).toBe('SELF_EXCLUDED');
    const trail = await h.identity.auditTrail(playerId);
    expect(trail.at(-1)).toMatchObject({ actor: 'rg-service', action: 'SET_STATE', after: { state: 'SELF_EXCLUDED' } });
    // Staff cannot lift it early (FR-RG-004).
    await expect(h.identity.setState(playerId, 'ACTIVE', 'staff:support', 'player asked')).rejects.toMatchObject({
      code: 'restriction_active',
    });

    // Deposit gate refuses.
    const gate = await h.rg.checkDeposit(playerId, 'XAF', 10_000n, h.clock.now());
    expect(gate).toEqual({ allowed: false, code: 'self_excluded', detail: expect.any(String) });
    await expect(deposit(h, playerId, 10_000n)).rejects.toMatchObject({ code: 'self_excluded' });

    // Bet refused with a specific reason, no stake posted.
    await expect(
      placeBet(h, betRequest(playerId, [{ selectionId: fixture!.selections.HOME, odds: fixture!.odds.HOME }], [1], 1_000n)),
    ).rejects.toMatchObject({ code: 'account_not_active', status: 403 });
    // The rg gate alone would refuse it too.
    expect(await h.rg.checkStake(playerId, 'XAF', 1_000n, h.clock.now())).toMatchObject({ allowed: false, code: 'self_excluded' });

    expect(await h.wallet.balance(cash(playerId))).toBe(50_000n);
    expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(0n);
    expect(await entryCount(h, 'BET_STAKE')).toBe(stakesBefore);
    expect((await h.wallet.reconcile()).ok).toBe(true);
  });
});
