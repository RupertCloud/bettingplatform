// Harm-risk score (FR-RG-010) and intervention thresholds (FR-RG-011).
//
// Markers, measured at time `at`:
//   deposits24h            deposits in the last 24 h (deposit velocity)
//   declinedDeposits7d     declined deposits in the last 7 days
//   lossChasing30d         deposits made within 30 min after a losing settlement, last 30 days
//   nightStakes30d         stakes placed 00:00-06:00 jurisdiction local time, last 30 days
//   limitIncreases30d      limit increase or removal requests, last 30 days
//   withdrawalCancels30d   withdrawals cancelled by the player, last 30 days
//   stakes7d / stakeSum7d  stakes in the last 7 days
//   stakesPrior / stakeSumPrior  stakes in the 21 days before that
//   sessionMinutes7d       time on site in sessions started in the last 7 days
//
// Weights (points, total clamped to 0..100):
//   deposit velocity     >= 5 deposits: 15, >= 3: 8
//   declined deposits    4 per decline, max 20
//   loss chasing         5 per chased loss, max 25
//   night play           >= 10 night stakes: 10, >= 3: 5
//   limit increases      5 per request, max 15
//   withdrawal cancels   5 per cancel, max 15
//   rising stakes        mean stake (7 d) >= 2x mean of prior 21 d: 10, >= 1.5x: 5 (needs >= 3 stakes in each)
//   time on site         >= 40 h in 7 d: 10, >= 20 h: 5
// Levels: LOW < 30 <= MEDIUM < 55 <= HIGH.

export interface RiskMarkers {
  deposits24h: number;
  declinedDeposits7d: number;
  lossChasing30d: number;
  nightStakes30d: number;
  limitIncreases30d: number;
  withdrawalCancels30d: number;
  stakes7d: number;
  stakeSum7d: bigint;
  stakesPrior: number;
  stakeSumPrior: bigint;
  sessionMinutes7d: number;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export const INTERVENTION_TYPES = ['MESSAGE', 'QUESTIONNAIRE', 'CALL_TASK', 'DEPOSIT_CAP', 'SUSPEND'] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

/** Minimum score at which each intervention is triggered automatically. */
export type InterventionThresholds = Record<InterventionType, number>;

export const DEFAULT_INTERVENTION_THRESHOLDS: InterventionThresholds = {
  MESSAGE: 30,
  QUESTIONNAIRE: 45,
  CALL_TASK: 55,
  DEPOSIT_CAP: 70,
  SUSPEND: 85,
};

export const HIGH_RISK_SCORE = 55;
export const MEDIUM_RISK_SCORE = 30;

const perCount = (n: number, each: number, max: number): number => Math.min(n * each, max);

/** Mean of a vs mean of b compared to ratio num/den, exactly: sumA/countA >= (num/den) * sumB/countB. */
const meanAtLeast = (sumA: bigint, countA: number, sumB: bigint, countB: number, num: bigint, den: bigint): boolean =>
  sumA * BigInt(countB) * den >= num * sumB * BigInt(countA);

export const markerPoints = (m: RiskMarkers): Record<string, number> => {
  let rising = 0;
  if (m.stakes7d >= 3 && m.stakesPrior >= 3 && m.stakeSumPrior > 0n) {
    if (meanAtLeast(m.stakeSum7d, m.stakes7d, m.stakeSumPrior, m.stakesPrior, 2n, 1n)) rising = 10;
    else if (meanAtLeast(m.stakeSum7d, m.stakes7d, m.stakeSumPrior, m.stakesPrior, 3n, 2n)) rising = 5;
  }
  return {
    depositVelocity: m.deposits24h >= 5 ? 15 : m.deposits24h >= 3 ? 8 : 0,
    declinedDeposits: perCount(m.declinedDeposits7d, 4, 20),
    lossChasing: perCount(m.lossChasing30d, 5, 25),
    nightPlay: m.nightStakes30d >= 10 ? 10 : m.nightStakes30d >= 3 ? 5 : 0,
    limitIncreases: perCount(m.limitIncreases30d, 5, 15),
    withdrawalCancels: perCount(m.withdrawalCancels30d, 5, 15),
    risingStakes: rising,
    timeOnSite: m.sessionMinutes7d >= 2400 ? 10 : m.sessionMinutes7d >= 1200 ? 5 : 0,
  };
};

export const scoreMarkers = (m: RiskMarkers): number => {
  const total = Object.values(markerPoints(m)).reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(100, total));
};

export const riskLevel = (score: number): RiskLevel =>
  score >= HIGH_RISK_SCORE ? 'HIGH' : score >= MEDIUM_RISK_SCORE ? 'MEDIUM' : 'LOW';

export const triggeredInterventions = (score: number, t: InterventionThresholds): InterventionType[] =>
  INTERVENTION_TYPES.filter((type) => score >= t[type]);
