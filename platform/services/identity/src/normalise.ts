import { z } from 'zod';
import { CURRENCY_DECIMALS, type Currency } from '@bp/common';

// FR-ACC-004: identifiers are compared exactly after normalisation.

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();
export const normaliseUsername = (raw: string): string => raw.trim().toLowerCase();

/** Accepts "+237 6 71 23 45 67", "00237-671234567" and so on; returns E.164 or null. */
export const normalisePhone = (raw: string): string | null => {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  const e164 = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
};

const USERNAME = /^[a-z][a-z0-9_.]{2,29}$/;
const ISO2 = /^[A-Z]{2}$/;
const currencies = Object.keys(CURRENCY_DECIMALS) as [Currency, ...Currency[]];

/** Calendar date YYYY-MM-DD that actually exists. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a valid date');

/** SEC-AUTH-002: length only, no composition rules. Upper bound keeps hashing cost bounded. */
export const password = z.string().max(256);

export const registrationSchema = z
  .object({
    email: z.string().max(254).transform(normaliseEmail).pipe(z.string().email()),
    phone: z
      .string()
      .max(32)
      .transform((s, ctx) => {
        const p = normalisePhone(s);
        if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone must be E.164' });
        return p ?? '';
      })
      .nullish(),
    username: z.string().max(64).transform(normaliseUsername).pipe(z.string().regex(USERNAME)),
    password,
    legalName: z.string().trim().min(2).max(200),
    dateOfBirth: isoDate,
    nationality: z.string().regex(ISO2),
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).nullish(),
        city: z.string().trim().min(1).max(100),
        postcode: z.string().trim().max(20).nullish(),
      })
      .strict(),
    country: z.string().regex(ISO2),
    jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/),
    currency: z.enum(currencies),
    termsVersion: z.string().trim().min(1).max(32),
    acceptedPrivacyNotice: z.literal(true),
    ageDeclaration: z.literal(true),
  })
  .strict();

export type RegistrationInput = z.input<typeof registrationSchema>;
export type Registration = z.output<typeof registrationSchema>;

/** Whole years between dateOfBirth (YYYY-MM-DD) and now, in UTC. */
export const ageOn = (dateOfBirth: string, now: Date): number => {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  return ny - y - (nm < m || (nm === m && nd < d) ? 1 : 0);
};

export type LoginIdentifier = { column: 'email' | 'username' | 'phone'; value: string };

/** Decides how a login identifier is matched. Usernames start with a letter and never contain @ or +. */
export const parseIdentifier = (raw: string): LoginIdentifier => {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return { column: 'email', value: normaliseEmail(trimmed) };
  if (/^[+0-9(]/.test(trimmed)) return { column: 'phone', value: normalisePhone(trimmed) ?? trimmed };
  return { column: 'username', value: normaliseUsername(trimmed) };
};
