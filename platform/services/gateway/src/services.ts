// Builds the six Release 1 services against one database (a schema each). Shared by the public
// gateway (player routes) and the internal ops service (staff routes, feed intake, timed jobs).
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, type Pool } from '@bp/common';
import { BettingService } from '@bp/betting';
import { CatalogueService } from '@bp/catalogue';
import { Identity, RG_ACTOR, type IdentityOptions } from '@bp/identity';
import { ResponsibleGambling, type Clock } from '@bp/rg';
import { Settlement } from '@bp/settlement';
import { Wallet } from '@bp/wallet';
import { DemoIdentity, FEED_SOURCE } from './demo.js';

export const SERVICES = ['identity', 'wallet', 'catalogue', 'rg', 'betting', 'settlement'] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface ServiceOptions {
  databaseUrl: string;
  demo: boolean;
  /** 32-byte key for MFA secrets at rest. Random when absent, so MFA enrolments do not survive a restart. */
  mfaKey?: Buffer;
  /** Prepended to each service's schema name; tests use it for throwaway schemas. */
  schemaPrefix?: string;
  /** Result feeds that must agree before a result confirms automatically (default 2). */
  resultSources?: 1 | 2;
  notify?: IdentityOptions['notify'];
  now?: () => Date;
}

export interface Services {
  schemas: Record<ServiceName, string>;
  pools: Record<ServiceName, Pool>;
  identity: Identity;
  wallet: Wallet;
  catalogue: CatalogueService;
  rg: ResponsibleGambling;
  betting: BettingService;
  settlement: Settlement;
  end: () => Promise<void>;
}

const migrationsDir = (service: ServiceName): string =>
  fileURLToPath(new URL(`../../${service}/migrations`, import.meta.url));

/** Creates the pools, runs every service's migrations and wires the services together. */
export const buildServices = async (opts: ServiceOptions): Promise<Services> => {
  const now = opts.now ?? (() => new Date());
  const clock: Clock = { now };
  const prefix = opts.schemaPrefix ?? '';
  const schemas = Object.fromEntries(SERVICES.map((s) => [s, `${prefix}${s}`])) as Record<ServiceName, string>;
  const pools = {} as Record<ServiceName, Pool>;
  const end = async () => {
    await Promise.all(Object.values(pools).map((p) => p.end()));
  };
  try {
    for (const s of SERVICES) {
      pools[s] = createPool(opts.databaseUrl, schemas[s]);
      await migrate(pools[s], schemas[s], migrationsDir(s));
    }
  } catch (err) {
    await end();
    throw err;
  }

  const identityOpts: IdentityOptions = {
    pool: pools.identity,
    now,
    mfaKey: opts.mfaKey ?? randomBytes(32),
    ...(opts.notify ? { notify: opts.notify } : {}),
  };
  const identity = opts.demo ? new DemoIdentity(identityOpts) : new Identity(identityOpts);
  const wallet = new Wallet(pools.wallet, { now });
  const catalogue = new CatalogueService(pools.catalogue, { primarySource: FEED_SOURCE, now });
  const rg = new ResponsibleGambling({
    pool: pools.rg,
    players: identity,
    // rg pushes time-outs and self-exclusions into identity's audited state change.
    stateSink: {
      async setState(playerId, state, until) {
        await identity.setState(playerId, state, RG_ACTOR, `rg:${state.toLowerCase()}`, { until });
      },
    },
    clock,
  });
  const betting = new BettingService({
    pool: pools.betting,
    players: identity,
    catalogue,
    rg,
    ledger: wallet,
    clock,
    config: {
      limits: { XAF: { global: { minStake: 100n, maxStake: 5_000_000n, maxPayout: 100_000_000n } } },
    },
  });
  const settlement = new Settlement({
    pool: pools.settlement, bets: betting, ledger: wallet, rg, now, resultSources: opts.resultSources ?? 2,
  });
  return { schemas, pools, identity, wallet, catalogue, rg, betting, settlement, end };
};
