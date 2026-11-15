// One process, one public HTTP app: wires the six Release 1 services against one database (a schema each)
// and forwards the player-facing routes to each service's own Fastify app. Nothing else is reachable.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { AppError, toProblem } from '@bp/common';
import { type BettingService, buildServer as bettingServer } from '@bp/betting';
import { type CatalogueService, buildServer as catalogueServer } from '@bp/catalogue';
import { type Identity, buildServer as identityServer, playerBearerAuth } from '@bp/identity';
import { type ResponsibleGambling, buildServer as rgServer } from '@bp/rg';
import type { Settlement } from '@bp/settlement';
import { type Wallet, buildServer as walletServer } from '@bp/wallet';
import { buildServices, SERVICES, type ServiceName } from './services.js';
import {
  DEMO_REFRESH_MS,
  MAX_DEPOSIT,
  MIN_DEPOSIT,
  demoDeposit,
  ingestDemoFixtures,
} from './demo.js';

export { SERVICES, type ServiceName };

export interface GatewayOptions {
  databaseUrl: string;
  demo: boolean;
  /** Origins allowed by CORS; empty sends no CORS headers. */
  allowedOrigins: string[];
  /** Fastify trustProxy: true, false, or comma-separated addresses / CIDRs of trusted proxies. */
  trustProxy: boolean | string;
  /** 32-byte key for MFA secrets at rest. Random when absent, so MFA enrolments do not survive a restart. */
  mfaKey?: Buffer;
  /** Prepended to each service's schema name; tests use it for throwaway schemas. */
  schemaPrefix?: string;
  logger?: boolean;
  now?: () => Date;
}

export interface Gateway {
  app: FastifyInstance;
  schemas: Record<ServiceName, string>;
  identity: Identity;
  wallet: Wallet;
  catalogue: CatalogueService;
  rg: ResponsibleGambling;
  betting: BettingService;
  settlement: Settlement;
}

type Route = readonly [HTTPMethods, string];

/** The only paths the player site can reach (everything else is 404). */
const PUBLIC_ROUTES: Record<Exclude<ServiceName, 'settlement'>, Route[]> = {
  identity: [
    ['POST', '/v1/auth/register'],
    ['POST', '/v1/auth/login'],
    ['POST', '/v1/auth/logout'],
    ['POST', '/v1/auth/refresh'],
    ['POST', '/v1/auth/mfa/verify'],
    ['POST', '/v1/auth/email/verify'],
    ['POST', '/v1/auth/password-reset/request'],
    ['POST', '/v1/auth/password-reset/confirm'],
    ['GET', '/v1/me/sessions'],
    ['DELETE', '/v1/me/sessions'],
    ['DELETE', '/v1/me/sessions/:id'],
    ['POST', '/v1/me/mfa/enrol'],
    ['POST', '/v1/me/mfa/confirm'],
    ['POST', '/v1/me/mfa/disable'],
    ['POST', '/v1/me/mfa/verify'],
  ],
  wallet: [['GET', '/v1/wallet/balances']],
  catalogue: [
    ['GET', '/v1/sports'],
    ['GET', '/v1/events'],
    ['GET', '/v1/events/:id'],
  ],
  betting: [
    ['GET', '/v1/bets'],
    ['POST', '/v1/bets'],
    ['GET', '/v1/bets/:id'],
    ['POST', '/v1/booking-codes'],
    ['GET', '/v1/booking-codes/:code'],
  ],
  rg: [
    ['GET', '/v1/rg/limits'],
    ['PUT', '/v1/rg/limits'],
    ['POST', '/v1/rg/limits/confirm'],
    ['POST', '/v1/rg/self-exclusion'],
    ['POST', '/v1/rg/time-out'],
  ],
};

/** Request headers the services read. Anything else (cookies, proxy headers) stays at the gateway. */
const FORWARD_REQUEST = ['authorization', 'content-type', 'idempotency-key', 'user-agent', 'accept'];
/** Response headers that belong to this hop, not to the forwarded response. */
const HOP_BY_HOP = new Set(['connection', 'content-length', 'date', 'keep-alive', 'transfer-encoding']);

const sendProblem = (reply: FastifyReply, err: unknown): FastifyReply => {
  let problem = toProblem(err);
  const status = (err as { statusCode?: unknown }).statusCode;
  // Fastify's own client errors (bad JSON, wrong content type, body too large) stay 4xx without detail leaks.
  if (!(err instanceof AppError) && typeof status === 'number' && status >= 400 && status < 500) {
    problem = toProblem(new AppError('bad_request', status, 'The request could not be read'));
  }
  return reply.status(problem.status).type('application/problem+json').send(problem);
};

const depositBody = z
  .object({
    amount: z
      .string()
      .regex(/^\d{1,7}$/, 'XAF minor units as a string')
      .transform((s) => BigInt(s))
      .refine((v) => v >= MIN_DEPOSIT && v <= MAX_DEPOSIT, 'amount must be 100 to 1000000'),
    requestId: z.string().uuid(),
  })
  .strict();

/** Builds every service, runs their migrations, and returns the public app (not yet listening). */
export const buildGateway = async (opts: GatewayOptions): Promise<Gateway> => {
  const now = opts.now ?? (() => new Date());
  const { schemas, identity, wallet, catalogue, rg, betting, settlement, end: endPools } = await buildServices({
    databaseUrl: opts.databaseUrl,
    demo: opts.demo,
    ...(opts.mfaKey ? { mfaKey: opts.mfaKey } : {}),
    ...(opts.schemaPrefix ? { schemaPrefix: opts.schemaPrefix } : {}),
    now,
  });

  const authenticate = playerBearerAuth(identity);
  const upstream: Record<keyof typeof PUBLIC_ROUTES, FastifyInstance> = {
    identity: identityServer({ identity, authenticate }),
    wallet: walletServer({ wallet, authenticate }),
    catalogue: catalogueServer({ catalogue, authenticate }),
    betting: bettingServer({ betting, authenticate }),
    rg: rgServer({ rg, authenticate }),
  };

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy, bodyLimit: 64 * 1024 });
  app.setErrorHandler((err, req, reply) => {
    const problem = sendProblem(reply, err);
    // Unexpected errors are logged here (message and stack only, never headers or bodies) and never sent.
    if (reply.statusCode >= 500) req.log.error({ err }, 'request failed');
    return problem;
  });
  app.setNotFoundHandler((_req, reply) => sendProblem(reply, new AppError('not_found', 404, 'No such route')));
  if (opts.allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: opts.allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      maxAge: 600,
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/config', async () => ({ demo: opts.demo, currency: 'XAF', jurisdiction: 'CM' }));

  // Forwarded routes take the body as raw bytes, so each service parses and validates it exactly as it would alone.
  await app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    for (const [service, target] of Object.entries(upstream) as [keyof typeof PUBLIC_ROUTES, FastifyInstance][]) {
      for (const [method, url] of PUBLIC_ROUTES[service]) {
        proxy.route({
          method,
          url,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const headers: Record<string, string> = {};
            for (const h of FORWARD_REQUEST) {
              const v = req.headers[h];
              if (typeof v === 'string') headers[h] = v;
            }
            const res = await target.inject({
              method,
              url: req.url,
              headers,
              remoteAddress: req.ip,
              ...(Buffer.isBuffer(req.body) ? { payload: req.body } : {}),
            });
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined && !HOP_BY_HOP.has(name)) void reply.header(name, value);
            }
            return reply.status(res.statusCode).send(res.rawPayload);
          },
        });
      }
    }
  });

  let refresh: NodeJS.Timeout | undefined;
  app.addHook('onClose', async () => {
    if (refresh) clearInterval(refresh);
    await Promise.all(Object.values(upstream).map((u) => u.close()));
    await endPools();
  });

  if (opts.demo) {
    app.post('/v1/demo/deposit', async (req) => {
      const { playerId } = await authenticate(req);
      const parsed = depositBody.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('validation_error', 400, 'The request is invalid.', {
          errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const balance = await demoDeposit({ rg, wallet, now }, playerId!, parsed.data.amount, parsed.data.requestId);
      return { balance };
    });

    try {
      await ingestDemoFixtures(catalogue, now());
    } catch (err) {
      await app.close();
      throw err;
    }
    refresh = setInterval(() => {
      ingestDemoFixtures(catalogue, now()).catch((err: unknown) => app.log.error({ err }, 'demo fixture refresh failed'));
    }, DEMO_REFRESH_MS);
    refresh.unref();
  }

  return { app, schemas, identity, wallet, catalogue, rg, betting, settlement };
};
