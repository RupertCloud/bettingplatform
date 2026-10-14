// Demo mode only (DEMO_MODE=true): self-activating registration, a play-money deposit and a
// rolling set of pre-match fixtures so the player site always has open markets.
import { createHash } from 'node:crypto';
import { AppError, fromMinor, type PlayerId } from '@bp/common';
import { b365Adapter, type CatalogueService } from '@bp/catalogue';
import { Identity, type RegisterResult, type RegistrationInput, type RequestMeta } from '@bp/identity';
import type { ResponsibleGambling } from '@bp/rg';
import type { Wallet } from '@bp/wallet';

export const DEMO_ACTOR = 'system:demo';
export const FEED_SOURCE = 'betsapi';
export const DEMO_REFRESH_MS = 6 * 60 * 60 * 1000;
export const MIN_DEPOSIT = 100n;
export const MAX_DEPOSIT = 1_000_000n;

/** Registration that activates a newly created player with full KYC, the way the e2e harness does. */
export class DemoIdentity extends Identity {
  override async register(input: RegistrationInput, meta?: RequestMeta): Promise<RegisterResult> {
    const result = await super.register(input, meta);
    if (result.created) {
      await this.setState(result.playerId, 'ACTIVE', DEMO_ACTOR, 'Demo mode: account activated on registration');
      await this.setKycLevel(result.playerId, 'FULL', DEMO_ACTOR, 'Demo mode: KYC not required');
    }
    return result;
  }
}

/**
 * Play-money deposit: rg deposit gate (recorded under the same ref, so a replay counts once), then the
 * ledger posting PSP_CLEARING -> CASH, idempotent on the player's requestId. Returns the CASH balance.
 */
export const demoDeposit = async (
  deps: { rg: ResponsibleGambling; wallet: Wallet; now: () => Date },
  playerId: PlayerId,
  amount: bigint,
  requestId: string,
): Promise<string> => {
  const at = deps.now();
  const ref = `demo:${playerId}:${requestId}`;
  const gate = await deps.rg.checkAndRecordDeposit(playerId, 'XAF', amount, ref, at);
  if (!gate.allowed) throw new AppError(gate.code, 403, gate.detail);
  try {
    await deps.wallet.post({
      idempotencyKey: `deposit:${ref}`,
      reason: 'DEPOSIT',
      reference: ref,
      lines: [
        { account: { owner: 'OPERATOR', kind: 'PSP_CLEARING', currency: 'XAF' }, amount: -amount },
        { account: { owner: 'PLAYER', playerId, kind: 'CASH', currency: 'XAF' }, amount },
      ],
    });
  } catch (err) {
    // A refused posting is a declined deposit; it stops counting toward deposit limits.
    if (err instanceof AppError && err.code !== 'idempotency_conflict') {
      await deps.rg.recordDepositDeclined(playerId, 'XAF', amount, ref, at);
    }
    throw err;
  }
  const balances = await deps.wallet.playerBalances(playerId, 'XAF');
  return fromMinor(balances.CASH, 'XAF');
};

// ---------- Fixtures ----------

interface League {
  id: string;
  name: string;
  clubs: string[];
}

const ELITE_ONE: League = {
  id: 'cm-elite-one',
  name: 'Elite One',
  clubs: [
    'Coton Sport', 'Canon Yaoundé', 'Union Douala', 'Tonnerre Yaoundé', 'PWD Bamenda', 'Colombe Sportive',
    'Fovu Baham', 'Bamboutos', 'Stade Renard', 'Fortuna Mfou', 'Victoria United', 'Dynamo Douala',
  ],
};
const LEAGUES: League[] = [
  ELITE_ONE,
  {
    id: 'ga-championnat-national-d1',
    name: 'Championnat National D1 (Gabon)',
    clubs: ['AS Mangasport', 'CF Mounana', 'FC 105 Libreville', 'AS Pélican', 'Bouenguidi Sports', 'Stade Mandji'],
  },
  {
    id: 'cg-ligue-1',
    name: 'Ligue 1 (Congo)',
    clubs: ['AS Otohô', 'Diables Noirs', 'CARA Brazzaville', 'AC Léopards', 'Étoile du Congo', 'Interclub'],
  },
];

/** Days ahead of each fixture: two tomorrow, then one a day up to a week out. */
const DAYS_AHEAD = [1, 1, 2, 3, 4, 5, 6, 7];
/** Kick-off hour (UTC) of the n-th fixture on a day. */
const KICK_OFF_UTC = [15, 18];
const DAY_MS = 86_400_000;

const hash = (s: string): number => createHash('sha256').update(s).digest().readUInt32BE(0);
const slug = (s: string): string => s.normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
const odds = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);

/**
 * BetsAPI-shaped payload for the next week of demo fixtures. Feed ids depend only on the kick-off date
 * and slot, so a restart or the next refresh updates the same events instead of adding new ones.
 */
export const demoFeedPayload = (now: Date): { results: unknown[] } => {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const slots = new Map<number, number>();
  const results = DAYS_AHEAD.map((days) => {
    const slot = slots.get(days) ?? 0;
    slots.set(days, slot + 1);
    const day = new Date(today + days * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const h = hash(`${date}:${slot}`);
    const league = slot === 0 ? LEAGUES[h % LEAGUES.length]! : ELITE_ONE;
    const n = league.clubs.length;
    const home = league.clubs[h % n]!;
    const away = league.clubs[(h + 1 + ((h >>> 8) % (n - 1))) % n]!;
    const homeOdds = 1.5 + ((h >>> 4) % 200) / 100;
    const drawOdds = 2.9 + ((h >>> 12) % 60) / 100;
    // About a 5 % book: whatever the home and draw prices leave for the away side.
    const awayOdds = Math.max(1.2, 1 / Math.max(0.05, 1.05 - 1 / homeOdds - 1 / drawOdds));
    return {
      id: `demo-${date.replaceAll('-', '')}-${slot}`,
      sport_id: '1',
      time: String((day.getTime() + KICK_OFF_UTC[slot % KICK_OFF_UTC.length]! * 3_600_000) / 1000),
      time_status: '0',
      league: { id: league.id, name: league.name },
      home: { id: `demo-${slug(home)}`, name: home },
      away: { id: `demo-${slug(away)}`, name: away },
      odds: { '1_1': [{ home_od: odds(homeOdds), draw_od: odds(drawOdds), away_od: odds(awayOdds) }] },
    };
  });
  return { results };
};

/** Sends the demo fixtures through the catalogue's feed adapter and ingestion. Returns how many applied. */
export const ingestDemoFixtures = async (catalogue: CatalogueService, now: Date): Promise<number> => {
  // Wall-clock sequence: every refresh is newer than the last one, across restarts too.
  const events = b365Adapter(FEED_SOURCE).normalise(demoFeedPayload(now), BigInt(now.getTime()));
  return (await catalogue.ingest(FEED_SOURCE, events)).applied;
};
