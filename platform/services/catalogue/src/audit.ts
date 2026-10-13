import { createHash } from 'node:crypto';
import type { Client } from '@bp/common';

// FR-RSK-002, FR-BO-010, SEC-LOG-002: append-only, hash-chained audit of trader actions.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TraderContext {
  /** Back-office user id of the trader. */
  actor: string;
  /** Mandatory free-text reason. */
  reason: string;
  /** Where the request came from. */
  ip?: string;
}

/** JSON with object keys sorted, so a row hashes the same after a jsonb round trip. */
export const stableStringify = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

interface AuditFields {
  at: Date;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  ip: string | null;
  before: Json;
  after: Json;
}

const hashRow = (prev: string | null, f: AuditFields): string =>
  createHash('sha256')
    .update(
      stableStringify([prev, f.at.toISOString(), f.actor, f.action, f.targetType, f.targetId, f.reason, f.ip, f.before, f.after]),
    )
    .digest('hex');

export const writeAudit = async (client: Client, fields: AuditFields): Promise<void> => {
  // One writer at a time keeps the chain linear; released at commit.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('catalogue:trader_actions'))");
  const prev = (await client.query<{ hash: string }>('SELECT hash FROM trader_actions ORDER BY id DESC LIMIT 1')).rows[0]?.hash ?? null;
  await client.query(
    `INSERT INTO trader_actions (at, actor, action, target_type, target_id, reason, ip, before, after, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fields.at,
      fields.actor,
      fields.action,
      fields.targetType,
      fields.targetId,
      fields.reason,
      fields.ip,
      JSON.stringify(fields.before),
      JSON.stringify(fields.after),
      prev,
      hashRow(prev, fields),
    ],
  );
};

interface AuditRow {
  at: Date;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  ip: string | null;
  before: Json;
  after: Json;
  prev_hash: string | null;
  hash: string;
}

/** Recomputes the chain; false if any row was altered, removed or reordered. */
export const verifyAuditChain = async (client: Pick<Client, 'query'>): Promise<boolean> => {
  const rows = (await client.query<AuditRow>('SELECT * FROM trader_actions ORDER BY id')).rows;
  let prev: string | null = null;
  for (const r of rows) {
    const expected = hashRow(prev, {
      at: r.at,
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      ip: r.ip,
      before: r.before,
      after: r.after,
    });
    if (r.prev_hash !== prev || r.hash !== expected) return false;
    prev = r.hash;
  }
  return true;
};
