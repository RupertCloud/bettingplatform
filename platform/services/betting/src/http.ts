import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  AppError,
  CURRENCY_DECIMALS,
  formatOdds,
  fromMinor,
  MAX_LEGS,
  parseOdds,
  toMinor,
  toProblem,
  type Currency,
  type SelectionQuote,
} from '@bp/common';
import { BOOKING_CODE_PATTERN, type BettingService, type PlayerBet } from './betting.js';

export interface Principal {
  playerId?: string;
  staffId?: string;
  roles: string[];
}

export interface HttpDeps {
  betting: BettingService;
  authenticate: (req: FastifyRequest) => Promise<Principal>;
  /** Staff roles allowed to read any player's bets (SEC-API-001). */
  staffReadRoles?: string[];
}

const DEFAULT_STAFF_READ_ROLES = ['support', 'trader', 'risk', 'compliance', 'auditor'];

const currencies = Object.keys(CURRENCY_DECIMALS) as [Currency, ...Currency[]];
const statuses = ['PENDING', 'OPEN', 'REJECTED', 'SETTLED', 'CASHED_OUT'] as const;

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'Idempotency-Key must be 8-128 safe characters');
const selectionId = z.string().min(1).max(64);

const placeBetBody = z
  .object({
    currency: z.enum(currencies),
    legs: z
      .array(z.object({ selectionId, odds: z.string().regex(/^\d{1,6}(\.\d{1,4})?$/) }).strict())
      .min(1)
      .max(MAX_LEGS),
    combinationSizes: z.array(z.number().int().min(1).max(MAX_LEGS)).min(1).max(MAX_LEGS),
    unitStake: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/),
    oddsChangePolicy: z.enum(['NONE', 'HIGHER', 'ANY']).optional(),
    channel: z.enum(['WEB', 'MOBILE', 'APP', 'USSD', 'RETAIL']),
    device: z.string().min(1).max(256).optional(),
  })
  .strict();

const listQuery = z
  .object({
    status: z
      .string()
      .max(100)
      .transform((s) => s.split(','))
      .pipe(z.array(z.enum(statuses)))
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    playerId: z.string().uuid().optional(),
  })
  .strict();

const betParams = z.object({ id: z.string().uuid() }).strict();
const bookingBody = z.object({ selectionIds: z.array(selectionId).min(1).max(30) }).strict();
const bookingParams = z
  .object({ code: z.string().transform((s) => s.toUpperCase()).pipe(z.string().regex(BOOKING_CODE_PATTERN)) })
  .strict();

export const betView = (b: PlayerBet) => {
  const money = (v: bigint) => fromMinor(v, b.currency);
  return {
    betId: b.betId,
    playerId: b.playerId,
    status: b.status,
    rejection: b.rejection,
    currency: b.currency,
    combinationSizes: b.combinationSizes,
    unitStake: money(b.unitStake),
    totalStake: money(b.totalStake),
    potentialReturn: money(b.potentialReturn),
    oddsChangePolicy: b.oddsChangePolicy,
    channel: b.channel,
    legs: b.legs.map((l) => ({
      selectionId: l.selectionId,
      marketId: l.marketId,
      eventId: l.eventId,
      line: l.line,
      odds: formatOdds(l.odds),
      requestedOdds: formatOdds(l.requestedOdds),
    })),
    submittedAt: b.submittedAt.toISOString(),
    acceptedAt: b.acceptedAt?.toISOString() ?? null,
  };
};

const quoteView = (q: SelectionQuote) => ({
  selectionId: q.selectionId,
  marketId: q.marketId,
  eventId: q.eventId,
  sport: q.sport,
  marketType: q.marketType,
  line: q.line,
  odds: formatOdds(q.odds),
  marketState: q.marketState,
  inPlay: q.inPlay,
  eventStartsAt: q.eventStartsAt.toISOString(),
});

const sendProblem = (reply: FastifyReply, err: unknown) => {
  let problem;
  if (err instanceof ZodError) {
    problem = {
      ...toProblem(new AppError('validation_error', 400, 'The request is not valid')),
      errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  } else if (!(err instanceof AppError) && isClientHttpError(err)) {
    problem = toProblem(new AppError('bad_request', err.statusCode, 'The request could not be read'));
  } else {
    problem = toProblem(err);
  }
  return reply.status(problem.status).type('application/problem+json').send(problem);
};

const isClientHttpError = (err: unknown): err is { statusCode: number } => {
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
};

export const buildServer = (deps: HttpDeps): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const readRoles = deps.staffReadRoles ?? DEFAULT_STAFF_READ_ROLES;
  const { betting } = deps;

  const auth = async (req: FastifyRequest): Promise<Principal> => {
    let p: Principal;
    try {
      p = await deps.authenticate(req);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('unauthenticated', 401, 'Authentication required');
    }
    if (!p.playerId && !p.staffId) throw new AppError('unauthenticated', 401, 'Authentication required');
    return p;
  };
  const isStaffReader = (p: Principal) => !!p.staffId && p.roles.some((r) => readRoles.includes(r));
  const forbidden = () => new AppError('forbidden', 403, 'Not allowed');

  app.setErrorHandler((err, _req, reply) => sendProblem(reply, err));
  app.setNotFoundHandler((_req, reply) => sendProblem(reply, new AppError('not_found', 404, 'No such route')));

  // FR-BET-003..007; Idempotency-Key is the client request ID (IF-API-003, FR-BET-006).
  app.post('/v1/bets', async (req, reply) => {
    const p = await auth(req);
    if (!p.playerId) throw forbidden();
    const requestId = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = placeBetBody.parse(req.body);
    const ua = req.headers['user-agent'];
    const result = await betting.placeBet({
      playerId: p.playerId,
      requestId,
      currency: body.currency,
      legs: body.legs.map((l) => ({ selectionId: l.selectionId, odds: parseOdds(l.odds) })),
      combinationSizes: body.combinationSizes,
      unitStake: toMinor(body.unitStake, body.currency),
      oddsChangePolicy: body.oddsChangePolicy ?? 'HIGHER',
      channel: body.channel,
      ip: req.ip,
      device: (body.device ?? (typeof ua === 'string' ? ua : 'unknown')).slice(0, 256),
    });
    return reply.status(result.replayed ? 200 : 201).send(betView(result.bet));
  });

  // FR-BET-011
  app.get('/v1/bets', async (req) => {
    const p = await auth(req);
    const q = listQuery.parse(req.query);
    let playerId: string;
    if (p.playerId) {
      if (q.playerId && q.playerId !== p.playerId) throw forbidden();
      playerId = p.playerId;
    } else {
      if (!isStaffReader(p)) throw forbidden();
      if (!q.playerId) throw new AppError('validation_error', 400, 'playerId is required');
      playerId = q.playerId;
    }
    const bets = await betting.listBets(playerId, {
      ...(q.status ? { status: q.status } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return { bets: bets.map(betView) };
  });

  app.get('/v1/bets/:id', async (req) => {
    const p = await auth(req);
    const { id } = betParams.parse(req.params);
    if (!p.playerId && !isStaffReader(p)) throw forbidden();
    const bet = await betting.getPlayerBet(id);
    // A player asking for someone else's bet gets the same answer as for a missing one.
    if (!bet || (p.playerId && bet.playerId !== p.playerId)) throw new AppError('bet_not_found', 404, 'No such bet');
    return betView(bet);
  });

  // FR-BET-009
  app.post('/v1/booking-codes', async (req, reply) => {
    const p = await auth(req);
    const body = bookingBody.parse(req.body);
    const saved = await betting.saveBookingCode(p.playerId ?? `staff:${p.staffId}`, body.selectionIds);
    return reply.status(201).send({ code: saved.code, selections: saved.selections.map(quoteView) });
  });

  app.get('/v1/booking-codes/:code', async (req) => {
    await auth(req);
    const { code } = bookingParams.parse(req.params);
    const loaded = await betting.loadBookingCode(code);
    if (!loaded) throw new AppError('booking_code_not_found', 404, 'No such booking code');
    return { code: loaded.code, selections: loaded.selections.map(quoteView) };
  });

  return app;
};
