import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, testDb, type LegOutcome, type Pool, type SelectionResult } from '@bp/common';
import { Settlement, type SettlementDeps } from '../src/index.js';
import { FakeBetStore, FakeLedger, makeBet } from './fakes.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const NOW = new Date('2026-10-01T18:00:00Z');

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
  const bets = new FakeBetStore();
  const ledger = new FakeLedger();
  const svc = new Settlement({ pool, bets, ledger, now: () => NOW, ...extra });
  return { bets, ledger, svc };
};

const sel = () => `sel-${randomUUID()}`;

const feed = (selectionId: string, outcome: LegOutcome, source: 'feed:primary' | 'feed:secondary', resultVersion = 1,
  deadHeat?: { numerator: number; denominator: number }): SelectionResult =>
  ({ selectionId, outcome, source, resultVersion, ...(deadHeat ? { deadHeat } : {}) });

/** Both feeds agree; returns the confirmed result ID. */
const confirm = async (svc: Settlement, selectionId: string, outcome: LegOutcome, version = 1): Promise<string> => {
  await svc.recordResult(feed(selectionId, outcome, 'feed:primary', version));
  const r = await svc.recordResult(feed(selectionId, outcome, 'feed:secondary', version));
  if (r.status !== 'CONFIRMED') throw new Error('not confirmed');
  return r.resultId;
};

describe('result intake', () => {
  it('FR-STL-001 confirms only when primary and secondary agree', async () => {
    const { svc } = setup();
    const s = sel();
    expect(await svc.recordResult(feed(s, 'WON', 'feed:primary'))).toEqual({ status: 'PENDING' });
    const r = await svc.recordResult(feed(s, 'WON', 'feed:secondary'));
    expect(r.status).toBe('CONFIRMED');
    // A repeat of the same submission is harmless and reports the same confirmed result.
    expect(await svc.recordResult(feed(s, 'WON', 'feed:primary'))).toEqual(r);
  });

  it('FR-STL-001 puts a disagreement in the mismatch queue with both versions', async () => {
    const { svc } = setup();
    const s = sel();
    await svc.recordResult(feed(s, 'WON', 'feed:primary'));
    const r = await svc.recordResult(feed(s, 'DEAD_HEAT', 'feed:secondary', 1, { numerator: 1, denominator: 2 }));
    expect(r.status).toBe('MISMATCH');
    const queue = (await svc.listMismatches()).filter((m) => m.selectionId === s);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.primary).toEqual({ selectionId: s, outcome: 'WON' });
    expect(queue[0]!.secondary).toEqual({ selectionId: s, outcome: 'DEAD_HEAT', deadHeat: { numerator: 1, denominator: 2 } });

    const confirmed = await svc.confirmResult({ selectionId: s, resultVersion: 1, outcome: 'WON' }, { staffId: 'trader-1' });
    expect(confirmed.confirmedBy).toBe('trader:trader-1');
    expect((await svc.listMismatches()).filter((m) => m.selectionId === s)).toHaveLength(0);
    const audit = await pool.query("SELECT actor, action FROM staff_audit WHERE target = $1", [`selection:${s}`]);
    expect(audit.rows).toEqual([{ actor: 'trader-1', action: 'RESULT_CONFIRM' }]);
  });

  it('FR-STL-001 FR-STL-009 a trader can only confirm a result a feed reported', async () => {
    const { svc } = setup();
    const s = sel();
    await expect(svc.confirmResult({ selectionId: s, resultVersion: 1, outcome: 'WON' }, { staffId: 't' }))
      .rejects.toMatchObject({ code: 'result_not_found', status: 404 });
    await svc.recordResult(feed(s, 'LOST', 'feed:primary'));
    await expect(svc.confirmResult({ selectionId: s, resultVersion: 1, outcome: 'WON' }, { staffId: 't' }))
      .rejects.toMatchObject({ code: 'result_not_submitted', status: 409 });
    // Primary alone, confirmed by a trader in place of the secondary feed.
    expect((await svc.confirmResult({ selectionId: s, resultVersion: 1, outcome: 'LOST' }, { staffId: 't' })).outcome).toBe('LOST');
  });

  it('FR-STL-001 treats equal dead-heat fractions as agreement', async () => {
    const { svc } = setup();
    const s = sel();
    await svc.recordResult(feed(s, 'DEAD_HEAT', 'feed:primary', 1, { numerator: 1, denominator: 2 }));
    const r = await svc.recordResult(feed(s, 'DEAD_HEAT', 'feed:secondary', 1, { numerator: 2, denominator: 4 }));
    expect(r.status).toBe('CONFIRMED');
  });

  it('FR-STL-001 rejects a changed result for the same source and version, and unknown sources', async () => {
    const { svc } = setup();
    const s = sel();
    await svc.recordResult(feed(s, 'WON', 'feed:primary'));
    await expect(svc.recordResult(feed(s, 'LOST', 'feed:primary'))).rejects.toMatchObject({ code: 'result_conflict', status: 409 });
    await expect(svc.recordResult({ ...feed(s, 'WON', 'feed:primary'), source: 'trader:x' })).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(svc.recordResult(feed(s, 'DEAD_HEAT', 'feed:secondary'))).rejects.toMatchObject({ code: 'invalid_result' });
  });

  it('FR-STL-001 confirms exactly once when both feeds arrive concurrently', async () => {
    const { svc } = setup();
    const ids = Array.from({ length: 10 }, sel);
    await Promise.all(ids.flatMap((s) => [
      svc.recordResult(feed(s, 'LOST', 'feed:primary')),
      svc.recordResult(feed(s, 'LOST', 'feed:secondary')),
    ]));
    const { rows } = await pool.query('SELECT selection_id FROM confirmed_results WHERE selection_id = ANY($1)', [ids]);
    expect(rows).toHaveLength(10);
  });
});

describe('settlement', () => {
  it('FR-STL-005 FR-STL-012 settles once with zero-sum lines and records versions and source', async () => {
    const { svc, bets, ledger } = setup();
    const [a, b] = [sel(), sel()];
    const bet = bets.add(makeBet({ legs: [[a, '2.00'], [b, '1.50']], unitStake: 1_000n }));
    const r1 = await confirm(svc, a, 'WON');
    expect((await svc.settleSelections([r1])).results).toEqual([{ betId: bet.betId, outcome: 'PENDING_RESULTS' }]);
    expect(ledger.entries.size).toBe(0);
    const r2 = await confirm(svc, b, 'WON');
    expect((await svc.settleSelections([r2])).results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);

    const posted = ledger.entries.get(`bet:${bet.betId}:settle:v1`)!.request;
    expect(posted.reason).toBe('BET_SETTLEMENT');
    expect(posted.lines.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
    expect(ledger.cash(bet.playerId)).toBe(3_000n);
    expect(ledger.op('BETS_OPEN')).toBe(-1_000n);
    expect(ledger.op('GGR')).toBe(-2_000n);
    expect(bets.bets.get(bet.betId)!.status).toBe('SETTLED');

    const [row] = await svc.settlementsFor(bet.betId);
    expect(row).toMatchObject({ version: 1, status: 'POSTED', grossReturn: 3_000n, tax: 0n, netReturn: 3_000n, source: 'AUTO', actor: null });
    expect(row!.legs.map((l) => [l.selectionId, l.outcome, l.resultVersion, l.resultSource])).toEqual([
      [a, 'WON', 1, 'feeds'], [b, 'WON', 1, 'feeds'],
    ]);

    // Re-running is a no-op (FR-STL-005).
    expect(await svc.settleBet(bet.betId)).toBe('UNCHANGED');
    await svc.settleSelections([r1, r2]);
    expect(ledger.entries.size).toBe(1);
    expect(await svc.settlementsFor(bet.betId)).toHaveLength(1);
  });

  it('FR-STL-005 concurrent settlement runs post one payout', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 500n }));
    const rid = await confirm(svc, s, 'WON');
    await Promise.all([
      ...Array.from({ length: 6 }, () => svc.settleBet(bet.betId)),
      ...Array.from({ length: 6 }, () => svc.settleSelections([rid])),
    ]);
    expect(ledger.entries.size).toBe(1);
    expect(ledger.cash(bet.playerId)).toBe(1_500n);
    expect(await svc.settlementsFor(bet.betId)).toHaveLength(1);
  });

  it('FR-STL-003 settles the SRS Appendix A treble with a void leg through the ledger', async () => {
    const { svc, bets, ledger } = setup();
    const [a, b, c] = [sel(), sel(), sel()];
    const bet = bets.add(makeBet({ legs: [[a, '1.80'], [b, '2.10'], [c, '1.50']], unitStake: 10_000n }));
    const ids = [await confirm(svc, a, 'WON'), await confirm(svc, b, 'VOID'), await confirm(svc, c, 'WON')];
    await svc.settleSelections(ids);
    expect(ledger.cash(bet.playerId)).toBe(27_000n);
    expect(ledger.op('GGR')).toBe(-17_000n);
  });

  it('FR-STL-007 voids a leg accepted after its cutoff, without waiting for its result', async () => {
    const { svc, bets, ledger } = setup();
    const [a, late] = [sel(), sel()];
    const bet = bets.add(makeBet({ legs: [[a, '2.00'], [late, '5.00']], unitStake: 1_000n, acceptedAt: new Date('2026-10-01T15:00:01Z') }));
    const rid = await confirm(svc, a, 'WON');
    const out = await svc.settleSelections([rid], { cutoffs: { [late]: new Date('2026-10-01T15:00:00Z') } });
    expect(out.results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);
    expect(ledger.cash(bet.playerId)).toBe(2_000n);
    const [row] = await svc.settlementsFor(bet.betId);
    expect(row!.legs[1]).toMatchObject({ selectionId: late, outcome: 'VOID', late: true, resultVersion: null });
  });

  it('FR-STL-007 a leg accepted exactly at the cutoff is not late', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const at = new Date('2026-10-01T15:00:00Z');
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 1_000n, acceptedAt: at }));
    await confirm(svc, s, 'LOST');
    expect(await svc.settleBet(bet.betId, { cutoffs: { [s]: at } })).toBe('SETTLED');
    expect(ledger.cash(bet.playerId)).toBe(0n);
    expect(ledger.op('GGR')).toBe(1_000n);
  });

  it('FR-STL-011 skips cashed-out bets', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add({ ...makeBet({ legs: [[s, '2.00']], unitStake: 1_000n }), status: 'CASHED_OUT' });
    await confirm(svc, s, 'WON');
    expect(await svc.settleBet(bet.betId)).toBe('SKIPPED_CASHED_OUT');
    expect(ledger.entries.size).toBe(0);
  });

  it('FR-STL-005 a PENDING intent left by a failed ledger call is re-posted unchanged, then resettled', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 1_000n }));
    await confirm(svc, s, 'WON');
    const realPost = ledger.post.bind(ledger);
    ledger.post = async () => { throw new AppError('unavailable', 503, 'ledger down'); };
    await expect(svc.settleBet(bet.betId)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await svc.settlementsFor(bet.betId))[0]!.status).toBe('PENDING');
    ledger.post = realPost;
    // The result is corrected before the retry: v1 still posts what it recorded, then v2 posts the difference.
    await confirm(svc, s, 'LOST', 2);
    expect(await svc.settleBet(bet.betId)).toBe('RESETTLED');
    const rows = await svc.settlementsFor(bet.betId);
    expect(rows.map((r) => [r.version, r.status, r.grossReturn, r.deltaNet])).toEqual([
      [1, 'POSTED', 2_000n, 2_000n], [2, 'POSTED', 0n, -2_000n],
    ]);
    expect(ledger.cash(bet.playerId)).toBe(0n);
    expect(ledger.op('GGR')).toBe(1_000n);
  });
});

describe('resettlement', () => {
  it('FR-STL-006 posts only the difference after a result correction', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 1_000n }));
    await svc.settleSelections([await confirm(svc, s, 'LOST')]);
    expect(ledger.cash(bet.playerId)).toBe(0n);
    const out = await svc.settleSelections([await confirm(svc, s, 'WON', 2)]);
    expect(out.results).toEqual([{ betId: bet.betId, outcome: 'RESETTLED' }]);
    const v2 = ledger.entries.get(`bet:${bet.betId}:settle:v2`)!.request;
    expect(v2.reason).toBe('BET_RESETTLEMENT');
    expect(v2.lines.map((l) => l.amount)).toEqual([2_000n, -2_000n]);
    expect(ledger.cash(bet.playerId)).toBe(2_000n);
    expect(ledger.op('GGR')).toBe(-1_000n);
    expect(ledger.op('BETS_OPEN')).toBe(-1_000n);
    expect(await svc.settleBet(bet.betId)).toBe('UNCHANGED');
  });

  it('FR-STL-006 queues a refused clawback for manual review without failing the batch', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const spent = bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 1_000n }));
    const kept = bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 1_000n }));
    await svc.settleSelections([await confirm(svc, s, 'WON')]);
    // The first player withdrew 2,500 of the 3,000 won.
    ledger.balances.set(`P:${spent.playerId}:CASH:XAF`, 500n);
    const out = await svc.settleSelections([await confirm(svc, s, 'LOST', 2)]);
    const byBet = Object.fromEntries(out.results.map((r) => [r.betId, r.outcome]));
    expect(byBet[spent.betId]).toBe('MANUAL_REVIEW');
    expect(byBet[kept.betId]).toBe('RESETTLED');
    expect(out.failed).toEqual([]);
    expect(ledger.cash(kept.playerId)).toBe(0n);
    expect(ledger.cash(spent.playerId)).toBe(500n);
    const review = (await svc.listManualReview()).filter((r) => r.betId === spent.betId);
    expect(review).toMatchObject([{ settlementVersion: 2, deltaNet: -3_000n, reason: 'insufficient_funds' }]);
    // Running again does not queue it twice.
    await svc.settleSelections([(await pool.query("SELECT result_id FROM confirmed_results WHERE selection_id = $1 AND result_version = 2", [s])).rows[0].result_id]);
    expect((await svc.listManualReview()).filter((r) => r.betId === spent.betId)).toHaveLength(1);
  });

  it('FR-STL-006 concurrent resettlement runs post the difference once', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '2.50']], unitStake: 2_000n }));
    await svc.settleSelections([await confirm(svc, s, 'WON')]);
    const rid = await confirm(svc, s, 'HALF_WON', 2);
    await Promise.all(Array.from({ length: 8 }, () => svc.settleSelections([rid])));
    expect(ledger.entries.size).toBe(2);
    // 2,000 x (1 + 2.5) / 2 = 3,500 after 5,000 was paid.
    expect(ledger.cash(bet.playerId)).toBe(3_500n);
    expect(await svc.settlementsFor(bet.betId)).toHaveLength(2);
  });
});

describe('winnings tax', () => {
  it('FR-STL-010 records gross, tax and net and posts the tax', async () => {
    const taxPolicy = (_j: string, stake: bigint, gross: bigint) => (gross > stake ? ((gross - stake) * 20n) / 100n : 0n);
    const { svc, bets, ledger } = setup({ taxPolicy, taxAccountKind: 'ADJUSTMENTS' });
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 1_000n }));
    await svc.settleSelections([await confirm(svc, s, 'WON')]);
    const [row] = await svc.settlementsFor(bet.betId);
    expect(row).toMatchObject({ grossReturn: 3_000n, tax: 400n, netReturn: 2_600n });
    expect(ledger.cash(bet.playerId)).toBe(2_600n);
    expect(ledger.op('ADJUSTMENTS')).toBe(400n);
    expect(ledger.op('GGR')).toBe(-2_000n);
    // A correction to LOST reverses gross, tax and net.
    ledger.balances.set(`P:${bet.playerId}:CASH:XAF`, 10_000n);
    await svc.settleSelections([await confirm(svc, s, 'LOST', 2)]);
    expect(ledger.op('ADJUSTMENTS')).toBe(0n);
    expect(ledger.cash(bet.playerId)).toBe(7_400n);
  });

  it('FR-STL-010 refuses to settle with tax due but no tax account configured', async () => {
    const { svc, bets, ledger } = setup({ taxPolicy: () => 1n });
    const s = sel();
    bets.add(makeBet({ legs: [[s, '3.00']], unitStake: 1_000n }));
    const out = await svc.settleSelections([await confirm(svc, s, 'WON')]);
    expect(out.failed.map((f) => f.code)).toEqual(['tax_account_missing']);
    expect(ledger.entries.size).toBe(0);
  });
});

describe('manual settle and void', () => {
  it('FR-STL-009 executes a small void immediately and records the trader', async () => {
    const { svc, bets, ledger } = setup();
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '4.00']], unitStake: 1_000n }));
    const action = await svc.requestManual({ action: 'VOID', reason: 'Match abandoned', results: [{ selectionId: s }] }, { staffId: 'tr-1' }, 'key-small-1');
    expect(action.status).toBe('EXECUTED');
    expect(action.settlement!.results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);
    expect(ledger.cash(bet.playerId)).toBe(1_000n);
    const [row] = await svc.settlementsFor(bet.betId);
    expect(row).toMatchObject({ source: 'MANUAL', actor: 'tr-1' });
    expect(row!.legs[0]).toMatchObject({ outcome: 'VOID', resultSource: 'trader:tr-1' });
    // Idempotent by key.
    const again = await svc.requestManual({ action: 'VOID', reason: 'Match abandoned', results: [{ selectionId: s }] }, { staffId: 'tr-1' }, 'key-small-1');
    expect(again.actionId).toBe(action.actionId);
    expect(ledger.entries.size).toBe(1);
    await expect(svc.requestManual({ action: 'VOID', reason: 'Other reason', results: [{ selectionId: s }] }, { staffId: 'tr-1' }, 'key-small-1'))
      .rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
  });

  it('FR-STL-009 needs a different second approver above the threshold', async () => {
    const { svc, bets, ledger } = setup({ approvalThresholds: { XAF: 5_000n } });
    const s = sel();
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 6_000n }));
    await svc.settleSelections([await confirm(svc, s, 'LOST')]);
    const action = await svc.requestManual(
      { action: 'SETTLE', reason: 'Feed graded wrong side', results: [{ selectionId: s, outcome: 'WON' }] },
      { staffId: 'tr-1' }, 'key-big-1',
    );
    expect(action.status).toBe('PENDING_APPROVAL');
    expect(action.affectedStake).toEqual([{ currency: 'XAF', amount: 6_000n }]);
    expect(ledger.entries.size).toBe(1);
    await expect(svc.approveManual(action.actionId, { staffId: 'tr-1' })).rejects.toMatchObject({ code: 'four_eyes_required', status: 403 });

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => svc.approveManual(action.actionId, { staffId: 'tr-2' })));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await expect(svc.approveManual(action.actionId, { staffId: 'tr-3' })).rejects.toMatchObject({ code: 'already_executed' });
    expect(ledger.cash(bet.playerId)).toBe(12_000n);
    expect(ledger.entries.size).toBe(2);
    const { rows } = await pool.query('SELECT result_version, confirmed_by FROM confirmed_results WHERE selection_id = $1 ORDER BY result_version', [s]);
    expect(rows).toEqual([{ result_version: 1, confirmed_by: 'feeds' }, { result_version: 2, confirmed_by: 'trader:tr-1' }]);
    const audit = await pool.query('SELECT actor, action FROM staff_audit WHERE target = $1 ORDER BY seq', [`manual_action:${action.actionId}`]);
    expect(audit.rows).toEqual([
      { actor: 'tr-1', action: 'MANUAL_SETTLE_REQUEST' },
      { actor: 'tr-2', action: 'MANUAL_SETTLE_APPROVE' },
    ]);
  });

  it('FR-STL-009 requires a reason and an outcome for SETTLE', async () => {
    const { svc } = setup();
    await expect(svc.requestManual({ action: 'VOID', reason: ' ', results: [{ selectionId: sel() }] }, { staffId: 't' }, 'key-r-1'))
      .rejects.toMatchObject({ code: 'reason_required' });
    await expect(svc.requestManual({ action: 'SETTLE', reason: 'x', results: [{ selectionId: sel() }] }, { staffId: 't' }, 'key-r-2'))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('staff audit', () => {
  it('SEC-LOG-002 is append-only and hash-chained', async () => {
    const { svc } = setup();
    const s = sel();
    await svc.recordResult(feed(s, 'LOST', 'feed:primary'));
    await svc.confirmResult({ selectionId: s, resultVersion: 1, outcome: 'LOST' }, { staffId: 'a1', ip: '10.0.0.1' });
    await expect(pool.query("UPDATE staff_audit SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM staff_audit')).rejects.toThrow(/append-only/);
    const { rows } = await pool.query<{ prev_hash: string; hash: string }>('SELECT prev_hash, hash FROM staff_audit ORDER BY seq');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r, i) => expect(r.prev_hash).toBe(i === 0 ? '' : rows[i - 1]!.hash));
  });
});
