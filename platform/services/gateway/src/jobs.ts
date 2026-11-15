// Timed jobs for the ops service. Each run takes a transaction-scoped advisory lock first, so when
// several ops instances run, each job still runs on one of them at a time.
import type { Pool } from '@bp/common';

export interface Job {
  name: string;
  everyMs: number;
  run: (now: Date) => Promise<unknown>;
}

export interface JobLog {
  error: (obj: object, msg: string) => void;
}

/** Runs the job once if no other instance holds its lock. Returns false when skipped. */
export const runOnce = async (pool: Pool, job: Job, now: Date): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`job:${job.name}`]);
    if (!got.rows[0]!.ok) return false;
    await job.run(now);
    return true;
  } finally {
    await client.query('COMMIT').catch(() => undefined);
    client.release();
  }
};

/** Starts every job on its interval. A job never overlaps itself in this process. Returns a stop function. */
export const startJobs = (pool: Pool, jobs: Job[], log: JobLog, now: () => Date = () => new Date()): (() => Promise<void>) => {
  const running = new Map<string, Promise<unknown>>();
  const timers = jobs.map((job) => {
    const t = setInterval(() => {
      if (running.has(job.name)) return;
      const p = runOnce(pool, job, now())
        .catch((err: unknown) => log.error({ err, job: job.name }, 'job failed'))
        .finally(() => running.delete(job.name));
      running.set(job.name, p);
    }, job.everyMs);
    t.unref();
    return t;
  });
  return async () => {
    for (const t of timers) clearInterval(t);
    await Promise.all(running.values());
  };
};
