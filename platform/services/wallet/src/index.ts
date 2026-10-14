import { fileURLToPath } from 'node:url';

export * from './ledger.js';
export { buildServer, type Identity, type ServerDeps } from './http.js';

/** Postgres schema owned by this service. */
export const WALLET_SCHEMA = 'wallet';
/** Directory holding this service's SQL migrations, for migrate(). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
