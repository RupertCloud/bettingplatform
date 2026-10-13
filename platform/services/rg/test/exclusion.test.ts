import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

describe('time-out and self-exclusion', () => {
  it('FR-RG-004 FR-RG-005 a 24 h time-out blocks stakes and deposits at once and expires on time', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    const e = await h.rg.timeOut(p, '24h');
    expect(e).toEqual({ state: 'TIMED_OUT', until: new Date(t.getTime() + DAY) });
    expect(h.states).toContainEqual({ playerId: p, state: 'TIMED_OUT', until: e.until });
    expect(await h.rg.checkStake(p, 'XAF', 100n, t)).toMatchObject({ allowed: false, code: 'timed_out' });
    expect(await h.rg.checkDeposit(p, 'XAF', 100n, t)).toMatchObject({ allowed: false, code: 'timed_out' });
    expect(await h.rg.canMarketTo(p)).toBe(false);
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(t.getTime() + DAY - 1))).toMatchObject({ allowed: false });
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(t.getTime() + DAY))).toEqual({ allowed: true });
    // A check back-dated to before the time-out started is still denied: the effect is immediate.
    expect(await h.rg.checkStake(p, 'XAF', 100n, new Date(t.getTime() - HOUR))).toMatchObject({ code: 'timed_out' });
  });

  it('FR-RG-004 exclusions are irreversible by anyone before expiry', async () => {
    const p = h.addPlayer();
    await h.rg.selfExclude(p, '6m');
    await expect(h.pool.query('DELETE FROM exclusions WHERE player_id = $1', [p])).rejects.toThrow(/append-only/);
    await expect(h.pool.query('UPDATE exclusions SET ends_at = starts_at + interval \'1 second\' WHERE player_id = $1', [p])).rejects.toThrow(
      /append-only/,
    );
    // A shorter time-out requested later does not shorten the self-exclusion.
    await h.rg.timeOut(p, '24h');
    const s = await h.rg.exclusionStatus(p, new Date(h.clock.now().getTime() + 2 * DAY));
    expect(s?.state).toBe('SELF_EXCLUDED');
  });

  it('FR-RG-004 self-exclusion periods use calendar months; permanent has no end', async () => {
    const p = h.addPlayer();
    const t = h.clock.now();
    const e = await h.rg.selfExclude(p, '1y');
    const expected = new Date(t);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    expect(e.until).toEqual(expected);
    const q = h.addPlayer();
    expect(await h.rg.selfExclude(q, 'permanent')).toEqual({ state: 'SELF_EXCLUDED', until: null });
    expect(await h.rg.checkDeposit(q, 'XAF', 1n, new Date(t.getTime() + 3650 * DAY))).toMatchObject({ code: 'self_excluded' });
  });

  it('FR-RG-007 exclusion follows the person across brands', async () => {
    const brandA = h.addPlayer();
    const brandB = h.addPlayer();
    await h.rg.linkIdentity(brandA, 'Jane.Doe@Example.com ', '1990-05-01');
    await h.rg.linkIdentity(brandB, 'jane.doe@example.com', '1990-05-01');
    h.states.length = 0;
    await h.rg.selfExclude(brandA, '5y');
    expect(h.states.map((s) => s.playerId).sort()).toEqual([brandA, brandB].sort());
    expect(await h.rg.checkStake(brandB, 'XAF', 100n, h.clock.now())).toMatchObject({ code: 'self_excluded' });

    // A new account opened later by the same person is excluded on linking.
    const brandC = h.addPlayer();
    h.states.length = 0;
    await h.rg.linkIdentity(brandC, 'jane.doe@example.com', '1990-05-01');
    expect(h.states).toEqual([{ playerId: brandC, state: 'SELF_EXCLUDED', until: expect.any(Date) }]);
    expect(await h.rg.checkDeposit(brandC, 'XAF', 100n, h.clock.now())).toMatchObject({ code: 'self_excluded' });

    // Excluded before linking: still found through the person.
    const early = h.addPlayer();
    await h.rg.timeOut(early, '7d');
    const later = h.addPlayer();
    await h.rg.linkIdentity(early, 'sam@example.com', '1985-01-01');
    await h.rg.linkIdentity(later, 'sam@example.com', '1985-01-01');
    expect(await h.rg.checkStake(later, 'XAF', 100n, h.clock.now())).toMatchObject({ code: 'timed_out' });
    await expect(h.rg.linkIdentity(later, 'other@example.com', '1985-01-01')).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  it('FR-RG-004 only periods offered by the rules set are accepted', async () => {
    const p = h.addPlayer();
    await expect(h.rg.timeOut(p, '6m' as never)).rejects.toMatchObject({ code: 'invalid_period' });
  });

  it('FR-RG-016 marketing excludes opted-out and excluded players', async () => {
    const p = h.addPlayer();
    expect(await h.rg.canMarketTo(p)).toBe(true);
    await h.rg.setMarketingOptOut(p, true);
    expect(await h.rg.canMarketTo(p)).toBe(false);
    await h.rg.setMarketingOptOut(p, false);
    expect(await h.rg.canMarketTo(p)).toBe(true);
    await h.rg.timeOut(p, '42d');
    expect(await h.rg.canMarketTo(p)).toBe(false);
    h.clock.advance(42 * DAY + HOUR);
    expect(await h.rg.canMarketTo(p)).toBe(true);
  });
});
