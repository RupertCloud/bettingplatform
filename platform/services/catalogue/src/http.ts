import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, formatOdds, parseOdds, toProblem } from '@bp/common';
import type { CatalogueService, EventSummary, MarketView } from './catalogue.js';
import { isUuid } from './catalogue.js';
import type { TraderContext } from './audit.js';

export interface Principal {
  playerId?: string;
  staffId?: string;
  roles: string[];
}

export interface HttpDeps {
  catalogue: CatalogueService;
  authenticate: (req: FastifyRequest) => Promise<Principal>;
}

export const TRADER_ROLE = 'trader';

const uuid = z.string().refine(isUuid, 'must be a UUID');
const idParams = z.object({ id: uuid }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const oddsString = z.string().regex(/^\d{1,6}(\.\d{1,4})?$/, 'decimal odds with up to 4 places');
const overrideBody = z.object({ odds: oddsString.nullable(), reason: z.string().trim().min(3).max(500) }).strict();
const eventsQuery = z
  .object({
    sport: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
    live: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
const marketType = z.string().regex(/^[A-Z0-9_]{1,40}$/);
const createEventBody = z
  .object({
    sport: z.string().regex(/^[a-z0-9-]{1,40}$/),
    competitionId: uuid.optional(),
    competitionName: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200),
    startsAt: z.string().datetime({ offset: true }),
    inPlayOffered: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((b) => (b.competitionId === undefined) !== (b.competitionName === undefined), {
    message: 'exactly one of competitionId or competitionName',
  });
const createMarketBody = z
  .object({
    type: marketType,
    line: z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,2})?$/)
      .nullable(),
    selections: z
      .array(z.object({ key: z.string().regex(/^[A-Z0-9_]{1,40}$/), name: z.string().trim().min(1).max(200), odds: oddsString }).strict())
      .min(1)
      .max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const eventJson = (e: EventSummary) => ({
  eventId: e.eventId,
  sport: e.sport,
  competition: { id: e.competitionId, name: e.competitionName },
  name: e.name,
  startsAt: e.startsAt.toISOString(),
  status: e.status,
  inPlay: e.inPlay,
  suspended: e.suspended,
});

const marketJson = (m: MarketView) => ({
  marketId: m.marketId,
  type: m.type,
  line: m.line,
  state: m.state,
  // Odds cross HTTP as decimal strings, never JSON numbers.
  selections: m.selections.map((s) => ({
    selectionId: s.selectionId,
    key: s.key,
    name: s.name,
    odds: s.odds === null ? null : formatOdds(s.odds),
    state: s.state,
    priceVersion: s.priceVersion,
  })),
});

const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 400, 'Request validation failed', {
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
};

export const buildServer = (deps: HttpDeps): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const { catalogue } = deps;

  app.setErrorHandler((err: unknown, _req, reply) => {
    let problem = toProblem(err);
    const status = (err as { statusCode?: unknown }).statusCode;
    if (!(err instanceof AppError) && typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify's own client errors (bad JSON, wrong content type, body too large).
      problem = toProblem(new AppError('bad_request', status, 'The request could not be processed'));
    }
    void reply.status(problem.status).type('application/problem+json').send(problem);
  });
  app.setNotFoundHandler((_req, reply) => {
    const problem = toProblem(new AppError('not_found', 404, 'No such route'));
    void reply.status(404).type('application/problem+json').send(problem);
  });

  /** SEC-API-001: authenticates every request; the catalogue is public to any authenticated caller. */
  const caller = async (req: FastifyRequest): Promise<Principal> => deps.authenticate(req);

  /** Staff routes: must be a staff user holding the trader role. */
  const trader = async (req: FastifyRequest): Promise<{ staffId: string }> => {
    const p = await deps.authenticate(req);
    if (!p.staffId && !p.playerId) throw new AppError('unauthenticated', 401, 'Authentication required');
    if (!p.staffId || !p.roles.includes(TRADER_ROLE)) throw new AppError('forbidden', 403, 'Trader role required');
    return { staffId: p.staffId };
  };

  const ctx = (staffId: string, reason: string, req: FastifyRequest): TraderContext => ({ actor: staffId, reason, ip: req.ip });

  app.get('/v1/sports', async (req) => {
    await caller(req);
    return { sports: await catalogue.listSports() };
  });

  app.get('/v1/events', async (req) => {
    await caller(req);
    const q = parse(eventsQuery, req.query);
    const events = await catalogue.listEvents({
      ...(q.sport ? { sport: q.sport } : {}),
      ...(q.live ? { live: q.live === 'true' } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return { events: events.map(eventJson) };
  });

  app.get('/v1/events/:id', async (req) => {
    await caller(req);
    const { id } = parse(idParams, req.params);
    const event = await catalogue.getEvent(id);
    if (!event) throw new AppError('event_not_found', 404, 'No such event');
    return { ...eventJson(event), markets: event.markets.map(marketJson) };
  });

  const suspensionRoute = (
    path: string,
    action: (id: string, c: TraderContext) => Promise<void>,
  ): void => {
    app.post(path, async (req, reply: FastifyReply) => {
      const { staffId } = await trader(req);
      const { id } = parse(idParams, req.params);
      const { reason } = parse(reasonBody, req.body);
      await action(id, ctx(staffId, reason, req));
      return reply.status(204).send();
    });
  };

  suspensionRoute('/v1/trading/events/:id/suspend', (id, c) => catalogue.suspendEvent(id, c));
  suspensionRoute('/v1/trading/events/:id/reopen', (id, c) => catalogue.reopenEvent(id, c));
  suspensionRoute('/v1/trading/markets/:id/suspend', (id, c) => catalogue.suspendMarket(id, c));
  suspensionRoute('/v1/trading/markets/:id/reopen', (id, c) => catalogue.reopenMarket(id, c));
  suspensionRoute('/v1/trading/selections/:id/suspend', (id, c) => catalogue.suspendSelection(id, c));
  suspensionRoute('/v1/trading/selections/:id/reopen', (id, c) => catalogue.reopenSelection(id, c));

  app.post('/v1/trading/selections/:id/price', async (req, reply) => {
    const { staffId } = await trader(req);
    const { id } = parse(idParams, req.params);
    const body = parse(overrideBody, req.body);
    await catalogue.overridePrice(id, body.odds === null ? null : parseOdds(body.odds), ctx(staffId, body.reason, req));
    return reply.status(204).send();
  });

  app.post('/v1/trading/events', async (req, reply) => {
    const { staffId } = await trader(req);
    const body = parse(createEventBody, req.body);
    const eventId = await catalogue.createEvent(
      {
        sport: body.sport,
        ...(body.competitionId ? { competitionId: body.competitionId } : {}),
        ...(body.competitionName ? { competitionName: body.competitionName } : {}),
        name: body.name,
        startsAt: new Date(body.startsAt),
        inPlayOffered: body.inPlayOffered,
      },
      ctx(staffId, body.reason, req),
    );
    return reply.status(201).send({ eventId });
  });

  app.post('/v1/trading/events/:id/markets', async (req, reply) => {
    const { staffId } = await trader(req);
    const { id } = parse(idParams, req.params);
    const body = parse(createMarketBody, req.body);
    const marketId = await catalogue.createMarket(
      id,
      { type: body.type, line: body.line, selections: body.selections.map((s) => ({ key: s.key, name: s.name, odds: parseOdds(s.odds) })) },
      ctx(staffId, body.reason, req),
    );
    return reply.status(201).send({ marketId });
  });

  return app;
};
