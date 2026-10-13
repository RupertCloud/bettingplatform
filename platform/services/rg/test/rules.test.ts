import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@bp/common';
import { DAY, HOUR, setup, type Harness } from './helpers.js';
import type { RulesSet } from '../src/index.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

const alice = { staffId: 'alice' };
const bob = { staffId: 'bob' };

describe('jurisdiction rules', () => {
  it('FR-JUR-001 seeds Cameroon (XAF) with the SRS bracketed defaults', async () => {
    const v = await h.rg.rulesFor('CM', h.clock.now());
    expect(v.version).toBe(1);
    expect(v.status).toBe('APPROVED');
    expect(v.rules).toEqual({
      currency: 'XAF',
      minAge: 18,
      realityCheckMinutes: 60,
      limitIncreaseCoolingHours: 24,
      mandatoryDepositLimitPrompt: true,
      creditCardBan: true,
      affordabilityNetDepositThreshold: 328_000n,
      withdrawalReversalAllowed: false,
      timeOutOptions: ['24h', '7d', '42d'],
      selfExclusionOptions: ['6m', '1y', '5y', 'permanent'],
      utcOffsetMinutes: 60,
    });
  });

  it('FR-JUR-003 a new version needs a different approver, takes effect at effectiveFrom and keeps old versions', async () => {
    const base = (await h.rg.rulesFor('CM', h.clock.now())).rules;
    const next: RulesSet = { ...base, realityCheckMinutes: 30, limitIncreaseCoolingHours: 72 };
    const effectiveFrom = new Date(h.clock.now().getTime() + DAY);
    const draft = await h.rg.proposeRules('CM', next, effectiveFrom, alice, 'Tighter reality checks');
    expect(draft).toMatchObject({ version: 2, status: 'PENDING', author: 'alice' });

    // Pending versions never apply.
    expect((await h.rg.rulesFor('CM', new Date(effectiveFrom.getTime() + HOUR))).version).toBe(1);

    await expect(h.rg.approveRules('CM', 2, alice, 'self approval')).rejects.toMatchObject({ code: 'four_eyes_required', status: 403 });
    const approved = await h.rg.approveRules('CM', 2, bob, 'Reviewed');
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: 'bob' });
    await expect(h.rg.approveRules('CM', 2, bob, 'again')).rejects.toMatchObject({ code: 'already_approved' });

    // Not yet in force; in force from effectiveFrom.
    expect((await h.rg.rulesFor('CM', h.clock.now())).version).toBe(1);
    expect((await h.rg.rulesFor('CM', effectiveFrom)).rules.realityCheckMinutes).toBe(30);

    const history = await h.rg.rulesHistory('CM');
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history[1]!.rules.realityCheckMinutes).toBe(60);

    // Content of a version is immutable, and versions cannot be deleted.
    await expect(h.pool.query(`UPDATE rules_versions SET rules = '{}'::jsonb WHERE version = 1`)).rejects.toThrow(/immutable/);
    await expect(h.pool.query('DELETE FROM rules_versions')).rejects.toThrow(/append-only/);
  });

  it('FR-JUR-003 refuses approval once the scheduled time has passed', async () => {
    const base = (await h.rg.rulesFor('CM', h.clock.now())).rules;
    const v = await h.rg.proposeRules('CM', base, new Date(h.clock.now().getTime() + HOUR), alice, 'Scheduled');
    h.clock.advance(2 * HOUR);
    await expect(h.rg.approveRules('CM', v.version, bob, 'late')).rejects.toMatchObject({ code: 'effective_from_passed' });
    await expect(h.rg.proposeRules('CM', base, new Date(h.clock.now().getTime() - 1), alice, 'past')).rejects.toBeInstanceOf(AppError);
  });

  it('FR-BO-010 staff rule actions are in an append-only hash-chained audit log', async () => {
    const rows = await h.pool.query<{ action: string; actor: string; reason: string }>('SELECT action, actor, reason FROM audit_log ORDER BY id');
    expect(rows.rows.map((r) => r.action)).toEqual(['RULES_PROPOSED', 'RULES_APPROVED', 'RULES_PROPOSED']);
    expect(await h.rg.verifyAuditChain()).toBe(true);
    await expect(h.pool.query(`UPDATE audit_log SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });

  it('FR-JUR-001 rejects an invalid rules set', async () => {
    const base = (await h.rg.rulesFor('CM', h.clock.now())).rules;
    await expect(
      h.rg.proposeRules('CM', { ...base, realityCheckMinutes: 5 }, new Date(h.clock.now().getTime() + DAY), alice, 'bad'),
    ).rejects.toThrow();
    await expect(h.rg.proposeRules('cm; drop', base, new Date(h.clock.now().getTime() + DAY), alice, 'bad')).rejects.toMatchObject({
      code: 'invalid_jurisdiction',
    });
  });
});
