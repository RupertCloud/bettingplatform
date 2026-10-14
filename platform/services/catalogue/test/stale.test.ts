import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedEvent, market1x2, setup, START, type Harness } from './helpers.js';

// Heartbeats and the active source are global state, so these tests run in their own schema, in order.
let h: Harness;
beforeAll(async () => {
  h = await setup();
  h.clock.t = new Date(START.getTime() + 60_000); // the match is under way
});
afterAll(async () => {
  await h.drop();
});

const eventId = async (source: string, externalId: string) =>
  (
    await h.pool.query<{ internal_id: string }>(
      `SELECT internal_id FROM feed_mappings WHERE source = $1 AND entity_type = 'event' AND external_id = $2`,
      [source, externalId],
    )
  ).rows[0]!.internal_id;

const homeState = async (id: string) => {
  const ev = await h.catalogue.getEvent(id);
  return ev!.markets[0]!.selections.find((s) => s.key === 'HOME')!;
};

const activeSource = async (sport: string) =>
  (await h.pool.query<{ active_source: string | null }>('SELECT active_source FROM sports WHERE key = $1', [sport])).rows[0]!
    .active_source;

describe('FR-SPD-006 / FR-SPD-013 heartbeat and failover', () => {
  let live: string;
  let prematch: string;

  it('FR-SPD-006 suspends live markets when the pricing source is silent for more than 5 s', async () => {
    await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId: 'live-1', status: 'LIVE' }),
      feedEvent({
        externalId: 'pre-1',
        startsAt: new Date(START.getTime() + 86_400_000),
        home: { externalId: 't-3', name: 'Roma' },
        away: { externalId: 't-4', name: 'Lazio' },
      }),
    ]);
    await h.catalogue.ingest('backup', [feedEvent({ externalId: 'B-live-1', status: 'LIVE' })]);
    live = await eventId('betsapi', 'live-1');
    prematch = await eventId('betsapi', 'pre-1');
    expect(await eventId('backup', 'B-live-1')).toBe(live);

    h.clock.advance(5_000);
    expect((await h.catalogue.checkStale(h.clock.t)).suspendedEvents).toEqual([]);

    h.clock.advance(1);
    await h.catalogue.heartbeat('backup');
    // Bets are refused as soon as the heartbeat is lost, even before the scheduled check runs.
    const sel = (await homeState(live)).selectionId;
    expect((await h.catalogue.getQuotes([sel]))[0]!.marketState).toBe('SUSPENDED');
    const result = await h.catalogue.checkStale(h.clock.t);
    expect(result.suspendedEvents).toEqual([live]);
    expect(result.failovers).toEqual([]);
    expect((await homeState(live)).state).toBe('SUSPENDED');
    expect((await homeState(prematch)).state).toBe('OPEN'); // pre-match events are not heartbeat-bound
    const last = (await h.catalogue.priceHistory((await homeState(live)).selectionId)).at(-1)!;
    expect(last).toMatchObject({ state: 'SUSPENDED', source: 'system:heartbeat' });
  });

  it('FR-SPD-006 a fresh update from the pricing source lifts the heartbeat suspension', async () => {
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 2n, status: 'LIVE' })]);
    expect((await homeState(live)).state).toBe('OPEN');
  });

  it('FR-SPD-013 fails over to the secondary source when the primary is silent beyond 10 s', async () => {
    h.clock.advance(10_001);
    await h.catalogue.heartbeat('backup');
    const result = await h.catalogue.checkStale(h.clock.t);
    expect(result.failovers).toContainEqual({ sport: 'soccer', from: 'betsapi', to: 'backup' });
    expect(result.suspendedEvents).toEqual([live]);
    expect(await activeSource('soccer')).toBe('backup');

    // The primary's late updates no longer price the sport.
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 3n, status: 'LIVE', markets: [market1x2(50_000n, 34_000n, 36_000n)] })]);
    // ...but that ingest was itself a primary heartbeat, so make the primary silent again.
    await h.pool.query(`UPDATE source_heartbeats SET last_seen = $1 WHERE source = 'betsapi'`, [new Date(h.clock.t.getTime() - 20_000)]);
    expect((await homeState(live)).state).toBe('SUSPENDED');

    // The secondary prices the event and reopens it.
    await h.catalogue.ingest('backup', [feedEvent({ externalId: 'B-live-1', seq: 2n, status: 'LIVE', markets: [market1x2(24_000n, 34_000n, 36_000n)] })]);
    const home = await homeState(live);
    expect(home).toMatchObject({ state: 'OPEN', odds: 22_800n }); // 2.4 / 1.05 = 2.285 -> 2.28
    expect((await h.catalogue.priceHistory(home.selectionId)).at(-1)!.source).toBe('feed:backup');
  });

  it('FR-SPD-013 suspends markets that cannot be priced when neither source is alive', async () => {
    h.clock.advance(6_000);
    const result = await h.catalogue.checkStale(h.clock.t);
    expect(result.failovers).toEqual([]);
    expect(result.suspendedEvents).toEqual([live]);
  });

  it('FR-SPD-013 returns to the primary once it is alive again', async () => {
    await h.catalogue.heartbeat('betsapi');
    const result = await h.catalogue.checkStale(h.clock.t);
    expect(result.failovers).toContainEqual({ sport: 'soccer', from: 'backup', to: 'betsapi' });
    expect(await activeSource('soccer')).toBeNull();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 4n, status: 'LIVE' })]);
    expect((await homeState(live)).state).toBe('OPEN');
  });

  it('FR-SPD-006 rejects heartbeats from unknown sources', async () => {
    await expect(h.catalogue.heartbeat('rogue')).rejects.toMatchObject({ code: 'unknown_source' });
  });
});
