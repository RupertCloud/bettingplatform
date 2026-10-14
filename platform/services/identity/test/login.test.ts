import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_FAILURE_LIMIT } from '../src/index.js';
import { META, PASSWORD, errCode, harness, registration, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({ ipFailureLimit: 8 });
});
afterAll(async () => h.drop());

const failures = async (playerId: string) =>
  (await h.pool.query('SELECT count(*)::int AS n FROM login_attempts WHERE player_id = $1 AND NOT success', [playerId])).rows[0].n as number;

let ipN = 0;
const freshIp = () => ({ ...META, ip: `192.0.2.${++ipN}` });

describe('login', () => {
  it('FR-ACC-008 logs in by email, username or phone, matched after normalisation', async () => {
    const input = registration({ phone: '+237677000111' });
    const r = await h.identity.register(input);
    const ids = [input.email.toUpperCase(), ` ${input.username.toUpperCase()} `, '00237 677 000 111'];
    for (const identifier of ids) {
      const res = await h.identity.login(identifier, PASSWORD, freshIp());
      expect(res.status).toBe('ok');
      if (res.status === 'ok' && r.created) {
        expect((await h.identity.authenticateAccess(res.tokens.accessToken)).playerId).toBe(r.playerId);
      }
    }
  });

  it('SEC-AUTH-008 returns the same error for an unknown account and a wrong password', async () => {
    const input = registration();
    await h.identity.register(input);
    const wrong = await h.identity.login(input.email, 'wrong password!!', freshIp()).catch((e: unknown) => e);
    const unknown = await h.identity.login('nobody@example.com', 'wrong password!!', freshIp()).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: 'invalid_credentials', status: 401, detail: 'Invalid credentials.' });
    expect(unknown).toMatchObject({ code: 'invalid_credentials', status: 401, detail: 'Invalid credentials.' });
  });

  it('SEC-AUTH-006 locks the account after 5 failures in 15 minutes, even for the right password', async () => {
    const id = await h.register();
    const { email } = (await h.pool.query('SELECT email FROM players WHERE id = $1', [id])).rows[0];
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) {
      expect(await errCode(h.identity.login(email, 'wrong password!!', freshIp()))).toBe('invalid_credentials');
    }
    expect(await errCode(h.identity.login(email, PASSWORD, freshIp()))).toBe('too_many_attempts');
    h.clock.advance(15 * 60_000 + 1);
    expect((await h.identity.login(email, PASSWORD, freshIp())).status).toBe('ok');
  });

  it('SEC-AUTH-006 parallel guesses cannot exceed the per-account limit', async () => {
    const id = await h.register();
    const { username } = (await h.pool.query('SELECT username FROM players WHERE id = $1', [id])).rows[0];
    const codes = await Promise.all(
      Array.from({ length: 12 }, () => errCode(h.identity.login(username, 'wrong password!!', freshIp()))),
    );
    expect(codes.filter((c) => c === 'invalid_credentials')).toHaveLength(ACCOUNT_FAILURE_LIMIT);
    expect(codes.filter((c) => c === 'too_many_attempts')).toHaveLength(12 - ACCOUNT_FAILURE_LIMIT);
    expect(await failures(id)).toBe(ACCOUNT_FAILURE_LIMIT);
  });

  it('SEC-AUTH-006 a success resets the account counter', async () => {
    const id = await h.register();
    const { email } = (await h.pool.query('SELECT email FROM players WHERE id = $1', [id])).rows[0];
    for (let i = 0; i < 4; i++) await errCode(h.identity.login(email, 'wrong password!!', freshIp()));
    expect((await h.identity.login(email, PASSWORD, freshIp())).status).toBe('ok');
    for (let i = 0; i < 4; i++) await errCode(h.identity.login(email, 'wrong password!!', freshIp()));
    expect((await h.identity.login(email, PASSWORD, freshIp())).status).toBe('ok');
  });

  it('SEC-AUTH-006 SEC-AUTH-008 unknown identifiers lock out exactly like real accounts', async () => {
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) {
      expect(await errCode(h.identity.login('ghost@example.com', 'wrong password!!', freshIp()))).toBe('invalid_credentials');
    }
    expect(await errCode(h.identity.login('ghost@example.com', 'wrong password!!', freshIp()))).toBe('too_many_attempts');
  });

  it('SEC-AUTH-006 limits failures per IP across accounts', async () => {
    const ip = { ...META, ip: '198.18.0.1' };
    for (let i = 0; i < 8; i++) {
      expect(await errCode(h.identity.login(`spray${i}@example.com`, 'wrong password!!', ip))).toBe('invalid_credentials');
    }
    const input = registration();
    await h.identity.register(input);
    expect(await errCode(h.identity.login(input.email, PASSWORD, ip))).toBe('too_many_attempts');
    expect((await h.identity.login(input.email, PASSWORD, freshIp())).status).toBe('ok');
  });

  it('FR-ACC-014 blocks login for a SUSPENDED account', async () => {
    const input = registration();
    const r = await h.identity.register(input);
    if (!r.created) throw new Error('setup');
    await h.identity.setState(r.playerId, 'SUSPENDED', 'staff:1', 'fraud review');
    expect(await errCode(h.identity.login(input.email, PASSWORD, freshIp()))).toBe('account_unavailable');
  });
});
