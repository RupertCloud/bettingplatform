import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, TEST_DATABASE_URL, type Pool } from '@bp/common';
import { buildGateway, ingestDemoFixtures, SERVICES, type Gateway } from '../src/index.js';

const PASSWORD = 'correct horse battery staple';
let seq = 0;

const registration = () => {
  const n = `${Date.now().toString(36)}${++seq}`;
  return {
    email: `player${n}@example.cm`,
    username: `player${n}`,
    password: PASSWORD,
    legalName: 'Demo Player',
    dateOfBirth: '1990-05-17',
    nationality: 'CM',
    address: { line1: '1 Rue de la Joie', city: 'Douala' },
    country: 'CM',
    jurisdiction: 'CM',
    currency: 'XAF',
    termsVersion: '2026-01',
    acceptedPrivacyNotice: true,
    ageDeclaration: true,
  };
};

interface Started {
  gw: Gateway;
  /** Reads the identity schema directly, to check account state. */
  identityDb: Pool;
  stop: () => Promise<void>;
}

/** A whole gateway on throwaway schemas; stop() closes it and drops them. */
const start = async (demo: boolean): Promise<Started> => {
  const prefix = `gw_t${randomBytes(4).toString('hex')}_`;
  const gw = await buildGateway({ databaseUrl: TEST_DATABASE_URL, demo, allowedOrigins: [], trustProxy: false, schemaPrefix: prefix });
  const identityDb = createPool(TEST_DATABASE_URL, gw.schemas.identity);
  return {
    gw,
    identityDb,
    stop: async () => {
      await gw.app.close();
      for (const s of SERVICES) await identityDb.query(`DROP SCHEMA IF EXISTS ${gw.schemas[s]} CASCADE`);
      await identityDb.end();
    },
  };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const registerAndLogin = async (gw: Gateway): Promise<{ email: string; token: string }> => {
  const body = registration();
  const reg = await gw.app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
  expect(reg.statusCode).toBe(202);
  expect(reg.json()).toEqual({ status: 'accepted' });
  const login = await gw.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: body.email, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  expect(login.headers['cache-control']).toBe('no-store');
  return { email: body.email, token: login.json<{ accessToken: string }>().accessToken };
};

describe('gateway in demo mode', () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(true);
  });
  afterAll(async () => {
    await s?.stop();
  });

  it('healthz and public config need no authentication', async () => {
    const health = await s.gw.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    const config = await s.gw.app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({ demo: true, currency: 'XAF', jurisdiction: 'CM' });
  });

  it('register, login, deposit (idempotent), browse fixtures, bet, list bets, balance reflects the stake', async () => {
    const { app } = s.gw;
    const { email, token } = await registerAndLogin(s.gw);

    // Demo registration activates the player with full KYC, audited as system:demo.
    const row = (
      await s.identityDb.query<{ id: string; state: string; kyc_level: string }>(
        'SELECT id, state, kyc_level FROM players WHERE email = $1',
        [email],
      )
    ).rows[0]!;
    expect(row).toMatchObject({ state: 'ACTIVE', kyc_level: 'FULL' });
    expect((await s.gw.identity.auditTrail(row.id)).map((a) => [a.action, a.actor])).toEqual([
      ['SET_STATE', 'system:demo'],
      ['SET_KYC_LEVEL', 'system:demo'],
    ]);

    const config = await app.inject({ method: 'GET', url: '/v1/config', headers: bearer(token) });
    expect(config.json()).toEqual({ demo: true, currency: 'XAF', jurisdiction: 'CM' });

    // Deposit, then replay with the same requestId: credited once.
    const requestId = randomUUID();
    const dep = await app.inject({ method: 'POST', url: '/v1/demo/deposit', headers: bearer(token), payload: { amount: '50000', requestId } });
    expect(dep.statusCode).toBe(200);
    expect(dep.json()).toEqual({ balance: '50000' });
    const replay = await app.inject({ method: 'POST', url: '/v1/demo/deposit', headers: bearer(token), payload: { amount: '50000', requestId } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ balance: '50000' });

    for (const amount of ['99', '1000001', '12.5', 100]) {
      const bad = await app.inject({ method: 'POST', url: '/v1/demo/deposit', headers: bearer(token), payload: { amount, requestId: randomUUID() } });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers['content-type']).toContain('application/problem+json');
    }

    // Demo fixtures: eight pre-match events, a day to a week ahead; a refresh does not add more.
    const events = (await app.inject({ method: 'GET', url: '/v1/events?sport=soccer', headers: bearer(token) })).json<{
      events: { eventId: string; name: string; startsAt: string; status: string; competition: { name: string } }[];
    }>().events;
    expect(events).toHaveLength(8);
    expect(events.some((e) => e.competition.name === 'Elite One')).toBe(true);
    for (const e of events) {
      const ahead = new Date(e.startsAt).getTime() - Date.now();
      expect(ahead).toBeGreaterThan(0);
      expect(ahead).toBeLessThan(8 * 86_400_000);
    }
    expect(await ingestDemoFixtures(s.gw.catalogue, new Date())).toBe(8);
    const again = (await app.inject({ method: 'GET', url: '/v1/events?sport=soccer', headers: bearer(token) })).json<{ events: unknown[] }>();
    expect(again.events).toHaveLength(8);

    const detail = await app.inject({ method: 'GET', url: `/v1/events/${events[0]!.eventId}`, headers: bearer(token) });
    expect(detail.statusCode).toBe(200);
    const market = detail
      .json<{ markets: { type: string; state: string; selections: { selectionId: string; key: string; odds: string }[] }[] }>()
      .markets.find((m) => m.type === '1X2')!;
    expect(market.state).toBe('OPEN');
    const home = market.selections.find((x) => x.key === 'HOME')!;

    const place = await app.inject({
      method: 'POST',
      url: '/v1/bets',
      headers: { ...bearer(token), 'idempotency-key': randomUUID() },
      payload: { currency: 'XAF', legs: [{ selectionId: home.selectionId, odds: home.odds }], combinationSizes: [1], unitStake: '1000', channel: 'WEB' },
    });
    expect(place.statusCode).toBe(201);
    const bet = place.json<{ betId: string; status: string; totalStake: string }>();
    expect(bet).toMatchObject({ status: 'OPEN', totalStake: '1000' });

    const list = await app.inject({ method: 'GET', url: '/v1/bets', headers: bearer(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ bets: { betId: string }[] }>().bets.map((b) => b.betId)).toEqual([bet.betId]);
    const one = await app.inject({ method: 'GET', url: `/v1/bets/${bet.betId}`, headers: bearer(token) });
    expect(one.json()).toMatchObject({ betId: bet.betId, playerId: row.id });

    const balances = await app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=XAF', headers: bearer(token) });
    expect(balances.statusCode).toBe(200);
    expect(balances.json()).toEqual({
      playerId: row.id,
      currency: 'XAF',
      balances: { CASH: '49000', BONUS: '0', PENDING_WITHDRAWAL: '0' },
    });
  });

  it('forwards responsible-gambling and session routes', async () => {
    const { app } = s.gw;
    const { token } = await registerAndLogin(s.gw);
    const limits = await app.inject({ method: 'GET', url: '/v1/rg/limits', headers: bearer(token) });
    expect(limits.statusCode).toBe(200);
    expect(limits.json()).toMatchObject({ currency: 'XAF' });
    const sessions = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(token) });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json<{ sessions: { current: boolean }[] }>().sessions).toHaveLength(1);
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(token) });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/v1/bets', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
  });

  it('staff, trading, settlement and internal routes are not reachable', async () => {
    const { app } = s.gw;
    const { token } = await registerAndLogin(s.gw);
    const id = randomUUID();
    const hidden: [string, string][] = [
      ['POST', '/v1/internal/postings'],
      ['POST', '/v1/trading/events'],
      ['POST', `/v1/trading/events/${id}/suspend`],
      ['GET', '/v1/settlement/mismatches'],
      ['POST', '/v1/settlement/results/confirm'],
      ['PATCH', `/v1/staff/players/${id}/state`],
      ['GET', `/v1/rg/players/${id}/risk`],
      ['POST', `/v1/rg/rules/CM/versions`],
      ['GET', '/v1/booking-codes'],
    ];
    for (const [method, url] of hidden) {
      const res = await app.inject({ method: method as 'GET', url, headers: { ...bearer(token), 'idempotency-key': randomUUID() }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toMatchObject({ status: 404, title: 'not_found' });
    }
  });

  it('unauthenticated player routes return 401 problem JSON', async () => {
    const res = await s.gw.app.inject({ method: 'GET', url: '/v1/bets' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, title: 'unauthenticated' });
    const dep = await s.gw.app.inject({ method: 'POST', url: '/v1/demo/deposit', payload: { amount: '1000', requestId: randomUUID() } });
    expect(dep.statusCode).toBe(401);
  });

  it('rejects bodies over 64 KB and malformed JSON without leaking details', async () => {
    const big = await s.gw.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ identifier: 'x'.repeat(70 * 1024), password: 'y' }),
    });
    expect(big.statusCode).toBe(413);
    const bad = await s.gw.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"identifier":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ title: 'bad_request', status: 400 });
    expect(bad.body).not.toMatch(/stack|at .*\.js/);
  });
});

describe('gateway with demo mode off', () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(false);
  });
  afterAll(async () => {
    await s?.stop();
  });

  it('has no demo routes or fixtures, and registration leaves the player pending verification', async () => {
    const { app } = s.gw;
    expect((await app.inject({ method: 'GET', url: '/v1/config' })).json()).toEqual({ demo: false, currency: 'XAF', jurisdiction: 'CM' });

    const body = registration();
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
    expect(reg.statusCode).toBe(202);
    expect(reg.json()).toEqual({ status: 'accepted' });
    const row = (await s.identityDb.query<{ state: string; kyc_level: string }>('SELECT state, kyc_level FROM players WHERE email = $1', [body.email]))
      .rows[0];
    expect(row).toEqual({ state: 'PENDING_VERIFICATION', kyc_level: 'NONE' });

    const dep = await app.inject({ method: 'POST', url: '/v1/demo/deposit', payload: { amount: '1000', requestId: randomUUID() } });
    expect(dep.statusCode).toBe(404);
    expect(await s.gw.catalogue.listEvents({ limit: 200 })).toEqual([]);
  });

  it('sends no CORS headers when no origins are configured', async () => {
    const res = await s.gw.app.inject({ method: 'GET', url: '/v1/config', headers: { origin: 'https://example.com' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('gateway CORS', () => {
  it('allows only the configured origins', async () => {
    const prefix = `gw_t${randomBytes(4).toString('hex')}_`;
    const gw = await buildGateway({
      databaseUrl: TEST_DATABASE_URL,
      demo: false,
      allowedOrigins: ['https://play.example.cm'],
      trustProxy: false,
      schemaPrefix: prefix,
    });
    const dropper = createPool(TEST_DATABASE_URL, 'public');
    try {
      const ok = await gw.app.inject({
        method: 'OPTIONS',
        url: '/v1/bets',
        headers: { origin: 'https://play.example.cm', 'access-control-request-method': 'POST' },
      });
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe('https://play.example.cm');
      const other = await gw.app.inject({ method: 'GET', url: '/v1/config', headers: { origin: 'https://evil.example' } });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await gw.app.close();
      for (const s of SERVICES) await dropper.query(`DROP SCHEMA IF EXISTS ${gw.schemas[s]} CASCADE`);
      await dropper.end();
    }
  });
});
