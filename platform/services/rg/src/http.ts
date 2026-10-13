import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AppError, fromMinor, toMinor, toProblem, type Currency } from '@bp/common';
import { INTERVENTION_TYPES } from './risk.js';
import {
  INTERVENTION_OUTCOMES,
  LIMIT_KINDS,
  isMoneyLimit,
  type Actor,
  type Intervention,
  type LimitKind,
  type ResponsibleGambling,
} from './rg.js';
import { JURISDICTION, SELF_EXCLUSION_PERIODS, TIME_OUT_PERIODS, rulesJsonSchema, type RulesVersion } from './rules.js';

export interface Identity {
  playerId?: string;
  staffId?: string;
  roles: string[];
}

export interface ServerDeps {
  rg: ResponsibleGambling;
  authenticate: (req: FastifyRequest) => Promise<Identity>;
}

const COMPLIANCE = 'compliance';

const decimal = z.string().regex(/^\d{1,18}(\.\d{1,4})?$/, 'Decimal string expected');
const reason = z.string().trim().min(3).max(500);
const uuid = z.string().uuid();

const limitBody = z.object({ kind: z.enum(LIMIT_KINDS), value: z.string().max(40).nullable() }).strict();
const confirmBody = z.object({ kind: z.enum(LIMIT_KINDS) }).strict();
const timeOutBody = z.object({ period: z.enum(TIME_OUT_PERIODS) }).strict();
const selfExclusionBody = z.object({ period: z.enum(SELF_EXCLUSION_PERIODS) }).strict();
const playerParams = z.object({ playerId: uuid }).strict();
const idParams = z.object({ id: uuid }).strict();
const interventionBody = z.object({ type: z.enum(INTERVENTION_TYPES), reason }).strict();
const outcomeBody = z.object({ outcome: z.enum(INTERVENTION_OUTCOMES), reason }).strict();
const jurisdictionParams = z.object({ jurisdiction: z.string().regex(JURISDICTION) }).strict();
const versionParams = z
  .object({ jurisdiction: z.string().regex(JURISDICTION), version: z.string().regex(/^[1-9]\d{0,5}$/) })
  .strict();
const rulesBody = z
  .object({
    rules: rulesJsonSchema.extend({ affordabilityNetDepositThreshold: decimal }),
    effectiveFrom: z.string().datetime({ offset: true }),
    reason,
  })
  .strict();
const approvalBody = z.object({ reason }).strict();
const affordabilityBody = z
  .object({ approvedAmount: decimal, currency: z.enum(['XAF', 'EUR', 'USD']), reason })
  .strict();

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

/** Player routes act only on the caller's own data (SEC-API-001). */
const asPlayer = async (deps: ServerDeps, req: FastifyRequest): Promise<string> => {
  const who = await identify(deps, req);
  if (!who.playerId) throw new AppError('forbidden', 403, 'Player access only');
  return who.playerId;
};

const asCompliance = async (deps: ServerDeps, req: FastifyRequest): Promise<Actor> => {
  const who = await identify(deps, req);
  if (!who.staffId || !who.roles.includes(COMPLIANCE)) throw new AppError('forbidden', 403, 'Compliance role required');
  return { staffId: who.staffId, ip: req.ip };
};

const parseLimitValue = (kind: LimitKind, value: string | null, currency: Currency): bigint | null => {
  if (value === null) return null;
  if (!isMoneyLimit(kind)) {
    if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
      throw new AppError('validation_error', 400, 'Session limit must be 1 to 1440 minutes');
    }
    return BigInt(value);
  }
  if (!/^\d{1,18}(\.\d{1,4})?$/.test(value)) throw new AppError('validation_error', 400, 'Decimal string expected');
  const minor = toMinor(value, currency);
  if (minor <= 0n) throw new AppError('validation_error', 400, 'Limit must be positive');
  return minor;
};

const showLimitValue = (kind: LimitKind, value: bigint | null, currency: Currency): string | null =>
  value === null ? null : isMoneyLimit(kind) ? fromMinor(value, currency) : value.toString();

const showRules = (v: RulesVersion) => ({
  jurisdiction: v.jurisdiction,
  version: v.version,
  status: v.status,
  effectiveFrom: v.effectiveFrom.toISOString(),
  author: v.author,
  approvedBy: v.approvedBy,
  approvedAt: v.approvedAt?.toISOString() ?? null,
  rules: {
    ...v.rules,
    affordabilityNetDepositThreshold: fromMinor(v.rules.affordabilityNetDepositThreshold, v.rules.currency),
  },
});

const showIntervention = (i: Intervention) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
  outcomeAt: i.outcomeAt?.toISOString() ?? null,
});

/** HTTP API for responsible gambling (SEC-API-001, SEC-API-002, IF-API-002). */
export const buildServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify({ logger: false });
  const { rg } = deps;

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

  // ----- Player routes -----

  app.get('/v1/rg/limits', async (req) => {
    const playerId = await asPlayer(deps, req);
    const currency = await rg.currencyOf(playerId);
    const limits = await rg.getLimits(playerId);
    return {
      currency,
      limits: limits.map((l) => ({
        kind: l.kind,
        value: showLimitValue(l.kind, l.value, currency),
        pending: l.pending
          ? { value: showLimitValue(l.kind, l.pending.value, currency), availableAt: l.pending.availableAt.toISOString() }
          : null,
      })),
    };
  });

  app.put('/v1/rg/limits', async (req) => {
    const playerId = await asPlayer(deps, req);
    const body = limitBody.parse(req.body);
    const currency = await rg.currencyOf(playerId);
    const result = await rg.setLimit(playerId, body.kind, parseLimitValue(body.kind, body.value, currency));
    return result.status === 'PENDING'
      ? { kind: body.kind, status: result.status, availableAt: result.availableAt.toISOString() }
      : { kind: body.kind, status: result.status };
  });

  app.post('/v1/rg/limits/confirm', async (req) => {
    const playerId = await asPlayer(deps, req);
    const body = confirmBody.parse(req.body);
    const currency = await rg.currencyOf(playerId);
    const r = await rg.confirmLimit(playerId, body.kind);
    return { kind: r.kind, value: showLimitValue(r.kind, r.value, currency), status: 'CONFIRMED' };
  });

  app.post('/v1/rg/time-out', async (req, reply) => {
    const playerId = await asPlayer(deps, req);
    const body = timeOutBody.parse(req.body);
    const e = await rg.timeOut(playerId, body.period);
    return reply.status(201).send({ state: e.state, until: e.until?.toISOString() ?? null });
  });

  app.post('/v1/rg/self-exclusion', async (req, reply) => {
    const playerId = await asPlayer(deps, req);
    const body = selfExclusionBody.parse(req.body);
    const e = await rg.selfExclude(playerId, body.period);
    return reply.status(201).send({ state: e.state, until: e.until?.toISOString() ?? null });
  });

  // ----- Compliance routes -----

  app.get('/v1/rg/players/:playerId/risk', async (req) => {
    await asCompliance(deps, req);
    const { playerId } = playerParams.parse(req.params);
    const risk = await rg.getRisk(playerId);
    return {
      playerId,
      latest: risk.latest ? { ...risk.latest, computedAt: risk.latest.computedAt.toISOString() } : null,
      interventions: risk.interventions.map(showIntervention),
    };
  });

  app.post('/v1/rg/players/:playerId/interventions', async (req, reply) => {
    const actor = await asCompliance(deps, req);
    const { playerId } = playerParams.parse(req.params);
    const body = interventionBody.parse(req.body);
    const i = await rg.createIntervention(playerId, body.type, actor, body.reason);
    return reply.status(201).send(showIntervention(i));
  });

  app.post('/v1/rg/interventions/:id/outcome', async (req) => {
    const actor = await asCompliance(deps, req);
    const { id } = idParams.parse(req.params);
    const body = outcomeBody.parse(req.body);
    return showIntervention(await rg.recordInterventionOutcome(id, body.outcome, actor, body.reason));
  });

  app.post('/v1/rg/rules/:jurisdiction/versions', async (req, reply) => {
    const actor = await asCompliance(deps, req);
    const { jurisdiction } = jurisdictionParams.parse(req.params);
    const body = rulesBody.parse(req.body);
    const rules = {
      ...body.rules,
      affordabilityNetDepositThreshold: toMinor(body.rules.affordabilityNetDepositThreshold, body.rules.currency),
    };
    if (rules.affordabilityNetDepositThreshold <= 0n) throw new AppError('validation_error', 400, 'Threshold must be positive');
    const v = await rg.proposeRules(jurisdiction, rules, new Date(body.effectiveFrom), actor, body.reason);
    return reply.status(201).send(showRules(v));
  });

  app.post('/v1/rg/rules/:jurisdiction/versions/:version/approval', async (req) => {
    const actor = await asCompliance(deps, req);
    const { jurisdiction, version } = versionParams.parse(req.params);
    const body = approvalBody.parse(req.body);
    return showRules(await rg.approveRules(jurisdiction, Number(version), actor, body.reason));
  });

  app.post('/v1/rg/affordability/:id/resolution', async (req) => {
    const actor = await asCompliance(deps, req);
    const { id } = idParams.parse(req.params);
    const body = affordabilityBody.parse(req.body);
    await rg.resolveAffordability(id, toMinor(body.approvedAmount, body.currency), body.currency, actor, body.reason);
    return { id, status: 'CLEARED' };
  });

  return app;
};
