import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META, PASSWORD, errCode, harness, registration, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({ isBreachedPassword: async (p) => p === 'password1234' });
});
afterAll(async () => h.drop());

const NEW_PASSWORD = 'a brand new passphrase';

const setup = async () => {
  const input = registration();
  const r = await h.identity.register(input);
  if (!r.created) throw new Error('setup');
  return { playerId: r.playerId, email: input.email };
};

describe('password reset', () => {
  it('FR-ACC-010 a reset token sets a new password once and ends all sessions', async () => {
    const p = await setup();
    const s = await h.identity.login(p.email, PASSWORD, META);
    if (s.status !== 'ok') throw new Error('setup');
    await h.identity.requestPasswordReset(p.email.toUpperCase());
    const token = h.lastToken('PASSWORD_RESET');
    await h.identity.confirmPasswordReset(token, NEW_PASSWORD);
    expect(await errCode(h.identity.authenticateAccess(s.tokens.accessToken))).toBe('unauthenticated');
    expect(await errCode(h.identity.login(p.email, PASSWORD, META))).toBe('invalid_credentials');
    expect((await h.identity.login(p.email, NEW_PASSWORD, META)).status).toBe('ok');
    expect(await errCode(h.identity.confirmPasswordReset(token, 'yet another passphrase'))).toBe('invalid_token');
  });

  it('FR-ACC-010 a reset token expires after 30 minutes', async () => {
    const p = await setup();
    await h.identity.requestPasswordReset(p.email);
    const token = h.lastToken('PASSWORD_RESET');
    h.clock.advance(30 * 60_000);
    expect(await errCode(h.identity.confirmPasswordReset(token, NEW_PASSWORD))).toBe('invalid_token');
  });

  it('FR-ACC-010 a successful reset burns the other outstanding reset tokens', async () => {
    const p = await setup();
    await h.identity.requestPasswordReset(p.email);
    const first = h.lastToken('PASSWORD_RESET');
    await h.identity.requestPasswordReset(p.email);
    const second = h.lastToken('PASSWORD_RESET');
    await h.identity.confirmPasswordReset(second, NEW_PASSWORD);
    expect(await errCode(h.identity.confirmPasswordReset(first, 'yet another passphrase'))).toBe('invalid_token');
  });

  it('FR-ACC-010 concurrent confirmations with one token succeed exactly once', async () => {
    const p = await setup();
    await h.identity.requestPasswordReset(p.email);
    const token = h.lastToken('PASSWORD_RESET');
    const results = await Promise.allSettled(
      ['first new passphrase', 'second new passphrase', 'third new passphrase'].map((pw) => h.identity.confirmPasswordReset(token, pw)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('SEC-AUTH-002 a weak or breached new password is refused without burning the token', async () => {
    const p = await setup();
    await h.identity.requestPasswordReset(p.email);
    const token = h.lastToken('PASSWORD_RESET');
    expect(await errCode(h.identity.confirmPasswordReset(token, 'short'))).toBe('weak_password');
    expect(await errCode(h.identity.confirmPasswordReset(token, 'password1234'))).toBe('breached_password');
    await h.identity.confirmPasswordReset(token, NEW_PASSWORD);
  });

  it('SEC-AUTH-008 a reset request for an unknown email resolves identically and sends nothing', async () => {
    const before = h.sent.length;
    await expect(h.identity.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    expect(h.sent.length).toBe(before);
  });
});
