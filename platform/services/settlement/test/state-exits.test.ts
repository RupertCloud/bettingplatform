import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb, type LegOutcome, type Pool, type SelectionResult } from '@bp/common';
import { Settlement, type SettlementDeps } from '../src/index.js';
import { FakeBetStore, FakeLedger, FakeRg, makeBet } from './fakes.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const HOUR = 3_600_000;

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
beforeAll(async () => {
  db = await testDb('settlement', MIGRATIONS);
  pool = db.pool;
});
afterAll(async () => {
  await db.drop();
});

const setup = (extra: Partial<SettlementDeps> = {}) => {
  const clock = { t: new Date('2026-10-01T18:00:00Z') };
  const bets = new FakeBetStore();
  const ledger = new FakeLedger();
  const svc = new Settlement({ pool, bets, ledger, rg: new FakeRg(), now: () => clock.t, ...extra });
  return { bets, ledger, svc, clock };
};
const sel = () => `sel-${randomUUID()}`;
const feed = (selectionId: string, outcome: LegOutcome, source: 'feed:primary' | 'feed:secondary', resultVersion = 1): SelectionResult =>
  ({ selectionId, outcome, source, resultVersion });
const confirm = async (svc: Settlement, s: string, outcome: LegOutcome, version = 1) => {
  await svc.recordResult(feed(s, outcome, 'feed:primary', version));
  const r = await svc.recordResult(feed(s, outcome, 'feed:secondary', version));
  if (r.status !== 'CONFIRMED') throw new Error('not confirmed');
  return r.resultId;
};

describe('FR-STL-001 single result source', () => {
  it('with resultSources 1 the primary feed alone confirms; a disagreeing secondary still opens a mismatch', async () => {
    const { svc } = setup({ resultSources: 1 });
    const s = sel();
    expect((await svc.recordResult(feed(s, 'WON', 'feed:primary'))).status).toBe('CONFIRMED');
    const t = sel();
    await svc.recordResult(feed(t, 'LOST', 'feed:secondary'));
    expect((await svc.recordResult(feed(t, 'WON', 'feed:primary'))).status).toBe('MISMATCH');
  });
});

describe('FR-STL-001 FR-STL-009 feed results after a manual result', () => {
  it('a feed correction at the version the trader used is neither dropped nor applied without a trader', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 1_000n }));
    await svc.settleSelections([await confirm(svc, s, 'LOST')]);
    // The trader settles the selection as WON; it takes result version 2.
    const action = await svc.requestManual({ action: 'SETTLE', reason: 'Feed graded the wrong side', results: [{ selectionId: s, outcome: 'WON' }] }, { staffId: 'tr-1' }, 'k-manual-1');
    expect(action.status).toBe('EXECUTED');
    expect(ledger.cash(bet.playerId)).toBe(2_000n);
    // The feeds now send their own version 2 saying VOID.
    await svc.recordResult(feed(s, 'VOID', 'feed:primary', 2));
    const r = await svc.recordResult(feed(s, 'VOID', 'feed:secondary', 2));
    expect(r.status).toBe('MISMATCH');
    const [mm] = (await svc.listMismatches()).filter((m) => m.selectionId === s);
    expect(mm).toMatchObject({ kind: 'FEED_VS_MANUAL', resultVersion: 2, primary: { outcome: 'VOID' }, secondary: { outcome: 'WON' } });
    expect(ledger.cash(bet.playerId)).toBe(2_000n); // nothing applied yet

    // A trader accepts the feed's correction: it becomes the newest version and resettles the bet.
    const accepted = await svc.confirmResult({ selectionId: s, resultVersion: 2, outcome: 'VOID' }, { staffId: 'tr-2' });
    expect(accepted.resultVersion).toBe(3);
    await svc.settleSelections([accepted.resultId]);
    expect(ledger.cash(bet.playerId)).toBe(1_000n);
    expect((await svc.listMismatches()).filter((m) => m.selectionId === s)).toHaveLength(0);
  });

  it('a later feed version never overrides a manual result on its own; a trader can keep the manual result', async () => {
    const { svc } = setup();
    const s = sel();
    await confirm(svc, s, 'LOST');
    await svc.requestManual({ action: 'SETTLE', reason: 'Wrong side graded', results: [{ selectionId: s, outcome: 'WON' }] }, { staffId: 'tr-1' }, 'k-manual-2');
    await svc.recordResult(feed(s, 'LOST', 'feed:primary', 5));
    expect((await svc.recordResult(feed(s, 'LOST', 'feed:secondary', 5))).status).toBe('MISMATCH');
    const kept = await svc.confirmResult({ selectionId: s, resultVersion: 5, outcome: 'WON' }, { staffId: 'tr-2' });
    expect(kept).toMatchObject({ resultVersion: 2, outcome: 'WON' });
    expect((await svc.listMismatches()).filter((m) => m.selectionId === s)).toHaveLength(0);
    // A feed that agrees with the manual result is a no-op.
    await svc.recordResult(feed(s, 'WON', 'feed:primary', 6));
    expect(await svc.recordResult(feed(s, 'WON', 'feed:secondary', 6))).toEqual({ status: 'CONFIRMED', resultId: kept.resultId });
  });
});

describe('FR-STL-010 manual review has an exit', () => {
  const refusedClawback = async () => {
    const env = setup();
    const s = sel();
    const bet = env.bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 1_000n }));
    await env.svc.settleSelections([await confirm(env.svc, s, 'WON')]);
    env.ledger.balances.set(`P:${bet.playerId}:CASH:XAF`, 500n);
    await env.svc.settleSelections([await confirm(env.svc, s, 'LOST', 2)]);
    const [item] = (await env.svc.listManualReview()).filter((r) => r.betId === bet.betId);
    return { ...env, s, bet, item: item! };
  };

  it('RETRY posts the clawback once funds are back and closes the item', async () => {
    const { svc, ledger, bet, item } = await refusedClawback();
    ledger.balances.set(`P:${bet.playerId}:CASH:XAF`, 3_000n);
    expect(await svc.resolveReview(item.reviewId, 'RETRY', { staffId: 'fin-1' }, 'Player topped up')).toEqual({ resolution: 'RETRIED', outcome: 'RESETTLED' });
    expect(ledger.cash(bet.playerId)).toBe(0n);
    expect((await svc.listManualReview()).filter((r) => r.betId === bet.betId)).toHaveLength(0);
    await expect(svc.resolveReview(item.reviewId, 'WAIVE', { staffId: 'fin-1' }, 'again')).rejects.toMatchObject({ code: 'review_closed' });
  });

  it('RETRY with funds still short puts the item back in the queue', async () => {
    const { svc, bet, item } = await refusedClawback();
    expect((await svc.resolveReview(item.reviewId, 'RETRY', { staffId: 'fin-1' }, 'Try again')).outcome).toBe('MANUAL_REVIEW');
    expect((await svc.listManualReview()).filter((r) => r.betId === bet.betId)).toHaveLength(1);
  });

  it('WAIVE closes the item and moves no money', async () => {
    const { svc, ledger, bet, item } = await refusedClawback();
    await svc.resolveReview(item.reviewId, 'WAIVE', { staffId: 'fin-1' }, 'Below recovery threshold');
    expect(ledger.cash(bet.playerId)).toBe(500n);
    expect((await svc.listManualReview()).filter((r) => r.betId === bet.betId)).toHaveLength(0);
  });

  it('a later resettlement closes the item as superseded, so a restored win is not clawed back again', async () => {
    const { svc, s, bet, item } = await refusedClawback();
    await svc.settleSelections([await confirm(svc, s, 'WON', 3)]);
    expect((await svc.listManualReview()).filter((r) => r.betId === bet.betId)).toHaveLength(0);
    const row = (await pool.query('SELECT resolution FROM manual_review WHERE review_id = $1', [item.reviewId])).rows[0];
    expect(row.resolution).toBe('SUPERSEDED');
  });
});

describe('FR-BO-011 manual actions waiting for approval have an exit', () => {
  const big = async (key: string) => {
    const env = setup({ approvalThresholds: { XAF: 5_000n } });
    const s = sel();
    env.bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 6_000n }));
    const action = await env.svc.requestManual({ action: 'VOID', reason: 'Match abandoned', results: [{ selectionId: s }] }, { staffId: 'tr-1' }, key);
    expect(action.status).toBe('PENDING_APPROVAL');
    return { ...env, action };
  };

  it('can be rejected, after which it cannot be approved', async () => {
    const { svc, action } = await big('k-rej-1');
    expect((await svc.rejectManual(action.actionId, { staffId: 'tr-2' }, 'Not abandoned')).status).toBe('REJECTED');
    await expect(svc.approveManual(action.actionId, { staffId: 'tr-3' })).rejects.toMatchObject({ code: 'manual_action_closed' });
  });

  it('expires after 24 hours without approval', async () => {
    const { svc, clock, action, ledger } = await big('k-exp-1');
    clock.t = new Date(clock.t.getTime() + 24 * HOUR);
    await expect(svc.approveManual(action.actionId, { staffId: 'tr-2' })).rejects.toMatchObject({ code: 'manual_action_expired' });
    expect((await svc.getManual(action.actionId))!.status).toBe('EXPIRED');
    expect(ledger.entries.size).toBe(0);
    expect(await svc.expireManualActions(clock.t)).toBe(0);
  });
});

describe('FR-STL-005 sweep of bets that opened after their results', () => {
  it('settles an OPEN bet whose selection was settled before the bet opened', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    await svc.settleSelections([await confirm(svc, s, 'WON')]); // nothing open yet
    const late = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 1_000n })); // a PENDING bet that just opened
    const out = await svc.sweepOpenBets();
    expect(out.results).toEqual([{ betId: late.betId, outcome: 'SETTLED' }]);
    expect(ledger.cash(late.playerId)).toBe(2_000n);
    expect((await svc.sweepOpenBets()).results).toEqual([]);
  });
});
