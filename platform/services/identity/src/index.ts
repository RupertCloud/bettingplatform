import { fileURLToPath } from 'node:url';

export * from './identity.js';
export * from './state.js';
export { registrationSchema, normaliseEmail, normalisePhone, normaliseUsername, type RegistrationInput } from './normalise.js';
export { buildServer, playerBearerAuth, type AuthContext, type HttpDeps } from './http.js';

/** Postgres schema owned by this service. */
export const SCHEMA = 'identity';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
