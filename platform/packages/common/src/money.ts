import { AppError } from './errors.js';

// Money is always an integer count of minor units (SRS CON-01).
export type Minor = bigint;

export type Currency = 'XAF' | 'EUR' | 'USD';

export const CURRENCY_DECIMALS: Record<Currency, number> = {
  XAF: 0,
  EUR: 2,
  USD: 2,
};

export const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && value in CURRENCY_DECIMALS;

/** Parses a decimal string such as "12.50" into minor units. Rejects excess precision. */
export const toMinor = (amount: string, currency: Currency): Minor => {
  const decimals = CURRENCY_DECIMALS[currency];
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new AppError('invalid_amount', 400, `Not a decimal amount: ${amount}`);
  const [, sign, whole, frac = ''] = match;
  if (frac.length > decimals) {
    throw new AppError('invalid_amount', 400, `${currency} allows ${decimals} decimal places`);
  }
  const minor = BigInt(whole! + frac.padEnd(decimals, '0'));
  return sign === '-' ? -minor : minor;
};

/** Formats minor units as a plain decimal string, e.g. 1250n EUR -> "12.50". */
export const fromMinor = (minor: Minor, currency: Currency): string => {
  const decimals = CURRENCY_DECIMALS[currency];
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? '.' + digits.slice(digits.length - decimals) : '';
  return (negative ? '-' : '') + whole + frac;
};
