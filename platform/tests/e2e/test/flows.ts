import type { PlayerId } from '@bp/common';
import type { PlayerBet } from '@bp/betting';
import {
  betRequest,
  confirmResult,
  deposit,
  ingestFixtures,
  placeBet,
  registerActivePlayer,
  type Fixture,
  type Harness,
} from './harness.js';

export const DEPOSIT = 100_000n;
export const UNIT_STAKE = 10_000n;

/** SRS appendix A: a treble at 1.80, 2.10 and 1.50. */
export const APPENDIX_A = [
  { home: 'Coton Sport', away: 'Canon Yaounde', odds: { home: '1.80', draw: '3.40', away: '4.00' } },
  { home: 'Union Douala', away: 'Tonnerre', odds: { home: '2.10', draw: '3.20', away: '3.50' } },
  { home: 'Fovu Baham', away: 'Bamboutos', odds: { home: '1.50', draw: '4.00', away: '6.00' } },
];

export interface TrebleState {
  playerId: PlayerId;
  fixtures: Fixture[];
  bet: PlayerBet;
}

/** Registers, activates and funds a player, ingests three fixtures and places the appendix A treble on the home sides. */
export const placeAppendixATreble = async (h: Harness, names: string): Promise<TrebleState> => {
  const playerId = await registerActivePlayer(h);
  await deposit(h, playerId, DEPOSIT);
  const fixtures = await ingestFixtures(
    h,
    APPENDIX_A.map((f) => ({ ...f, home: `${f.home} ${names}`, away: `${f.away} ${names}` })),
  );
  const legs = fixtures.map((f) => ({ selectionId: f.selections.HOME, odds: f.odds.HOME }));
  const { bet } = await placeBet(h, betRequest(playerId, legs, [3], UNIT_STAKE));
  return { playerId, fixtures, bet };
};

/** Results as in appendix A: leg 1 won, leg 2 void (abandoned), leg 3 won. Returns the confirmed result IDs. */
export const confirmAppendixAResults = async (h: Harness, fixtures: Fixture[]): Promise<string[]> => [
  await confirmResult(h, fixtures[0]!.selections.HOME, 'WON'),
  await confirmResult(h, fixtures[1]!.selections.HOME, 'VOID'),
  await confirmResult(h, fixtures[2]!.selections.HOME, 'WON'),
];
