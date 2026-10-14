import { AppError, ODDS_SCALE, type Odds } from '@bp/common';

// FR-RSK-001: margin and price ladder, all in bigint odds scaled by 10,000.

/** Lowest price ever offered: 1.0001. */
export const MIN_ODDS: Odds = ODDS_SCALE + 1n;

/** Prices below `upTo` (exclusive) move in steps of `step`. The last band has no upper bound. */
export interface LadderBand {
  upTo: Odds | null;
  step: Odds;
}

/** Default ladder: 0.01 to 2, 0.02 to 3, 0.05 to 4, 0.1 to 6, 0.2 to 10, 0.5 to 20, 1 to 30, 2 to 50, 5 to 100, 10 above. */
export const DEFAULT_LADDER: readonly LadderBand[] = [
  { upTo: 20_000n, step: 100n },
  { upTo: 30_000n, step: 200n },
  { upTo: 40_000n, step: 500n },
  { upTo: 60_000n, step: 1_000n },
  { upTo: 100_000n, step: 2_000n },
  { upTo: 200_000n, step: 5_000n },
  { upTo: 300_000n, step: 10_000n },
  { upTo: 500_000n, step: 20_000n },
  { upTo: 1_000_000n, step: 50_000n },
  { upTo: null, step: 100_000n },
];

export const validateLadder = (ladder: readonly LadderBand[]): void => {
  let from = ODDS_SCALE;
  ladder.forEach((band, i) => {
    const last = i === ladder.length - 1;
    if (band.step <= 0n) throw new Error('Ladder step must be positive');
    if (last !== (band.upTo === null)) throw new Error('Only the last ladder band is open-ended');
    if (band.upTo !== null) {
      if (band.upTo <= from || (band.upTo - from) % band.step !== 0n) {
        throw new Error('Ladder bands must ascend and each band must be a whole number of steps');
      }
      from = band.upTo;
    }
  });
  if (ladder.length === 0) throw new Error('Ladder is empty');
};

/** Rounds odds DOWN to the ladder (the operator never offers more than the computed price), never below 1.0001. */
export const roundDownToLadder = (odds: Odds, ladder: readonly LadderBand[] = DEFAULT_LADDER): Odds => {
  let from = ODDS_SCALE;
  for (const band of ladder) {
    if (band.upTo === null || odds < band.upTo) {
      const rounded = from + ((odds - from) / band.step) * band.step;
      return rounded < MIN_ODDS ? MIN_ODDS : rounded;
    }
    from = band.upTo;
  }
  /* c8 ignore next */
  return MIN_ODDS;
};

/** odds / (1 + margin), margin in basis points; integer division rounds down. */
export const applyMargin = (odds: Odds, marginBp: number): Odds => {
  if (!Number.isInteger(marginBp) || marginBp < 0 || marginBp > 5000) {
    throw new AppError('invalid_margin', 400, 'Margin must be 0 to 5000 basis points');
  }
  return (odds * 10_000n) / (10_000n + BigInt(marginBp));
};

/** Feed price to offered price (FR-RSK-001). */
export const priceFromFeed = (feedOdds: Odds, marginBp: number, ladder: readonly LadderBand[] = DEFAULT_LADDER): Odds =>
  roundDownToLadder(applyMargin(feedOdds, marginBp), ladder);
