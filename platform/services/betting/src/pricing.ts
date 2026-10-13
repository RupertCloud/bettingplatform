import {
  AppError,
  combinations,
  lineCount,
  multiplyOdds,
  ODDS_SCALE,
  payout,
  type Minor,
  type Odds,
  type SelectionQuote,
} from '@bp/common';

/** One line (combination) of a bet: which legs it covers and what it returns if all win. */
export interface Line {
  legs: number[];
  fullWinReturn: Minor;
}

/** Every line of the bet with its full-win return, using common payout() rounding (rounded down). */
export const betLines = (odds: Odds[], sizes: number[], unitStake: Minor): Line[] =>
  sizes.flatMap((k) =>
    combinations(odds.length, k).map((legs) => ({
      legs,
      fullWinReturn: payout(
        unitStake,
        legs.reduce((acc, i) => multiplyOdds(acc, odds[i]!), ODDS_SCALE),
      ),
    })),
  );

/**
 * Potential net payout (return minus stake) each leg's selection adds to liability if it wins
 * (FR-RSK-003): the sum over lines that contain the leg.
 */
export const legLiabilities = (lines: Line[], legCount: number, unitStake: Minor): Minor[] => {
  const out: Minor[] = Array.from({ length: legCount }, () => 0n);
  for (const line of lines) {
    const net = line.fullWinReturn - unitStake;
    for (const i of line.legs) out[i] = out[i]! + net;
  }
  return out;
};

/** Number of lines, refusing bets with more lines than we are prepared to enumerate. */
export const checkedLineCount = (legs: number, sizes: number[], maxLines: number): bigint => {
  const n = lineCount(legs, sizes);
  if (n > BigInt(maxLines)) {
    throw new AppError('too_many_lines', 400, `A bet may have at most ${maxLines} lines`, { maxLines });
  }
  return n;
};

// ---------- Layered stake limits (FR-RSK-004, FR-RSK-005) ----------

export interface StakeLimits {
  /** Minimum stake per line. The highest minimum across layers applies. */
  minStake?: Minor;
  /** Maximum total stake per bet. The lowest maximum across layers applies. */
  maxStake?: Minor;
  /** Maximum full-win return per bet. The lowest maximum across layers applies. */
  maxPayout?: Minor;
}

export interface CurrencyLimits {
  global: StakeLimits;
  sport?: Record<string, StakeLimits>;
  marketType?: Record<string, StakeLimits>;
}

export interface EffectiveLimits {
  minStake: Minor | null;
  maxStake: Minor | null;
  maxPayout: Minor | null;
}

const minOf = (a: Minor | null, b: Minor | undefined): Minor | null =>
  b === undefined ? a : a === null || b < a ? b : a;
const maxOf = (a: Minor | null, b: Minor | undefined): Minor | null =>
  b === undefined ? a : a === null || b > a ? b : a;

/** Stake factor 0.01..10.0 as basis points (10,000 = 1.0), clamped to the allowed range. */
export const stakeFactorBp = (factor: number): bigint => {
  const bp = Number.isFinite(factor) ? Math.round(factor * 10_000) : 10_000;
  return BigInt(Math.min(100_000, Math.max(100, bp)));
};

/**
 * The lowest maximum of the global, sport and market type layers for every leg, scaled by the
 * player's stake factor (rounded down); the highest minimum, unscaled.
 */
export const effectiveLimits = (
  config: CurrencyLimits,
  quotes: SelectionQuote[],
  stakeFactor: number,
): EffectiveLimits => {
  const layers: StakeLimits[] = [config.global];
  for (const q of quotes) {
    const s = config.sport?.[q.sport];
    const m = config.marketType?.[q.marketType];
    if (s) layers.push(s);
    if (m) layers.push(m);
  }
  let minStake: Minor | null = null;
  let maxStake: Minor | null = null;
  let maxPayout: Minor | null = null;
  for (const l of layers) {
    minStake = maxOf(minStake, l.minStake);
    maxStake = minOf(maxStake, l.maxStake);
    maxPayout = minOf(maxPayout, l.maxPayout);
  }
  const bp = stakeFactorBp(stakeFactor);
  const scale = (v: Minor | null) => (v === null ? null : (v * bp) / 10_000n);
  return { minStake, maxStake: scale(maxStake), maxPayout: scale(maxPayout) };
};
