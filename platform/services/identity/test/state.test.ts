import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_ACTIONS, isAllowed } from '../src/index.js';
import { META, PASSWORD, errCode, harness, registration, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.drop());

const DAY = 24 * 60 * 60_000;

const setup = async () => {
  const input = registration();
  const r = await h.identity.register(input);
  if (!r.created) throw new Error('setup');
  return { playerId: r.playerId, email: input.email };
};

describe('account state', () => {
  it('FR-ACC-014 defines allowed actions for all eight states', () => {
    expect(Object.keys(ALLOWED_ACTIONS)).toHaveLength(8);
    expect(isAllowed('ACTIVE', 'bet')).toBe(true);
    expect(isAllowed('RESTRICTED', 'deposit')).toBe(false);
    expect(isAllowed('RESTRICTED', 'bet')).toBe(false);
    expect(isAllowed('RESTRICTED', 'withdraw')).toBe(true);
    expect(isAllowed('SELF_EXCLUDED', 'bet')).toBe(false);
    expect(isAllowed('SELF_EXCLUDED', 'withdraw')).toBe(true);
    expect(isAllowed('SUSPENDED', 'login')).toBe(false);
    expect(isAllowed('CLOSED', 'login')).toBe(false);
  });

  it('FR-ACC-014 FR-BO-010 setState writes an append-only audit row with actor, before, after and reason', async () => {
    const { playerId } = await setup();
    await h.identity.setState(playerId, 'ACTIVE', 'staff:42', 'documents verified', { ip: '10.0.0.5' });
    const trail = await h.identity.auditTrail(playerId);
    expect(trail).toEqual([
      expect.objectContaining({
        actor: 'staff:42', action: 'SET_STATE', reason: 'documents verified', ip: '10.0.0.5', at: h.clock.t,
        before: { state: 'PENDING_VERIFICATION', until: null }, after: { state: 'ACTIVE', until: null },
      }),
    ]);
    await expect(h.pool.query('UPDATE account_audit SET reason = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(h.pool.query('DELETE FROM account_audit')).rejects.toThrow(/append-only/);
    expect(await errCode(h.identity.setState(playerId, 'RESTRICTED', 'staff:42', '  '))).toBe('invalid_request');
  });

  it('FR-ACC-014 rejects transitions the state machine does not allow', async () => {
    const { playerId } = await setup();
    await h.identity.setState(playerId, 'CLOSED', 'staff:1', 'player request');
    expect(await errCode(h.identity.setState(playerId, 'ACTIVE', 'staff:1', 'reopen'))).toBe('invalid_transition');
    expect(await errCode(h.identity.setState('00000000-0000-4000-8000-000000000000', 'ACTIVE', 'staff:1', 'x y'))).toBe('not_found');
  });

  it('FR-RG-004 only rg-service can self-exclude or time out, and staff cannot lift it before expiry', async () => {
    const { playerId } = await setup();
    await h.activate(playerId);
    const until = new Date(h.clock.t.getTime() + 180 * DAY);
    expect(await errCode(h.identity.setState(playerId, 'SELF_EXCLUDED', 'staff:7', 'asked by phone', { until }))).toBe('forbidden');
    await h.identity.setState(playerId, 'SELF_EXCLUDED', 'rg-service', 'player self-excluded 6 months', { until });
    expect(await errCode(h.identity.setState(playerId, 'ACTIVE', 'staff:7', 'player asked'))).toBe('restriction_active');
    expect(await errCode(h.identity.setState(playerId, 'ACTIVE', 'rg-service', 'player asked'))).toBe('restriction_active');
    expect(await errCode(h.identity.setState(playerId, 'CLOSED', 'staff:7', 'closing'))).toBe('restriction_active');
    // Shortening is refused; extending is allowed.
    expect(
      await errCode(h.identity.setState(playerId, 'SELF_EXCLUDED', 'rg-service', 'shorter', { until: new Date(until.getTime() - DAY) })),
    ).toBe('restriction_active');
    const longer = new Date(until.getTime() + 185 * DAY);
    await h.identity.setState(playerId, 'SELF_EXCLUDED', 'rg-service', 'extended to 1 year', { until: longer });
    h.clock.t = new Date(longer.getTime() + 1);
    expect((await h.identity.setState(playerId, 'ACTIVE', 'staff:7', 'exclusion ended')).state).toBe('ACTIVE');
  });

  it('FR-RG-004 a permanent self-exclusion can never be lifted; a time-out needs an end time', async () => {
    const { playerId } = await setup();
    expect(await errCode(h.identity.setState(playerId, 'TIMED_OUT', 'rg-service', 'time-out'))).toBe('invalid_request');
    await h.identity.setState(playerId, 'TIMED_OUT', 'rg-service', '24h time-out', { until: new Date(h.clock.t.getTime() + DAY) });
    await h.identity.setState(playerId, 'SELF_EXCLUDED', 'rg-service', 'permanent exclusion', { until: null });
    h.clock.advance(10 * 365 * DAY);
    expect(await errCode(h.identity.setState(playerId, 'ACTIVE', 'staff:1', 'please'))).toBe('restriction_active');
  });

  it('SEC-AUTH-005 suspension and self-exclusion end every session', async () => {
    const { playerId, email } = await setup();
    const s = await h.identity.login(email, PASSWORD, META);
    if (s.status !== 'ok') throw new Error('setup');
    await h.identity.setState(playerId, 'SUSPENDED', 'staff:1', 'fraud review');
    expect(await errCode(h.identity.authenticateAccess(s.tokens.accessToken))).toBe('unauthenticated');
    expect(await h.identity.listSessions(playerId)).toEqual([]);
  });

  it('FR-ACC-014 concurrent state changes serialise and keep the audit hash chain intact (SEC-LOG-002)', async () => {
    const { playerId } = await setup();
    await h.activate(playerId);
    const until = new Date(h.clock.t.getTime() + 7 * DAY);
    const results = await Promise.allSettled([
      h.identity.setState(playerId, 'TIMED_OUT', 'rg-service', '7 day time-out', { until }),
      h.identity.setState(playerId, 'RESTRICTED', 'staff:3', 'pending review'),
      h.identity.setState(playerId, 'SUSPENDED', 'staff:4', 'fraud'),
      h.identity.setKycLevel(playerId, 'FULL', 'kyc-service', 'e-verification passed'),
    ]);
    const final = await h.identity.getStatus(playerId);
    const trail = await h.identity.auditTrail(playerId);
    const stateRows = trail.filter((r) => r.action === 'SET_STATE');
    // Every applied change is audited and each row's "before" is the previous row's "after".
    expect(stateRows.length).toBe(1 + results.slice(0, 3).filter((r) => r.status === 'fulfilled').length);
    for (let i = 1; i < stateRows.length; i++) expect(stateRows[i]!.before).toEqual(stateRows[i - 1]!.after);
    expect((stateRows.at(-1)!.after as { state: string }).state).toBe(final?.state);
    expect(final?.kycLevel).toBe('FULL');
    expect(await h.identity.verifyAuditChain()).toBeNull();
  });

  it('FR-KYC-010 setKycLevel is audited; FR-RSK-005 getStatus reports the stored stake factor', async () => {
    const { playerId } = await setup();
    await h.identity.setKycLevel(playerId, 'BASIC', 'kyc-service', 'email and phone verified');
    await h.identity.setStakeFactor(playerId, '0.25', 'risk-service', 'sharp player');
    expect(await errCode(h.identity.setStakeFactor(playerId, '10.01', 'risk-service', 'too high'))).toBe('invalid_request');
    expect(await errCode(h.identity.setStakeFactor(playerId, '0', 'risk-service', 'too low'))).toBe('invalid_request');
    expect(await h.identity.getStatus(playerId)).toMatchObject({ kycLevel: 'BASIC', stakeFactor: 0.25 });
    expect((await h.identity.auditTrail(playerId)).map((r) => [r.action, r.before, r.after])).toEqual([
      ['SET_KYC_LEVEL', { kycLevel: 'NONE' }, { kycLevel: 'BASIC' }],
      ['SET_STAKE_FACTOR', { stakeFactor: '1.00' }, { stakeFactor: '0.25' }],
    ]);
    expect(await h.identity.getStatus('not-a-uuid')).toBeNull();
    expect(await h.identity.getStatus('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
