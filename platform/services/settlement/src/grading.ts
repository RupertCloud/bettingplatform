// Pure grading maths (FR-STL-002, FR-STL-003). Exact rationals in bigint; the only
// rounding is one floor per line, so the operator never over-pays a fraction.
import {
  AppError, combinations, ODDS_SCALE, validateSizes,
  type LegOutcome, type Minor, type Odds,
} from '@bp/common';

export interface Ratio {
  num: bigint;
  den: bigint;
}

export interface DeadHeat {
  numerator: number;
  denominator: number;
}

export const validateDeadHeat = (dh: DeadHeat | undefined): DeadHeat => {
  if (
    !dh || !Number.isSafeInteger(dh.numerator) || !Number.isSafeInteger(dh.denominator)
    || dh.numerator < 1 || dh.denominator < 1 || dh.numerator > dh.denominator
  ) {
    throw new AppError('invalid_result', 400, 'DEAD_HEAT needs 1 <= numerator <= denominator');
  }
  return dh;
};

/**
 * Factor a leg contributes to every line it is in.
 * WON = odds, LOST = 0, VOID = 1, HALF_WON = (1 + odds) / 2, HALF_LOST = 1/2,
 * DEAD_HEAT = odds x numerator / denominator.
 */
export const legFactor = (outcome: LegOutcome, odds: Odds, deadHeat?: DeadHeat): Ratio => {
  if (odds <= 0n) throw new AppError('invalid_odds', 400, 'Odds must be positive');
  switch (outcome) {
    case 'WON':
      return { num: odds, den: ODDS_SCALE };
    case 'LOST':
      return { num: 0n, den: 1n };
    case 'VOID':
      return { num: 1n, den: 1n };
    case 'HALF_WON':
      return { num: ODDS_SCALE + odds, den: 2n * ODDS_SCALE };
    case 'HALF_LOST':
      return { num: 1n, den: 2n };
    case 'DEAD_HEAT': {
      const dh = validateDeadHeat(deadHeat);
      return { num: odds * BigInt(dh.numerator), den: ODDS_SCALE * BigInt(dh.denominator) };
    }
  }
};

/** unitStake x product of factors, rounded down once. */
export const lineReturn = (unitStake: Minor, factors: Ratio[]): Minor => {
  let num = unitStake;
  let den = 1n;
  for (const f of factors) {
    num *= f.num;
    den *= f.den;
  }
  return num / den;
};

export interface GradedLeg {
  outcome: LegOutcome;
  odds: Odds;
  deadHeat?: DeadHeat;
}

/** Sum of every combination line of the bet (singles, multiples and full-cover systems). */
export const betReturn = (unitStake: Minor, sizes: number[], legs: GradedLeg[]): Minor => {
  if (unitStake < 0n) throw new AppError('invalid_bet', 400, 'Negative stake');
  validateSizes(legs.length, sizes);
  const factors = legs.map((l) => legFactor(l.outcome, l.odds, l.deadHeat));
  let total = 0n;
  for (const k of sizes) {
    for (const combo of combinations(legs.length, k)) {
      total += lineReturn(unitStake, combo.map((i) => factors[i]!));
    }
  }
  return total;
};
