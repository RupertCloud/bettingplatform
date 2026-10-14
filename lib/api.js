'use client';

import { formatXaf, displayOdds } from './format.mjs';

/**
 * Calls the platform through this site's proxy. Never throws: returns
 * { ok, status, data } on success and { ok: false, status, error: { code, detail, ... } } on failure.
 */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers }, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    return { ok: false, status: 0, error: { code: 'network', detail: 'No connection.' } };
  }
  let data = null;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) markSignedOut();
  if (res.ok) return { ok: true, status: res.status, data };
  const p = data && typeof data === 'object' ? data : {};
  return { ok: false, status: res.status, error: { ...p, code: p.code ?? p.title ?? 'error', detail: p.detail ?? '' } };
}

export const newRequestId = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// ----- Signed-in state (a non-secret cookie set by the proxy) -----

const listeners = new Set();
export const isSignedIn = () => typeof document !== 'undefined' && /(?:^|;\s*)bp_signed_in=1(?:;|$)/.test(document.cookie);
export const onAuthChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const notifyAuthChange = () => listeners.forEach((fn) => fn(isSignedIn()));
function markSignedOut() {
  notifyAuthChange();
}

// ----- Plain-words messages for platform refusals -----

const MESSAGES = {
  gateway_not_configured: 'This site is not connected to the betting platform yet. Please come back later.',
  gateway_unreachable: 'The platform could not be reached. Please try again in a moment.',
  network: 'No connection. Check your internet and try again.',
  unauthenticated: 'Please sign in to continue.',
  forbidden: 'You are not allowed to do this.',
  csrf_rejected: 'This request was blocked for your safety. Reload the page and try again.',
  payload_too_large: 'The request is too large.',
  validation_error: 'Some details are not valid. Please check the form.',
  validation_failed: 'Some details are not valid. Please check the form.',
  bad_request: 'The request could not be read. Please try again.',
  invalid_credentials: 'The username or password is not correct.',
  too_many_attempts: 'Too many failed attempts. Please try again later.',
  account_unavailable: 'This account cannot sign in right now. Please contact support.',
  invalid_code: 'That code is not correct or has expired.',
  invalid_token: 'This link or code has expired. Please start again.',
  underage: 'You must be at least 18 to register.',
  weak_password: 'Use a password of at least 10 characters.',
  breached_password: 'This password has appeared in a data breach. Please choose another.',
  insufficient_funds: 'You do not have enough money in your wallet for this stake.',
  account_not_active: 'Your account cannot place bets right now.',
  kyc_required: 'Please verify your identity before placing bets.',
  currency_mismatch: 'Bets must be in your account currency.',
  invalid_stake: 'Enter a stake greater than zero.',
  duplicate_selection: 'The same selection is in your slip twice.',
  selection_not_found: 'One of your selections is no longer available. Remove it and try again.',
  correlated_selections: 'An accumulator cannot have two selections from the same match.',
  market_not_open: 'One of your markets is suspended or closed. Remove it or try again later.',
  event_started: 'One of your matches has already started.',
  price_changed: 'A price has changed. Check the new price and place the bet again.',
  stake_below_min: 'Your stake is below the minimum.',
  stake_above_max: 'Your stake is above the maximum allowed.',
  payout_above_max: 'The potential return is above the maximum payout. Lower your stake.',
  liability_limit: 'This selection is not taking more bets at this stake. Try a lower stake.',
  idempotency_conflict: 'This bet was already sent with different details. Please try again.',
  too_many_lines: 'Too many selections for one bet.',
  invalid_bet: 'This bet is not valid.',
  self_excluded: 'Your account is self-excluded, so you cannot bet.',
  timed_out: 'Your account is in a time-out, so you cannot bet right now.',
  rg_suspended: 'Your account is suspended pending a responsible gambling review.',
  session_limit_reached: 'You have reached your session time limit.',
  stake_limit_exceeded: 'This stake is over your stake limit.',
  loss_limit_exceeded: 'This stake would take you over your loss limit.',
  deposit_limit_exceeded: 'This deposit would take you over your deposit limit.',
  cooling_off_active: 'The waiting period for this limit change has not ended yet.',
  no_pending_change: 'There is no pending limit change to confirm.',
  invalid_period: 'That period is not offered.',
};

/** Turns an error from api() into a sentence for the player. */
export function describeError(error) {
  if (!error) return '';
  let text = MESSAGES[error.code];
  if (error.code === 'price_changed' && error.currentOdds) {
    text = `A price has changed to ${displayOdds(error.currentOdds)}. Check the new price and place the bet again.`;
  } else if (error.code === 'stake_below_min' && error.minStake) {
    text = `The minimum stake is ${formatXaf(error.minStake)}.`;
  } else if (error.code === 'stake_above_max' && error.maxStake) {
    text = `The maximum stake is ${formatXaf(error.maxStake)}.`;
  } else if (error.code === 'payout_above_max' && error.maxPayout) {
    text = `The maximum payout is ${formatXaf(error.maxPayout)}. Lower your stake.`;
  }
  if (text) return text;
  if (Array.isArray(error.errors) && error.errors.length) {
    return `Please check: ${error.errors.map((e) => e.path || e.message).join(', ')}.`;
  }
  return error.detail || 'Something went wrong. Please try again.';
}
