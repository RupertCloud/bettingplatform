import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@bp/common';
import { buildServer, type Identity } from '../src/index.js';
import { DAY, HOUR, setup, type Harness } from './helpers.js';

let h: Harness;
let app: FastifyInstance;
let player: string;
let other: string;

// Test tokens: "player:<id>" or "staff:<id>:<role,role>".
const authenticate = async (req: FastifyRequest): Promise<Identity> => {
  const auth = req.headers.authorization;
  if (!auth) throw new AppError('unauthenticated', 401, 'Authentication required');
  const [kind, id, roles] = auth.replace(/^Bearer /, '').split(':');
  if (kind === 'player' && id) return { playerId: id, roles: [] };
  if (kind === 'staff' && id) return { staffId: id, roles: roles ? roles.split(',') : [] };
  throw new AppError('unauthenticated', 401, 'Bad token');
};

const asPlayer = (id: string) => ({ authorization: `Bearer player:${id}` });
const compliance = (id = 'officer1') => ({ authorization: `Bearer staff:${id}:compliance` });

beforeAll(async () => {
  h = await setup();
  player = h.addPlayer('XAF');
  other = h.addPlayer('XAF');
  app = buildServer({ rg: h.rg, authenticate });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await h.drop();
});

describe('HTTP', () => {
  it('SEC-API-001 rejects unauthenticated requests with 401 problem details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/rg/limits' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ title: 'unauthenticated', status: 401 });
  });

  it('SEC-API-001 enforces roles: players cannot use staff routes and staff without compliance cannot either', async () => {
    let res = await app.inject({ method: 'GET', url: `/v1/rg/players/${player}/risk`, headers: asPlayer(player) });
    expect(res.statusCode).toBe(403);
    res = await app.inject({ method: 'GET', url: `/v1/rg/players/${player}/risk`, headers: { authorization: 'Bearer staff:t1:trader' } });
    expect(res.statusCode).toBe(403);
    res = await app.inject({ method: 'GET', url: '/v1/rg/limits', headers: compliance() });
    expect(res.statusCode).toBe(403);
  });

  it('SEC-API-002 validates bodies and params', async () => {
    let res = await app.inject({ method: 'PUT', url: '/v1/rg/limits', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY', value: 5000 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ title: 'validation_error' });
    res = await app.inject({ method: 'PUT', url: '/v1/rg/limits', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY', value: '10.5' } });
    expect(res.statusCode).toBe(400); // XAF has no decimals
    res = await app.inject({ method: 'PUT', url: '/v1/rg/limits', headers: asPlayer(player), payload: { kind: 'SESSION_MINUTES', value: '0' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: '/v1/rg/players/not-a-uuid/risk', headers: compliance() });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: 'POST', url: '/v1/rg/time-out', headers: { ...asPlayer(player), 'content-type': 'application/json' }, payload: '{bad json',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).not.toMatch(/at .*\.js|stack/i);
  });

  it('FR-RG-001 FR-RG-003 players manage their own limits as decimal strings', async () => {
    let res = await app.inject({ method: 'PUT', url: '/v1/rg/limits', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY', value: '50000' } });
    expect(res.json()).toEqual({ kind: 'DEPOSIT_DAY', status: 'APPLIED' });
    res = await app.inject({ method: 'PUT', url: '/v1/rg/limits', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY', value: '80000' } });
    expect(res.json()).toMatchObject({ status: 'PENDING', availableAt: new Date(h.clock.now().getTime() + 24 * HOUR).toISOString() });
    res = await app.inject({ method: 'POST', url: '/v1/rg/limits/confirm', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ title: 'cooling_off_active' });

    res = await app.inject({ method: 'GET', url: '/v1/rg/limits', headers: asPlayer(player) });
    const day = res.json().limits.find((l: { kind: string }) => l.kind === 'DEPOSIT_DAY');
    expect(day).toMatchObject({ value: '50000', pending: { value: '80000' } });
    // Another player sees only their own limits.
    res = await app.inject({ method: 'GET', url: '/v1/rg/limits', headers: asPlayer(other) });
    expect(res.json().limits.every((l: { value: unknown }) => l.value === null)).toBe(true);

    h.clock.advance(DAY);
    res = await app.inject({ method: 'POST', url: '/v1/rg/limits/confirm', headers: asPlayer(player), payload: { kind: 'DEPOSIT_DAY' } });
    expect(res.json()).toEqual({ kind: 'DEPOSIT_DAY', value: '80000', status: 'CONFIRMED' });
  });

  it('FR-RG-004 players can take a time-out and self-exclude', async () => {
    let res = await app.inject({ method: 'POST', url: '/v1/rg/time-out', headers: asPlayer(other), payload: { period: '7d' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: 'TIMED_OUT' });
    res = await app.inject({ method: 'POST', url: '/v1/rg/self-exclusion', headers: asPlayer(other), payload: { period: 'permanent' } });
    expect(res.json()).toEqual({ state: 'SELF_EXCLUDED', until: null });
    res = await app.inject({ method: 'POST', url: '/v1/rg/self-exclusion', headers: asPlayer(other), payload: { period: '2w' } });
    expect(res.statusCode).toBe(400);
  });

  it('FR-JUR-003 compliance proposes and a second officer approves a rules version', async () => {
    const current = (await h.rg.rulesFor('CM', h.clock.now())).rules;
    const rules = { ...current, affordabilityNetDepositThreshold: '400000', minAge: 21 };
    const effectiveFrom = new Date(h.clock.now().getTime() + DAY).toISOString();
    let res = await app.inject({
      method: 'POST', url: '/v1/rg/rules/CM/versions', headers: compliance('officer1'), payload: { rules, effectiveFrom, reason: 'Raise minimum age' },
    });
    expect(res.statusCode).toBe(201);
    const version = res.json().version as number;
    expect(res.json().rules.affordabilityNetDepositThreshold).toBe('400000');
    res = await app.inject({ method: 'POST', url: `/v1/rg/rules/CM/versions/${version}/approval`, headers: compliance('officer1'), payload: { reason: 'Self approval' } });
    expect(res.statusCode).toBe(403);
    res = await app.inject({ method: 'POST', url: `/v1/rg/rules/CM/versions/${version}/approval`, headers: compliance('officer2'), payload: { reason: 'Reviewed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'APPROVED', approvedBy: 'officer2' });
    res = await app.inject({
      method: 'POST', url: '/v1/rg/rules/CM/versions', headers: compliance(), payload: { rules: { ...rules, extra: 1 }, effectiveFrom, reason: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('FR-RG-011 compliance records interventions with outcomes and reads risk', async () => {
    let res = await app.inject({
      method: 'POST', url: `/v1/rg/players/${player}/interventions`, headers: compliance(), payload: { type: 'CALL_TASK', reason: 'Night play pattern' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    res = await app.inject({
      method: 'POST', url: `/v1/rg/interventions/${id}/outcome`, headers: compliance(), payload: { outcome: 'COMPLETED', reason: 'Spoke to player' },
    });
    expect(res.json()).toMatchObject({ outcome: 'COMPLETED', outcomeBy: 'officer1' });
    await h.rg.scoreRisk(player);
    res = await app.inject({ method: 'GET', url: `/v1/rg/players/${player}/risk`, headers: compliance() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ playerId: player, latest: { level: 'LOW' }, interventions: [{ type: 'CALL_TASK' }] });
  });

  it('FR-RG-012 compliance resolves an affordability case', async () => {
    const p = h.addPlayer('XAF');
    await h.rg.checkAndRecordDeposit(p, 'XAF', 400_000n, 'big', h.clock.now());
    const c = await h.rg.openAffordabilityCase(p);
    expect(c).not.toBeNull();
    let res = await app.inject({
      method: 'POST', url: `/v1/rg/affordability/${c!.id}/resolution`, headers: asPlayer(p), payload: { approvedAmount: '1000000', currency: 'XAF', reason: 'x' },
    });
    expect(res.statusCode).toBe(403);
    res = await app.inject({
      method: 'POST', url: `/v1/rg/affordability/${c!.id}/resolution`, headers: compliance(),
      payload: { approvedAmount: '1000000', currency: 'XAF', reason: 'Bank statements' },
    });
    expect(res.json()).toEqual({ id: c!.id, status: 'CLEARED' });
  });

  it('IF-API-002 unknown routes return problem details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: asPlayer(player) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ type: 'urn:bp:error:not_found' });
  });
});
