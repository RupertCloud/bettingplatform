import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// int8 columns (money, ids) come back as bigint, never as lossy numbers.
pg.types.setTypeParser(20, (value: string) => BigInt(value));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/** One pool per service; every connection uses that service's own schema. */
export const createPool = (connectionString: string, schema: string): Pool => {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  // Set at connection start-up, so no query can run before it applies.
  return new pg.Pool({ connectionString, max: 20, options: `-c search_path=${schema}` });
};

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock
const MAX_ATTEMPTS = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn in one transaction. Retries serialization failures and deadlocks up to
 * MAX_ATTEMPTS times with jittered backoff, so callers can rely on SERIALIZABLE or
 * row locks (SRS CON-02). Each round of conflicting transactions commits at least
 * one, so up to MAX_ATTEMPTS concurrent writers on one row always finish.
 */
export const withTx = async <T>(
  pool: Pool,
  fn: (client: Client) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (attempt < MAX_ATTEMPTS && code && RETRYABLE.has(code)) {
        await sleep(Math.random() * Math.min(50, 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
};

/**
 * Applies every *.sql file in dir, in name order, once, inside the given schema.
 * Applied files are recorded in <schema>.schema_migrations.
 */
export const migrate = async (pool: Pool, schema: string, dir: string): Promise<string[]> => {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await withTx(pool, async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    // One migrator at a time per schema.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(await readFile(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
  });
  return applied;
};
