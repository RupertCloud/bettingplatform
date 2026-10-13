import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@bp/common';
import { buildServer, type Principal } from '../src/http.js';
import { feedEvent, setup, type Harness } from './helpers.js';

// Tokens stand in for the identity service: the header names who is calling.
const PRINCIPALS: Record<string, Principal> = {
  trader: { staffId: 'staff-7', roles: ['trader'] },
  support: { staffId: 'staff-8', roles: ['support'] },
  player: { playerId: '11111111-1111-1111-1111-111111111111', roles: ['player'] },
  anonymous: { roles: [] },
};
const authenticate = async (req: FastifyRequest): Promise<Principal> => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const p = token ? PRINCIPALS[token] : PRINCIPALS.anonymous;
  if (!p) throw new AppError('unauthenticated', 401, 'Invalid token');
  return p;
};

let h: Harness;
let app: FastifyInstance;
let eventId: string;
let marketId: string;
let homeId: string;

const as = (who: string) => ({ authorization: `Bearer ${who}` });

beforeAll(async () => {
  h = await setup();
  app = buildServer({ catalogue: h.catalogue, authenticate });
  await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'http-1', status: 'LIVE' })]);
  eventId = (await h.pool.query<{ internal_id: string }>(`SELECT internal_id FROM feed_mappings WHERE entity_type = 'event'`)).rows[0]!
    .internal_id;
  const ev = (await h.catalogue.getEvent(eventId))!;
  marketId = ev.markets[0]!.marketId;
  homeId = ev.markets[0]!.selections.find((s) => s.key === 'HOME')!.selectionId;
});
afterAll(async () => {
  await app.close();
  await h.drop();
});

describe('public catalogue routes', () => {
  it('FR-SPD-003 lists the configured sports', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/sports', headers: as('player') });
    expect(res.statusCode).toBe(200);
    expect(res.json().sports.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['soccer', 'tennis', 'esports']));
  });

  it('FR-SPD-001 lists events filtered by sport and live state', async () => {
    const live = await app.inject({ method: 'GET', url: '/v1/events?sport=soccer&live=true' });
    expect(live.statusCode).toBe(200);
    expect(live.json().events).toEqual([expect.objectContaining({ eventId, inPlay: true, status: 'LIVE' })]);
    const pre = await app.inject({ method: 'GET', url: '/v1/events?sport=soccer&live=false' });
    expect(pre.json().events).toEqual([]);
  });

  it('CON-04 returns an event with prices as decimal strings', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/events/${eventId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markets[0]).toMatchObject({ marketId, type: '1X2', line: null, state: 'OPEN' });
    expect(body.markets[0].selections.find((s: { key: string }) => s.key === 'HOME')).toEqual({
      selectionId: homeId,
      key: 'HOME',
      name: 'Home',
      odds: '2',
      state: 'OPEN',
      priceVersion: 1,
    });
    expect(body.markets[0].selections.find((s: { key: string }) => s.key === 'DRAW').odds).toBe('3.2');
  });

  it('SEC-API-002 rejects malformed parameters with a problem response', async () => {
    const bad = await app.inject({ method: 'GET', url: '/v1/events/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.json()).toMatchObject({ title: 'validation_failed', status: 400 });
    const q = await app.inject({ method: 'GET', url: '/v1/events?live=maybe' });
    expect(q.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/v1/events/00000000-0000-0000-0000-000000000000' });
    expect(missing.statusCode).toBe(404);
  });

  it('SEC-API-001 rejects an invalid token on public routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/sports', headers: as('forged') });
    expect(res.statusCode).toBe(401);
  });
});

describe('trader routes', () => {
  it('SEC-API-001 requires authentication and the trader role', async () => {
    const url = `/v1/trading/markets/${marketId}/suspend`;
    const payload = { reason: 'suspicious volume' };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload, headers: as('player') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload, headers: as('support') })).statusCode).toBe(403);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('OPEN');
  });

  it('FR-RSK-002 suspends and reopens a market, auditing actor, reason and origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trading/markets/${marketId}/suspend`,
      payload: { reason: 'suspicious volume' },
      headers: as('trader'),
    });
    expect(res.statusCode).toBe(204);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('SUSPENDED');
    const reopen = await app.inject({
      method: 'POST',
      url: `/v1/trading/markets/${marketId}/reopen`,
      payload: { reason: 'cleared' },
      headers: as('trader'),
    });
    expect(reopen.statusCode).toBe(204);
    const audit = await h.pool.query<{ actor: string; reason: string; ip: string }>(
      `SELECT actor, reason, ip FROM trader_actions WHERE target_id = $1 ORDER BY id`,
      [marketId],
    );
    expect(audit.rows).toEqual([
      { actor: 'staff-7', reason: 'suspicious volume', ip: '127.0.0.1' },
      { actor: 'staff-7', reason: 'cleared', ip: '127.0.0.1' },
    ]);
  });

  it('FR-SPD-005 returns 409 for an illegal transition', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trading/markets/${marketId}/reopen`,
      payload: { reason: 'again' },
      headers: as('trader'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().title).toBe('illegal_market_transition');
  });

  it('FR-RSK-002 overrides a price given as a decimal string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trading/selections/${homeId}/price`,
      payload: { odds: '1.85', reason: 'liability' },
      headers: as('trader'),
    });
    expect(res.statusCode).toBe(204);
    expect((await h.catalogue.getQuotes([homeId]))[0]!.odds).toBe(18_500n);
  });

  it('SEC-API-002 rejects numeric odds, missing reasons and unknown fields', async () => {
    const url = `/v1/trading/selections/${homeId}/price`;
    for (const payload of [{ odds: 1.85, reason: 'liability' }, { odds: '1.85' }, { odds: '1.85', reason: 'ok!', extra: 1 }, { odds: '1.00005', reason: 'x'.repeat(10) }]) {
      const res = await app.inject({ method: 'POST', url, payload, headers: as('trader') });
      expect(res.statusCode).toBe(400);
    }
    const one = await app.inject({ method: 'POST', url, payload: { odds: '1.0', reason: 'liability' }, headers: as('trader') });
    expect(one.statusCode).toBe(400);
    expect(one.json().title).toBe('invalid_odds');
    const json = await app.inject({ method: 'POST', url, payload: '{bad', headers: { ...as('trader'), 'content-type': 'application/json' } });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({ title: 'bad_request' });
  });

  it('FR-SPD-012 creates a manual event and market over HTTP', async () => {
    const ev = await app.inject({
      method: 'POST',
      url: '/v1/trading/events',
      payload: { sport: 'soccer', competitionName: 'Specials', name: 'Golden Boot', startsAt: '2026-07-01T00:00:00Z', inPlayOffered: true, reason: 'special' },
      headers: as('trader'),
    });
    expect(ev.statusCode).toBe(201);
    const id = ev.json().eventId as string;
    const mk = await app.inject({
      method: 'POST',
      url: `/v1/trading/events/${id}/markets`,
      payload: { type: 'OUTRIGHT', line: null, selections: [{ key: 'KANE', name: 'Kane', odds: '5.5' }], reason: 'special' },
      headers: as('trader'),
    });
    expect(mk.statusCode).toBe(201);
    const detail = await app.inject({ method: 'GET', url: `/v1/events/${id}` });
    expect(detail.json().markets[0].selections[0]).toMatchObject({ key: 'KANE', odds: '5.5', state: 'OPEN' });
  });

  it('SEC-API-007 never leaks internals for unexpected errors', async () => {
    const broken = buildServer({
      catalogue: h.catalogue,
      authenticate: async () => {
        throw new Error('connect ECONNREFUSED db.internal:5432');
      },
    });
    const res = await broken.inject({ method: 'GET', url: '/v1/sports' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.json()).toMatchObject({ title: 'internal' });
    await broken.close();
  });
});
