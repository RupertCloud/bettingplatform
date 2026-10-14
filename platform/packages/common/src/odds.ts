import { AppError } from './errors.js';
import type { Minor } from './money.js';

// Decimal odds stored exactly as an integer scaled by 10,000 (SRS CON-04).
// 2.5 is 25_000n. Odds below 1.0001 are invalid.
export type Odds = bigint;

export const ODDS_SCALE = 10_000n;

export const parseOdds = (decimal: string): Odds => {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(decimal);
  if (!match) throw new AppError('invalid_odds', 400, `Not decimal odds: ${decimal}`);
  const odds = BigInt(match[1]! + (match[2] ?? '').padEnd(4, '0'));
  if (odds <= ODDS_SCALE) throw new AppError('invalid_odds', 400, 'Odds must be above 1.0');
  return odds;
};

export const formatOdds = (odds: Odds): string => {
  const whole = odds / ODDS_SCALE;
  const frac = (odds % ODDS_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};

/** Multiplies odds exactly; result stays scaled by ODDS_SCALE, rounded down. */
export const multiplyOdds = (a: Odds, b: Odds): Odds => (a * b) / ODDS_SCALE;

/** Stake × odds, rounded down to whole minor units (the operator never over-pays a fraction). */
export const payout = (stake: Minor, odds: Odds): Minor => (stake * odds) / ODDS_SCALE;
