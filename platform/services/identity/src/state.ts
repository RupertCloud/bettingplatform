import type { AccountState } from '@bp/common';

// FR-ACC-014: account states and what each one allows.

export type AccountAction = 'login' | 'deposit' | 'bet' | 'withdraw';

export const ACCOUNT_STATES: readonly AccountState[] = [
  'PENDING_VERIFICATION', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED', 'DORMANT',
];

const row = (login: boolean, deposit: boolean, bet: boolean, withdraw: boolean) => ({ login, deposit, bet, withdraw });

/**
 * Self-excluded and timed-out players may still log in to withdraw their balance (FR-RG-005);
 * deposits and bets stay blocked. KYC gating (FR-KYC-001) is applied separately by kycLevel.
 */
export const ALLOWED_ACTIONS: Readonly<Record<AccountState, Readonly<Record<AccountAction, boolean>>>> = {
  PENDING_VERIFICATION: row(true, false, false, false),
  ACTIVE: row(true, true, true, true),
  RESTRICTED: row(true, false, false, true),
  SUSPENDED: row(false, false, false, false),
  SELF_EXCLUDED: row(true, false, false, true),
  TIMED_OUT: row(true, false, false, true),
  CLOSED: row(false, false, false, false),
  DORMANT: row(true, false, false, true),
};

export const isAllowed = (state: AccountState, action: AccountAction): boolean => ALLOWED_ACTIONS[state][action];

/** Transitions a staff member or service may request. RG states have extra rules in Identity.setState. */
export const TRANSITIONS: Readonly<Record<AccountState, readonly AccountState[]>> = {
  PENDING_VERIFICATION: ['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED'],
  ACTIVE: ['RESTRICTED', 'SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED', 'DORMANT'],
  RESTRICTED: ['ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'RESTRICTED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED'],
  SELF_EXCLUDED: ['ACTIVE', 'SELF_EXCLUDED', 'CLOSED'],
  TIMED_OUT: ['ACTIVE', 'TIMED_OUT', 'SELF_EXCLUDED', 'CLOSED'],
  CLOSED: [],
  DORMANT: ['ACTIVE', 'SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED'],
};

/** States entered only by the responsible-gambling service (FR-RG-004). */
export const RG_STATES: ReadonlySet<AccountState> = new Set(['SELF_EXCLUDED', 'TIMED_OUT']);
export const RG_ACTOR = 'rg-service';

/** Entering these ends every session (SEC-AUTH-005). */
export const REVOKING_STATES: ReadonlySet<AccountState> = new Set(['SUSPENDED', 'SELF_EXCLUDED', 'TIMED_OUT', 'CLOSED']);
