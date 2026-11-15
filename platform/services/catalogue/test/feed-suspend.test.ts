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

const home = async (externalId: string) => {
  const id = (
    await h.pool.query<{ internal_id: string }>(
      `SELECT internal_id FROM feed_mappings WHERE source = 'betsapi' AND entity_type = 'event' AND external_id = $1`,
      [externalId],
    )
  ).rows[0]!.internal_id;
  const ev = await h.catalogue.getEvent(id);
  const sel = ev!.markets[0]!.selections.find((s) => s.key === 'HOME')!;
  const quote = (await h.catalogue.getQuotes([sel.selectionId]))[0]!;
  return { state: sel.state, quoteState: quote.marketState, odds: quote.odds };
};

describe("FR-SPD-006 the feed's own suspension flag", () => {
  it('stays on after "interrupted" then "in play" with no prices, so old prices are not offered', async () => {
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'int-1', status: 'LIVE' })]);
    expect(await home('int-1')).toMatchObject({ state: 'OPEN', quoteState: 'OPEN' });

    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'int-1', seq: 2n, status: 'LIVE', suspended: true, markets: undefined })]);
    expect(await home('int-1')).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });

    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'int-1', seq: 3n, status: 'LIVE', suspended: false, markets: undefined })]);
    expect(await home('int-1')).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'int-1', seq: 4n, status: 'LIVE', suspended: false, markets: [] })]);
    expect(await home('int-1')).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
  });

  it('is lifted by an update that carries fresh prices', async () => {
    await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId: 'int-1', seq: 5n, status: 'LIVE', suspended: false, markets: [market1x2(24_000n, 34_000n, 36_000n)] }),
    ]);
    expect(await home('int-1')).toMatchObject({ state: 'OPEN', quoteState: 'OPEN', odds: 22_800n });
  });

  it('a priced update that itself says suspended keeps the event suspended', async () => {
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'int-1', seq: 6n, status: 'LIVE', suspended: true })]);
    expect(await home('int-1')).toMatchObject({ state: 'SUSPENDED', quoteState: 'SUSPENDED' });
  });
});
