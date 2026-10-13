import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testDb, type Currency, type PlayerStatus, type Pool } from '@bp/common';
import { ResponsibleGambling, type ExclusionState } from '../src/index.js';

export const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

export const T0 = new Date('2026-03-02T12:00:00Z');
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Harness {
  pool: Pool;
  rg: ResponsibleGambling;
  clock: { t: Date; now: () => Date; advance: (ms: number) => Date };
  states: Array<{ playerId: string; state: ExclusionState; until: Date | null }>;
  addPlayer: (currency?: Currency, jurisdiction?: string) => string;
  drop: () => Promise<void>;
}

export const setup = async (): Promise<Harness> => {
  const db = await testDb('rg', migrationsDir);
  const players = new Map<string, PlayerStatus>();
  const states: Harness['states'] = [];
  const clock = {
    t: new Date(T0),
    now(): Date {
      return new Date(clock.t);
    },
    advance(ms: number): Date {
      clock.t = new Date(clock.t.getTime() + ms);
      return clock.now();
    },
  };
  const rg = new ResponsibleGambling({
    pool: db.pool,
    players: { getStatus: async (id) => players.get(id) ?? null },
    stateSink: {
      setState: async (playerId, state, until) => {
        states.push({ playerId, state, until });
      },
    },
    clock,
  });
  return {
    pool: db.pool,
    rg,
    clock,
    states,
    addPlayer: (currency = 'XAF', jurisdiction = 'CM') => {
      const playerId = randomUUID();
      players.set(playerId, { playerId, state: 'ACTIVE', kycLevel: 'FULL', jurisdiction, currency, stakeFactor: 1 });
      return playerId;
    },
    drop: db.drop,
  };
};

export const at = (ms: number): Date => new Date(T0.getTime() + ms);
