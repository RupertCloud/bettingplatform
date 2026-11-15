import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedEvent, setup, START, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

const trader = { actor: 'trader-1', reason: 'event cancelled' };

const marketOf = async (externalId: string) => {
  const id = (
    await h.pool.query<{ internal_id: string }>(
      `SELECT internal_id FROM feed_mappings WHERE source = 'betsapi' AND entity_type = 'event' AND external_id = $1`,
      [externalId],
    )
  ).rows[0]!.internal_id;
  const m = (await h.catalogue.getEvent(id))!.markets[0]!;
  return { marketId: m.marketId, selections: m.selections.map((s) => s.selectionId) };
};
const stateOf = async (marketId: string) =>
  (await h.pool.query<{ state: string }>('SELECT state FROM markets WHERE id = $1', [marketId])).rows[0]!.state;

describe('FR-SPD-005 markets reach their final states', () => {
  it('a market is SETTLED only once every selection has a result, and the call is safe to repeat', async () => {
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'fin-1' })]);
    h.clock.t = new Date(START.getTime() + 2 * 3_600_000);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId: 'fin-1', seq: 2n, status: 'ENDED', markets: undefined })]);
    const { marketId, selections } = await marketOf('fin-1');
    expect(await stateOf(marketId)).toBe('CLOSED');

    expect(await h.catalogue.settleMarkets(selections.slice(0, 2), h.clock.t)).toEqual([]);
    expect(await stateOf(marketId)).toBe('CLOSED');
    expect(await h.catalogue.settleMarkets([selections[2]!], h.clock.t)).toEqual([marketId]);
    expect(await stateOf(marketId)).toBe('SETTLED');
    expect(await h.catalogue.settleMarkets(selections, h.clock.t)).toEqual([]);
    const q = await h.catalogue.getQuotes([selections[0]!]);
    expect(q[0]!.marketState).toBe('SETTLED');
  });

  it('a trader can void an open market; a voided or settled market cannot change again', async () => {
    h.clock.t = new Date(START.getTime() - 3_600_000);
    await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId: 'fin-2', home: { externalId: 't-8', name: 'Lyon' }, away: { externalId: 't-9', name: 'Nice' } }),
    ]);
    const { marketId } = await marketOf('fin-2');
    await h.catalogue.voidMarket(marketId, trader);
    expect(await stateOf(marketId)).toBe('VOIDED');
    await expect(h.catalogue.voidMarket(marketId, trader)).rejects.toMatchObject({ code: 'illegal_market_transition' });
    await expect(h.catalogue.reopenMarket(marketId, trader)).rejects.toMatchObject({ code: 'illegal_market_transition' });
  });
});
