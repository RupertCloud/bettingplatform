import { randomBytes } from 'node:crypto';
import { createPool, migrate, type Pool } from './db.js';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';

/**
 * Creates a throwaway schema, runs the service migrations into it and returns a pool
 * bound to it. Each test file gets its own schema, so test files can run in parallel.
 */
export const testDb = async (
  prefix: string,
  migrationsDir: string,
): Promise<{ pool: Pool; schema: string; drop: () => Promise<void> }> => {
  const schema = `${prefix}_t${randomBytes(4).toString('hex')}`;
  const pool = createPool(TEST_DATABASE_URL, schema);
  await migrate(pool, schema, migrationsDir);
  return {
    pool,
    schema,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    },
  };
};
