import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, toProblem } from '@bp/common';
import type { Identity, RequestMeta, SessionTokens } from './identity.js';
import { password, registrationSchema } from './normalise.js';
import { ACCOUNT_STATES } from './state.js';

export interface AuthContext {
  playerId?: string;
  staffId?: string;
  roles: string[];
  /** Set for player sessions authenticated by this service. */
  sessionId?: string;
}

export interface HttpDeps {
  identity: Identity;
  /** Resolves the caller; throws AppError 401 when credentials are missing or invalid. */
  authenticate: (req: FastifyRequest) => Promise<AuthContext>;
}

/** deps.authenticate for player bearer tokens issued by this service. */
export const playerBearerAuth =
  (identity: Identity) =>
  async (req: FastifyRequest): Promise<AuthContext> => {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization ?? '');
    if (!m) throw new AppError('unauthenticated', 401, 'Authentication required.');
    const { playerId, sessionId } = await identity.authenticateAccess(m[1]!);
    return { playerId, sessionId, roles: ['player'] };
  };

const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError('validation_error', 400, 'The request is invalid.', {
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
};

const token = z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/);
const code = z.string().regex(/^\d{6}$/);
const uuid = z.string().uuid();

const loginBody = z.object({ identifier: z.string().min(1).max(254), password }).strict();
const mfaLoginBody = z.object({ challenge: token, code }).strict();
const refreshBody = z.object({ refreshToken: token }).strict();
const resetRequestBody = z.object({ email: z.string().max(254) }).strict();
const resetConfirmBody = z.object({ token, newPassword: password }).strict();
const emailVerifyBody = z.object({ token }).strict();
const codeBody = z.object({ code }).strict();
const idParams = z.object({ id: uuid }).strict();
const stateBody = z
  .object({
    state: z.enum(ACCOUNT_STATES as [string, ...string[]]).transform((s) => s as (typeof ACCOUNT_STATES)[number]),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const meta = (req: FastifyRequest): RequestMeta => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : null,
});

const tokensBody = (t: SessionTokens) => ({
  status: 'ok' as const,
  sessionId: t.sessionId,
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: t.expiresAt.toISOString(),
});

const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

export const buildServer = (deps: HttpDeps): FastifyInstance => {
  const { identity, authenticate } = deps;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  // SEC-API-001: object-level checks. A player acts only on their own account.
  const requirePlayer = async (req: FastifyRequest) => {
    const ctx = await authenticate(req);
    if (!ctx.playerId || !ctx.sessionId) throw new AppError('forbidden', 403, 'Player access only.');
    return { playerId: ctx.playerId, sessionId: ctx.sessionId };
  };
  const requireStaff = async (req: FastifyRequest, role: string) => {
    const ctx = await authenticate(req);
    if (!ctx.staffId || !ctx.roles.includes(role)) throw new AppError('forbidden', 403, 'Not permitted.');
    return ctx.staffId;
  };

  app.setErrorHandler((err, _req, reply) => {
    let problem = toProblem(err);
    const status = (err as { statusCode?: number }).statusCode;
    // Fastify's own client errors (bad JSON, wrong content type, body too large) stay 4xx without detail leaks.
    if (!(err instanceof AppError) && status && status >= 400 && status < 500) {
      problem = { type: 'urn:bp:error:bad_request', title: 'bad_request', status, detail: 'The request could not be read.' };
    }
    void reply.status(problem.status).type('application/problem+json').send(problem);
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send({ type: 'urn:bp:error:not_found', title: 'not_found', status: 404, detail: 'Not found.' });
  });

  // ----- Public authentication endpoints (they are how a caller obtains credentials) -----

  app.post('/v1/auth/register', async (req, reply) => {
    const body = parse(registrationSchema, req.body);
    await identity.register(body, meta(req));
    // Same response whether or not the email or username already existed (SEC-AUTH-008).
    return reply.status(202).send({ status: 'accepted' });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const body = parse(loginBody, req.body);
    const result = await identity.login(body.identifier, body.password, meta(req));
    noStore(reply);
    if (result.status === 'mfa_required') {
      return { status: 'mfa_required', challenge: result.challenge, expiresAt: result.expiresAt.toISOString() };
    }
    return tokensBody(result.tokens);
  });

  app.post('/v1/auth/mfa/verify', async (req, reply) => {
    const body = parse(mfaLoginBody, req.body);
    const tokens = await identity.completeMfaLogin(body.challenge, body.code, meta(req));
    noStore(reply);
    return tokensBody(tokens);
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    const body = parse(refreshBody, req.body);
    const tokens = await identity.refresh(body.refreshToken);
    noStore(reply);
    return tokensBody(tokens);
  });

  app.post('/v1/auth/password-reset/request', async (req, reply) => {
    const body = parse(resetRequestBody, req.body);
    await identity.requestPasswordReset(body.email);
    return reply.status(202).send({ status: 'accepted' });
  });

  app.post('/v1/auth/password-reset/confirm', async (req, reply) => {
    const body = parse(resetConfirmBody, req.body);
    await identity.confirmPasswordReset(body.token, body.newPassword);
    return reply.status(204).send();
  });

  app.post('/v1/auth/email/verify', async (req, reply) => {
    const body = parse(emailVerifyBody, req.body);
    await identity.verifyEmail(body.token);
    return reply.status(204).send();
  });

  // ----- Player endpoints -----

  app.post('/v1/auth/logout', async (req, reply) => {
    const { sessionId } = await requirePlayer(req);
    await identity.logout(sessionId);
    return reply.status(204).send();
  });

  app.get('/v1/me/sessions', async (req) => {
    const { playerId, sessionId } = await requirePlayer(req);
    const sessions = await identity.listSessions(playerId);
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        current: s.sessionId === sessionId,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
      })),
    };
  });

  app.delete('/v1/me/sessions', async (req, reply) => {
    const { playerId } = await requirePlayer(req);
    await identity.revokeAll(playerId, 'revoked_by_player');
    return reply.status(204).send();
  });

  app.delete('/v1/me/sessions/:id', async (req, reply) => {
    const { playerId } = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    // Another player's session id looks exactly like a missing one.
    if (!(await identity.revokeSession(playerId, id))) throw new AppError('not_found', 404, 'Session not found.');
    return reply.status(204).send();
  });

  app.post('/v1/me/mfa/enrol', async (req, reply) => {
    const { playerId } = await requirePlayer(req);
    noStore(reply);
    return identity.enrolMfa(playerId);
  });

  app.post('/v1/me/mfa/confirm', async (req, reply) => {
    const { playerId, sessionId } = await requirePlayer(req);
    const body = parse(codeBody, req.body);
    await identity.confirmMfa(playerId, sessionId, body.code);
    return reply.status(204).send();
  });

  app.post('/v1/me/mfa/verify', async (req, reply) => {
    const { sessionId } = await requirePlayer(req);
    const body = parse(codeBody, req.body);
    await identity.verifyMfa(sessionId, body.code);
    return reply.status(204).send();
  });

  // ----- Staff endpoints -----

  app.patch('/v1/staff/players/:id/state', async (req) => {
    const staffId = await requireStaff(req, 'compliance');
    const { id } = parse(idParams, req.params);
    const body = parse(stateBody, req.body);
    const status = await identity.setState(id, body.state, `staff:${staffId}`, body.reason, { ip: req.ip });
    return status;
  });

  return app;
};
