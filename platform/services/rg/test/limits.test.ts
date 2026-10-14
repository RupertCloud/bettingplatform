import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

describe('limits', () => {
  it('FR-RG-003 a decrease applies at once; an increase waits for cooling-off and re-confirmation', async () => {
    const p = h.addPlayer();
    expect(await h.rg.setLimit(p, 'DEPOSIT_DAY', 10_000n)).toEqual({ status: 'APPLIED' });
    expect(await h.rg.setLimit(p, 'DEPOSIT_DAY', 5_000n)).toEqual({ status: 'APPLIED' });

    const inc = await h.rg.setLimit(p, 'DEPOSIT_DAY', 20_000n);
    expect(inc).toEqual({ status: 'PENDING', availableAt: new Date(h.clock.now().getTime() + 24 * HOUR) });
    let view = (await h.rg.getLimits(p)).find((l) => l.kind === 'DEPOSIT_DAY')!;
    expect(view.value).toBe(5_000n);
    expect(view.pending?.value).toBe(20_000n);

    // Still old limit while pending.
    expect(await h.rg.checkDeposit(p, 'XAF', 6_000n, h.clock.now())).toMatchObject({ allowed: false, code: 'deposit_limit_exceeded' });
    await expect(h.rg.confirmLimit(p, 'DEPOSIT_DAY')).rejects.toMatchObject({ code: 'cooling_off_active', status: 409 });

    h.clock.advance(24 * HOUR);
    // Cooling-off over, but nothing changes without the player's confirmation.
    expect((await h.rg.getLimits(p)).find((l) => l.kind === 'DEPOSIT_DAY')!.value).toBe(5_000n);
    expect(await h.rg.confirmLimit(p, 'DEPOSIT_DAY')).toEqual({ kind: 'DEPOSIT_DAY', value: 20_000n });
    view = (await h.rg.getLimits(p)).find((l) => l.kind === 'DEPOSIT_DAY')!;
    expect(view).toEqual({ kind: 'DEPOSIT_DAY', value: 20_000n, pending: null });
  });

  it('FR-RG-003 removal is pending too, and a later decrease supersedes a pending increase', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'LOSS_WEEK', 50_000n);
    expect((await h.rg.setLimit(p, 'LOSS_WEEK', null)).status).toBe('PENDING');
    expect((await h.rg.setLimit(p, 'LOSS_WEEK', 40_000n)).status).toBe('APPLIED');
    h.clock.advance(25 * HOUR);
    await expect(h.rg.confirmLimit(p, 'LOSS_WEEK')).rejects.toMatchObject({ code: 'no_pending_change' });

    expect((await h.rg.setLimit(p, 'LOSS_WEEK', null)).status).toBe('PENDING');
    h.clock.advance(24 * HOUR);
    await h.rg.confirmLimit(p, 'LOSS_WEEK');
    expect((await h.rg.getLimits(p)).find((l) => l.kind === 'LOSS_WEEK')!.value).toBeNull();
  });

  it('FR-RG-001 deposit limits use rolling day, week and month windows; declined deposits do not count', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'DEPOSIT_DAY', 10_000n);
    await h.rg.setLimit(p, 'DEPOSIT_WEEK', 25_000n);
    const t = h.clock.now();
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 8_000n, 'd1', t)).toEqual({ allowed: true });
    expect(await h.rg.checkDeposit(p, 'XAF', 2_001n, t)).toMatchObject({ allowed: false, code: 'deposit_limit_exceeded' });
    expect(await h.rg.checkDeposit(p, 'XAF', 2_000n, t)).toEqual({ allowed: true });
    // PSP declined d1: it no longer counts.
    await h.rg.recordDepositDeclined(p, 'XAF', 8_000n, 'd1', t);
    expect(await h.rg.checkDeposit(p, 'XAF', 10_000n, t)).toEqual({ allowed: true });
    // The declined ref cannot be replayed to slip a deposit past the limits.
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 8_000n, 'd1', t)).toMatchObject({ code: 'reference_declined' });

    await h.rg.recordDeposit(p, 'XAF', 10_000n, 'd2', t);
    const nextDay = new Date(t.getTime() + DAY + MIN);
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 10_000n, 'd3', nextDay)).toEqual({ allowed: true });
    // Week: 20,000 used, 5,000 left.
    const day3 = new Date(t.getTime() + 2 * DAY + 2 * MIN);
    expect(await h.rg.checkDeposit(p, 'XAF', 6_000n, day3)).toMatchObject({ allowed: false, detail: expect.stringContaining('week') });
  });

  it('FR-RG-002 stake per bet, stake per day and loss limits including this stake', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'STAKE_PER_BET', 5_000n);
    await h.rg.setLimit(p, 'STAKE_DAY', 12_000n);
    await h.rg.setLimit(p, 'LOSS_DAY', 8_000n);
    const t = h.clock.now();
    expect(await h.rg.checkStake(p, 'XAF', 5_001n, t)).toMatchObject({ allowed: false, code: 'stake_limit_exceeded' });
    expect(await h.rg.checkAndRecordStake(p, 'XAF', 5_000n, 'b1', t)).toEqual({ allowed: true });
    // 5,000 staked (counted as lost while open); 3,001 more would breach the 8,000 loss limit.
    expect(await h.rg.checkStake(p, 'XAF', 3_001n, t)).toMatchObject({ allowed: false, code: 'loss_limit_exceeded' });
    // b1 wins 9,000: net loss is now -4,000.
    await h.rg.recordSettlement(p, 'XAF', 5_000n, 9_000n, 'b1', t);
    expect(await h.rg.checkAndRecordStake(p, 'XAF', 5_000n, 'b2', t)).toEqual({ allowed: true });
    // Stake per day: 10,000 used.
    expect(await h.rg.checkStake(p, 'XAF', 2_001n, t)).toMatchObject({ allowed: false, code: 'stake_limit_exceeded' });
    expect(await h.rg.checkStake(p, 'XAF', 2_000n, t)).toEqual({ allowed: true });
  });

  it('FR-RG-002 a released stake stops counting and its ref cannot be reused', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'STAKE_DAY', 10_000n);
    const t = h.clock.now();
    expect(await h.rg.checkAndRecordStake(p, 'XAF', 8_000n, 'r1', t)).toEqual({ allowed: true });
    expect(await h.rg.checkStake(p, 'XAF', 8_000n, t)).toMatchObject({ allowed: false, code: 'stake_limit_exceeded' });
    // The bet was refused after recording (e.g. insufficient funds): the stake was never taken.
    await h.rg.releaseStake(p, 'XAF', 8_000n, 'r1', t);
    expect(await h.rg.checkStake(p, 'XAF', 8_000n, t)).toEqual({ allowed: true });
    expect(await h.rg.checkAndRecordStake(p, 'XAF', 8_000n, 'r1', t)).toMatchObject({ code: 'reference_declined' });
    // Releasing twice is a no-op.
    await h.rg.releaseStake(p, 'XAF', 8_000n, 'r1', t);
    expect(await h.rg.checkAndRecordStake(p, 'XAF', 10_000n, 'r2', t)).toEqual({ allowed: true });
  });

  it('FR-RG-002 session time limit blocks stakes once reached', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'SESSION_MINUTES', 30n);
    const start = h.clock.now();
    await h.rg.startSession(p, start);
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(start.getTime() + 29 * MIN))).toEqual({ allowed: true });
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(start.getTime() + 30 * MIN))).toMatchObject({
      code: 'session_limit_reached',
    });
    await h.rg.startSession(p, new Date(start.getTime() + 2 * HOUR));
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(start.getTime() + 2 * HOUR + MIN))).toEqual({ allowed: true });
  });

  it('FR-RG-002 parallel bets cannot both pass a stake limit', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'STAKE_DAY', 1_000n);
    const t = h.clock.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => h.rg.checkAndRecordStake(p, 'XAF', 200n, `bet-${i}`, t)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const sum = await h.pool.query<{ s: bigint }>(
      `SELECT SUM(amount)::bigint AS s FROM activity WHERE player_id = $1 AND kind = 'STAKE'`,
      [p],
    );
    expect(sum.rows[0]!.s).toBe(1_000n);
  });

  it('FR-RG-001 parallel deposits cannot both pass a deposit limit, and replays are not counted twice', async () => {
    const p = h.addPlayer();
    await h.rg.setLimit(p, 'DEPOSIT_DAY', 3_000n);
    const t = h.clock.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => h.rg.checkAndRecordDeposit(p, 'XAF', 1_000n, `dep-${i % 4}`, t)),
    );
    expect(results.every((r) => r.allowed === true || r.code === 'deposit_limit_exceeded')).toBe(true);
    const rows = await h.pool.query<{ n: bigint }>(`SELECT COUNT(*) AS n FROM activity WHERE player_id = $1 AND kind = 'DEPOSIT'`, [p]);
    expect(rows.rows[0]!.n).toBe(3n);
    // A replay of an accepted ref is allowed without counting again.
    const accepted = await h.pool.query<{ ref: string }>(`SELECT ref FROM activity WHERE player_id = $1 AND kind = 'DEPOSIT' LIMIT 1`, [p]);
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 1_000n, accepted.rows[0]!.ref, t)).toEqual({ allowed: true });
  });

  it('FR-RG-002 denies unknown players, wrong currency and non-positive amounts', async () => {
    const p = h.addPlayer('XAF');
    expect(await h.rg.checkStake('00000000-0000-4000-8000-000000000000', 'XAF', 1n, h.clock.now())).toMatchObject({ code: 'unknown_player' });
    expect(await h.rg.checkStake(p, 'EUR', 1n, h.clock.now())).toMatchObject({ code: 'currency_mismatch' });
    await expect(h.rg.checkStake(p, 'XAF', 0n, h.clock.now())).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(h.rg.setLimit(p, 'STAKE_DAY', -1n)).rejects.toMatchObject({ code: 'invalid_amount' });
  });
});
