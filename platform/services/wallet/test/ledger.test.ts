import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, testDb, type AccountRef, type Pool, type PostingRequest } from '@bp/common';
import { MIGRATIONS_DIR, Wallet } from '../src/index.js';

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let wallet: Wallet;
const NOW = new Date('2026-10-01T12:00:00Z');

beforeAll(async () => {
  db = await testDb('wallet', MIGRATIONS_DIR);
  pool = db.pool;
  wallet = new Wallet(pool, { now: () => NOW, adjustmentThresholds: { XAF: 100_000n } });
});
afterAll(async () => {
  await db.drop();
});

const cash = (playerId: string): AccountRef => ({ owner: 'PLAYER', playerId, kind: 'CASH', currency: 'XAF' });
const op = (kind: 'PSP_CLEARING' | 'BETS_OPEN' | 'ADJUSTMENTS'): AccountRef => ({ owner: 'OPERATOR', kind, currency: 'XAF' });

const deposit = (playerId: string, amount: bigint, key = randomUUID()): PostingRequest => ({
  idempotencyKey: key,
  reason: 'DEPOSIT',
  reference: `psp-${key}`,
  lines: [
    { account: cash(playerId), amount },
    { account: op('PSP_CLEARING'), amount: -amount },
  ],
});

const stake = (playerId: string, amount: bigint, key = randomUUID()): PostingRequest => ({
  idempotencyKey: key,
  reason: 'BET_STAKE',
  reference: `bet-${key}`,
  lines: [
    { account: cash(playerId), amount: -amount },
    { account: op('BETS_OPEN'), amount },
  ],
});

const expectCode = async (p: Promise<unknown>, code: string, status: number): Promise<void> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(status);
};

describe('posting', () => {
  it('FR-WAL-001 posts a balanced entry and updates projections', async () => {
    const p = randomUUID();
    const entry = await wallet.post(deposit(p, 5_000n));
    expect(entry.replayed).toBe(false);
    expect(entry.postedAt).toEqual(NOW);
    expect(await wallet.balance(cash(p))).toBe(5_000n);
    expect(await wallet.playerBalances(p, 'XAF')).toEqual({ CASH: 5_000n, BONUS: 0n, PENDING_WITHDRAWAL: 0n });
  });

  it('FR-WAL-001 rejects empty, zero-amount and unbalanced postings', async () => {
    const p = randomUUID();
    await expectCode(wallet.post({ ...deposit(p, 1n), lines: [] }), 'invalid_posting', 400);
    await expectCode(
      wallet.post({ ...deposit(p, 1n), lines: [{ account: cash(p), amount: 0n }] }),
      'invalid_posting',
      400,
    );
    await expectCode(
      wallet.post({ ...deposit(p, 1n), lines: [{ account: cash(p), amount: 10n }, { account: op('PSP_CLEARING'), amount: -9n }] }),
      'invalid_posting',
      400,
    );
    // Balanced in total but not per currency.
    await expectCode(
      wallet.post({
        ...deposit(p, 1n),
        lines: [
          { account: cash(p), amount: 10n },
          { account: { owner: 'OPERATOR', kind: 'PSP_CLEARING', currency: 'EUR' }, amount: -10n },
        ],
      }),
      'invalid_posting',
      400,
    );
    expect(await wallet.balance(cash(p))).toBe(0n);
  });

  it('FR-WAL-004 rejects a posting that would make cash negative', async () => {
    const p = randomUUID();
    await wallet.post(deposit(p, 100n));
    await expectCode(wallet.post(stake(p, 101n)), 'insufficient_funds', 422);
    expect(await wallet.balance(cash(p))).toBe(100n);
    // A rejected key is not consumed.
    const key = randomUUID();
    await expectCode(wallet.post(stake(p, 500n, key)), 'insufficient_funds', 422);
    await wallet.post(deposit(p, 400n));
    expect((await wallet.post(stake(p, 500n, key))).replayed).toBe(false);
    expect(await wallet.balance(cash(p))).toBe(0n);
  });

  it('FR-WAL-004 50 concurrent 100-unit stakes from 1,000 give exactly 10 successes', async () => {
    const p = randomUUID();
    await wallet.post(deposit(p, 1_000n));
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => wallet.post(stake(p, 100n))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(40);
    for (const f of failed) expect((f.reason as AppError).code).toBe('insufficient_funds');
    expect(await wallet.balance(cash(p))).toBe(0n);
  });
});

describe('idempotency', () => {
  it('FR-WAL-003 replays the same key and payload without posting twice', async () => {
    const p = randomUUID();
    const req = deposit(p, 700n);
    const first = await wallet.post(req);
    const again = await wallet.post(req);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await wallet.balance(cash(p))).toBe(700n);
  });

  it('FR-WAL-003 rejects the same key with a different payload', async () => {
    const p = randomUUID();
    const req = deposit(p, 700n);
    await wallet.post(req);
    await expectCode(wallet.post({ ...req, lines: deposit(p, 701n).lines }), 'idempotency_conflict', 409);
    await expectCode(wallet.post({ ...req, reference: 'other' }), 'idempotency_conflict', 409);
    expect(await wallet.balance(cash(p))).toBe(700n);
  });

  it('FR-WAL-003 concurrent posts with the same new key yield exactly one entry', async () => {
    const p = randomUUID();
    const req = deposit(p, 250n);
    const results = await Promise.all(Array.from({ length: 20 }, () => wallet.post(req)));
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await wallet.balance(cash(p))).toBe(250n);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM entries WHERE idempotency_key = $1', [req.idempotencyKey]);
    expect(rows[0].n).toBe(1);
  });
});

describe('immutability and reversal', () => {
  it('FR-WAL-007 database triggers block UPDATE and DELETE of entries and lines', async () => {
    const p = randomUUID();
    const e = await wallet.post(deposit(p, 10n));
    await expect(pool.query(`UPDATE entries SET reference = 'x' WHERE id = $1`, [e.entryId])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM entries WHERE id = $1', [e.entryId])).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE entry_lines SET amount = amount * 2 WHERE entry_id = $1', [e.entryId])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM entry_lines WHERE entry_id = $1', [e.entryId])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE entry_lines CASCADE')).rejects.toThrow(/append-only/);
  });

  it('FR-WAL-007 reverse posts negated lines as REVERSAL, once', async () => {
    const p = randomUUID();
    const e = await wallet.post(deposit(p, 300n));
    const key = randomUUID();
    const r = await wallet.reverse(e.entryId, key, 'staff-1', 'Duplicate PSP callback');
    expect(r.reason).toBe('REVERSAL');
    expect(r.reference).toBe(e.entryId);
    expect(await wallet.balance(cash(p))).toBe(0n);
    expect((await wallet.reverse(e.entryId, key, 'staff-1', 'Duplicate PSP callback')).replayed).toBe(true);
    await expectCode(wallet.reverse(e.entryId, randomUUID(), 'staff-1', 'again'), 'already_reversed', 409);
    const { rows } = await pool.query('SELECT actor, note FROM entries WHERE id = $1', [r.entryId]);
    expect(rows[0]).toEqual({ actor: 'staff-1', note: 'Duplicate PSP callback' });
    expect(await wallet.balance(cash(p))).toBe(0n);
  });

  it('FR-WAL-007 a reversal that would make cash negative is rejected', async () => {
    const p = randomUUID();
    const e = await wallet.post(deposit(p, 300n));
    await wallet.post(stake(p, 200n));
    await expectCode(wallet.reverse(e.entryId, randomUUID(), 'staff-1', 'chargeback'), 'insufficient_funds', 422);
    await expectCode(wallet.reverse(randomUUID(), randomUUID(), 'staff-1', 'x'), 'not_found', 404);
  });
});

describe('manual adjustments', () => {
  const adj = (playerId: string, amount: bigint, requestedBy = 'staff-a') =>
    wallet.requestAdjustment({ playerId, kind: 'CASH', currency: 'XAF', amount, reasonText: 'Goodwill credit', requestedBy });

  it('FR-WAL-011 below the threshold the requester may approve; posts against ADJUSTMENTS', async () => {
    const p = randomUUID();
    const id = await adj(p, 100_000n);
    expect(await wallet.balance(cash(p))).toBe(0n); // pending until approved
    const e = await wallet.approve(id, 'staff-a');
    expect(e.reason).toBe('ADJUSTMENT');
    expect(await wallet.balance(cash(p))).toBe(100_000n);
    expect((await wallet.approve(id, 'staff-a')).replayed).toBe(true);
    await expectCode(wallet.approve(id, 'staff-b'), 'already_approved', 409);
    expect(await wallet.balance(cash(p))).toBe(100_000n);
  });

  it('FR-WAL-011 above the threshold needs a second approver (four-eyes)', async () => {
    const p = randomUUID();
    const id = await adj(p, 100_001n);
    await expectCode(wallet.approve(id, 'staff-a'), 'four_eyes_required', 403);
    expect(await wallet.balance(cash(p))).toBe(0n);
    await wallet.approve(id, 'staff-b');
    expect(await wallet.balance(cash(p))).toBe(100_001n);
    const { rows } = await pool.query('SELECT approved_by FROM adjustment_approvals WHERE request_id = $1', [id]);
    expect(rows[0].approved_by).toBe('staff-b');
  });

  it('FR-WAL-011 concurrent approvals post once; requests need a reason; audit is append-only', async () => {
    const p = randomUUID();
    const id = await adj(p, 500n);
    const results = await Promise.all([wallet.approve(id, 'staff-b'), wallet.approve(id, 'staff-b'), wallet.approve(id, 'staff-b')]);
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(await wallet.balance(cash(p))).toBe(500n);
    await expectCode(
      wallet.requestAdjustment({ playerId: p, kind: 'CASH', currency: 'XAF', amount: 1n, reasonText: '', requestedBy: 'x' }),
      'invalid_posting',
      400,
    );
    await expect(pool.query(`UPDATE adjustment_requests SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM adjustment_approvals WHERE request_id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('FR-WAL-011 a debit adjustment cannot overdraw the player', async () => {
    const p = randomUUID();
    const id = await adj(p, -10n);
    await expectCode(wallet.approve(id, 'staff-b'), 'insufficient_funds', 422);
  });
});

describe('reconciliation', () => {
  it('FR-WAL-008 NFR-DI-001 reports a clean ledger, then finds a tampered projection', async () => {
    const p = randomUUID();
    await wallet.post(deposit(p, 900n));
    expect(await wallet.reconcile()).toEqual({ mismatches: [], unbalancedEntries: [], allEntriesBalanced: true, ok: true });

    await pool.query(`UPDATE accounts SET balance = balance + 5 WHERE owner = 'PLAYER' AND player_id = $1 AND kind = 'CASH'`, [p]);
    const report = await wallet.reconcile();
    expect(report.ok).toBe(false);
    expect(report.allEntriesBalanced).toBe(true);
    expect(report.mismatches).toEqual([{ account: cash(p), projection: 905n, ledger: 900n }]);
  });
});
