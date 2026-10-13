import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, testDb } from '@bp/common';
import { buildServer, MIGRATIONS_DIR, Wallet, type Identity } from '../src/index.js';

let db: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let wallet: Wallet;

// Test auth: the bearer token is a JSON identity.
const authenticate = async (req: { headers: Record<string, unknown> }): Promise<Identity> => {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new AppError('unauthenticated', 401, 'No token');
  return JSON.parse(h.slice(7)) as Identity;
};
const as = (who: Identity) => ({ authorization: `Bearer ${JSON.stringify(who)}` });
const service = as({ staffId: 'svc-payments', roles: ['service'] });

beforeAll(async () => {
  db = await testDb('wallet_http', MIGRATIONS_DIR);
  wallet = new Wallet(db.pool, { now: () => new Date('2026-10-01T00:00:00Z') });
  app = buildServer({ wallet, authenticate });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const depositBody = (playerId: string, amount: string) => ({
  reason: 'DEPOSIT',
  reference: 'psp-1',
  lines: [
    { account: { owner: 'PLAYER', playerId, kind: 'CASH', currency: 'EUR' }, amount },
    { account: { owner: 'OPERATOR', kind: 'PSP_CLEARING', currency: 'EUR' }, amount: `-${amount}` },
  ],
});

describe('POST /v1/internal/postings', () => {
  it('IF-API-003 posts with a decimal-string amount and replays on the same Idempotency-Key', async () => {
    const p = randomUUID();
    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/internal/postings',
        headers: { ...service, 'idempotency-key': key },
        payload: depositBody(p, '12.50'),
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ idempotencyKey: key, reason: 'DEPOSIT', replayed: false });
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(await wallet.balance({ owner: 'PLAYER', playerId: p, kind: 'CASH', currency: 'EUR' })).toBe(1250n);
  });

  it('IF-API-003 requires an Idempotency-Key header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/postings',
      headers: service,
      payload: depositBody(randomUUID(), '1.00'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe('idempotency_key_required');
  });

  it('SEC-API-001 rejects missing auth with 401 and non-service callers with 403', async () => {
    const payload = depositBody(randomUUID(), '1.00');
    const noAuth = await app.inject({ method: 'POST', url: '/v1/internal/postings', headers: { 'idempotency-key': 'k1' }, payload });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.headers['content-type']).toContain('application/problem+json');
    const player = await app.inject({
      method: 'POST',
      url: '/v1/internal/postings',
      headers: { ...as({ playerId: randomUUID(), roles: ['service'] }), 'idempotency-key': 'k2' },
      payload,
    });
    expect(player.statusCode).toBe(403);
    const staff = await app.inject({
      method: 'POST',
      url: '/v1/internal/postings',
      headers: { ...as({ staffId: 'ops-1', roles: ['support'] }), 'idempotency-key': 'k3' },
      payload,
    });
    expect(staff.statusCode).toBe(403);
  });

  it('SEC-API-002 rejects numeric amounts, unknown fields and manual reasons with 400', async () => {
    const p = randomUUID();
    const numeric = { ...depositBody(p, '1.00'), lines: [{ account: { owner: 'PLAYER', playerId: p, kind: 'CASH', currency: 'EUR' }, amount: 1 }] };
    for (const payload of [numeric, { ...depositBody(p, '1.00'), extra: 1 }, { ...depositBody(p, '1.00'), reason: 'ADJUSTMENT' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/postings',
        headers: { ...service, 'idempotency-key': randomUUID() },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().title).toBe('validation_error');
    }
    const precision = await app.inject({
      method: 'POST',
      url: '/v1/internal/postings',
      headers: { ...service, 'idempotency-key': randomUUID() },
      payload: depositBody(p, '1.005'),
    });
    expect(precision.statusCode).toBe(400);
    expect(precision.json().title).toBe('invalid_amount');
  });

  it('FR-WAL-004 returns 422 problem details on insufficient funds without internals', async () => {
    const p = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/postings',
      headers: { ...service, 'idempotency-key': randomUUID() },
      payload: {
        reason: 'BET_STAKE',
        reference: 'bet-1',
        lines: [
          { account: { owner: 'PLAYER', playerId: p, kind: 'CASH', currency: 'EUR' }, amount: '-1.00' },
          { account: { owner: 'OPERATOR', kind: 'BETS_OPEN', currency: 'EUR' }, amount: '1.00' },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ title: 'insufficient_funds', status: 422 });
    expect(res.body).not.toMatch(/stack|SELECT|accounts/i);
  });
});

describe('GET /v1/wallet/balances', () => {
  it('SEC-API-001 a player sees only their own balances, as decimal strings', async () => {
    const p = randomUUID();
    await wallet.post({
      idempotencyKey: randomUUID(),
      reason: 'DEPOSIT',
      reference: 'psp',
      lines: [
        { account: { owner: 'PLAYER', playerId: p, kind: 'CASH', currency: 'EUR' }, amount: 1005n },
        { account: { owner: 'OPERATOR', kind: 'PSP_CLEARING', currency: 'EUR' }, amount: -1005n },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=EUR', headers: as({ playerId: p, roles: [] }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      playerId: p,
      currency: 'EUR',
      balances: { CASH: '10.05', BONUS: '0.00', PENDING_WITHDRAWAL: '0.00' },
    });
    // Another player's ID in the query is not accepted; identity comes only from auth.
    const other = await app.inject({
      method: 'GET',
      url: `/v1/wallet/balances?currency=EUR&playerId=${randomUUID()}`,
      headers: as({ playerId: p, roles: [] }),
    });
    expect(other.statusCode).toBe(400);
  });

  it('SEC-API-001 rejects unauthenticated and staff callers', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=EUR' })).statusCode).toBe(401);
    const staff = await app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=EUR', headers: service });
    expect(staff.statusCode).toBe(403);
  });

  it('SEC-API-002 rejects a bad currency with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/wallet/balances?currency=GBP', headers: as({ playerId: randomUUID(), roles: [] }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe('validation_error');
  });
});
