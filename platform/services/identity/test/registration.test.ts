import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errCode, harness, registration, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({
    minimumAge: (j) => (j === 'GB' ? 18 : j === 'XX' ? 21 : 18),
    isBreachedPassword: async (p) => p === 'password1234',
  });
});
afterAll(async () => h.drop());

describe('registration', () => {
  it('FR-ACC-001 creates a PENDING_VERIFICATION account with KYC NONE and normalised identifiers', async () => {
    const input = registration({ phone: '+237 6 71-23 45 67', username: '  MixedCase_1 ' });
    const r = await h.identity.register(input);
    expect(r.created).toBe(true);
    if (!r.created) return;
    const status = await h.identity.getStatus(r.playerId);
    expect(status).toEqual({
      playerId: r.playerId, state: 'PENDING_VERIFICATION', kycLevel: 'NONE', jurisdiction: 'CM', currency: 'XAF', stakeFactor: 1,
    });
    const row = (await h.pool.query('SELECT email, username, phone FROM players WHERE id = $1', [r.playerId])).rows[0];
    expect(row).toEqual({ email: input.email.trim().toLowerCase(), username: 'mixedcase_1', phone: '+237671234567' });
  });

  it('FR-ACC-001 rejects missing consent and malformed fields', async () => {
    expect(await errCode(h.identity.register({ ...registration(), ageDeclaration: false as unknown as true }))).toBe('validation_error');
    expect(await errCode(h.identity.register(registration({ phone: '12345' })))).toBe('validation_error');
    expect(await errCode(h.identity.register(registration({ dateOfBirth: '1990-02-30' })))).toBe('validation_error');
    expect(await errCode(h.identity.register(registration({ currency: 'GBP' as 'EUR' })))).toBe('validation_error');
  });

  it('FR-ACC-004 enforces uniqueness after normalisation without revealing it (SEC-AUTH-008)', async () => {
    const first = registration({ phone: '+237699000001' });
    await h.identity.register(first);
    const dupEmail = await h.identity.register(registration({ email: `  ${first.email.toUpperCase()}` }));
    const dupUser = await h.identity.register(registration({ username: first.username.toUpperCase() }));
    const dupPhone = await h.identity.register(registration({ phone: '00237 699 000 001' }));
    expect([dupEmail, dupUser, dupPhone]).toEqual([{ created: false }, { created: false }, { created: false }]);
    expect(h.sent.filter((n) => n.kind === 'REGISTRATION_CONFLICT')).toHaveLength(3);
  });

  it('FR-ACC-004 concurrent registrations with the same email create exactly one account', async () => {
    const base = registration();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => h.identity.register({ ...registration(), email: base.email, username: `racer${i}${Date.now()}` })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const n = await h.pool.query('SELECT count(*)::int AS n FROM players WHERE email = $1', [base.email.trim().toLowerCase()]);
    expect(n.rows[0].n).toBe(1);
  });

  it('FR-ACC-002 rejects under the jurisdiction minimum age and records the attempt', async () => {
    // Clock is 2026-03-02: born 2008-03-03 is one day short of 18.
    const young = registration({ dateOfBirth: '2008-03-03' });
    expect(await errCode(h.identity.register(young, { ip: '198.51.100.1' }))).toBe('underage');
    expect(await h.identity.register(registration({ dateOfBirth: '2008-03-02' }))).toMatchObject({ created: true });
    // Injectable rules: 21 in jurisdiction XX.
    expect(await errCode(h.identity.register(registration({ dateOfBirth: '2006-01-01', jurisdiction: 'XX' })))).toBe('underage');
    const rows = (await h.pool.query('SELECT email, jurisdiction, reason, ip FROM registration_rejections ORDER BY id')).rows;
    expect(rows).toEqual([
      { email: young.email.trim().toLowerCase(), jurisdiction: 'CM', reason: 'UNDERAGE', ip: '198.51.100.1' },
      expect.objectContaining({ jurisdiction: 'XX', reason: 'UNDERAGE' }),
    ]);
  });

  it('SEC-AUTH-002 requires 10 characters and rejects breached passwords, with no composition rules', async () => {
    expect(await errCode(h.identity.register(registration({ password: 'short pw1' })))).toBe('weak_password');
    expect(await errCode(h.identity.register(registration({ password: 'password1234' })))).toBe('breached_password');
    expect(await h.identity.register(registration({ password: 'alllowercaseletters' }))).toMatchObject({ created: true });
  });

  it('SEC-AUTH-001 stores an Argon2id hash with memory >= 64 MiB and >= 3 iterations', async () => {
    const id = await h.register();
    const { password_hash: hash } = (await h.pool.query('SELECT password_hash FROM players WHERE id = $1', [id])).rows[0];
    const m = /^\$argon2id\$v=19\$([^$]+)\$/.exec(hash);
    expect(m).not.toBeNull();
    const params = Object.fromEntries(m![1]!.split(',').map((kv) => kv.split('=')));
    expect(Number(params.m)).toBeGreaterThanOrEqual(65_536);
    expect(Number(params.t)).toBeGreaterThanOrEqual(3);
  });

  it('FR-ACC-003 email verification token is single-use and expires after 15 minutes', async () => {
    const id = await h.register();
    const token = h.lastToken('EMAIL_VERIFICATION');
    const stored = (await h.pool.query('SELECT token_hash FROM one_time_tokens WHERE player_id = $1', [id])).rows[0];
    expect(stored.token_hash.toString('utf8')).not.toContain(token);
    await h.identity.verifyEmail(token);
    const row = (await h.pool.query('SELECT email_verified_at FROM players WHERE id = $1', [id])).rows[0];
    expect(row.email_verified_at).toEqual(h.clock.t);
    expect(await errCode(h.identity.verifyEmail(token))).toBe('invalid_token');

    await h.register();
    const late = h.lastToken('EMAIL_VERIFICATION');
    h.clock.advance(15 * 60_000);
    expect(await errCode(h.identity.verifyEmail(late))).toBe('invalid_token');
  });
});
