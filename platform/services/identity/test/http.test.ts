import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, playerBearerAuth, type AuthContext } from '../src/index.js';
import { PASSWORD, harness, registration, totp, type Harness } from './helpers.js';

let h: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await harness();
  const playerAuth = playerBearerAuth(h.identity);
  // Staff tokens come from the back-office IdP in production; a fixed header stands in for it here.
  const authenticate = async (req: FastifyRequest): Promise<AuthContext> => {
    const staff = req.headers['x-test-staff'];
    if (typeof staff === 'string') {
      const [staffId, roles = ''] = staff.split(':');
      return { staffId, roles: roles.split(',').filter(Boolean) };
    }
    return playerAuth(req);
  };
  app = buildServer({ identity: h.identity, authenticate });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await h.drop();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const registerAndLogin = async () => {
  const input = registration();
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: input });
  expect(reg.statusCode).toBe(202);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: input.email, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const body = login.json();
  const playerId = (await h.pool.query('SELECT id FROM players WHERE email = $1', [input.email.trim().toLowerCase()])).rows[0].id as string;
  return { input, playerId, ...(body as { sessionId: string; accessToken: string; refreshToken: string }) };
};

describe('http', () => {
  it('FR-ACC-001 SEC-AUTH-008 register returns 202 for new and duplicate accounts alike', async () => {
    const input = registration();
    const a = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: input });
    const b = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: input });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(a.body).toBe(b.body);
  });

  it('SEC-API-002 rejects invalid bodies with a 400 problem and no internals', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { ...registration(), email: 'not-an-email', extra: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ title: 'validation_error', status: 400 });
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{oops' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ type: 'urn:bp:error:bad_request', title: 'bad_request', status: 400, detail: 'The request could not be read.' });
  });

  it('SEC-AUTH-008 login gives one generic 401 for unknown and wrong credentials', async () => {
    const { input } = await registerAndLogin();
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: input.email, password: 'wrong password!!' } });
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: 'x@example.com', password: 'wrong password!!' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
  });

  it('SEC-API-001 player routes return 401 without a valid token', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me/sessions' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer('A'.repeat(43)) });
    expect(res.statusCode).toBe(401);
    expect(res.json().title).toBe('unauthenticated');
  });

  it('FR-ACC-018 SEC-API-001 a player lists and revokes only their own sessions', async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const list = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(a.accessToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toEqual([expect.objectContaining({ sessionId: a.sessionId, current: true })]);
    const cross = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${a.sessionId}`, headers: bearer(b.accessToken) });
    expect(cross.statusCode).toBe(404);
    const badId = await app.inject({ method: 'DELETE', url: '/v1/me/sessions/abc', headers: bearer(b.accessToken) });
    expect(badId.statusCode).toBe(400);
    const own = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${a.sessionId}`, headers: bearer(a.accessToken) });
    expect(own.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(a.accessToken) })).statusCode).toBe(401);
  });

  it('SEC-AUTH-003 refresh rotates tokens and logout revokes the session', async () => {
    const a = await registerAndLogin();
    const r = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: a.refreshToken } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const t = r.json();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(t.accessToken) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: t.refreshToken } })).statusCode).toBe(401);
  });

  it('FR-ACC-008 MFA enrol, confirm, then login needs the challenge via /v1/auth/mfa/verify', async () => {
    const a = await registerAndLogin();
    const enrol = await app.inject({ method: 'POST', url: '/v1/me/mfa/enrol', headers: bearer(a.accessToken) });
    expect(enrol.statusCode).toBe(200);
    const { secret } = enrol.json();
    const confirm = await app.inject({
      method: 'POST', url: '/v1/me/mfa/confirm', headers: bearer(a.accessToken), payload: { code: totp(secret, h.clock.t) },
    });
    expect(confirm.statusCode).toBe(204);
    h.clock.advance(30_000);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: a.input.username, password: PASSWORD } });
    expect(login.json()).toMatchObject({ status: 'mfa_required' });
    const verify = await app.inject({
      method: 'POST', url: '/v1/auth/mfa/verify', payload: { challenge: login.json().challenge, code: totp(secret, h.clock.t) },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ status: 'ok' });
  });

  it('FR-ACC-010 SEC-AUTH-008 password reset request always answers 202; confirm works once', async () => {
    const a = await registerAndLogin();
    const known = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: a.input.email } });
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: 'none@example.com' } });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.body).toBe(unknown.body);
    const token = h.lastToken('PASSWORD_RESET');
    const payload = { token, newPassword: 'fresh passphrase here' };
    expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(a.accessToken) })).statusCode).toBe(401);
  });

  it('FR-ACC-014 SEC-API-001 staff state change needs the compliance role and is audited', async () => {
    const a = await registerAndLogin();
    const url = `/v1/staff/players/${a.playerId}/state`;
    const payload = { state: 'ACTIVE', reason: 'KYC complete' };
    expect((await app.inject({ method: 'PATCH', url, payload, headers: bearer(a.accessToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, payload, headers: { 'x-test-staff': 's1:support' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, payload: { state: 'ACTIVE' }, headers: { 'x-test-staff': 's1:compliance' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url, payload, headers: { 'x-test-staff': 's1:compliance' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ playerId: a.playerId, state: 'ACTIVE', stakeFactor: 1 });
    const trail = await h.identity.auditTrail(a.playerId);
    expect(trail.at(-1)).toMatchObject({ actor: 'staff:s1', reason: 'KYC complete' });
    // Staff cannot self-exclude a player; that belongs to the RG service.
    const se = await app.inject({ method: 'PATCH', url, payload: { state: 'SELF_EXCLUDED', reason: 'asked' }, headers: { 'x-test-staff': 's1:compliance' } });
    expect(se.statusCode).toBe(403);
  });
});
