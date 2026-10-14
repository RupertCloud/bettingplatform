import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { AppError, testDb, type Pool } from '@bp/common';
import { Identity, MIGRATIONS_DIR, type IdentityOptions, type Notification, type RegistrationInput } from '../src/index.js';

export interface Harness {
  pool: Pool;
  identity: Identity;
  clock: { t: Date; advance(ms: number): void };
  sent: Notification[];
  drop: () => Promise<void>;
  /** Registers a player and returns its id. */
  register(overrides?: Partial<RegistrationInput>): Promise<string>;
  /** Makes a player ACTIVE through the audited path. */
  activate(playerId: string): Promise<void>;
  lastToken(kind: Notification['kind']): string;
}

export const PASSWORD = 'correct horse battery';

let seq = 0;
export const registration = (overrides: Partial<RegistrationInput> = {}): RegistrationInput => {
  seq += 1;
  const n = `${Date.now().toString(36)}${seq}`;
  return {
    email: `Player${n}@Example.com `,
    phone: null,
    username: `player${n}`,
    password: PASSWORD,
    legalName: 'Ada Example',
    dateOfBirth: '1990-05-17',
    nationality: 'CM',
    address: { line1: '1 Rue de la Paix', city: 'Douala' },
    country: 'CM',
    jurisdiction: 'CM',
    currency: 'XAF',
    termsVersion: '2026-01',
    acceptedPrivacyNotice: true,
    ageDeclaration: true,
    ...overrides,
  };
};

export const harness = async (opts: Partial<IdentityOptions> = {}): Promise<Harness> => {
  const db = await testDb('identity', MIGRATIONS_DIR);
  const clock = {
    t: new Date('2026-03-02T10:00:00.000Z'),
    advance(ms: number) {
      this.t = new Date(this.t.getTime() + ms);
    },
  };
  const sent: Notification[] = [];
  const identity = new Identity({
    pool: db.pool,
    now: () => clock.t,
    mfaKey: randomBytes(32),
    notify: async (n) => {
      sent.push(n);
    },
    ...opts,
  });
  const h: Harness = {
    pool: db.pool,
    identity,
    clock,
    sent,
    drop: db.drop,
    async register(overrides) {
      const r = await identity.register(registration(overrides));
      if (!r.created) throw new Error('not created');
      return r.playerId;
    },
    async activate(playerId) {
      await identity.setState(playerId, 'ACTIVE', 'staff:test', 'KYC passed');
    },
    lastToken(kind) {
      const n = [...sent].reverse().find((x) => x.kind === kind);
      if (!n || !('token' in n)) throw new Error(`no ${kind} sent`);
      return n.token;
    },
  };
  return h;
};

export const META = { ip: '203.0.113.7', userAgent: 'vitest' };

export const totp = (secret: string, at: Date): string => authenticator.clone({ epoch: at.getTime() }).generate(secret);

/** Resolves to the AppError code a promise rejects with. */
export const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  throw new Error('expected rejection');
};
