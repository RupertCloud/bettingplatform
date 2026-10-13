import { z } from 'zod';
import type { Odds } from '@bp/common';

// FR-SPD-001, IF-SW-001: every feed source is normalised to this shape before ingestion.

export type FeedEventStatus = 'PREMATCH' | 'LIVE' | 'ENDED';

export interface FeedRef {
  externalId: string;
  name: string;
}

export interface FeedSelection {
  key: string; // e.g. HOME, DRAW, AWAY, OVER, UNDER
  name: string;
  /** null when the feed shows no price (treated as suspended). */
  odds: Odds | null;
}

export interface FeedMarket {
  type: string; // e.g. 1X2, ASIAN_HANDICAP, TOTALS
  line: string | null;
  suspended: boolean;
  selections: FeedSelection[];
}

export interface FeedEvent {
  externalId: string;
  /** Per-source sequence number; an update with seq <= the last applied one is ignored. */
  seq: bigint;
  sport: string; // internal sport key, e.g. soccer
  competition: FeedRef;
  home: FeedRef;
  away: FeedRef;
  startsAt: Date;
  status: FeedEventStatus;
  /** Feed suspension, dangerous-attack or similar signal (FR-SPD-006). */
  suspended: boolean;
  /** When present, the complete current set of feed markets for the event. */
  markets?: FeedMarket[];
}

/** Turns one raw payload of a feed source into normalised events. */
export interface FeedAdapter<Raw> {
  readonly source: string;
  normalise(raw: Raw, seq: bigint): FeedEvent[];
}

// ---------- BetsAPI (b365api) ----------

const str = z.union([z.string(), z.number()]).transform(String);
const ref = z.object({ id: str, name: z.string().min(1).max(200) });
const oddsRow = z
  .object({
    home_od: str.optional(),
    draw_od: str.optional(),
    away_od: str.optional(),
    over_od: str.optional(),
    under_od: str.optional(),
    handicap: str.optional(),
  })
  .passthrough();

export const b365EventSchema = z
  .object({
    id: str,
    sport_id: str,
    time: str,
    time_status: str,
    league: ref,
    home: ref,
    away: ref,
    odds: z.record(z.array(oddsRow)).optional(),
  })
  .passthrough();

export type B365Event = z.input<typeof b365EventSchema>;

const B365_SPORTS: Record<string, string> = {
  '1': 'soccer',
  '18': 'basketball',
  '13': 'tennis',
  '92': 'table-tennis',
  '91': 'volleyball',
  '17': 'ice-hockey',
  '162': 'mma',
  '9': 'boxing',
  '3': 'cricket',
  '151': 'esports',
};

/** BetsAPI time_status to our status, and whether it signals a suspension. */
const B365_STATUS: Record<string, { status: FeedEventStatus; suspended: boolean }> = {
  '0': { status: 'PREMATCH', suspended: false },
  '1': { status: 'LIVE', suspended: false },
  '2': { status: 'PREMATCH', suspended: true }, // to be fixed
  '3': { status: 'ENDED', suspended: false },
  '4': { status: 'PREMATCH', suspended: true }, // postponed
  '5': { status: 'PREMATCH', suspended: true }, // cancelled
  '6': { status: 'ENDED', suspended: false }, // walkover
  '7': { status: 'LIVE', suspended: true }, // interrupted
  '8': { status: 'ENDED', suspended: false }, // abandoned
  '9': { status: 'ENDED', suspended: false }, // retired
  '99': { status: 'PREMATCH', suspended: true }, // removed
};

/** "2.100" -> 21000n; "-", "" or anything at or below 1.0 -> null. Extra decimals are truncated. */
export const parseFeedOdds = (raw: string | undefined): Odds | null => {
  const match = raw === undefined ? null : /^(\d{1,6})(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const odds = BigInt(match[1]! + (match[2] ?? '').slice(0, 4).padEnd(4, '0'));
  return odds > 10_000n ? odds : null;
};

/** "0.0,-0.5" -> "-0.25", "+1.5" -> "1.5". Returns null for anything that is not a quarter line. */
export const normaliseLine = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const parts = raw.split(',').map((p) => /^([+-]?)(\d{1,3})(?:\.(\d{1,2}))?$/.exec(p.trim()));
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !p)) return null;
  const hundredths = parts.map((p) => {
    const v = BigInt(p![2]! + (p![3] ?? '').padEnd(2, '0'));
    return p![1] === '-' ? -v : v;
  });
  const sum = hundredths.reduce((a, b) => a + b, 0n);
  const n = BigInt(hundredths.length);
  if (sum % n !== 0n) return null;
  const v = sum / n;
  if (v % 25n !== 0n) return null;
  const abs = v < 0n ? -v : v;
  const frac = (abs % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return (v < 0n ? '-' : '') + (abs / 100n).toString() + (frac ? `.${frac}` : '');
};

const marketFromB365 = (
  sport: string,
  kind: string,
  row: z.infer<typeof oddsRow>,
  home: string,
  away: string,
): FeedMarket | null => {
  const sel = (key: string, name: string, raw: string | undefined): FeedSelection => ({ key, name, odds: parseFeedOdds(raw) });
  let market: Omit<FeedMarket, 'suspended'>;
  if (kind === '1') {
    market =
      row.draw_od !== undefined
        ? {
            type: '1X2',
            line: null,
            selections: [sel('HOME', home, row.home_od), sel('DRAW', 'Draw', row.draw_od), sel('AWAY', away, row.away_od)],
          }
        : { type: 'MONEYLINE', line: null, selections: [sel('HOME', home, row.home_od), sel('AWAY', away, row.away_od)] };
  } else if (kind === '2' || kind === '3') {
    const line = normaliseLine(row.handicap);
    if (line === null) return null;
    market =
      kind === '2'
        ? {
            type: sport === 'soccer' ? 'ASIAN_HANDICAP' : 'HANDICAP',
            line,
            selections: [sel('HOME', home, row.home_od), sel('AWAY', away, row.away_od)],
          }
        : { type: 'TOTALS', line, selections: [sel('OVER', 'Over', row.over_od), sel('UNDER', 'Under', row.under_od)] };
  } else {
    return null;
  }
  return { ...market, suspended: market.selections.some((s) => s.odds === null) };
};

/** One event as returned by BetsAPI upcoming/inplay/ended endpoints, with its `odds` summary attached. */
export const normaliseB365Event = (raw: unknown, seq: bigint): FeedEvent | null => {
  const parsed = b365EventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const sport = B365_SPORTS[e.sport_id];
  const status = B365_STATUS[e.time_status];
  const time = Number(e.time);
  if (!sport || !status || !Number.isSafeInteger(time) || time <= 0) return null;
  const markets: FeedMarket[] = [];
  for (const [key, rows] of Object.entries(e.odds ?? {})) {
    const [sportId, kind] = key.split('_');
    // BetsAPI lists the newest odds row first.
    const latest = rows[0];
    if (sportId !== e.sport_id || !kind || !latest) continue;
    const market = marketFromB365(sport, kind, latest, e.home.name, e.away.name);
    if (market) markets.push(market);
  }
  return {
    externalId: e.id,
    seq,
    sport,
    competition: { externalId: e.league.id, name: e.league.name },
    home: { externalId: e.home.id, name: e.home.name },
    away: { externalId: e.away.id, name: e.away.name },
    startsAt: new Date(time * 1000),
    status: status.status,
    suspended: status.suspended,
    ...(e.odds ? { markets } : {}),
  };
};

/** BetsAPI adapter: a payload is `{ results: [...] }` or a bare array of events. Malformed events are dropped. */
export const b365Adapter = (source = 'betsapi'): FeedAdapter<unknown> => ({
  source,
  normalise(raw: unknown, seq: bigint): FeedEvent[] {
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : [];
    return list.map((e) => normaliseB365Event(e, seq)).filter((e): e is FeedEvent => e !== null);
  },
});
