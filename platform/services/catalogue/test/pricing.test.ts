import { describe, expect, it } from 'vitest';
import { applyMargin, MIN_ODDS, priceFromFeed, roundDownToLadder, validateLadder } from '../src/pricing.js';
import { assertTransition, canTransition } from '../src/states.js';
import { b365Adapter, normaliseB365Event, normaliseLine, parseFeedOdds } from '../src/feed.js';

describe('pricing', () => {
  it('FR-RSK-001 applies the margin as odds / (1 + margin) in bigint', () => {
    expect(applyMargin(21_000n, 500)).toBe(20_000n); // 2.1 / 1.05 = 2.0
    expect(applyMargin(30_000n, 0)).toBe(30_000n);
    expect(applyMargin(20_000n, 300)).toBe(19_417n); // 1.941747... rounded down
  });

  it('FR-RSK-001 rounds down to the price ladder', () => {
    expect(roundDownToLadder(19_417n)).toBe(19_400n); // step 0.01 below 2
    expect(roundDownToLadder(25_150n)).toBe(25_000n); // step 0.02 below 3
    expect(roundDownToLadder(25_199n)).toBe(25_000n);
    expect(roundDownToLadder(25_200n)).toBe(25_200n);
    expect(roundDownToLadder(57_999n)).toBe(57_000n);
    expect(roundDownToLadder(2_345_000n)).toBe(2_300_000n);
  });

  it('FR-RSK-001 never prices below 1.0001', () => {
    expect(roundDownToLadder(10_050n)).toBe(MIN_ODDS);
    expect(priceFromFeed(10_100n, 5000)).toBe(MIN_ODDS);
  });

  it('FR-RSK-001 rejects a malformed ladder and an out-of-range margin', () => {
    expect(() => validateLadder([{ upTo: 20_000n, step: 300n }, { upTo: null, step: 100n }])).toThrow();
    expect(() => validateLadder([{ upTo: 20_000n, step: 100n }])).toThrow();
    expect(() => applyMargin(20_000n, -1)).toThrow();
    expect(() => applyMargin(20_000n, 1.5)).toThrow();
  });
});

describe('market states', () => {
  it('FR-SPD-005 allows only legal transitions', () => {
    expect(canTransition('OPEN', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'OPEN')).toBe(true);
    expect(canTransition('CLOSED', 'SETTLED')).toBe(true);
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('OPEN', 'SETTLED')).toBe(false);
    expect(canTransition('SETTLED', 'VOIDED')).toBe(false);
    expect(canTransition('VOIDED', 'OPEN')).toBe(false);
    expect(() => assertTransition('SETTLED', 'OPEN')).toThrow(/illegal_market_transition/);
  });
});

describe('BetsAPI normaliser', () => {
  const raw = {
    id: '9001',
    sport_id: '1',
    time: '1780315200',
    time_status: '0',
    league: { id: '94', name: 'England Premier League' },
    home: { id: '10', name: 'Arsenal' },
    away: { id: '20', name: 'Chelsea' },
    odds: {
      '1_1': [{ home_od: '2.100', draw_od: '3.40', away_od: '3.6' }],
      '1_2': [{ home_od: '1.95', handicap: '0.0,-0.5', away_od: '1.90' }],
      '1_3': [{ over_od: '1.85', handicap: '2.5', under_od: '-' }],
      '1_99': [{ home_od: '2' }],
    },
  };

  it('FR-SPD-001 normalises a b365 event with 1X2, Asian handicap and totals', () => {
    const ev = normaliseB365Event(raw, 7n)!;
    expect(ev).toMatchObject({
      externalId: '9001',
      seq: 7n,
      sport: 'soccer',
      competition: { externalId: '94', name: 'England Premier League' },
      home: { externalId: '10', name: 'Arsenal' },
      status: 'PREMATCH',
      suspended: false,
    });
    expect(ev.startsAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(ev.markets).toEqual([
      {
        type: '1X2',
        line: null,
        suspended: false,
        selections: [
          { key: 'HOME', name: 'Arsenal', odds: 21_000n },
          { key: 'DRAW', name: 'Draw', odds: 34_000n },
          { key: 'AWAY', name: 'Chelsea', odds: 36_000n },
        ],
      },
      {
        type: 'ASIAN_HANDICAP',
        line: '-0.25',
        suspended: false,
        selections: [
          { key: 'HOME', name: 'Arsenal', odds: 19_500n },
          { key: 'AWAY', name: 'Chelsea', odds: 19_000n },
        ],
      },
      {
        type: 'TOTALS',
        line: '2.5',
        suspended: true,
        selections: [
          { key: 'OVER', name: 'Over', odds: 18_500n },
          { key: 'UNDER', name: 'Under', odds: null },
        ],
      },
    ]);
  });

  it('FR-SPD-006 maps interrupted and postponed statuses to a suspension signal', () => {
    expect(normaliseB365Event({ ...raw, time_status: '7' }, 1n)).toMatchObject({ status: 'LIVE', suspended: true });
    expect(normaliseB365Event({ ...raw, time_status: '4' }, 1n)).toMatchObject({ suspended: true });
    expect(normaliseB365Event({ ...raw, time_status: '3' }, 1n)).toMatchObject({ status: 'ENDED', suspended: false });
  });

  it('FR-SPD-001 drops malformed events and unknown sports', () => {
    const adapter = b365Adapter();
    const out = adapter.normalise({ results: [raw, { ...raw, sport_id: '999' }, { id: 'x' }, null] }, 1n);
    expect(out).toHaveLength(1);
    expect(adapter.source).toBe('betsapi');
  });

  it('FR-SPD-004 parses quarter lines and feed odds exactly', () => {
    expect(normaliseLine('+1.5')).toBe('1.5');
    expect(normaliseLine('0.0')).toBe('0');
    expect(normaliseLine('-0.5,-1.0')).toBe('-0.75');
    expect(normaliseLine('2.5,3.0')).toBe('2.75');
    expect(normaliseLine('2.1')).toBeNull();
    expect(normaliseLine('abc')).toBeNull();
    expect(parseFeedOdds('1.83333')).toBe(18_333n);
    expect(parseFeedOdds('1.0')).toBeNull();
    expect(parseFeedOdds('-')).toBeNull();
  });
});
