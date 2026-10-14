import {
  ACCESS_COOKIE,
  MAX_BODY_BYTES,
  PUBLIC_PATHS,
  REFRESH_COOKIE,
  TOKEN_PATHS,
  allowedPath,
  clearCookies,
  isStateChanging,
  isToken,
  parseCookies,
  problem,
  sameOrigin,
  takeTokens,
} from '../../../lib/proxy.mjs';

export const dynamic = 'force-dynamic';

const UPSTREAM_TIMEOUT_MS = 15_000;
const FORWARDED_HEADERS = ['accept', 'accept-language', 'content-type', 'idempotency-key', 'user-agent'];

const json = (status, body, cookies = []) => {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
};

const readBody = async (req) => {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return { tooLarge: true };
  if (!req.body) return { body: undefined };
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  if (size === 0) return { body: undefined };
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { body: out };
};

const callGateway = async (gateway, path, search, method, headers, body) => {
  const res = await fetch(`${gateway}/${path}${search}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, contentType: res.headers.get('content-type'), text, data };
};

/** Exchanges the refresh cookie for new tokens. Returns the new access token and cookies, or null. */
const refresh = async (gateway, baseHeaders, refreshToken) => {
  if (!isToken(refreshToken)) return null;
  const headers = new Headers(baseHeaders);
  headers.delete('authorization');
  headers.set('content-type', 'application/json');
  headers.delete('idempotency-key');
  const r = await callGateway(gateway, 'v1/auth/refresh', '', 'POST', headers, JSON.stringify({ refreshToken }));
  if (r.status !== 200) return null;
  const taken = takeTokens(r.data);
  if (!taken) return null;
  return { accessToken: r.data.accessToken, cookies: taken.cookies };
};

const handle = async (req, ctx) => {
  const method = req.method.toUpperCase();
  const { path: segments } = await ctx.params;
  const path = allowedPath(method, segments);
  if (!path) return json(404, problem(404, 'not_found', 'No such route.'));

  const gatewayRaw = process.env.GATEWAY_URL;
  if (!gatewayRaw) return json(503, problem(503, 'gateway_not_configured', 'The site is not connected to the platform yet.'));
  const gateway = gatewayRaw.replace(/\/+$/, '');

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (isStateChanging(method) && !sameOrigin(req.headers.get('origin'), host)) {
    return json(403, problem(403, 'csrf_rejected', 'The request did not come from this site.'));
  }

  let body;
  if (isStateChanging(method)) {
    const read = await readBody(req);
    if (read.tooLarge) return json(413, problem(413, 'payload_too_large', 'The request is too large.'));
    body = read.body;
  }

  const cookies = parseCookies(req.headers.get('cookie'));
  const url = new URL(req.url);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const xff = req.headers.get('x-forwarded-for');
  if (xff) headers.set('x-forwarded-for', xff);

  const setCookies = [];
  try {
    // The browser never holds the refresh token, so a refresh request is built from the cookie.
    if (path === 'v1/auth/refresh') {
      const r = await refresh(gateway, headers, cookies[REFRESH_COOKIE]);
      if (!r) return json(401, problem(401, 'unauthenticated', 'Please sign in again.'), clearCookies());
      return json(200, { status: 'ok' }, r.cookies);
    }

    const needsAuth = !PUBLIC_PATHS.has(path);
    let access = cookies[ACCESS_COOKIE];
    if (needsAuth && !isToken(access) && cookies[REFRESH_COOKIE]) {
      const r = await refresh(gateway, headers, cookies[REFRESH_COOKIE]);
      if (r) {
        access = r.accessToken;
        setCookies.push(...r.cookies);
      }
    }
    if (needsAuth && isToken(access)) headers.set('authorization', `Bearer ${access}`);

    let res = await callGateway(gateway, path, url.search, method, headers, body);

    if (res.status === 401 && needsAuth && path !== 'v1/auth/logout' && setCookies.length === 0 && cookies[REFRESH_COOKIE]) {
      const r = await refresh(gateway, headers, cookies[REFRESH_COOKIE]);
      if (r) {
        setCookies.push(...r.cookies);
        headers.set('authorization', `Bearer ${r.accessToken}`);
        res = await callGateway(gateway, path, url.search, method, headers, body);
      } else {
        setCookies.push(...clearCookies());
      }
    }

    if (path === 'v1/auth/logout') {
      return new Response(null, { status: res.status === 401 ? 204 : res.status, headers: cookieHeaders(clearCookies()) });
    }

    if (TOKEN_PATHS.has(path) && res.status === 200) {
      const taken = takeTokens(res.data);
      if (taken) return json(200, taken.body, taken.cookies);
      // No tokens (for example an MFA challenge): pass the body through, never any token-looking fields.
      if (res.data && typeof res.data === 'object') {
        const { accessToken: _a, refreshToken: _r, ...rest } = res.data;
        return json(200, rest);
      }
    }

    if (res.status === 401 && needsAuth && setCookies.length === 0) setCookies.push(...clearCookies());

    const out = cookieHeaders(setCookies);
    if (!res.text) return new Response(null, { status: res.status, headers: out });
    out.set('content-type', res.contentType ?? 'application/json');
    return new Response(res.text, { status: res.status, headers: out });
  } catch {
    if (path === 'v1/auth/logout') return new Response(null, { status: 204, headers: cookieHeaders(clearCookies()) });
    return json(502, problem(502, 'gateway_unreachable', 'The platform could not be reached. Please try again.'), setCookies);
  }
};

const cookieHeaders = (cookies) => {
  const h = new Headers({ 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return h;
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
