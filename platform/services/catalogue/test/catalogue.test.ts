import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedEvent, market1x2, setup, START, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h.drop();
});

let ext = 0;
/** A fresh external id per test so tests in this file do not interfere. */
const fresh = (prefix = 'ev') => `${prefix}-${++ext}`;

const eventIdFor = async (source: string, externalId: string): Promise<string> =>
  (
    await h.pool.query<{ internal_id: string }>(
      `SELECT internal_id FROM feed_mappings WHERE source = $1 AND entity_type = 'event' AND external_id = $2`,
      [source, externalId],
    )
  ).rows[0]!.internal_id;

const selections = async (eventId: string) => {
  const ev = await h.catalogue.getEvent(eventId);
  return Object.fromEntries(ev!.markets.flatMap((m) => m.selections.map((s) => [`${m.type}:${s.key}`, s])));
};

const ingestFresh = async (overrides: Parameters<typeof feedEvent>[0] = {}) => {
  const externalId = fresh();
  await h.catalogue.ingest('betsapi', [feedEvent({ externalId, ...overrides })]);
  const eventId = await eventIdFor('betsapi', externalId);
  return { externalId, eventId };
};

const trader = { actor: 'staff-1', reason: 'integrity alert', ip: '10.0.0.1' };

describe('feed ingestion', () => {
  it('FR-RSK-001 prices feed odds with the default margin and the ladder', async () => {
    const { eventId } = await ingestFresh();
    const s = await selections(eventId);
    expect(s['1X2:HOME']).toMatchObject({ odds: 20_000n, state: 'OPEN', priceVersion: 1 });
    expect(s['1X2:DRAW']!.odds).toBe(32_000n); // 3.4 / 1.05 = 3.238 -> 3.20
    expect(s['1X2:AWAY']!.odds).toBe(34_000n); // 3.6 / 1.05 = 3.428 -> 3.40
  });

  it('FR-RSK-001 uses the most specific margin for sport, competition, market type and in-play', async () => {
    const competition = { externalId: fresh('lg'), name: 'ATP Rome' };
    const { externalId, eventId } = await ingestFresh({ sport: 'tennis', competition });
    const competitionId = (await h.catalogue.getEvent(eventId))!.competitionId;
    await h.catalogue.setMargin({ sport: 'tennis', marginBp: 1000 }, trader);
    await h.catalogue.setMargin({ sport: 'tennis', competitionId, marketType: '1X2', marginBp: 0 }, trader);
    await h.catalogue.setMargin({ sport: 'tennis', competitionId, marketType: '1X2', inPlay: true, marginBp: 2000 }, trader);

    const other = await ingestFresh({ sport: 'tennis', competition: { externalId: fresh('lg'), name: 'Other' } });
    expect((await selections(other.eventId))['1X2:HOME']!.odds).toBe(19_000n); // sport-wide 10 %: 2.1 / 1.1 = 1.909 -> 1.90

    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, sport: 'tennis', competition, seq: 2n })]);
    expect((await selections(eventId))['1X2:HOME']!.odds).toBe(21_000n); // competition + 1X2, pre-match: 0 %
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, sport: 'tennis', competition, seq: 3n, status: 'LIVE' })]);
    expect((await selections(eventId))['1X2:HOME']!.odds).toBe(17_500n); // in-play 20 %: 2.1 / 1.2 = 1.75
    const audit = await h.pool.query(`SELECT 1 FROM trader_actions WHERE action = 'SET_MARGIN'`);
    expect(audit.rowCount).toBe(3);
  });

  it('FR-SPD-002 maps external ids to one stable internal id and reuses it on later updates', async () => {
    const externalId = fresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 1n })]);
    const id1 = await eventIdFor('betsapi', externalId);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n })]);
    expect(await eventIdFor('betsapi', externalId)).toBe(id1);
    const count = await h.pool.query(`SELECT 1 FROM feed_mappings WHERE entity_type = 'event' AND internal_id = $1`, [id1]);
    expect(count.rowCount).toBe(1);
  });

  it('FR-SPD-002 maps the same fixture from the secondary source onto the same internal event', async () => {
    const externalId = fresh();
    const home = { externalId: fresh('t'), name: 'Lyon' };
    const away = { externalId: fresh('t'), name: 'Nice' };
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, home, away })]);
    await h.catalogue.ingest('backup', [
      feedEvent({ externalId: 'B-' + externalId, home: { externalId: 'x' + home.externalId, name: 'LYON' }, away: { externalId: 'x' + away.externalId, name: 'nice' } }),
    ]);
    expect(await eventIdFor('backup', 'B-' + externalId)).toBe(await eventIdFor('betsapi', externalId));
  });

  it('FR-SPD-001 ignores stale and out-of-order updates by sequence number', async () => {
    const externalId = fresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 5n, markets: [market1x2(21_000n, 34_000n, 36_000n)] })]);
    const result = await h.catalogue.ingest('betsapi', [
      feedEvent({ externalId, seq: 4n, markets: [market1x2(50_000n, 34_000n, 36_000n)] }),
      feedEvent({ externalId, seq: 5n, markets: [market1x2(50_000n, 34_000n, 36_000n)] }),
    ]);
    expect(result).toEqual({ applied: 0, ignored: 2 });
    expect((await selections(await eventIdFor('betsapi', externalId)))['1X2:HOME']!.odds).toBe(20_000n);
  });

  it('FR-SPD-001 handles concurrent deliveries of a new event without duplicates', async () => {
    const externalId = fresh();
    await Promise.all(
      [3n, 1n, 5n, 2n, 4n].map((seq) => h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq, markets: [market1x2(20_000n + seq * 1_000n, 34_000n, 36_000n)] })])),
    );
    const maps = await h.pool.query<{ internal_id: string; last_seq: bigint }>(
      `SELECT internal_id, last_seq FROM feed_mappings WHERE source = 'betsapi' AND entity_type = 'event' AND external_id = $1`,
      [externalId],
    );
    expect(maps.rows).toHaveLength(1);
    expect(maps.rows[0]!.last_seq).toBe(5n);
    // seq 5 carried 2.5 -> 2.5 / 1.05 = 2.38 -> 2.38
    expect((await selections(maps.rows[0]!.internal_id))['1X2:HOME']!.odds).toBe(23_800n);
    const teams = await h.pool.query(`SELECT 1 FROM participants WHERE name = 'Arsenal'`);
    expect(teams.rowCount).toBe(1);
  });

  it('FR-SPD-009 keeps an append-only history of every price and state change', async () => {
    const externalId = fresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 1n })]);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, markets: [market1x2(22_000n, 34_000n, 36_000n)] })]);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n, markets: [market1x2(22_000n, 34_000n, 36_000n, true)] })]);
    const home = (await selections(await eventIdFor('betsapi', externalId)))['1X2:HOME']!;
    const history = await h.catalogue.priceHistory(home.selectionId);
    expect(history.map((r) => [r.odds, r.state, r.priceVersion, r.source])).toEqual([
      [20_000n, 'OPEN', 1, 'feed:betsapi'],
      [20_800n, 'OPEN', 2, 'feed:betsapi'], // 2.2 / 1.05 = 2.095 -> 2.08
      [20_800n, 'SUSPENDED', 3, 'feed:betsapi'],
    ]);
    expect(home.priceVersion).toBe(3);
    await expect(h.pool.query('UPDATE price_history SET odds = 1 WHERE selection_id = $1', [home.selectionId])).rejects.toThrow(/append-only/);
    await expect(h.pool.query('DELETE FROM price_history WHERE selection_id = $1', [home.selectionId])).rejects.toThrow(/append-only/);
  });

  it('FR-SPD-006 a feed suspension signal suspends every market of the event at once', async () => {
    const { externalId, eventId } = await ingestFresh({ status: 'LIVE' });
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, status: 'LIVE', suspended: true })]);
    const s = await selections(eventId);
    expect(Object.values(s).every((x) => x.state === 'SUSPENDED')).toBe(true);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n, status: 'LIVE', suspended: false })]);
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('OPEN');
  });

  it('FR-SPD-006 a market missing from the feed snapshot is suspended, and reopened when it returns', async () => {
    const { externalId, eventId } = await ingestFresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, markets: [] })]);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('SUSPENDED');
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n })]);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('OPEN');
  });

  it('FR-SPD-008 a start time change suspends the event pending trader review', async () => {
    const { externalId, eventId } = await ingestFresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, startsAt: new Date(START.getTime() + 3_600_000) })]);
    let ev = await h.catalogue.getEvent(eventId);
    expect(ev!.suspended).toBe(true);
    expect(ev!.startsAt.toISOString()).toBe('2026-06-01T13:00:00.000Z');
    // A further normal update does not clear the review flag; only a trader does.
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n, startsAt: new Date(START.getTime() + 3_600_000) })]);
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('SUSPENDED');
    await h.catalogue.reopenEvent(eventId, trader);
    ev = await h.catalogue.getEvent(eventId);
    expect(ev!.suspended).toBe(false);
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('OPEN');
  });

  it('FR-SPD-008 a participant change suspends the event pending trader review', async () => {
    const { externalId, eventId } = await ingestFresh();
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, away: { externalId: fresh('t'), name: 'Spurs' } })]);
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('SUSPENDED');
  });

  it('FR-SPD-005 an ended event closes its open markets', async () => {
    const { externalId, eventId } = await ingestFresh({ status: 'LIVE' });
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, status: 'ENDED' })]);
    const ev = await h.catalogue.getEvent(eventId);
    expect(ev!.markets.every((m) => m.state === 'CLOSED')).toBe(true);
    // The feed cannot move it back to live.
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n, status: 'LIVE' })]);
    expect((await h.catalogue.getEvent(eventId))!.status).toBe('ENDED');
  });
});

describe('scheduled checks', () => {
  it('FR-SPD-007 closes pre-match markets at the start time when the event is not offered in-play', async () => {
    await h.pool.query(`UPDATE sports SET in_play_default = false WHERE key = 'boxing'`);
    const { eventId } = await ingestFresh({ sport: 'boxing' });
    const { eventId: inPlayEvent } = await ingestFresh({ sport: 'mma' });
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('OPEN');
    const saved = h.clock.t;
    h.clock.t = START;
    try {
      // Read guard: closed as soon as the start time passes, before the job runs.
      const sel = (await selections(eventId))['1X2:HOME']!;
      expect((await h.catalogue.getQuotes([sel.selectionId]))[0]!.marketState).toBe('CLOSED');
      const closed = await h.catalogue.closePrematch(START);
      expect(closed).toContain(eventId);
      expect(closed).not.toContain(inPlayEvent);
      expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('CLOSED');
      expect((await h.catalogue.priceHistory(sel.selectionId)).at(-1)).toMatchObject({ state: 'CLOSED', source: 'system:prematch-close' });
      expect((await h.catalogue.getEvent(inPlayEvent))!.markets[0]!.state).not.toBe('CLOSED');
    } finally {
      h.clock.t = saved;
    }
  });
});

describe('trader actions', () => {
  it('FR-RSK-002 overrides a price, which wins over later feed prices until cleared', async () => {
    const { externalId, eventId } = await ingestFresh();
    const home = (await selections(eventId))['1X2:HOME']!;
    await h.catalogue.overridePrice(home.selectionId, 18_500n, trader);
    expect((await h.catalogue.getQuotes([home.selectionId]))[0]!.odds).toBe(18_500n);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, markets: [market1x2(30_000n, 34_000n, 36_000n)] })]);
    expect((await h.catalogue.getQuotes([home.selectionId]))[0]!.odds).toBe(18_500n);
    await h.catalogue.overridePrice(home.selectionId, null, trader);
    expect((await h.catalogue.getQuotes([home.selectionId]))[0]!.odds).toBe(28_400n); // 3.0 / 1.05 = 2.857 -> 2.84
    const last = (await h.catalogue.priceHistory(home.selectionId)).at(-1)!;
    expect(last.source).toBe('trader:staff-1');
  });

  it('FR-RSK-002 suspends and reopens a selection, a market and an event', async () => {
    const { eventId } = await ingestFresh();
    const s = await selections(eventId);
    const home = s['1X2:HOME']!;
    const marketId = (await h.catalogue.getQuotes([home.selectionId]))[0]!.marketId;

    await h.catalogue.suspendSelection(home.selectionId, trader);
    expect((await selections(eventId))['1X2:HOME']!.state).toBe('SUSPENDED');
    expect((await selections(eventId))['1X2:DRAW']!.state).toBe('OPEN');
    await h.catalogue.reopenSelection(home.selectionId, trader);

    await h.catalogue.suspendMarket(marketId, trader);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('SUSPENDED');
    await h.catalogue.reopenMarket(marketId, trader);

    await h.catalogue.suspendEvent(eventId, trader);
    expect(Object.values(await selections(eventId)).every((x) => x.state === 'SUSPENDED')).toBe(true);
    await h.catalogue.reopenEvent(eventId, trader);
    expect(Object.values(await selections(eventId)).every((x) => x.state === 'OPEN')).toBe(true);

    const audit = await h.pool.query<{ action: string; actor: string; reason: string; ip: string }>(
      `SELECT action, actor, reason, ip FROM trader_actions WHERE target_id IN ($1, $2, $3) ORDER BY id`,
      [home.selectionId, marketId, eventId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'SUSPEND_SELECTION',
      'REOPEN_SELECTION',
      'SUSPEND_MARKET',
      'REOPEN_MARKET',
      'SUSPEND_EVENT',
      'REOPEN_EVENT',
    ]);
    expect(audit.rows.every((r) => r.actor === 'staff-1' && r.reason === 'integrity alert' && r.ip === '10.0.0.1')).toBe(true);
  });

  it('FR-RSK-002 a trader-suspended market is not reopened by the feed', async () => {
    const { externalId, eventId } = await ingestFresh();
    const marketId = (await h.catalogue.getEvent(eventId))!.markets[0]!.marketId;
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, markets: [market1x2(21_000n, 34_000n, 36_000n, true)] })]);
    await h.catalogue.suspendMarket(marketId, trader);
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 3n })]);
    expect((await h.catalogue.getEvent(eventId))!.markets[0]!.state).toBe('SUSPENDED');
  });

  it('FR-SPD-005 rejects reopening a closed market', async () => {
    const { externalId, eventId } = await ingestFresh({ status: 'LIVE' });
    await h.catalogue.ingest('betsapi', [feedEvent({ externalId, seq: 2n, status: 'ENDED' })]);
    const marketId = (await h.catalogue.getEvent(eventId))!.markets[0]!.marketId;
    await expect(h.catalogue.reopenMarket(marketId, trader)).rejects.toMatchObject({ code: 'illegal_market_transition', status: 409 });
    const home = (await selections(eventId))['1X2:HOME']!;
    await expect(h.catalogue.overridePrice(home.selectionId, 20_000n, trader)).rejects.toMatchObject({ status: 409 });
  });

  it('FR-BO-010 requires a reason for every trader action', async () => {
    const { eventId } = await ingestFresh();
    await expect(h.catalogue.suspendEvent(eventId, { actor: 'staff-1', reason: '  ' })).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('FR-SPD-012 creates a manual event and market with the same lifecycle as feed markets', async () => {
    const eventId = await h.catalogue.createEvent(
      { sport: 'soccer', competitionName: 'World Cup 2026 Specials', name: 'Top scorer', startsAt: START, inPlayOffered: true },
      trader,
    );
    const marketId = await h.catalogue.createMarket(
      eventId,
      { type: 'OUTRIGHT', line: null, selections: [{ key: 'MBAPPE', name: 'Mbappe', odds: 55_000n }, { key: 'KANE', name: 'Kane', odds: 60_000n }] },
      trader,
    );
    const ev = (await h.catalogue.getEvent(eventId))!;
    expect(ev.markets).toHaveLength(1);
    expect(ev.markets[0]).toMatchObject({ marketId, state: 'OPEN' });
    const mbappe = ev.markets[0]!.selections.find((s) => s.key === 'MBAPPE')!;
    expect((await h.catalogue.getQuotes([mbappe.selectionId]))[0]).toMatchObject({ odds: 55_000n, marketState: 'OPEN', marketType: 'OUTRIGHT' });
    await h.catalogue.suspendMarket(marketId, trader);
    expect((await h.catalogue.getQuotes([mbappe.selectionId]))[0]!.marketState).toBe('SUSPENDED');
    await expect(
      h.catalogue.createMarket(eventId, { type: 'OUTRIGHT', line: null, selections: [{ key: 'X', name: 'X', odds: 20_000n }] }, trader),
    ).rejects.toMatchObject({ code: 'market_exists' });
    const actions = await h.pool.query<{ action: string }>(`SELECT action FROM trader_actions WHERE target_id IN ($1, $2) ORDER BY id`, [eventId, marketId]);
    expect(actions.rows.map((r) => r.action)).toEqual(['CREATE_EVENT', 'CREATE_MARKET', 'SUSPEND_MARKET']);
  });

  it('SEC-LOG-002 the trader audit is append-only and hash-chained under concurrent writers', async () => {
    const { eventId } = await ingestFresh();
    const home = (await selections(eventId))['1X2:HOME']!;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? h.catalogue.suspendSelection(home.selectionId, trader) : h.catalogue.overridePrice(home.selectionId, 20_000n + BigInt(i) * 100n, trader),
      ),
    );
    expect(await h.catalogue.verifyAudit()).toBe(true);
    await expect(h.pool.query(`UPDATE trader_actions SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query(`DELETE FROM trader_actions`)).rejects.toThrow(/append-only/);
    // Every version bump has exactly one history row, even with concurrent writers.
    const after = (await h.catalogue.getQuotes([home.selectionId]))[0]!;
    const history = await h.catalogue.priceHistory(home.selectionId);
    expect(history.map((r) => r.priceVersion)).toEqual(Array.from({ length: after.priceVersion }, (_, i) => i + 1));
  });

  it('FR-SPD-002 the mapping tool points an unmatched external id at an existing event', async () => {
    const { eventId } = await ingestFresh();
    await h.catalogue.mapEntity('backup', 'event', 'manual-map-1', eventId, trader);
    expect(await eventIdFor('backup', 'manual-map-1')).toBe(eventId);
    await expect(h.catalogue.mapEntity('backup', 'event', 'manual-map-2', eventId, trader)).rejects.toMatchObject({ code: 'already_mapped' });
  });
});

describe('Catalogue.getQuotes', () => {
  it('FR-SPD-005 returns current quotes and omits unknown ids', async () => {
    const { eventId } = await ingestFresh({ status: 'LIVE' });
    const home = (await selections(eventId))['1X2:HOME']!;
    const quotes = await h.catalogue.getQuotes([home.selectionId, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      selectionId: home.selectionId,
      eventId,
      sport: 'soccer',
      marketType: '1X2',
      line: null,
      odds: 20_000n,
      marketState: 'OPEN',
      inPlay: true,
      priceVersion: 1,
    });
    expect(quotes[0]!.eventStartsAt.toISOString()).toBe(START.toISOString());
  });
});
