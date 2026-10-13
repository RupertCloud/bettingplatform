import { fileURLToPath } from 'node:url';

export * from './betting.js';
export * from './pricing.js';
export { buildServer, betView, type HttpDeps, type Principal } from './http.js';

/** Schema this service owns, and where its migrations live (for migrate()). */
export const SCHEMA = 'betting';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
