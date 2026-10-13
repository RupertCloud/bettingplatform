import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AppError, fromMinor, toProblem } from '@bp/common';
import type { BatchSummary, ManualAction, Settlement, StaffContext } from './settlement.js';

export interface Identity {
  playerId?: string;
  staffId?: string;
  roles: string[];
}

export interface HttpDeps {
  settlement: Settlement;
  authenticate: (req: FastifyRequest) => Promise<Identity>;
}

const outcome = z.enum(['WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'DEAD_HEAT']);
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const deadHeat = z.object({
  numerator: z.number().int().min(1).max(1000),
  denominator: z.number().int().min(1).max(1000),
}).strict().refine((d) => d.numerator <= d.denominator, 'numerator must not exceed denominator');

const confirmBody = z.object({
  selectionId: id,
  resultVersion: z.number().int().min(1).max(1_000_000),
  outcome,
  deadHeat: deadHeat.optional(),
}).strict().refine((b) => (b.outcome === 'DEAD_HEAT') === (b.deadHeat !== undefined), 'deadHeat is required for DEAD_HEAT only');

const manualBody = z.object({
  action: z.enum(['SETTLE', 'VOID']),
  reason: z.string().trim().min(3).max(500),
  results: z.array(z.object({
    selectionId: id,
    outcome: outcome.optional(),
    deadHeat: deadHeat.optional(),
  }).strict()).min(1).max(200),
}).strict();

const actionParams = z.object({ actionId: z.string().uuid() }).strict();
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

const requireKey = (req: FastifyRequest): string => {
  const parsed = idempotencyKey.safeParse(req.headers['idempotency-key']);
  if (!parsed.success) throw new AppError('idempotency_key_required', 400, 'A valid Idempotency-Key header is required');
  return parsed.data;
};

const summaryView = (s: BatchSummary) => ({ results: s.results, failed: s.failed });

const manualView = (a: ManualAction) => ({
  actionId: a.actionId,
  action: a.action,
  results: a.results,
  reason: a.reason,
  requestedBy: a.requestedBy,
  approvedBy: a.approvedBy,
  status: a.status,
  affectedStake: a.affectedStake.map((s) => ({ currency: s.currency, amount: fromMinor(s.amount, s.currency) })),
  ...(a.settlement ? { settlement: summaryView(a.settlement) } : {}),
});

export const buildServer = (deps: HttpDeps): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const { settlement } = deps;

  /** Authenticates and requires a staff user with the role (SEC-API-001). */
  const staff = async (req: FastifyRequest, role: string): Promise<StaffContext> => {
    let who: Identity;
    try {
      who = await deps.authenticate(req);
    } catch {
      throw new AppError('unauthenticated', 401, 'Authentication required');
    }
    if (!who.staffId || !who.roles.includes(role)) throw new AppError('forbidden', 403, `Role ${role} required`);
    return { staffId: who.staffId, ip: req.ip };
  };

  app.setErrorHandler((err, _req, reply) => {
    let problem;
    if (err instanceof ZodError) {
      problem = {
        ...toProblem(new AppError('validation_failed', 400, 'Request failed validation')),
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (!(err instanceof AppError) && (err as { statusCode?: number }).statusCode === 400) {
      problem = toProblem(new AppError('bad_request', 400, 'Malformed request'));
    } else if (!(err instanceof AppError) && (err as { statusCode?: number }).statusCode === 415) {
      problem = toProblem(new AppError('unsupported_media_type', 415, 'Use application/json'));
    } else {
      problem = toProblem(err);
    }
    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.get('/v1/settlement/mismatches', async (req) => {
    await staff(req, 'trader');
    const items = await settlement.listMismatches();
    return { items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) };
  });

  app.post('/v1/settlement/results/confirm', async (req) => {
    const who = await staff(req, 'trader');
    requireKey(req); // the confirm and the settlement it triggers are idempotent by content
    const body = confirmBody.parse(req.body);
    const result = await settlement.confirmResult(
      { selectionId: body.selectionId, resultVersion: body.resultVersion, outcome: body.outcome, ...(body.deadHeat ? { deadHeat: body.deadHeat } : {}) },
      who,
    );
    const summary = await settlement.settleSelections([result.resultId], { actor: who.staffId });
    return { result: { ...result, confirmedAt: result.confirmedAt.toISOString() }, settlement: summaryView(summary) };
  });

  app.post('/v1/settlement/manual-actions', async (req, reply) => {
    const who = await staff(req, 'trader');
    const key = requireKey(req);
    const body = manualBody.parse(req.body);
    const action = await settlement.requestManual(
      {
        action: body.action,
        reason: body.reason,
        results: body.results.map((r) => ({
          selectionId: r.selectionId,
          ...(r.outcome ? { outcome: r.outcome } : {}),
          ...(r.deadHeat ? { deadHeat: r.deadHeat } : {}),
        })),
      },
      who,
      key,
    );
    void reply.status(action.status === 'PENDING_APPROVAL' ? 202 : 200);
    return manualView(action);
  });

  app.post('/v1/settlement/manual-actions/:actionId/approve', async (req) => {
    const who = await staff(req, 'trader');
    requireKey(req); // approval is idempotent per approver
    const { actionId } = actionParams.parse(req.params);
    return manualView(await settlement.approveManual(actionId, who));
  });

  app.get('/v1/settlement/manual-review', async (req) => {
    await staff(req, 'finance');
    const items = await settlement.listManualReview();
    return {
      items: items.map((i) => ({
        ...i,
        deltaNet: fromMinor(i.deltaNet, i.currency),
        createdAt: i.createdAt.toISOString(),
      })),
    };
  });

  return app;
};
