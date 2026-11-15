// Internal ops service: staff routes, feed and result intake, and the timed jobs that move bets,
// markets and settlements on. Never public: deploy it with internal ingress only. Players cannot
// authenticate here; callers present a staff or feed token listed in STAFF_TOKENS.
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, toProblem, type LegOutcome } from '@bp/common';
import { b365Adapter, buildServer as catalogueServer } from '@bp/catalogue';
import { buildServer as identityServer } from '@bp/identity';
import { buildServer as rgServer } from '@bp/rg';
import { buildServer as settlementServer } from '@bp/settlement';
import { FEED_SOURCE } from './demo.js';
import { startJobs, type Job } from './jobs.js';
import { buildServices, type ServiceOptions, type Services } from './services.js';

export interface StaffToken {
  /** SHA-256 of the bearer token, hex. The token itself is never stored. */
  tokenSha256: string;
  staffId: string;
  /** trader, compliance, finance, feed. */
  roles: string[];
}

export interface OpsOptions extends Omit<ServiceOptions, 'demo'> {
  staffTokens: StaffToken[];
  /** Fastify trustProxy. */
  trustProxy?: boolean | string;
  /** Start the timed jobs (default true). Tests run them by hand. */
  jobs?: boolean;
  logger?: boolean;
}

export interface Ops {
  app: FastifyInstance;
  services: Services;
  jobs: Job[];
}

interface Caller {
  staffId: string;
  roles: string[];
}

const STAFF_ROLES = new Set(['trader', 'compliance', 'finance', 'feed']);
const HEX64 = /^[0-9a-f]{64}$/;

/** Parses STAFF_TOKENS: a JSON array of { tokenSha256, staffId, roles }. */
export const parseStaffTokens = (raw: string | undefined): StaffToken[] => {
  if (!raw) return [];
  const parsed = z
    .array(
      z
        .object({
          tokenSha256: z.string().regex(HEX64),
          staffId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
          roles: z.array(z.string().refine((r) => STAFF_ROLES.has(r), 'unknown role')).min(1),
        })
        .strict(),
    )
    .safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('STAFF_TOKENS must be a JSON array of { tokenSha256, staffId, roles }');
  return parsed.data;
};

const staffAuth = (tokens: StaffToken[]) => {
  const table = tokens.map((t) => ({ hash: Buffer.from(t.tokenSha256, 'hex'), caller: { staffId: t.staffId, roles: t.roles } }));
  return async (req: FastifyRequest): Promise<Caller> => {
    const m = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(req.headers.authorization ?? '');
    if (!m) throw new AppError('unauthenticated', 401, 'Authentication required');
    const hash = createHash('sha256').update(m[1]!).digest();
    let found: Caller | undefined;
    for (const t of table) if (timingSafeEqual(t.hash, hash)) found = t.caller;
    if (!found) throw new AppError('unauthenticated', 401, 'Authentication required');
    return found;
  };
};

const outcome = z.enum(['WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'DEAD_HEAT']);
const resultsBody = z
  .object({
    results: z
      .array(
        z
          .object({
            selectionId: z.string().uuid(),
            source: z.enum(['primary', 'secondary']),
            resultVersion: z.number().int().min(1).max(1_000_000),
            outcome,
            deadHeat: z.object({ numerator: z.number().int().min(1).max(1000), denominator: z.number().int().min(1).max(1000) }).strict().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** Path prefixes forwarded to each service's own app. Each service checks roles itself. */
const FORWARD: [prefix: string, service: 'identity' | 'catalogue' | 'rg' | 'settlement'][] = [
  ['/v1/staff/', 'identity'],
  ['/v1/trading/', 'catalogue'],
  ['/v1/sports', 'catalogue'],
  ['/v1/events', 'catalogue'],
  ['/v1/rg/', 'rg'],
  ['/v1/settlement/', 'settlement'],
];

const sendProblem = (reply: FastifyReply, err: unknown): FastifyReply => {
  let problem = toProblem(err);
  const status = (err as { statusCode?: unknown }).statusCode;
  if (!(err instanceof AppError) && typeof status === 'number' && status >= 400 && status < 500) {
    problem = toProblem(new AppError('bad_request', status, 'The request could not be read'));
  }
  return reply.status(problem.status).type('application/problem+json').send(problem);
};

/** The jobs that give OPEN bets, PENDING bets, stale markets and old manual actions an exit. */
export const opsJobs = (s: Services): Job[] => [
  { name: 'catalogue.checkStale', everyMs: 1_000, run: (now) => s.catalogue.checkStale(now) },
  { name: 'catalogue.closePrematch', everyMs: 10_000, run: (now) => s.catalogue.closePrematch(now) },
  { name: 'betting.recoverPending', everyMs: 30_000, run: (now) => s.betting.recoverPending(now) },
  { name: 'settlement.sweepOpenBets', everyMs: 60_000, run: (now) => s.settlement.sweepOpenBets(now) },
  { name: 'catalogue.settleMarkets', everyMs: 60_000, run: (now) => settleRecentMarkets(s, now) },
  { name: 'settlement.expireManualActions', everyMs: 300_000, run: (now) => s.settlement.expireManualActions(now) },
];

/** Marks markets SETTLED for selections confirmed in the last day (covers trader confirms and manual actions). */
export const settleRecentMarkets = async (s: Services, now: Date): Promise<string[]> => {
  const { rows } = await s.pools.settlement.query<{ selection_id: string }>(
    'SELECT DISTINCT selection_id FROM confirmed_results WHERE confirmed_at > $1',
    [new Date(now.getTime() - 24 * 3_600_000)],
  );
  return rows.length ? s.catalogue.settleMarkets(rows.map((r) => r.selection_id), now) : [];
};

export const buildOps = async (opts: OpsOptions): Promise<Ops> => {
  const services = await buildServices({ ...opts, demo: false });
  const authenticate = staffAuth(opts.staffTokens);
  const upstream = {
    identity: identityServer({ identity: services.identity, authenticate }),
    catalogue: catalogueServer({ catalogue: services.catalogue, authenticate }),
    rg: rgServer({ rg: services.rg, authenticate }),
    settlement: settlementServer({ settlement: services.settlement, authenticate }),
  };

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((err, req, reply) => {
    const r = sendProblem(reply, err);
    if (reply.statusCode >= 500) req.log.error({ err }, 'request failed');
    return r;
  });
  app.setNotFoundHandler((_req, reply) => sendProblem(reply, new AppError('not_found', 404, 'No such route')));
  app.get('/healthz', async () => ({ status: 'ok' }));

  const feedCaller = async (req: FastifyRequest): Promise<Caller> => {
    const who = await authenticate(req);
    if (!who.roles.includes('feed')) throw new AppError('forbidden', 403, 'Feed role required');
    return who;
  };

  // Odds feed intake: a poller pushes raw BetsAPI payloads here. Every call is also a heartbeat.
  const adapter = b365Adapter(FEED_SOURCE);
  // Sequence numbers follow the clock, so payloads pushed to different instances still order correctly.
  let counter = 0n;
  app.post('/v1/feed/events', async (req) => {
    await feedCaller(req);
    counter = (counter + 1n) % 1000n;
    return services.catalogue.ingest(FEED_SOURCE, adapter.normalise(req.body, BigInt(Date.now()) * 1000n + counter));
  });
  app.post('/v1/feed/heartbeat', async (req, reply) => {
    await feedCaller(req);
    await services.catalogue.heartbeat(FEED_SOURCE);
    return reply.status(204).send();
  });

  // Result intake: confirmed results settle their bets at once and settle their markets.
  app.post('/v1/feed/results', async (req) => {
    await feedCaller(req);
    const body = resultsBody.safeParse(req.body);
    if (!body.success) throw new AppError('validation_failed', 400, 'Request failed validation');
    const intake = [];
    const confirmed: string[] = [];
    for (const r of body.data.results) {
      const res = await services.settlement.recordResult({
        selectionId: r.selectionId,
        source: `feed:${r.source}`,
        resultVersion: r.resultVersion,
        outcome: r.outcome as LegOutcome,
        ...(r.deadHeat ? { deadHeat: r.deadHeat } : {}),
      });
      intake.push({ selectionId: r.selectionId, ...res });
      if (res.status === 'CONFIRMED') confirmed.push(res.resultId);
    }
    const settlement = confirmed.length ? await services.settlement.settleSelections(confirmed) : { results: [], failed: [] };
    const settledSelections = intake.filter((i) => i.status === 'CONFIRMED').map((i) => i.selectionId);
    const markets = await services.catalogue.settleMarkets(settledSelections);
    return { intake, settlement, settledMarkets: markets };
  });

  // Staff routes: forwarded to each service's own app, which validates the body and checks the role.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/v1/*',
    handler: async (req, reply) => {
      const path = req.url.split('?')[0]!;
      const target = FORWARD.find(([p]) => path.startsWith(p));
      if (!target) throw new AppError('not_found', 404, 'No such route');
      await authenticate(req); // no anonymous traffic reaches the services
      const headers: Record<string, string> = {};
      for (const h of ['authorization', 'content-type', 'idempotency-key', 'accept']) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const res = await upstream[target[1]].inject({
        method: req.method as 'GET',
        url: req.url,
        headers,
        remoteAddress: req.ip,
        ...(req.body !== undefined ? { payload: JSON.stringify(req.body) } : {}),
      });
      const type = res.headers['content-type'];
      if (typeof type === 'string') void reply.type(type);
      return reply.status(res.statusCode).send(res.rawPayload);
    },
  });

  const jobs = opsJobs(services);
  let stopJobs: (() => Promise<void>) | undefined;
  if (opts.jobs !== false) stopJobs = startJobs(services.pools.settlement, jobs, app.log);
  app.addHook('onClose', async () => {
    if (stopJobs) await stopJobs();
    await Promise.all(Object.values(upstream).map((u) => u.close()));
    await services.end();
  });
  return { app, services, jobs };
};
