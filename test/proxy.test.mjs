import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SIGNED_IN_COOKIE,
  allowedPath,
  clearCookies,
  isStateChanging,
  parseCookies,
  sameOrigin,
  serializeCookie,
  takeTokens,
} from '../lib/proxy.mjs';
import { comboOdds, displayOdds, formatXaf, parseStake, payout } from '../lib/format.mjs';

const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const seg = (p) => p.split('/');

test('allowedPath accepts whitelisted routes with the right method', () => {
  assert.equal(allowedPath('POST', seg('v1/auth/login')), 'v1/auth/login');
  assert.equal(allowedPath('GET', seg('v1/config')), 'v1/config');
  assert.equal(allowedPath('GET', seg(`v1/events/${ID}`)), `v1/events/${ID}`);
  assert.equal(allowedPath('GET', seg(`v1/bets/${ID}`)), `v1/bets/${ID}`);
  assert.equal(allowedPath('PUT', seg('v1/rg/limits')), 'v1/rg/limits');
  assert.equal(allowedPath('POST', seg('v1/demo/deposit')), 'v1/demo/deposit');
});

test('allowedPath refuses other methods, routes and tricky segments', () => {
  assert.equal(allowedPath('GET', seg('v1/auth/login')), null);
  assert.equal(allowedPath('DELETE', seg('v1/bets')), null);
  assert.equal(allowedPath('POST', seg('v1/internal/postings')), null);
  assert.equal(allowedPath('GET', seg('v1/events/not-a-uuid')), null);
  assert.equal(allowedPath('GET', seg(`v1/events/${ID}/markets`)), null);
  assert.equal(allowedPath('PATCH', seg(`v1/staff/players/${ID}/state`)), null);
  assert.equal(allowedPath('GET', ['v1', '..', 'v1', 'config']), null);
  assert.equal(allowedPath('GET', ['v1', 'config%2F..']), null);
  assert.equal(allowedPath('GET', ['v1/config']), null);
  assert.equal(allowedPath('GET', []), null);
  assert.equal(allowedPath('GET', undefined), null);
});

test('sameOrigin compares the Origin host with the request host', () => {
  assert.equal(sameOrigin('https://bet.example.cm', 'bet.example.cm'), true);
  assert.equal(sameOrigin('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(sameOrigin('https://evil.example', 'bet.example.cm'), false);
  assert.equal(sameOrigin('https://bet.example.cm.evil.example', 'bet.example.cm'), false);
  assert.equal(sameOrigin(null, 'bet.example.cm'), false);
  assert.equal(sameOrigin('null', 'bet.example.cm'), false);
  assert.equal(isStateChanging('GET'), false);
  assert.equal(isStateChanging('POST'), true);
  assert.equal(isStateChanging('DELETE'), true);
});

test('parseCookies reads the first value of each cookie', () => {
  const c = parseCookies(`${ACCESS_COOKIE}=abc; other=1; ${ACCESS_COOKIE}=second; enc=a%20b`);
  assert.equal(c[ACCESS_COOKIE], 'abc');
  assert.equal(c.other, '1');
  assert.equal(c.enc, 'a b');
  assert.deepEqual(parseCookies(null), {});
});

test('serializeCookie sets secure defaults', () => {
  const s = serializeCookie('n', 'v', { maxAge: 10 });
  assert.match(s, /^n=v; Path=\/; Secure; SameSite=Lax; HttpOnly; Max-Age=10$/);
  assert.doesNotMatch(serializeCookie('n', 'v', { httpOnly: false }), /HttpOnly/);
  const cleared = clearCookies();
  assert.equal(cleared.length, 3);
  assert.ok(cleared.every((c) => c.includes('Max-Age=0')));
});

test('takeTokens moves tokens into cookies and strips them from the body', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const body = {
    status: 'ok',
    sessionId: ID,
    accessToken: 'A'.repeat(43),
    refreshToken: 'R'.repeat(43),
    expiresAt: '2026-10-14T10:15:00Z',
  };
  const t = takeTokens(body, now);
  assert.deepEqual(t.body, { status: 'ok', sessionId: ID, expiresAt: '2026-10-14T10:15:00Z' });
  const [access, refresh, flag] = t.cookies;
  assert.ok(access.startsWith(`${ACCESS_COOKIE}=${'A'.repeat(43)};`));
  assert.match(access, /HttpOnly/);
  assert.match(access, /Max-Age=900$/);
  assert.ok(refresh.startsWith(`${REFRESH_COOKIE}=`));
  assert.match(refresh, /HttpOnly/);
  assert.ok(flag.startsWith(`${SIGNED_IN_COOKIE}=1;`));
  assert.doesNotMatch(flag, /HttpOnly/);
  assert.ok(!JSON.stringify(t.body).includes('A'.repeat(20)));
});

test('takeTokens returns null for an MFA challenge or malformed tokens', () => {
  assert.equal(takeTokens({ status: 'mfa_required', challenge: 'c'.repeat(43) }), null);
  assert.equal(takeTokens({ accessToken: 'short', refreshToken: 'R'.repeat(43) }), null);
  assert.equal(takeTokens(null), null);
});

test('XAF formatting and slip maths', () => {
  assert.equal(formatXaf('1500000'), '1,500,000 XAF');
  assert.equal(formatXaf('0'), '0 XAF');
  assert.equal(formatXaf('-2500'), '-2,500 XAF');
  assert.equal(formatXaf('999.00'), '999 XAF');
  assert.equal(formatXaf(null), '-');
  assert.equal(parseStake('1,000'), '1000');
  assert.equal(parseStake('0'), null);
  assert.equal(parseStake('12.5'), null);
  assert.equal(displayOdds('2'), '2.00');
  assert.equal(displayOdds('1.875'), '1.875');
  const acc = comboOdds(['2', '1.5']);
  assert.equal(acc, 30000n);
  assert.equal(payout('1000', acc), '3000');
  assert.equal(payout('333', comboOdds(['1.01'])), '336');
});
