import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, TEST_DATABASE_URL, type Pool } from '@bp/common';
import { buildGateway, buildOps, demoDeposit, demoFeedPayload, runOnce, SERVICES, type Gateway, type Ops } from '../src/index.js';

const PASSWORD = 'correct horse battery staple';
const token = (name: string) => `${name}-${randomBytes(24).toString('hex')}`;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const TOKENS = {
  compliance: token('compliance'),
  trader: token('trader'),
  feed: token('feed'),
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let gw: Gateway;
let ops: Ops;
let db: Pool;
let prefix: string;

beforeAll(async () => {
  prefix = `ops_t${randomBytes(4).toString('hex')}_`;
  const mfaKey = randomBytes(32);
  // The public gateway (not demo) and the internal ops service share one database, as deployed.
  gw = await buildGateway({ databaseUrl: TEST_DATABASE_URL, demo: false, allowedOrigins: [], trustProxy: false, schemaPrefix: prefix, mfaKey });
  ops = await buildOps({
    databaseUrl: TEST_DATABASE_URL,
    schemaPrefix: prefix,
    mfaKey,
    resultSources: 1,
    jobs: false,
    staffTokens: [
      { tokenSha256: sha(TOKENS.compliance), staffId: 'comp-1', roles: ['compliance'] },
      { tokenSha256: sha(TOKENS.trader), staffId: 'trader-1', roles: ['trader'] },
      { tokenSha256: sha(TOKENS.feed), staffId: 'feed-1', roles: ['feed'] },
    ],
  });
  db = createPool(TEST_DATABASE_URL, gw.schemas.identity);
});
afterAll(async () => {
  await ops?.app.close();
  await gw?.app.close();
  for (const s of SERVICES) await db.query(`DROP SCHEMA IF EXISTS ${prefix}${s} CASCADE`);
  await db.end();
});

describe('ops service', () => {
  it('needs a staff token: anonymous callers and player tokens are refused', async () => {
    expect((await ops.app.inject({ method: 'GET', url: '/v1/settlement/mismatches' })).statusCode).toBe(401);
    expect((await ops.app.inject({ method: 'GET', url: '/v1/settlement/mismatches', headers: bearer(randomBytes(32).toString('hex')) })).statusCode).toBe(401);
    expect((await ops.app.inject({ method: 'POST', url: '/v1/feed/heartbeat', headers: bearer(TOKENS.trader) })).statusCode).toBe(403);
    expect((await ops.app.inject({ method: 'GET', url: '/v1/settlement/manual-review', headers: bearer(TOKENS.trader) })).statusCode).toBe(403);
    expect((await ops.app.inject({ method: 'GET', url: '/v1/wallet/balances', headers: bearer(TOKENS.trader) })).statusCode).toBe(404);
  });

  it('end to end without demo mode: activate, fund, bet, result in, bet settled and market settled', async () => {
    // A player registers on the public gateway and stays PENDING_VERIFICATION.
    const n = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const reg = await gw.app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        email: `p${n}@example.cm`, username: `p${n}`, password: PASSWORD, legalName: 'Ops Player', dateOfBirth: '1990-05-17',
        nationality: 'CM', address: { line1: '1 Rue', city: 'Douala' }, country: 'CM', jurisdiction: 'CM', currency: 'XAF',
        termsVersion: '2026-01', acceptedPrivacyNotice: true, ageDeclaration: true,
      },
    });
    expect(reg.statusCode).toBe(202);
    const playerId = (await db.query<{ id: string }>('SELECT id FROM players WHERE username = $1', [`p${n}`])).rows[0]!.id;

    // Compliance activates the account and records KYC through the ops service.
    const kyc = await ops.app.inject({
      method: 'PATCH', url: `/v1/staff/players/${playerId}/kyc`, headers: bearer(TOKENS.compliance), payload: { level: 'FULL', reason: 'Documents checked' },
    });
    expect(kyc.statusCode).toBe(204);
    const state = await ops.app.inject({
      method: 'PATCH', url: `/v1/staff/players/${playerId}/state`, headers: bearer(TOKENS.compliance), payload: { state: 'ACTIVE', reason: 'Email confirmed by phone' },
    });
    expect(state.statusCode).toBe(200);
    await demoDeposit({ rg: ops.services.rg, wallet: ops.services.wallet, now: () => new Date() }, playerId, 10_000n, randomUUID());

    // The feed pushes fixtures; the player bets on the public gateway.
    const ingested = await ops.app.inject({ method: 'POST', url: '/v1/feed/events', headers: bearer(TOKENS.feed), payload: demoFeedPayload(new Date()) });
    expect(ingested.statusCode).toBe(200);
    const login = await gw.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: `p${n}`, password: PASSWORD } });
    const access = login.json<{ accessToken: string }>().accessToken;
    const events = (await gw.app.inject({ method: 'GET', url: '/v1/events?sport=soccer', headers: bearer(access) })).json<{ events: { eventId: string }[] }>().events;
    const market = (await gw.app.inject({ method: 'GET', url: `/v1/events/${events[0]!.eventId}`, headers: bearer(access) }))
      .json<{ markets: { marketId: string; type: string; selections: { selectionId: string; key: string; odds: string }[] }[] }>()
      .markets.find((m) => m.type === '1X2')!;
    const home = market.selections.find((s) => s.key === 'HOME')!;
    const place = await gw.app.inject({
      method: 'POST', url: '/v1/bets', headers: { ...bearer(access), 'idempotency-key': randomUUID() },
      payload: { currency: 'XAF', legs: [{ selectionId: home.selectionId, odds: home.odds }], combinationSizes: [1], unitStake: '1000', channel: 'WEB' },
    });
    expect(place.statusCode).toBe(201);
    const betId = place.json<{ betId: string }>().betId;

    // Results come in through the ops service: the bet settles and pays, and the market settles.
    const results = await ops.app.inject({
      method: 'POST', url: '/v1/feed/results', headers: bearer(TOKENS.feed),
      payload: {
        results: market.selections.map((s) => ({
          selectionId: s.selectionId, source: 'primary', resultVersion: 1, outcome: s.key === 'HOME' ? 'WON' : 'LOST',
        })),
      },
    });
    expect(results.statusCode).toBe(200);
    expect(results.json()).toMatchObject({ settlement: { results: [{ betId, outcome: 'SETTLED' }], failed: [] }, settledMarkets: [market.marketId] });
    const bet = (await gw.app.inject({ method: 'GET', url: `/v1/bets/${betId}`, headers: bearer(access) })).json<{ status: string }>();
    expect(bet.status).toBe('SETTLED');
    const cash = (await gw.app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=XAF', headers: bearer(access) })).json<{ balances: { CASH: string } }>();
    const payout = (1000 * Number(home.odds)).toFixed(0);
    expect(cash.balances.CASH).toBe(String(9000 + Number(payout)));
  });

  it('runs each timed job on one instance at a time', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const job = { name: `test-${randomUUID()}`, everyMs: 1000, run: async () => { calls++; await gate; } };
    const first = runOnce(ops.services.pools.settlement, job, new Date());
    await new Promise((r) => setTimeout(r, 50));
    expect(await runOnce(ops.services.pools.settlement, job, new Date())).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    for (const j of ops.jobs) await runOnce(ops.services.pools.settlement, j, new Date()); // every job runs cleanly
  });
});
