// Pure helpers for the API proxy in app/api/[...path]/route.js. No Next.js imports so `node --test` can load them.

export const MAX_BODY_BYTES = 64 * 1024;

export const ACCESS_COOKIE = '__Host-bp_at';
export const REFRESH_COOKIE = '__Host-bp_rt';
/** Readable by page scripts; holds no secret, only tells the UI that a session cookie exists. */
export const SIGNED_IN_COOKIE = 'bp_signed_in';

/** Refresh tokens carry no expiry in the identity response; the server-side session decides validity. */
export const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;
const DEFAULT_ACCESS_MAX_AGE = 15 * 60;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Gateway routes the browser may reach, by method. Everything else is refused with 404. */
const ROUTES = [
  ['POST', 'v1/auth/register'],
  ['POST', 'v1/auth/login'],
  ['POST', 'v1/auth/logout'],
  ['POST', 'v1/auth/refresh'],
  ['POST', 'v1/auth/mfa/verify'],
  ['POST', 'v1/auth/password-reset/request'],
  ['POST', 'v1/auth/password-reset/confirm'],
  ['GET', 'v1/config'],
  ['POST', 'v1/demo/deposit'],
  ['GET', 'v1/wallet/balances'],
  ['GET', 'v1/sports'],
  ['GET', 'v1/events'],
  ['GET', `v1/events/${UUID}`],
  ['GET', 'v1/bets'],
  ['POST', 'v1/bets'],
  ['GET', `v1/bets/${UUID}`],
  ['GET', 'v1/rg/limits'],
  ['PUT', 'v1/rg/limits'],
  ['POST', 'v1/rg/limits/confirm'],
  ['POST', 'v1/rg/self-exclusion'],
  ['POST', 'v1/rg/time-out'],
].map(([method, pattern]) => ({ method, re: new RegExp(`^${pattern}$`) }));

/** Routes that answer without a session; no Authorization header is attached. */
export const PUBLIC_PATHS = new Set(['v1/auth/register', 'v1/auth/login', 'v1/config', 'v1/auth/mfa/verify', 'v1/auth/password-reset/request', 'v1/auth/password-reset/confirm']);

/** Successful responses from these carry tokens that the proxy moves into cookies. */
export const TOKEN_PATHS = new Set(['v1/auth/login', 'v1/auth/refresh', 'v1/auth/mfa/verify']);

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;

/**
 * Returns the gateway path ("v1/...") for an allowed method and path segments, or null.
 * Segments are checked one by one so encoded slashes, dot segments and odd characters never pass.
 */
export const allowedPath = (method, segments) => {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 6) return null;
  if (!segments.every((s) => typeof s === 'string' && SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  const path = segments.join('/');
  return ROUTES.some((r) => r.method === method && r.re.test(path)) ? path : null;
};

export const isStateChanging = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);

/** CSRF check: a state-changing call must come from a page on this same host. */
export const sameOrigin = (origin, host) => {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};

export const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    out[name] = value;
  }
  return out;
};

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
export const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);

export const serializeCookie = (name, value, { maxAge, httpOnly = true } = {}) => {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Secure', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
};

export const clearCookies = () => [
  serializeCookie(ACCESS_COOKIE, '', { maxAge: 0 }),
  serializeCookie(REFRESH_COOKIE, '', { maxAge: 0 }),
  serializeCookie(SIGNED_IN_COOKIE, '', { maxAge: 0, httpOnly: false }),
];

/**
 * Splits a token response into Set-Cookie values and a body safe for page scripts.
 * Returns null when the body does not hold a valid token pair (for example status "mfa_required").
 */
export const takeTokens = (body, now = Date.now()) => {
  if (!body || typeof body !== 'object' || !isToken(body.accessToken) || !isToken(body.refreshToken)) return null;
  const expires = Date.parse(body.expiresAt);
  const accessMaxAge = Number.isFinite(expires) ? Math.max(1, (expires - now) / 1000) : DEFAULT_ACCESS_MAX_AGE;
  const { accessToken, refreshToken, ...rest } = body;
  return {
    cookies: [
      serializeCookie(ACCESS_COOKIE, accessToken, { maxAge: accessMaxAge }),
      serializeCookie(REFRESH_COOKIE, refreshToken, { maxAge: REFRESH_MAX_AGE }),
      serializeCookie(SIGNED_IN_COOKIE, '1', { maxAge: REFRESH_MAX_AGE, httpOnly: false }),
    ],
    body: rest,
  };
};

/** Problem JSON in the gateway's shape, for errors the proxy itself raises. */
export const problem = (status, code, detail) => ({ type: `urn:bp:error:${code}`, title: code, code, status, detail });
