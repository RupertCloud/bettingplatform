import { AppError, type MarketState } from '@bp/common';

// FR-SPD-005: legal market state transitions. SETTLED and VOIDED are final.
const TRANSITIONS: Record<MarketState, readonly MarketState[]> = {
  OPEN: ['SUSPENDED', 'CLOSED', 'VOIDED'],
  SUSPENDED: ['OPEN', 'CLOSED', 'VOIDED'],
  CLOSED: ['SETTLED', 'VOIDED'],
  SETTLED: [],
  VOIDED: [],
};

export const MARKET_STATES: readonly MarketState[] = ['OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED', 'VOIDED'];

export const canTransition = (from: MarketState, to: MarketState): boolean => TRANSITIONS[from].includes(to);

export const assertTransition = (from: MarketState, to: MarketState): void => {
  if (!canTransition(from, to)) {
    throw new AppError('illegal_market_transition', 409, `Market cannot go from ${from} to ${to}`, { from, to });
  }
};
