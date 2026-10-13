import { createHash } from 'node:crypto';
import {
  AppError,
  isCurrency,
  withTx,
  type AccountRef,
  type Client,
  type Currency,
  type Ledger,
  type LedgerReason,
  type Minor,
  type OperatorAccountKind,
  type PlayerAccountKind,
  type PlayerId,
  type Pool,
  type PostedEntry,
  type PostingRequest,
} from '@bp/common';

export const PLAYER_KINDS = ['CASH', 'BONUS', 'PENDING_WITHDRAWAL'] as const;
export const OPERATOR_KINDS = [
  'PSP_CLEARING',
  'BETS_OPEN',
  'GGR',
  'BONUS_COST',
  'ADJUSTMENTS',
  'WITHDRAWALS_PAYABLE',
] as const;
export const LEDGER_REASONS = [
  'DEPOSIT',
  'WITHDRAWAL_REQUEST',
  'WITHDRAWAL_PAID',
  'WITHDRAWAL_CANCELLED',
  'BET_STAKE',
  'BET_SETTLEMENT',
  'BET_RESETTLEMENT',
  'CASH_OUT',
  'BONUS_AWARD',
  'BONUS_FORFEIT',
  'ADJUSTMENT',
  'REVERSAL',
] as const;

/** Largest absolute amount accepted on one line; keeps every sum far inside int8. */
export const MAX_LINE_AMOUNT: Minor = 10n ** 15n;
export const MAX_LINES = 100;
const MAX_TEXT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Four-eyes thresholds for manual adjustments, per currency (FR-WAL-011). */
export const DEFAULT_ADJUSTMENT_THRESHOLDS: Partial<Record<Currency, Minor>> = { XAF: 100_000n };

export interface WalletOptions {
  now?: () => Date;
  /**
   * An adjustment whose absolute amount is above the threshold for its currency needs an
   * approver other than the requester. A currency without a threshold always needs one.
   */
  adjustmentThresholds?: Partial<Record<Currency, Minor>>;
}

export interface AdjustmentRequest {
  playerId: PlayerId;
  kind: PlayerAccountKind;
  currency: Currency;
  /** Positive credits the player, negative debits. */
  amount: Minor;
  reasonText: string;
  requestedBy: string;
}

export interface ReconcileMismatch {
  account: AccountRef;
  projection: Minor;
  ledger: Minor;
}

export interface ReconcileReport {
  /** Accounts whose balance projection differs from the sum of their lines (NFR-DI-001). */
  mismatches: ReconcileMismatch[];
  /** Entries whose lines do not sum to zero in some currency (FR-WAL-001). */
  unbalancedEntries: string[];
  allEntriesBalanced: boolean;
  ok: boolean;
}

export type PlayerBalances = Record<PlayerAccountKind, Minor>;

interface EntryRow {
  id: string;
  idempotency_key: string;
  reason: LedgerReason;
  reference: string;
  request_hash: string;
  posted_at: Date;
}

interface AccountRow {
  owner: 'PLAYER' | 'OPERATOR';
  player_id: string | null;
  kind: string;
  currency: Currency;
}

const bad = (detail: string): AppError => new AppError('invalid_posting', 400, detail);

const checkText = (value: unknown, name: string, optional = false): void => {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw bad(`${name} must be 1 to ${MAX_TEXT} characters`);
  }
};

const isPlayerKind = (kind: string): kind is PlayerAccountKind =>
  (PLAYER_KINDS as readonly string[]).includes(kind);

export const validateAccount = (account: AccountRef): void => {
  if (!account || typeof account !== 'object') throw bad('Missing account');
  if (!isCurrency(account.currency)) throw bad('Unknown currency');
  if (account.owner === 'PLAYER') {
    if (typeof account.playerId !== 'string' || !UUID.test(account.playerId)) throw bad('playerId must be a UUID');
    if (!isPlayerKind(account.kind)) throw bad(`Bad player account kind ${String(account.kind)}`);
  } else if (account.owner === 'OPERATOR') {
    if (!(OPERATOR_KINDS as readonly string[]).includes(account.kind)) {
      throw bad(`Bad operator account kind ${String(account.kind)}`);
    }
  } else {
    throw bad('Account owner must be PLAYER or OPERATOR');
  }
};

/** Canonical account key; also the lock order, so concurrent posts never deadlock. */
const accountKey = (a: AccountRef): string =>
  a.owner === 'PLAYER'
    ? `PLAYER|${a.playerId.toLowerCase()}|${a.kind}|${a.currency}`
    : `OPERATOR||${a.kind}|${a.currency}`;

const toRef = (row: AccountRow): AccountRef =>
  row.owner === 'PLAYER'
    ? { owner: 'PLAYER', playerId: row.player_id!, kind: row.kind as PlayerAccountKind, currency: row.currency }
    : { owner: 'OPERATOR', kind: row.kind as OperatorAccountKind, currency: row.currency };

const validateRequest = (req: PostingRequest): void => {
  checkText(req.idempotencyKey, 'idempotencyKey');
  checkText(req.reference, 'reference');
  checkText(req.actor, 'actor', true);
  if (!(LEDGER_REASONS as readonly string[]).includes(req.reason)) throw bad('Unknown reason');
  if (!Array.isArray(req.lines) || req.lines.length === 0) throw bad('A posting needs lines');
  if (req.lines.length > MAX_LINES) throw bad(`At most ${MAX_LINES} lines`);
  const sums = new Map<Currency, bigint>();
  for (const line of req.lines) {
    validateAccount(line.account);
    if (typeof line.amount !== 'bigint') throw bad('Line amounts must be bigint minor units');
    if (line.amount === 0n) throw bad('Zero-amount lines are not allowed');
    if (line.amount > MAX_LINE_AMOUNT || line.amount < -MAX_LINE_AMOUNT) throw bad('Line amount out of range');
    const c = line.account.currency;
    sums.set(c, (sums.get(c) ?? 0n) + line.amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n) throw bad(`Lines do not balance in ${currency}`);
  }
};

interface PostExtra {
  note?: string;
  reverses?: string;
}

const requestHash = (req: PostingRequest, extra: PostExtra): string => {
  const lines = req.lines.map((l) => `${accountKey(l.account)}=${l.amount.toString()}`).sort();
  const canonical = JSON.stringify([req.reason, req.reference, req.actor ?? null, extra.note ?? null, extra.reverses ?? null, lines]);
  return createHash('sha256').update(canonical).digest('hex');
};

const toEntry = (row: EntryRow, replayed: boolean): PostedEntry => ({
  entryId: row.id,
  idempotencyKey: row.idempotency_key,
  reason: row.reason,
  reference: row.reference,
  postedAt: row.posted_at,
  replayed,
});

const ENTRY_COLS = 'id, idempotency_key, reason, reference, request_hash, posted_at';

/** Double-entry wallet ledger (FR-WAL-001 to FR-WAL-004, FR-WAL-007, FR-WAL-008, FR-WAL-011). */
export class Wallet implements Ledger {
  private readonly now: () => Date;
  private readonly thresholds: Partial<Record<Currency, Minor>>;

  constructor(
    private readonly pool: Pool,
    options: WalletOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.thresholds = options.adjustmentThresholds ?? DEFAULT_ADJUSTMENT_THRESHOLDS;
  }

  /** Posts a balanced entry exactly once per idempotency key (FR-WAL-001, FR-WAL-003, FR-WAL-004). */
  async post(request: PostingRequest): Promise<PostedEntry> {
    validateRequest(request);
    return withTx(this.pool, (client) => this.postIn(client, request, {}));
  }

  async balance(account: AccountRef): Promise<Minor> {
    validateAccount(account);
    const { sql, params } = accountWhere(account);
    const { rows } = await this.pool.query<{ balance: bigint }>(`SELECT balance FROM accounts WHERE ${sql}`, params);
    return rows[0]?.balance ?? 0n;
  }

  async playerBalances(playerId: PlayerId, currency: Currency): Promise<PlayerBalances> {
    validateAccount({ owner: 'PLAYER', playerId, kind: 'CASH', currency });
    const { rows } = await this.pool.query<{ kind: PlayerAccountKind; balance: bigint }>(
      `SELECT kind, balance FROM accounts WHERE owner = 'PLAYER' AND player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    const out: PlayerBalances = { CASH: 0n, BONUS: 0n, PENDING_WITHDRAWAL: 0n };
    for (const r of rows) out[r.kind] = r.balance;
    return out;
  }

  /** Corrects a posted entry with a new, negated entry (FR-WAL-007). */
  async reverse(entryId: string, idempotencyKey: string, actor: string, reasonText: string): Promise<PostedEntry> {
    if (typeof entryId !== 'string' || !UUID.test(entryId)) throw bad('entryId must be a UUID');
    checkText(actor, 'actor');
    checkText(reasonText, 'reasonText');
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query<AccountRow & { amount: bigint }>(
        `SELECT a.owner, a.player_id, a.kind, a.currency, l.amount
           FROM entry_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY l.id`,
        [entryId],
      );
      if (rows.length === 0) throw new AppError('not_found', 404, 'No such entry');
      const request: PostingRequest = {
        idempotencyKey,
        reason: 'REVERSAL',
        reference: entryId,
        actor,
        lines: rows.map((r) => ({ account: toRef(r), amount: -r.amount })),
      };
      validateRequest(request);
      return this.postIn(client, request, { note: reasonText, reverses: entryId });
    });
  }

  /** Records a manual adjustment awaiting approval (FR-WAL-011). Returns the request ID. */
  async requestAdjustment(req: AdjustmentRequest): Promise<string> {
    validateAccount({ owner: 'PLAYER', playerId: req.playerId, kind: req.kind, currency: req.currency });
    if (typeof req.amount !== 'bigint' || req.amount === 0n) throw bad('Adjustment amount must be a non-zero bigint');
    if (req.amount > MAX_LINE_AMOUNT || req.amount < -MAX_LINE_AMOUNT) throw bad('Adjustment amount out of range');
    checkText(req.reasonText, 'reasonText');
    checkText(req.requestedBy, 'requestedBy');
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO adjustment_requests (player_id, kind, currency, amount, reason_text, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.playerId, req.kind, req.currency, req.amount, req.reasonText, req.requestedBy, this.now()],
    );
    return rows[0]!.id;
  }

  /**
   * Approves and posts a manual adjustment. Above the currency threshold the approver must
   * differ from the requester (FR-WAL-011). Re-approval by the same approver replays.
   */
  async approve(requestId: string, approverId: string): Promise<PostedEntry> {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw bad('requestId must be a UUID');
    checkText(approverId, 'approverId');
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query<{
        player_id: string;
        kind: PlayerAccountKind;
        currency: Currency;
        amount: bigint;
        reason_text: string;
        requested_by: string;
      }>(
        `SELECT player_id, kind, currency, amount, reason_text, requested_by
           FROM adjustment_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const adj = rows[0];
      if (!adj) throw new AppError('not_found', 404, 'No such adjustment request');

      const done = await client.query<{ approved_by: string } & EntryRow>(
        `SELECT p.approved_by, ${ENTRY_COLS.split(', ').map((c) => `e.${c}`).join(', ')}
           FROM adjustment_approvals p JOIN entries e ON e.id = p.entry_id WHERE p.request_id = $1`,
        [requestId],
      );
      const prior = done.rows[0];
      if (prior) {
        if (prior.approved_by !== approverId) throw new AppError('already_approved', 409, 'Adjustment already approved');
        return toEntry(prior, true);
      }

      const abs = adj.amount < 0n ? -adj.amount : adj.amount;
      const threshold = this.thresholds[adj.currency] ?? 0n;
      if (abs > threshold && approverId === adj.requested_by) {
        throw new AppError('four_eyes_required', 403, 'A second approver is required for this amount');
      }

      const entry = await this.postIn(
        client,
        {
          idempotencyKey: `adjustment:${requestId}`,
          reason: 'ADJUSTMENT',
          reference: requestId,
          actor: approverId,
          lines: [
            { account: { owner: 'PLAYER', playerId: adj.player_id, kind: adj.kind, currency: adj.currency }, amount: adj.amount },
            { account: { owner: 'OPERATOR', kind: 'ADJUSTMENTS', currency: adj.currency }, amount: -adj.amount },
          ],
        },
        { note: adj.reason_text },
      );
      await client.query(
        `INSERT INTO adjustment_approvals (request_id, approved_by, entry_id, approved_at) VALUES ($1, $2, $3, $4)`,
        [requestId, approverId, entry.entryId, this.now()],
      );
      return entry;
    });
  }

  /** Checks every projection against its lines and every entry for balance (FR-WAL-008, NFR-DI-001). */
  async reconcile(): Promise<ReconcileReport> {
    return withTx(
      this.pool,
      async (client) => {
        const mism = await client.query<AccountRow & { projection: bigint; ledger: string }>(
          `SELECT a.owner, a.player_id, a.kind, a.currency, a.balance AS projection,
                  COALESCE(SUM(l.amount), 0)::text AS ledger
             FROM accounts a LEFT JOIN entry_lines l ON l.account_id = a.id
            GROUP BY a.id
           HAVING a.balance <> COALESCE(SUM(l.amount), 0)
            ORDER BY a.id`,
        );
        const unbalanced = await client.query<{ entry_id: string }>(
          `SELECT DISTINCT l.entry_id
             FROM entry_lines l JOIN accounts a ON a.id = l.account_id
            GROUP BY l.entry_id, a.currency
           HAVING SUM(l.amount) <> 0`,
        );
        const mismatches = mism.rows.map((r) => ({
          account: toRef(r),
          projection: r.projection,
          ledger: BigInt(r.ledger),
        }));
        const unbalancedEntries = unbalanced.rows.map((r) => r.entry_id).sort();
        const allEntriesBalanced = unbalancedEntries.length === 0;
        return { mismatches, unbalancedEntries, allEntriesBalanced, ok: allEntriesBalanced && mismatches.length === 0 };
      },
      'REPEATABLE READ',
    );
  }

  /** Posts inside an open transaction. The request must already be validated. */
  private async postIn(client: Client, req: PostingRequest, extra: PostExtra): Promise<PostedEntry> {
    const hash = requestHash(req, extra);
    // Claiming the key first: a concurrent post with the same key waits here until the
    // other transaction ends, then either sees its entry or (if it rolled back) proceeds.
    const inserted = await client.query<EntryRow>(
      `INSERT INTO entries (idempotency_key, reason, reference, actor, note, reverses, request_hash, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ENTRY_COLS}`,
      [req.idempotencyKey, req.reason, req.reference, req.actor ?? null, extra.note ?? null, extra.reverses ?? null, hash, this.now()],
    ).catch((err: unknown) => {
      if ((err as { constraint?: string }).constraint === 'entries_reverses_key') {
        throw new AppError('already_reversed', 409, 'This entry has already been reversed');
      }
      throw err;
    });
    const entry = inserted.rows[0];
    if (!entry) {
      const { rows } = await client.query<EntryRow>(`SELECT ${ENTRY_COLS} FROM entries WHERE idempotency_key = $1`, [
        req.idempotencyKey,
      ]);
      const existing = rows[0]!;
      if (existing.request_hash !== hash) {
        throw new AppError('idempotency_conflict', 409, 'Idempotency key was already used with a different request');
      }
      return toEntry(existing, true);
    }

    // Net change per account, locked in canonical order so concurrent posts cannot deadlock.
    const net = new Map<string, { account: AccountRef; delta: bigint }>();
    for (const line of req.lines) {
      const key = accountKey(line.account);
      const cur = net.get(key) ?? { account: line.account, delta: 0n };
      cur.delta += line.amount;
      net.set(key, cur);
    }
    const ids = new Map<string, bigint>();
    for (const key of [...net.keys()].sort()) {
      const { account, delta } = net.get(key)!;
      const { id, balance } = await this.lockAccount(client, account);
      ids.set(key, id);
      if (account.owner === 'PLAYER' && balance + delta < 0n) {
        throw new AppError('insufficient_funds', 422, `Insufficient funds in ${account.kind} ${account.currency}`);
      }
      await client.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [id, delta]);
    }
    for (const line of req.lines) {
      await client.query('INSERT INTO entry_lines (entry_id, account_id, amount) VALUES ($1, $2, $3)', [
        entry.id,
        ids.get(accountKey(line.account)),
        line.amount,
      ]);
    }
    return toEntry(entry, false);
  }

  /** Creates the account on first use and locks it for the rest of the transaction. */
  private async lockAccount(client: Client, account: AccountRef): Promise<{ id: bigint; balance: bigint }> {
    if (account.owner === 'PLAYER') {
      await client.query(
        `INSERT INTO accounts (owner, player_id, kind, currency) VALUES ('PLAYER', $1, $2, $3)
         ON CONFLICT (player_id, kind, currency) WHERE owner = 'PLAYER' DO NOTHING`,
        [account.playerId, account.kind, account.currency],
      );
    } else {
      await client.query(
        `INSERT INTO accounts (owner, kind, currency) VALUES ('OPERATOR', $1, $2)
         ON CONFLICT (kind, currency) WHERE owner = 'OPERATOR' DO NOTHING`,
        [account.kind, account.currency],
      );
    }
    const { sql, params } = accountWhere(account);
    const { rows } = await client.query<{ id: bigint; balance: bigint }>(
      `SELECT id, balance FROM accounts WHERE ${sql} FOR UPDATE`,
      params,
    );
    return rows[0]!;
  }
}

const accountWhere = (a: AccountRef): { sql: string; params: string[] } =>
  a.owner === 'PLAYER'
    ? { sql: `owner = 'PLAYER' AND player_id = $1 AND kind = $2 AND currency = $3`, params: [a.playerId, a.kind, a.currency] }
    : { sql: `owner = 'OPERATOR' AND kind = $1 AND currency = $2`, params: [a.kind, a.currency] };
