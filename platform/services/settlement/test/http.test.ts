import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, testDb } from '@bp/common';
import { buildServer, Settlement, type Identity } from '../src/index.js';
import { FakeBetStore, FakeLedger, makeBet } from './fakes.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

// Bearer token -> identity; anything else is unauthenticated.
const USERS: Record<string, Identity> = {
  trader1: { staffId: 'tr-1', roles: ['trader'] },
  trader2: { staffId: 'tr-2', roles: ['trader'] },
  finance: { staffId: 'fi-1', roles: ['finance'] },
  player: { playerId: 'p-1', roles: [] },
};

let db: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let svc: Settlement;
const bets = new FakeBetStore();
const ledger = new FakeLedger();

beforeAll(async () => {
  db = await testDb('settlement', MIGRATIONS);
  svc = new Settlement({ pool: db.pool, bets, ledger, now: () => new Date('2026-10-01T18:00:00Z'), approvalThresholds: { XAF: 5_000n } });
  app = buildServer({
    settlement: svc,
    authenticate: async (req) => {
      const user = USERS[(req.headers.authorization ?? '').replace(/^Bearer /, '')];
      if (!user) throw new AppError('unauthenticated', 401, 'no session');
      return user;
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const as = (user: string, key?: string) => ({
  authorization: `Bearer ${user}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

describe('settlement HTTP', () => {
  it('SEC-API-001 rejects missing auth with 401 and wrong roles with 403', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/settlement/mismatches' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ type: 'urn:bp:error:unauthenticated', status: 401 });
    const player = await app.inject({ method: 'GET', url: '/v1/settlement/mismatches', headers: as('player') });
    expect(player.statusCode).toBe(403);
    const fin = await app.inject({ method: 'GET', url: '/v1/settlement/mismatches', headers: as('finance') });
    expect(fin.statusCode).toBe(403);
    const trader = await app.inject({ method: 'GET', url: '/v1/settlement/manual-review', headers: as('trader1') });
    expect(trader.statusCode).toBe(403);
    const confirm = await app.inject({
      method: 'POST', url: '/v1/settlement/results/confirm', headers: as('player', 'idem-key-0001'),
      payload: { selectionId: 's1', resultVersion: 1, outcome: 'WON' },
    });
    expect(confirm.statusCode).toBe(403);
  });

  it('SEC-API-002 validates bodies and params as problem details', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/v1/settlement/results/confirm', headers: as('trader1', 'idem-key-0002'),
      payload: { selectionId: 's1', resultVersion: 0, outcome: 'MAYBE', extra: 1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.json()).toMatchObject({ title: 'validation_failed', status: 400 });
    const dh = await app.inject({
      method: 'POST', url: '/v1/settlement/results/confirm', headers: as('trader1', 'idem-key-0003'),
      payload: { selectionId: 's1', resultVersion: 1, outcome: 'DEAD_HEAT' },
    });
    expect(dh.statusCode).toBe(400);
    const param = await app.inject({ method: 'POST', url: '/v1/settlement/manual-actions/not-a-uuid/approve', headers: as('trader2', 'idem-key-0004') });
    expect(param.statusCode).toBe(400);
    const junk = await app.inject({
      method: 'POST', url: '/v1/settlement/manual-actions', headers: { ...as('trader1', 'idem-key-0005'), 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.body).not.toMatch(/at |stack|Unexpected token/);
  });

  it('IF-API-003 requires an Idempotency-Key on mutating routes', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/settlement/manual-actions', headers: as('trader1'),
      payload: { action: 'VOID', reason: 'Abandoned', results: [{ selectionId: 's1' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe('idempotency_key_required');
  });

  it('FR-STL-001 trader lists mismatches and confirms a result, which settles the bets', async () => {
    const s = `sel-${randomUUID()}`;
    const bet = bets.add(makeBet({ legs: [[s, '2.50']], unitStake: 1_000n }));
    await svc.recordResult({ selectionId: s, outcome: 'WON', source: 'feed:primary', resultVersion: 1 });
    await svc.recordResult({ selectionId: s, outcome: 'LOST', source: 'feed:secondary', resultVersion: 1 });
    const list = await app.inject({ method: 'GET', url: '/v1/settlement/mismatches', headers: as('trader1') });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.find((m: { selectionId: string }) => m.selectionId === s)).toMatchObject({
      primary: { outcome: 'WON' }, secondary: { outcome: 'LOST' },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/settlement/results/confirm', headers: as('trader1', 'idem-key-0006'),
      payload: { selectionId: s, resultVersion: 1, outcome: 'WON' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.results).toEqual([{ betId: bet.betId, outcome: 'SETTLED' }]);
    expect(ledger.cash(bet.playerId)).toBe(2_500n);
  });

  it('FR-STL-009 manual void above threshold needs a second trader; finance sees the review queue', async () => {
    const s = `sel-${randomUUID()}`;
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 6_000n }));
    const req = await app.inject({
      method: 'POST', url: '/v1/settlement/manual-actions', headers: as('trader1', 'idem-key-0007'),
      payload: { action: 'VOID', reason: 'Event abandoned', results: [{ selectionId: s }] },
    });
    expect(req.statusCode).toBe(202);
    const body = req.json();
    expect(body).toMatchObject({ status: 'PENDING_APPROVAL', affectedStake: [{ currency: 'XAF', amount: '6000' }] });
    const self = await app.inject({ method: 'POST', url: `/v1/settlement/manual-actions/${body.actionId}/approve`, headers: as('trader1', 'idem-key-0008') });
    expect(self.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/v1/settlement/manual-actions/${body.actionId}/approve`, headers: as('trader2', 'idem-key-0009') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'EXECUTED', approvedBy: 'tr-2' });
    expect(ledger.cash(bet.playerId)).toBe(6_000n);

    const review = await app.inject({ method: 'GET', url: '/v1/settlement/manual-review', headers: as('finance') });
    expect(review.statusCode).toBe(200);
    expect(Array.isArray(review.json().items)).toBe(true);
  });

  it('FR-STL-006 manual-review amounts cross HTTP as decimal strings', async () => {
    const s = `sel-${randomUUID()}`;
    const bet = bets.add(makeBet({ legs: [[s, '2.00']], unitStake: 100n, currency: 'EUR' }));
    await svc.recordResult({ selectionId: s, outcome: 'WON', source: 'feed:primary', resultVersion: 1 });
    const r1 = await svc.recordResult({ selectionId: s, outcome: 'WON', source: 'feed:secondary', resultVersion: 1 });
    if (r1.status !== 'CONFIRMED') throw new Error('expected confirm');
    await svc.settleSelections([r1.resultId]);
    ledger.balances.set(`P:${bet.playerId}:CASH:EUR`, 0n);
    await svc.recordResult({ selectionId: s, outcome: 'LOST', source: 'feed:primary', resultVersion: 2 });
    const r2 = await svc.recordResult({ selectionId: s, outcome: 'LOST', source: 'feed:secondary', resultVersion: 2 });
    if (r2.status !== 'CONFIRMED') throw new Error('expected confirm');
    await svc.settleSelections([r2.resultId]);
    const review = await app.inject({ method: 'GET', url: '/v1/settlement/manual-review', headers: as('finance') });
    expect(review.json().items.find((i: { betId: string }) => i.betId === bet.betId)).toMatchObject({ currency: 'EUR', deltaNet: '-2.00' });
  });
});
