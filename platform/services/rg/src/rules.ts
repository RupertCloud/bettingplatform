import { z } from 'zod';
import { AppError, type Currency, type Minor } from '@bp/common';

export const TIME_OUT_PERIODS = ['24h', '7d', '42d'] as const;
export const SELF_EXCLUSION_PERIODS = ['6m', '1y', '5y', 'permanent'] as const;
export type TimeOutPeriod = (typeof TIME_OUT_PERIODS)[number];
export type SelfExclusionPeriod = (typeof SELF_EXCLUSION_PERIODS)[number];

/** One jurisdiction rules set (FR-JUR-001). Money is in minor units of `currency`. */
export interface RulesSet {
  currency: Currency;
  minAge: number;
  /** Default reality-check interval (FR-RG-008). */
  realityCheckMinutes: number;
  /** Cooling-off before a limit increase or removal can be confirmed (FR-RG-003). */
  limitIncreaseCoolingHours: number;
  /** Prompt for deposit limits at registration (FR-RG-001). */
  mandatoryDepositLimitPrompt: boolean;
  /** No credit-card deposits (FR-RG-013). */
  creditCardBan: boolean;
  /** Net deposits per rolling 30 days above which an affordability case opens (FR-RG-012). */
  affordabilityNetDepositThreshold: Minor;
  /** When false, a requested withdrawal cannot be reversed by the player (FR-RG-014). */
  withdrawalReversalAllowed: boolean;
  timeOutOptions: TimeOutPeriod[];
  selfExclusionOptions: SelfExclusionPeriod[];
  /** Jurisdiction local time offset, used for the night-play marker (FR-RG-010). */
  utcOffsetMinutes: number;
}

export interface RulesVersion {
  jurisdiction: string;
  version: number;
  rules: RulesSet;
  effectiveFrom: Date;
  author: string;
  status: 'PENDING' | 'APPROVED';
  approvedBy: string | null;
  approvedAt: Date | null;
}

/** Stored and wire form: the threshold is an integer string of minor units. */
export const rulesJsonSchema = z
  .object({
    currency: z.enum(['XAF', 'EUR', 'USD']),
    minAge: z.number().int().min(18).max(25),
    realityCheckMinutes: z.number().int().min(15).max(120),
    limitIncreaseCoolingHours: z.number().int().min(24).max(24 * 30),
    mandatoryDepositLimitPrompt: z.boolean(),
    creditCardBan: z.boolean(),
    affordabilityNetDepositThreshold: z.string().regex(/^[1-9]\d{0,17}$/),
    withdrawalReversalAllowed: z.boolean(),
    timeOutOptions: z.array(z.enum(TIME_OUT_PERIODS)).min(1).max(TIME_OUT_PERIODS.length),
    selfExclusionOptions: z.array(z.enum(SELF_EXCLUSION_PERIODS)).min(1).max(SELF_EXCLUSION_PERIODS.length),
    utcOffsetMinutes: z.number().int().min(-720).max(840),
  })
  .strict();

export type RulesJson = z.infer<typeof rulesJsonSchema>;

export const rulesFromJson = (raw: unknown): RulesSet => {
  const j = rulesJsonSchema.parse(raw);
  return { ...j, affordabilityNetDepositThreshold: BigInt(j.affordabilityNetDepositThreshold) };
};

export const rulesToJson = (r: RulesSet): RulesJson => ({
  ...r,
  affordabilityNetDepositThreshold: r.affordabilityNetDepositThreshold.toString(),
});

export const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export const assertJurisdiction = (j: string): void => {
  if (!JURISDICTION.test(j)) throw new AppError('invalid_jurisdiction', 400, 'Bad jurisdiction code');
};
