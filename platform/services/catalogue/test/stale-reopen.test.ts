import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedEvent, market1x2, setup, START, type Harness } from './helpers.js';

// Heartbeats are global state, so these tests run in their own schema, in order.
let h: Harness;
beforeAll(async () => {
  h = await setup();
  h.clock.t = new Date(START.getTime() + 60_000); // the match is under way
});
afterAll(async () => {
  await h.drop();
});

const trader = { actor: 'trader-1', reason: 'test' };

const eventId = async (externalId: string) =>
  (
    await h.pool.query<{ internal_id: string }>(
      `SELECT internal_id FROM feed_mappings WHERE source = 'betsapi' AND entity_type = 'event' AND external_id = $1`,
      [externalId],
    )
  ).rows[0]!.internal_id;

const home = async (id: string) => {
  const ev = await h.catalogue.getEvent(id);
  const sel = ev!.markets[0]!.selections.find((s) => s.key === 'HOME')!;
  const quote = (await h.catalogue.getQuotes([sel.selectionId]))[0]!;
  return { state: sel.state, quoteState: quote.marketState, odds: quote.odds };
};

describe('FR-SPD-006 / FR-SPD-013 reopening after a feed outage', () => {
  let live: string;
  let prematch: string;

  it('FR-SPD-006 a bare heartbeat after an outage does not reopen a live event at its old prices', async () => {
    await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId: 'live-1', status: 'LIVE' }),
      feedEvent({
        externalId: 'pre-1',
        startsAt: new Date(START.getTime() + 86_400_000),
        home: { externalId: 't-3', name: 'Roma' },
        away: { externalId: 't-4', name: 'Lazio' },
      }),
    ]);
    live = await eventId('live-1');
    prematch = await eventId('pre-1');
    expect(await home(live)).toMatchObject({ state: 'OPEN', quoteState: 'OPEN' });

    h.clock.advance(6_000); // outage
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
    await h.catalogue.heartbeat('betsapi'); // keep-alive, no prices
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
    expect(await home(prematch)).toMatchObject({ state: 'OPEN', quoteState: 'OPEN' }); // pre-match unaffected
  });

  it('FR-SPD-006 a market-less update after an outage does not reopen the live event', async () => {
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 2n, status: 'LIVE', markets: undefined })]);
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
  });

  it('FR-SPD-006 an update carrying fresh prices reopens the live event', async () => {
    await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId: 'live-1', seq: 3n, status: 'LIVE', markets: [market1x2(24_000n, 34_000n, 36_000n)] }),
    ]);
    expect(await home(live)).toMatchObject({ state: 'OPEN', quoteState: 'OPEN', odds: 22_800n });
  });

  it('FR-SPD-006 once checkStale marks a live event stale, a market-less update does not clear it', async () => {
    h.clock.advance(6_000);
    expect((await h.catalogue.checkStale(h.clock.t)).suspendedEvents).toEqual([live]);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 4n, status: 'LIVE', markets: undefined })]);
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 5n, status: 'LIVE', markets: [] })]);
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });

    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'live-1', seq: 6n, status: 'LIVE' })]);
    expect(await home(live)).toMatchObject({ state: 'OPEN', quoteState: 'OPEN', odds: 20_000n });
  });

  it('FR-SPD-006 trader suspend and reopen still work on a freshly priced live event', async () => {
    await h.catalogue.suspendEvent(live, trader);
    expect(await home(live)).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
    await h.catalogue.reopenEvent(live, trader);
    expect(await home(live)).toMatchObject({ state: 'OPEN', quoteState: 'OPEN' });
  });
});
