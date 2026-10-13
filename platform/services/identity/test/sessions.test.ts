import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto.js';
import type { SessionTokens } from '../src/index.js';
import { META, PASSWORD, errCode, harness, registration, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.drop());

const newPlayer = async (): Promise<{ playerId: string; email: string }> => {
  const input = registration();
  const r = await h.identity.register(input);
  if (!r.created) throw new Error('setup');
  return { playerId: r.playerId, email: input.email };
};
const loginAs = async (email: string): Promise<SessionTokens> => {
  const r = await h.identity.login(email, PASSWORD, META);
  if (r.status !== 'ok') throw new Error('expected session');
  return r.tokens;
};

describe('sessions', () => {
  it('SEC-AUTH-003 issues distinct 256-bit random tokens and stores only their SHA-256', async () => {
    const { email } = await newPlayer();
    const t = await loginAs(email);
    expect(Buffer.from(t.accessToken, 'base64url')).toHaveLength(32);
    expect(Buffer.from(t.refreshToken, 'base64url')).toHaveLength(32);
    expect(t.accessToken).not.toBe(t.refreshToken);
    const row = (await h.pool.query('SELECT access_hash, refresh_hash FROM session_tokens WHERE session_id = $1', [t.sessionId])).rows[0];
    expect(row.access_hash.equals(hashToken(t.accessToken))).toBe(true);
    expect(row.refresh_hash.equals(hashToken(t.refreshToken))).toBe(true);
    const cols = (await h.pool.query('SELECT access_hash, refresh_hash FROM session_tokens')).rows
      .flatMap((r) => [r.access_hash.toString('latin1'), r.access_hash.toString('base64url')]);
    expect(cols.some((c) => c.includes(t.accessToken))).toBe(false);
  });

  it('SEC-AUTH-003 rotates the refresh token on use and invalidates the old access token', async () => {
    const { email } = await newPlayer();
    const t1 = await loginAs(email);
    const t2 = await h.identity.refresh(t1.refreshToken);
    expect(t2.sessionId).toBe(t1.sessionId);
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
    expect(await errCode(h.identity.authenticateAccess(t1.accessToken))).toBe('unauthenticated');
    await h.identity.authenticateAccess(t2.accessToken);
  });

  it('SEC-AUTH-003 reuse of a rotated refresh token revokes the whole session', async () => {
    const { email } = await newPlayer();
    const t1 = await loginAs(email);
    const t2 = await h.identity.refresh(t1.refreshToken);
    expect(await errCode(h.identity.refresh(t1.refreshToken))).toBe('unauthenticated');
    expect(await errCode(h.identity.authenticateAccess(t2.accessToken))).toBe('unauthenticated');
    expect(await errCode(h.identity.refresh(t2.refreshToken))).toBe('unauthenticated');
  });

  it('SEC-AUTH-003 concurrent refreshes with one token: one wins, the replay revokes the session', async () => {
    const { email } = await newPlayer();
    const t1 = await loginAs(email);
    const results = await Promise.allSettled([h.identity.refresh(t1.refreshToken), h.identity.refresh(t1.refreshToken)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { revoke_reason } = (await h.pool.query('SELECT revoke_reason FROM sessions WHERE id = $1', [t1.sessionId])).rows[0];
    expect(revoke_reason).toBe('refresh_token_reuse');
  });

  it('FR-ACC-018 ends a session after 30 minutes idle', async () => {
    const { email } = await newPlayer();
    const t = await loginAs(email);
    h.clock.advance(29 * 60_000);
    await h.identity.authenticateAccess(t.accessToken); // activity resets the idle timer
    h.clock.advance(29 * 60_000);
    await h.identity.authenticateAccess(t.accessToken);
    h.clock.advance(30 * 60_000);
    expect(await errCode(h.identity.authenticateAccess(t.accessToken))).toBe('unauthenticated');
    expect(await errCode(h.identity.refresh(t.refreshToken))).toBe('unauthenticated');
  });

  it('FR-ACC-018 ends a session after 12 hours however active', async () => {
    const { email } = await newPlayer();
    let t = await loginAs(email);
    for (let i = 0; i < 28; i++) {
      h.clock.advance(25 * 60_000);
      t = await h.identity.refresh(t.refreshToken);
    }
    h.clock.advance(25 * 60_000); // 12 h 5 min after login
    expect(await errCode(h.identity.authenticateAccess(t.accessToken))).toBe('unauthenticated');
    expect(await errCode(h.identity.refresh(t.refreshToken))).toBe('unauthenticated');
  });

  it('FR-ACC-018 lists active sessions and revokes one; another player cannot revoke it (SEC-API-001)', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const s1 = await loginAs(a.email);
    const s2 = await loginAs(a.email);
    const list = await h.identity.listSessions(a.playerId);
    expect(list.map((s) => s.sessionId).sort()).toEqual([s1.sessionId, s2.sessionId].sort());
    expect(await h.identity.revokeSession(b.playerId, s1.sessionId)).toBe(false);
    expect(await h.identity.revokeSession(a.playerId, s1.sessionId)).toBe(true);
    expect(await errCode(h.identity.authenticateAccess(s1.accessToken))).toBe('unauthenticated');
    expect((await h.identity.listSessions(a.playerId)).map((s) => s.sessionId)).toEqual([s2.sessionId]);
  });

  it('FR-ACC-018 SEC-AUTH-005 revokeAll and logout invalidate tokens server-side', async () => {
    const a = await newPlayer();
    const s1 = await loginAs(a.email);
    const s2 = await loginAs(a.email);
    await h.identity.logout(s1.sessionId);
    expect(await errCode(h.identity.authenticateAccess(s1.accessToken))).toBe('unauthenticated');
    await h.identity.authenticateAccess(s2.accessToken);
    expect(await h.identity.revokeAll(a.playerId)).toBe(1);
    expect(await errCode(h.identity.refresh(s2.refreshToken))).toBe('unauthenticated');
    expect(await h.identity.listSessions(a.playerId)).toEqual([]);
  });
});
