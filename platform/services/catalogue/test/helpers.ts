import { fileURLToPath } from 'node:url';
import { testDb, type Pool } from '@bp/common';
import { CatalogueService } from '../src/catalogue.js';
import type { FeedEvent, FeedMarket } from '../src/feed.js';

export const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export const START = new Date('2026-06-01T12:00:00Z');

export interface Harness {
  pool: Pool;
  catalogue: CatalogueService;
  clock: { t: Date; advance: (ms: number) => void };
  drop: () => Promise<void>;
}

export const setup = async (): Promise<Harness> => {
  const db = await testDb('catalogue', MIGRATIONS);
  const clock = {
    t: new Date(START.getTime() - 3_600_000),
    advance(ms: number) {
      this.t = new Date(this.t.getTime() + ms);
    },
  };
  const catalogue = new CatalogueService(db.pool, {
    primarySource: 'betsapi',
    secondarySource: 'backup',
    now: () => clock.t,
  });
  return { pool: db.pool, catalogue, clock, drop: db.drop };
};

export const market1x2 = (home: bigint, draw: bigint, away: bigint, suspended = false): FeedMarket => ({
  type: '1X2',
  line: null,
  suspended,
  selections: [
    { key: 'HOME', name: 'Home', odds: home },
    { key: 'DRAW', name: 'Draw', odds: draw },
    { key: 'AWAY', name: 'Away', odds: away },
  ],
});

export const feedEvent = (overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  externalId: 'ev-1',
  seq: 1n,
  sport: 'soccer',
  competition: { externalId: 'lg-1', name: 'Premier League' },
  home: { externalId: 't-1', name: 'Arsenal' },
  away: { externalId: 't-2', name: 'Chelsea' },
  startsAt: START,
  status: 'PREMATCH',
  suspended: false,
  markets: [market1x2(21_000n, 34_000n, 36_000n)],
  ...overrides,
});
