import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@bp/common';
import { buildServer, type Principal } from '../src/index.js';
import { setup, type Env } from './fakes.js';

let env: Env;
let app: FastifyInstance;
let alice: string;
let bob: string;

// Test auth: "Bearer player:<id>" or "Bearer staff:<id>:<role,role>".
const authenticate = async (req: { headers: Record<string, unknown> }): Promise<Principal> => {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new AppError('unauthenticated', 401, 'Login required');
  const [kind, id, roles] = h.slice(7).split(':');
  if (kind === 'player') return { playerId: id!, roles: [] };
  return { staffId: id!, roles: roles ? roles.split(',') : [] };
};

beforeAll(async () => {
  env = await setup();
  app = buildServer({ betting: env.betting, authenticate });
  alice = env.players.add();
  bob = env.players.add();
  env.ledger.fund(alice, 100_000n);
  env.ledger.fund(bob, 100_000n);
  env.catalogue.add('h1', 25_000n);
  env.catalogue.add('h2', 18_000n);
});
afterAll(async () => {
  await app.close();
  await env.db.drop();
});

const as = (who: string) => ({ authorization: `Bearer ${who}` });
const betBody = (over: Record<string, unknown> = {}) => ({
  currency: 'XAF',
  legs: [{ selectionId: 'h1', odds: '2.5' }],
  combinationSizes: [1],
  unitStake: '1000',
  channel: 'WEB',
  ...over,
});
const place = (who: string, key: string, body: unknown = betBody()) =>
  app.inject({ method: 'POST', url: '/v1/bets', headers: { ...as(who), 'idempotency-key': key }, payload: body as object });

describe('HTTP', () => {
  it('SEC-API-001 rejects unauthenticated requests with 401 problem details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/bets' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ title: 'unauthenticated', status: 401 });
  });

  it('IF-API-003 requires an Idempotency-Key to place a bet', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/bets', headers: as(`player:${alice}`), payload: betBody() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ title: 'validation_error' });
  });

  it('SEC-API-002 rejects an invalid body with a validation problem and no internals', async () => {
    const res = await place(`player:${alice}`, randomUUID(), betBody({ unitStake: 10.5, extra: 'x' }));
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.title).toBe('validation_error');
    expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.ts/);
  });

  it('FR-BET-005 FR-BET-006 places a bet with money as strings, and a replay returns the same bet', async () => {
    const key = randomUUID();
    const res = await place(`player:${alice}`, key);
    expect(res.statusCode).toBe(201);
    const bet = res.json();
    expect(bet).toMatchObject({
      status: 'OPEN',
      totalStake: '1000',
      potentialReturn: '2500',
      legs: [{ selectionId: 'h1', odds: '2.5' }],
    });
    const again = await place(`player:${alice}`, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().betId).toBe(bet.betId);
    expect(env.ledger.cash(alice)).toBe(99_000n);
  });

  it('FR-BET-007 returns a specific rejection reason with the current price', async () => {
    const res = await place(`player:${alice}`, randomUUID(), betBody({ legs: [{ selectionId: 'h2', odds: '2' }] }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ title: 'price_changed', currentOdds: '1.8', requestedOdds: '2' });
  });

  it('SEC-API-001 staff cannot place bets for players', async () => {
    const res = await place('staff:s1:trader', randomUUID());
    expect(res.statusCode).toBe(403);
  });

  it('SEC-API-001 FR-BET-011 a player sees only their own bets', async () => {
    const mine = (await place(`player:${bob}`, randomUUID())).json();
    const list = await app.inject({ method: 'GET', url: '/v1/bets?status=OPEN', headers: as(`player:${bob}`) });
    expect(list.statusCode).toBe(200);
    expect(list.json().bets.map((b: { betId: string }) => b.betId)).toEqual([mine.betId]);

    const own = await app.inject({ method: 'GET', url: `/v1/bets/${mine.betId}`, headers: as(`player:${bob}`) });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: `/v1/bets/${mine.betId}`, headers: as(`player:${alice}`) });
    expect(other.statusCode).toBe(404);
    const spy = await app.inject({ method: 'GET', url: `/v1/bets?playerId=${bob}`, headers: as(`player:${alice}`) });
    expect(spy.statusCode).toBe(403);
    const badId = await app.inject({ method: 'GET', url: '/v1/bets/not-a-uuid', headers: as(`player:${bob}`) });
    expect(badId.statusCode).toBe(400);
  });

  it('SEC-API-001 staff need a read role to see a player\'s bets', async () => {
    const noRole = await app.inject({ method: 'GET', url: `/v1/bets?playerId=${bob}`, headers: as('staff:s2:marketing') });
    expect(noRole.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: `/v1/bets?playerId=${bob}`, headers: as('staff:s3:support') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bets.length).toBe(1);
  });

  it('FR-BET-009 saves and loads a booking code over HTTP', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/booking-codes',
      headers: as(`player:${alice}`),
      payload: { selectionIds: ['h1', 'h2'] },
    });
    expect(saved.statusCode).toBe(201);
    const { code } = saved.json();
    const loaded = await app.inject({ method: 'GET', url: `/v1/booking-codes/${code}`, headers: as(`player:${bob}`) });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().selections.map((s: { odds: string }) => s.odds)).toEqual(['2.5', '1.8']);
    const bad = await app.inject({ method: 'GET', url: '/v1/booking-codes/0000', headers: as(`player:${bob}`) });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: `/v1/booking-codes/${code}` });
    expect(anon.statusCode).toBe(401);
  });
});
