import { AppError } from './errors.js';

/** Named full-cover and system bets (FR-BET-002), as combination sizes on n legs. */
export const NAMED_SYSTEMS: Record<string, { legs: number; sizes: number[] }> = {
  TRIXIE: { legs: 3, sizes: [2, 3] },
  PATENT: { legs: 3, sizes: [1, 2, 3] },
  YANKEE: { legs: 4, sizes: [2, 3, 4] },
  LUCKY_15: { legs: 4, sizes: [1, 2, 3, 4] },
  CANADIAN: { legs: 5, sizes: [2, 3, 4, 5] },
  LUCKY_31: { legs: 5, sizes: [1, 2, 3, 4, 5] },
  HEINZ: { legs: 6, sizes: [2, 3, 4, 5, 6] },
  LUCKY_63: { legs: 6, sizes: [1, 2, 3, 4, 5, 6] },
  SUPER_HEINZ: { legs: 7, sizes: [2, 3, 4, 5, 6, 7] },
  GOLIATH: { legs: 8, sizes: [2, 3, 4, 5, 6, 7, 8] },
};

export const MAX_LEGS = 30;

/** All k-element index combinations of 0..n-1, in lexicographic order. */
export const combinations = (n: number, k: number): number[][] => {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i <= n - (k - acc.length); i++) {
      acc.push(i);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  if (k >= 1 && k <= n) pick(0, []);
  return out;
};

/** n choose k as a bigint (exact for any leg count we allow). */
export const choose = (n: number, k: number): bigint => {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  for (let i = 1; i <= k; i++) result = (result * BigInt(n - k + i)) / BigInt(i);
  return result;
};

/** Number of lines a bet on n legs with these combination sizes contains. */
export const lineCount = (legs: number, sizes: number[]): bigint => {
  validateSizes(legs, sizes);
  return sizes.reduce((sum, k) => sum + choose(legs, k), 0n);
};

export const validateSizes = (legs: number, sizes: number[]): void => {
  if (legs < 1 || legs > MAX_LEGS) throw new AppError('invalid_bet', 400, `1 to ${MAX_LEGS} legs allowed`);
  if (sizes.length === 0) throw new AppError('invalid_bet', 400, 'No combination sizes');
  const seen = new Set<number>();
  for (const k of sizes) {
    if (!Number.isInteger(k) || k < 1 || k > legs || seen.has(k)) {
      throw new AppError('invalid_bet', 400, `Bad combination size ${k} for ${legs} legs`);
    }
    seen.add(k);
  }
};
