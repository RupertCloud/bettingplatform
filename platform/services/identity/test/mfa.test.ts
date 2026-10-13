import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META, PASSWORD, errCode, harness, registration, totp, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.drop());

/** Registers, logs in and enrols TOTP. Leaves the clock 30 s past the confirming code. */
const enrolled = async () => {
  const input = registration();
  const r = await h.identity.register(input);
  if (!r.created) throw new Error('setup');
  const login = await h.identity.login(input.email, PASSWORD, META);
  if (login.status !== 'ok') throw new Error('setup');
  const { secret } = await h.identity.enrolMfa(r.playerId);
  await h.identity.confirmMfa(r.playerId, login.tokens.sessionId, totp(secret, h.clock.t));
  h.clock.advance(30_000);
  return { playerId: r.playerId, email: input.email, secret, sessionId: login.tokens.sessionId };
};

describe('mfa', () => {
  it('FR-ACC-008 enrolment stores the TOTP secret encrypted (AES-256-GCM), not in plain text', async () => {
    const { playerId, secret } = await enrolled();
    const row = (await h.pool.query('SELECT mfa_secret, mfa_pending FROM players WHERE id = $1', [playerId])).rows[0];
    expect(row.mfa_pending).toBeNull();
    expect(row.mfa_secret.length).toBe(12 + 16 + secret.length);
    expect(row.mfa_secret.toString('latin1')).not.toContain(secret);
    expect(await errCode(h.identity.enrolMfa(playerId))).toBe('mfa_already_enrolled');
  });

  it('FR-ACC-008 rejects a wrong confirmation code and keeps the enrolment pending', async () => {
    const input = registration();
    const r = await h.identity.register(input);
    if (!r.created) throw new Error('setup');
    const login = await h.identity.login(input.email, PASSWORD, META);
    if (login.status !== 'ok') throw new Error('setup');
    const { secret } = await h.identity.enrolMfa(r.playerId);
    const bad = totp(secret, new Date(h.clock.t.getTime() + 5 * 60_000));
    expect(await errCode(h.identity.confirmMfa(r.playerId, login.tokens.sessionId, bad))).toBe('invalid_code');
    const row = (await h.pool.query('SELECT mfa_secret, mfa_pending FROM players WHERE id = $1', [r.playerId])).rows[0];
    expect(row.mfa_secret).toBeNull();
    expect(row.mfa_pending).not.toBeNull();
  });

  it('FR-ACC-008 login with MFA enrolled returns a challenge that a TOTP code completes', async () => {
    const p = await enrolled();
    const res = await h.identity.login(p.email, PASSWORD, META);
    expect(res.status).toBe('mfa_required');
    if (res.status !== 'mfa_required') return;
    const tokens = await h.identity.completeMfaLogin(res.challenge, totp(p.secret, h.clock.t), META);
    expect((await h.identity.authenticateAccess(tokens.accessToken)).playerId).toBe(p.playerId);
    await h.identity.requireRecentMfa(tokens.sessionId);
    // Challenge is single use.
    h.clock.advance(30_000);
    expect(await errCode(h.identity.completeMfaLogin(res.challenge, totp(p.secret, h.clock.t), META))).toBe('invalid_credentials');
  });

  it('FR-ACC-008 rejects replay of an already-used TOTP code', async () => {
    const p = await enrolled();
    const code = totp(p.secret, h.clock.t);
    const a = await h.identity.login(p.email, PASSWORD, META);
    const b = await h.identity.login(p.email, PASSWORD, META);
    if (a.status !== 'mfa_required' || b.status !== 'mfa_required') throw new Error('setup');
    await h.identity.completeMfaLogin(a.challenge, code, META);
    expect(await errCode(h.identity.completeMfaLogin(b.challenge, code, META))).toBe('invalid_code');
  });

  it('SEC-AUTH-006 wrong TOTP codes count towards the account lockout', async () => {
    const p = await enrolled();
    for (let i = 0; i < 5; i++) {
      const res = await h.identity.login(p.email, PASSWORD, META);
      if (res.status !== 'mfa_required') throw new Error(`expected challenge, got ${res.status}`);
      expect(await errCode(h.identity.completeMfaLogin(res.challenge, '000000', META))).toBe('invalid_code');
    }
    expect(await errCode(h.identity.login(p.email, PASSWORD, META))).toBe('too_many_attempts');
  });

  it('FR-ACC-009 requireRecentMfa demands a step-up after 5 minutes and accepts a fresh code', async () => {
    const p = await enrolled(); // confirmMfa marked this session verified 30 s ago
    await h.identity.requireRecentMfa(p.sessionId);
    h.clock.advance(5 * 60_000);
    expect(await errCode(h.identity.requireRecentMfa(p.sessionId))).toBe('mfa_required');
    await h.identity.verifyMfa(p.sessionId, totp(p.secret, h.clock.t));
    await h.identity.requireRecentMfa(p.sessionId);
  });

  it('FR-ACC-009 requireRecentMfa refuses a player who has not enrolled', async () => {
    const input = registration();
    await h.identity.register(input);
    const res = await h.identity.login(input.email, PASSWORD, META);
    if (res.status !== 'ok') throw new Error('setup');
    expect(await errCode(h.identity.requireRecentMfa(res.tokens.sessionId))).toBe('mfa_enrolment_required');
  });

  it('FR-ACC-009 five failed step-up codes end the session', async () => {
    const p = await enrolled();
    for (let i = 0; i < 5; i++) expect(await errCode(h.identity.verifyMfa(p.sessionId, '000000'))).toBe('invalid_code');
    expect(await errCode(h.identity.verifyMfa(p.sessionId, totp(p.secret, h.clock.t)))).toBe('unauthenticated');
    expect(await errCode(h.identity.requireRecentMfa(p.sessionId))).toBe('unauthenticated');
  });
});
