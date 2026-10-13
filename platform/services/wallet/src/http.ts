import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AppError, fromMinor, toMinor, toProblem, type AccountRef, type PostingRequest } from '@bp/common';
import { LEDGER_REASONS, MAX_LINES, OPERATOR_KINDS, PLAYER_KINDS, type Wallet } from './ledger.js';

export interface Identity {
  playerId?: string;
  staffId?: string;
  roles: string[];
}

export interface ServerDeps {
  wallet: Wallet;
  authenticate: (req: FastifyRequest) => Promise<Identity>;
}

const currency = z.enum(['XAF', 'EUR', 'USD']);
const text = z.string().min(1).max(200);
const decimal = z.string().regex(/^-?\d{1,18}(\.\d{1,4})?$/, 'Decimal string expected');

const accountSchema = z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('PLAYER'), playerId: z.string().uuid(), kind: z.enum(PLAYER_KINDS), currency }).strict(),
  z.object({ owner: z.literal('OPERATOR'), kind: z.enum(OPERATOR_KINDS), currency }).strict(),
]);

const postingBody = z
  .object({
    // Adjustments and reversals carry staff accountability and have their own flows (FR-WAL-007, FR-WAL-011).
    reason: z.enum(LEDGER_REASONS).refine((r) => r !== 'ADJUSTMENT' && r !== 'REVERSAL', 'Reason not allowed here'),
    reference: text,
    actor: text.optional(),
    lines: z.array(z.object({ account: accountSchema, amount: decimal }).strict()).min(1).max(MAX_LINES),
  })
  .strict();

const balancesQuery = z.object({ currency }).strict();
const idempotencyKey = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, 'Printable ASCII expected');

const sendProblem = (reply: FastifyReply, err: unknown): FastifyReply => {
  const problem = toProblem(err);
  return reply.status(problem.status).type('application/problem+json').send(problem);
};

const identify = async (deps: ServerDeps, req: FastifyRequest): Promise<Identity> => {
  let who: Identity;
  try {
    who = await deps.authenticate(req);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('unauthenticated', 401, 'Authentication required');
  }
  if (!who || (!who.playerId && !who.staffId)) throw new AppError('unauthenticated', 401, 'Authentication required');
  return { ...who, roles: Array.isArray(who.roles) ? who.roles : [] };
};

/** HTTP API for the wallet (SEC-API-001, SEC-API-002, IF-API-002, IF-API-003). */
export const buildServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return sendProblem(
        reply,
        new AppError('validation_error', 400, 'Request failed validation', {
          errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (!(err instanceof AppError) && status && status >= 400 && status < 500) {
      return sendProblem(reply, new AppError('bad_request', status, 'Malformed request'));
    }
    return sendProblem(reply, err);
  });
  app.setNotFoundHandler((_req, reply) => sendProblem(reply, new AppError('not_found', 404, 'No such route')));

  // A player sees only their own balances (SEC-API-001).
  app.get('/v1/wallet/balances', async (req) => {
    const who = await identify(deps, req);
    if (!who.playerId) throw new AppError('forbidden', 403, 'Player access only');
    const { currency: cur } = balancesQuery.parse(req.query);
    const b = await deps.wallet.playerBalances(who.playerId, cur);
    return {
      playerId: who.playerId,
      currency: cur,
      balances: {
        CASH: fromMinor(b.CASH, cur),
        BONUS: fromMinor(b.BONUS, cur),
        PENDING_WITHDRAWAL: fromMinor(b.PENDING_WITHDRAWAL, cur),
      },
    };
  });

  // Internal postings by other services, staff role "service" only.
  app.post('/v1/internal/postings', async (req, reply) => {
    const who = await identify(deps, req);
    if (!who.staffId || !who.roles.includes('service')) throw new AppError('forbidden', 403, 'Service role required');
    const key = req.headers['idempotency-key'];
    if (key === undefined) throw new AppError('idempotency_key_required', 400, 'Idempotency-Key header is required');
    const idem = idempotencyKey.parse(key);
    const body = postingBody.parse(req.body);
    const request: PostingRequest = {
      idempotencyKey: idem,
      reason: body.reason,
      reference: body.reference,
      lines: body.lines.map((l) => ({ account: l.account as AccountRef, amount: toMinor(l.amount, l.account.currency) })),
      ...(body.actor === undefined ? {} : { actor: body.actor }),
    };
    const entry = await deps.wallet.post(request);
    return reply.status(entry.replayed ? 200 : 201).send({ ...entry, postedAt: entry.postedAt.toISOString() });
  });

  return app;
};
