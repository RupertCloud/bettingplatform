import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betReturn } from '@bp/settlement';
import { cash, entryCount, operator, setup, type Harness } from './harness.js';
import { DEPOSIT, UNIT_STAKE, confirmAppendixAResults, placeAppendixATreble } from './flows.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.drop();
});

describe('happy path: register, deposit, ingest, treble, settle', () => {
  it(
    'FR-ACC-014 FR-KYC-001 FR-WAL-001 FR-WAL-003 FR-WAL-008 FR-SPD-001 FR-BET-003 FR-BET-005 FR-STL-002 FR-STL-003 NFR-DI-001: ' +
      'treble with a void leg settles at stake x product of the two winning legs (SRS appendix A)',
    async () => {
      const { playerId, fixtures, bet } = await placeAppendixATreble(h, 'HP');

      // Identity holds the player as ACTIVE / FULL with an audit row per change.
      const status = await h.identity.getStatus(playerId);
      expect(status).toMatchObject({ state: 'ACTIVE', kycLevel: 'FULL', jurisdiction: 'CM', currency: 'XAF' });
      const trail = await h.identity.auditTrail(playerId);
      expect(trail.map((a) => a.action)).toEqual(['SET_STATE', 'SET_KYC_LEVEL']);
      expect(await h.identity.verifyAuditChain()).toBeNull();

      // Catalogue prices with margin 0 equal the feed prices: 1.80, 2.10, 1.50.
      expect(fixtures.map((f) => f.odds.HOME)).toEqual([18_000n, 21_000n, 15_000n]);

      // Bet accepted, stake moved CASH -> BETS_OPEN.
      expect(bet.status).toBe('OPEN');
      expect(bet.totalStake).toBe(UNIT_STAKE);
      expect(bet.potentialReturn).toBe(56_700n); // 10,000 x 5.67
      expect(await h.wallet.balance(cash(playerId))).toBe(DEPOSIT - UNIT_STAKE);
      expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(UNIT_STAKE);
      expect(await h.wallet.balance(operator('PSP_CLEARING'))).toBe(-DEPOSIT);

      // Results: won, void, won. Settle.
      const resultIds = await confirmAppendixAResults(h, fixtures);
      const summary = await h.settlement.settleSelections(resultIds);
      expect(summary.failed).toEqual([]);
      expect(summary.results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);

      // Return = 10,000 x 1.80 x 1.50 = 27,000 (void leg at 1.00).
      const expectedReturn = (UNIT_STAKE * 18_000n * 15_000n) / 10_000n / 10_000n;
      expect(expectedReturn).toBe(27_000n);
      expect(
        betReturn(UNIT_STAKE, [3], [
          { outcome: 'WON', odds: 18_000n },
          { outcome: 'VOID', odds: 21_000n },
          { outcome: 'WON', odds: 15_000n },
        ]),
      ).toBe(expectedReturn);

      expect(await h.wallet.balance(cash(playerId))).toBe(117_000n); // 100,000 - 10,000 + 27,000
      expect(await h.wallet.balance(operator('BETS_OPEN'))).toBe(0n);
      expect(await h.wallet.balance(operator('GGR'))).toBe(UNIT_STAKE - expectedReturn); // -17,000

      const settled = await h.betting.getBet(bet.betId);
      expect(settled?.status).toBe('SETTLED');
      const rows = await h.settlement.settlementsFor(bet.betId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'SETTLE', status: 'POSTED', grossReturn: 27_000n, netReturn: 27_000n });
      expect(rows[0]!.legs.map((l) => l.outcome)).toEqual(['WON', 'VOID', 'WON']);

      // Liability released once the bet is settled.
      for (const f of fixtures) expect(await h.betting.liability(f.selections.HOME, 'XAF')).toBe(0n);

      // Re-running settlement posts nothing (FR-STL-005).
      const again = await h.settlement.settleSelections(resultIds);
      expect(again.results).toEqual([{ betId: bet.betId, outcome: 'UNCHANGED' }]);
      expect(await entryCount(h, 'BET_SETTLEMENT')).toBe(1);
      expect(await h.wallet.balance(cash(playerId))).toBe(117_000n);

      const report = await h.wallet.reconcile();
      expect(report).toMatchObject({ ok: true, mismatches: [], unbalancedEntries: [] });
    },
  );
});
