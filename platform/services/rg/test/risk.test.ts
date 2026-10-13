import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, setup, type Harness } from './helpers.js';
import { nextRealityCheck, riskLevel, scoreMarkers, type RiskMarkers } from '../src/index.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

const staff = { staffId: 'carol', ip: '10.0.0.1' };

const zero: RiskMarkers = {
  deposits24h: 0,
  declinedDeposits7d: 0,
  lossChasing30d: 0,
  nightStakes30d: 0,
  limitIncreases30d: 0,
  withdrawalCancels30d: 0,
  stakes7d: 0,
  stakeSum7d: 0n,
  stakesPrior: 0,
  stakeSumPrior: 0n,
  sessionMinutes7d: 0,
};

describe('harm-risk score', () => {
  it('FR-RG-010 the score is deterministic, weighted and clamped to 0..100', () => {
    expect(scoreMarkers(zero)).toBe(0);
    expect(scoreMarkers({ ...zero, deposits24h: 3 })).toBe(8);
    expect(scoreMarkers({ ...zero, declinedDeposits7d: 10 })).toBe(20);
    expect(scoreMarkers({ ...zero, stakes7d: 3, stakeSum7d: 450n, stakesPrior: 3, stakeSumPrior: 300n })).toBe(5);
    const max: RiskMarkers = {
      deposits24h: 9, declinedDeposits7d: 9, lossChasing30d: 9, nightStakes30d: 99, limitIncreases30d: 9,
      withdrawalCancels30d: 9, stakes7d: 9, stakeSum7d: 9_000n, stakesPrior: 9, stakeSumPrior: 900n, sessionMinutes7d: 9_999,
    };
    expect(scoreMarkers(max)).toBe(100);
    expect([riskLevel(29), riskLevel(30), riskLevel(55)]).toEqual(['LOW', 'MEDIUM', 'HIGH']);
  });

  it('FR-RG-010 FR-RG-011 markers come from activity and thresholds open interventions once', async () => {
    const p = h.addPlayer();
    const t = h.clock.now(); // 2026-03-02T12:00Z, 13:00 local in CM (UTC+1)
    const ago = (ms: number) => new Date(t.getTime() - ms);
    // Rising stakes: 3 x 100 three weeks ago, 3 x 300 at night (00:30 local) yesterday.
    for (let i = 0; i < 3; i++) await h.rg.recordStake(p, 'XAF', 100n, `old-${i}`, ago(20 * DAY + i * MIN));
    for (let i = 0; i < 3; i++) await h.rg.recordStake(p, 'XAF', 300n, `night-${i}`, new Date(`2026-03-01T23:3${i}:00Z`));
    // A loss, then a deposit 15 minutes later (chasing), plus four more deposits today: 5 in 24 h.
    await h.rg.recordSettlement(p, 'XAF', 300n, 0n, 'night-0', ago(2 * HOUR));
    await h.rg.recordDeposit(p, 'XAF', 1_000n, 'chase', ago(2 * HOUR - 15 * MIN));
    for (let i = 0; i < 4; i++) await h.rg.recordDeposit(p, 'XAF', 1_000n, `dep-${i}`, ago(HOUR - i * MIN));
    await h.rg.recordDepositDeclined(p, 'XAF', 1_000n, 'decl-1', ago(DAY));
    await h.rg.recordDepositDeclined(p, 'XAF', 1_000n, 'decl-2', ago(DAY));
    await h.rg.recordWithdrawal(p, 'XAF', 500n, 'w1', ago(3 * DAY));
    await h.rg.recordWithdrawalCancelled(p, 'XAF', 500n, 'w1', ago(3 * DAY - HOUR));
    await h.rg.setLimit(p, 'DEPOSIT_DAY', 5_000n);
    await h.rg.setLimit(p, 'DEPOSIT_DAY', 50_000n); // increase request

    const a = await h.rg.scoreRisk(p);
    expect(a.points).toEqual({
      depositVelocity: 15,
      declinedDeposits: 8,
      lossChasing: 5,
      nightPlay: 5,
      limitIncreases: 5,
      withdrawalCancels: 5,
      risingStakes: 10,
      timeOnSite: 0,
    });
    expect(a.score).toBe(53);
    expect(a.level).toBe('MEDIUM');
    expect(a.interventionsCreated).toEqual(['MESSAGE', 'QUESTIONNAIRE']);
    expect(await h.rg.canMarketTo(p)).toBe(true);

    // Rescoring does not duplicate open interventions.
    expect((await h.rg.scoreRisk(p)).interventionsCreated).toEqual([]);

    // One more declined deposit: HIGH.
    await h.rg.recordDepositDeclined(p, 'XAF', 1_000n, 'decl-3', ago(MIN));
    const b = await h.rg.scoreRisk(p);
    expect(b.score).toBe(57);
    expect(b.level).toBe('HIGH');
    expect(b.interventionsCreated).toEqual(['CALL_TASK']);
    expect(await h.rg.canMarketTo(p)).toBe(false); // FR-RG-016

    const risk = await h.rg.getRisk(p);
    expect(risk.latest).toMatchObject({ score: 57, level: 'HIGH' });
    expect(risk.interventions.map((i) => i.type).sort()).toEqual(['CALL_TASK', 'MESSAGE', 'QUESTIONNAIRE']);
    expect(await h.rg.scoreAll()).toBeGreaterThanOrEqual(1);
  });

  it('FR-RG-011 deposit cap and suspension block until the outcome is recorded', async () => {
    const p = h.addPlayer();
    const cap = await h.rg.createIntervention(p, 'DEPOSIT_CAP', staff, 'Rapid deposits after losses');
    expect(await h.rg.checkDeposit(p, 'XAF', 100n, h.clock.now())).toMatchObject({ allowed: false, code: 'deposit_capped' });
    expect(await h.rg.checkStake(p, 'XAF', 100n, h.clock.now())).toEqual({ allowed: true });
    await expect(h.rg.createIntervention(p, 'DEPOSIT_CAP', staff, 'again')).rejects.toMatchObject({ code: 'intervention_open' });
    const closed = await h.rg.recordInterventionOutcome(cap.id, 'LIFTED', staff, 'Affordability evidence received');
    expect(closed).toMatchObject({ outcome: 'LIFTED', outcomeBy: 'carol' });
    await expect(h.rg.recordInterventionOutcome(cap.id, 'COMPLETED', staff, 'twice')).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.rg.checkDeposit(p, 'XAF', 100n, h.clock.now())).toEqual({ allowed: true });

    await h.rg.createIntervention(p, 'SUSPEND', staff, 'Call outcome: harm indicated');
    expect(await h.rg.checkStake(p, 'XAF', 100n, h.clock.now())).toMatchObject({ code: 'rg_suspended' });
    expect(await h.rg.canMarketTo(p)).toBe(false);
    const audit = await h.pool.query<{ action: string; ip: string }>(`SELECT action, ip FROM audit_log WHERE subject LIKE $1 OR subject LIKE 'intervention:%' ORDER BY id`, [`player:${p}`]);
    expect(audit.rows.map((r) => r.action)).toEqual(['INTERVENTION_CREATED', 'INTERVENTION_OUTCOME', 'INTERVENTION_CREATED']);
    expect(audit.rows[0]!.ip).toBe('10.0.0.1');
    expect(await h.rg.verifyAuditChain()).toBe(true);
  });
});

describe('reality check', () => {
  it('FR-RG-008 computes the next check from session start or last acknowledgement', () => {
    const start = new Date('2026-01-01T10:00:00Z');
    expect(nextRealityCheck(start, null, { intervalMinutes: 60 })).toEqual(new Date('2026-01-01T11:00:00Z'));
    expect(nextRealityCheck(start, new Date('2026-01-01T11:05:00Z'), { intervalMinutes: 15 })).toEqual(
      new Date('2026-01-01T11:20:00Z'),
    );
  });

  it('FR-RG-008 shows session duration and net result and requires acknowledgement', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    const s = await h.rg.startSession(p, t);
    await h.rg.recordStake(p, 'XAF', 1_000n, 'rc-1', new Date(t.getTime() + 10 * MIN));
    await h.rg.recordSettlement(p, 'XAF', 1_000n, 2_500n, 'rc-1', new Date(t.getTime() + 20 * MIN));
    let v = await h.rg.realityCheck(p, s, new Date(t.getTime() + 59 * MIN));
    expect(v).toMatchObject({ sessionMinutes: 59, netResult: 1_500n, intervalMinutes: 60, due: false });
    v = await h.rg.realityCheck(p, s, new Date(t.getTime() + 60 * MIN));
    expect(v.due).toBe(true);
    await h.rg.acknowledgeRealityCheck(p, s, new Date(t.getTime() + 61 * MIN));
    await h.rg.setRealityCheckInterval(p, 15);
    v = await h.rg.realityCheck(p, s, new Date(t.getTime() + 70 * MIN));
    expect(v).toMatchObject({ due: false, intervalMinutes: 15, nextAt: new Date(t.getTime() + 76 * MIN) });
    await expect(h.rg.setRealityCheckInterval(p, 10)).rejects.toMatchObject({ code: 'invalid_interval' });
    await expect(h.rg.acknowledgeRealityCheck(h.addPlayer(), s, t)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('affordability and payment rules', () => {
  it('FR-RG-012 net deposits above the threshold open a case and cap deposits until resolved', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 300_000n, 'a1', t)).toEqual({ allowed: true });
    await h.rg.recordWithdrawal(p, 'XAF', 50_000n, 'aw1', t);
    // Net 250,000; 78,000 more reaches exactly 328,000, which is allowed.
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 78_000n, 'a2', t)).toEqual({ allowed: true });
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 1n, 'a3', t)).toMatchObject({ code: 'affordability_check_required' });
    expect(await h.rg.checkDeposit(p, 'XAF', 1n, t)).toMatchObject({ code: 'affordability_check_pending' });
    const open = await h.rg.openAffordabilityCase(p);
    expect(open).toMatchObject({ netDeposits: 328_001n, threshold: 328_000n, status: 'OPEN' });

    await expect(h.rg.resolveAffordability(open!.id, 1_000_000n, 'EUR', staff, 'wrong currency')).rejects.toMatchObject({ code: 'not_found' });
    await h.rg.resolveAffordability(open!.id, 1_000_000n, 'XAF', staff, 'Payslips verified');
    expect(await h.rg.checkAndRecordDeposit(p, 'XAF', 100_000n, 'a4', t)).toEqual({ allowed: true });
    expect(await h.rg.checkDeposit(p, 'XAF', 600_000n, t)).toMatchObject({ code: 'affordability_check_required' });
  });

  it('FR-RG-012 parallel deposits cannot slip past the affordability threshold', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.rg.checkAndRecordDeposit(p, 'XAF', 100_000n, `par-${i}`, t)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('FR-RG-013 FR-RG-014 credit cards and withdrawal reversal follow the rules set', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    expect(await h.rg.checkPaymentMethod(p, 'CREDIT_CARD', t)).toMatchObject({ allowed: false, code: 'credit_card_banned' });
    expect(await h.rg.checkPaymentMethod(p, 'MOBILE_MONEY', t)).toEqual({ allowed: true });
    expect(await h.rg.checkWithdrawalReversal(p, t)).toMatchObject({ allowed: false, code: 'withdrawal_reversal_blocked' });
  });
});
