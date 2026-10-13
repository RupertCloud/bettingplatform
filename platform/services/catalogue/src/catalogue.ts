import {
  AppError,
  withTx,
  type Catalogue,
  type Client,
  type MarketState,
  type Odds,
  type Pool,
  type SelectionQuote,
} from '@bp/common';
import { writeAudit, verifyAuditChain, type Json, type TraderContext } from './audit.js';
import type { FeedEvent, FeedEventStatus, FeedRef } from './feed.js';
import { DEFAULT_LADDER, priceFromFeed, validateLadder, type LadderBand } from './pricing.js';
import { assertTransition } from './states.js';

export interface CatalogueOptions {
  /** Feed source that prices every sport by default (FR-SPD-001). */
  primarySource: string;
  /** Failover source (FR-SPD-013). */
  secondarySource?: string;
  now?: () => Date;
  ladder?: readonly LadderBand[];
  /** Margin when no margins row matches, in basis points. Default 500 (5 %). */
  defaultMarginBp?: number;
}

/** FR-SPD-006: live markets are suspended after this long without a heartbeat. */
export const HEARTBEAT_TIMEOUT_MS = 5_000;
/** FR-SPD-013: fail over to the secondary source after this long. */
export const FAILOVER_AFTER_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

const STATUS_RANK: Record<FeedEventStatus, number> = { PREMATCH: 0, LIVE: 1, ENDED: 2 };

export interface SportView {
  key: string;
  name: string;
}

export interface EventSummary {
  eventId: string;
  sport: string;
  competitionId: string;
  competitionName: string;
  name: string;
  startsAt: Date;
  status: FeedEventStatus;
  inPlay: boolean;
  suspended: boolean;
}

export interface SelectionView {
  selectionId: string;
  key: string;
  name: string;
  odds: Odds | null;
  state: MarketState;
  priceVersion: number;
}

export interface MarketView {
  marketId: string;
  type: string;
  line: string | null;
  state: MarketState;
  selections: SelectionView[];
}

export interface EventDetail extends EventSummary {
  markets: MarketView[];
}

export interface IngestResult {
  applied: number;
  ignored: number;
}

export interface StaleCheckResult {
  suspendedEvents: string[];
  failovers: { sport: string; from: string; to: string }[];
}

export interface ManualEventInput {
  sport: string;
  /** An existing competition, or a name to file the event under (created when new). */
  competitionId?: string;
  competitionName?: string;
  name: string;
  startsAt: Date;
  inPlayOffered: boolean;
}

export interface ManualMarketInput {
  type: string;
  line: string | null;
  selections: { key: string; name: string; odds: Odds }[];
}

export interface MarginInput {
  sport: string;
  competitionId?: string | null;
  marketType?: string | null;
  inPlay?: boolean | null;
  marginBp: number;
}

interface EventRow {
  id: string;
  sport: string;
  competition_id: string;
  home_id: string | null;
  away_id: string | null;
  starts_at: Date;
  status: FeedEventStatus;
  in_play_offered: boolean;
  feed_suspended: boolean;
  stale: boolean;
  review_required: boolean;
  trader_suspended: boolean;
}

/**
 * Read-side guard applied wherever a state is shown, so a missed scheduler run never lets a bet through:
 * a pre-match-only event past its start is closed (FR-SPD-007), and a started feed event whose pricing
 * source has been silent for more than 5 s is suspended (FR-SPD-006). Uses $2 = now, $3 = primary source,
 * and expects aliases e (events) and hb (heartbeat of the sport's active source; see GUARD_JOIN).
 */
const shown = (state: string): string => `CASE
  WHEN ${state} IN ('OPEN', 'SUSPENDED') AND NOT e.in_play_offered AND e.starts_at <= $2 THEN 'CLOSED'
  WHEN ${state} = 'OPEN' AND e.origin = 'feed' AND e.status <> 'ENDED' AND (e.status = 'LIVE' OR e.starts_at <= $2)
       AND (hb.last_seen IS NULL OR hb.last_seen < $2::timestamptz - interval '${HEARTBEAT_TIMEOUT_MS} milliseconds') THEN 'SUSPENDED'
  ELSE ${state} END`;
const GUARD_JOIN = `JOIN sports sp ON sp.key = e.sport
  LEFT JOIN source_heartbeats hb ON hb.source = COALESCE(sp.active_source, $3)`;

export class CatalogueService implements Catalogue {
  private readonly now: () => Date;
  private readonly ladder: readonly LadderBand[];
  private readonly defaultMarginBp: number;
  private readonly primary: string;
  private readonly secondary: string | null;

  constructor(
    private readonly pool: Pool,
    options: CatalogueOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.ladder = options.ladder ?? DEFAULT_LADDER;
    validateLadder(this.ladder);
    this.defaultMarginBp = options.defaultMarginBp ?? 500;
    this.primary = options.primarySource;
    this.secondary = options.secondarySource ?? null;
    if (this.primary === this.secondary) throw new Error('Primary and secondary sources must differ');
  }

  // ---------- Catalogue port ----------

  /** Current quotes for the given selections; unknown or never-priced ids are omitted. */
  async getQuotes(selectionIds: string[]): Promise<SelectionQuote[]> {
    const ids = [...new Set(selectionIds.filter(isUuid))];
    if (ids.length === 0) return [];
    const rows = await this.pool.query<{
      id: string;
      market_id: string;
      event_id: string;
      sport: string;
      competition_id: string;
      type: string;
      line: string | null;
      eff_odds: bigint;
      state: MarketState;
      starts_at: Date;
      status: FeedEventStatus;
      price_version: number;
    }>(
      `SELECT s.id, s.market_id, m.event_id, e.sport, e.competition_id, m.type, m.line, s.eff_odds,
              ${shown('s.eff_state')} AS state, e.starts_at, e.status, s.price_version
         FROM selections s JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id ${GUARD_JOIN}
        WHERE s.id = ANY($1::uuid[]) AND s.eff_odds IS NOT NULL AND s.eff_state IS NOT NULL`,
      [ids, this.now(), this.primary],
    );
    return rows.rows.map((r) => ({
      selectionId: r.id,
      marketId: r.market_id,
      eventId: r.event_id,
      sport: r.sport,
      competitionId: r.competition_id,
      marketType: r.type,
      line: r.line,
      odds: r.eff_odds,
      marketState: r.state,
      eventStartsAt: r.starts_at,
      inPlay: r.status === 'LIVE',
      priceVersion: r.price_version,
    }));
  }

  // ---------- Public reads ----------

  async listSports(): Promise<SportView[]> {
    return (await this.pool.query<SportView>('SELECT key, name FROM sports ORDER BY name')).rows;
  }

  async listEvents(filter: { sport?: string; live?: boolean; limit?: number }): Promise<EventSummary[]> {
    const rows = await this.pool.query<EventRow & { competition_name: string; name: string }>(
      `SELECT e.*, c.name AS competition_name FROM events e JOIN competitions c ON c.id = e.competition_id
        WHERE e.status <> 'ENDED'
          AND ($1::text IS NULL OR e.sport = $1)
          AND ($2::boolean IS NULL OR (e.status = 'LIVE') = $2)
        ORDER BY e.starts_at, e.id LIMIT $3`,
      [filter.sport ?? null, filter.live ?? null, filter.limit ?? 100],
    );
    return rows.rows.map(summary);
  }

  async getEvent(eventId: string): Promise<EventDetail | null> {
    if (!isUuid(eventId)) return null;
    const ev = (
      await this.pool.query<EventRow & { competition_name: string; name: string }>(
        `SELECT e.*, c.name AS competition_name FROM events e JOIN competitions c ON c.id = e.competition_id WHERE e.id = $1`,
        [eventId],
      )
    ).rows[0];
    if (!ev) return null;
    const rows = await this.pool.query<{
      market_id: string;
      type: string;
      line: string | null;
      market_state: MarketState;
      id: string | null;
      key: string;
      name: string;
      eff_odds: bigint | null;
      state: MarketState;
      price_version: number;
    }>(
      `SELECT m.id AS market_id, m.type, m.line, ${shown('m.state')} AS market_state,
              s.id, s.key, s.name, s.eff_odds, ${shown('s.eff_state')} AS state, s.price_version
         FROM markets m JOIN events e ON e.id = m.event_id ${GUARD_JOIN} LEFT JOIN selections s ON s.market_id = m.id
        WHERE m.event_id = $1
        ORDER BY m.type, m.line NULLS FIRST, m.id, s.key`,
      [eventId, this.now(), this.primary],
    );
    const markets = new Map<string, MarketView>();
    for (const r of rows.rows) {
      let m = markets.get(r.market_id);
      if (!m) {
        m = { marketId: r.market_id, type: r.type, line: r.line, state: r.market_state, selections: [] };
        markets.set(r.market_id, m);
      }
      if (r.id) {
        m.selections.push({
          selectionId: r.id,
          key: r.key,
          name: r.name,
          odds: r.eff_odds,
          state: r.state ?? 'SUSPENDED',
          priceVersion: r.price_version,
        });
      }
    }
    return { ...summary(ev), markets: [...markets.values()] };
  }

  /** FR-SPD-009: the selection's price and state history, oldest first. */
  async priceHistory(
    selectionId: string,
  ): Promise<{ odds: Odds | null; state: MarketState; priceVersion: number; source: string; at: Date }[]> {
    if (!isUuid(selectionId)) return [];
    const rows = await this.pool.query<{ odds: bigint | null; state: MarketState; price_version: number; source: string; at: Date }>(
      'SELECT odds, state, price_version, source, at FROM price_history WHERE selection_id = $1 ORDER BY id',
      [selectionId],
    );
    return rows.rows.map((r) => ({ odds: r.odds, state: r.state, priceVersion: r.price_version, source: r.source, at: r.at }));
  }

  // ---------- Feed ingestion (FR-SPD-001/002/006/008, FR-RSK-001) ----------

  /** Records a keep-alive from a source (push feeds send these between updates). */
  async heartbeat(source: string): Promise<void> {
    this.assertSource(source);
    await this.pool.query(
      `INSERT INTO source_heartbeats (source, last_seen) VALUES ($1, $2)
       ON CONFLICT (source) DO UPDATE SET last_seen = GREATEST(source_heartbeats.last_seen, EXCLUDED.last_seen)`,
      [source, this.now()],
    );
  }

  /** Applies one batch of normalised feed events. Each event is its own transaction. */
  async ingest(source: string, events: FeedEvent[]): Promise<IngestResult> {
    await this.heartbeat(source);
    const result: IngestResult = { applied: 0, ignored: 0 };
    for (const ev of events) {
      if (await withTx(this.pool, (c) => this.ingestEvent(c, source, ev))) result.applied++;
      else result.ignored++;
    }
    return result;
  }

  private async ingestEvent(c: Client, source: string, ev: FeedEvent): Promise<boolean> {
    const at = this.now();
    // Shared lock: checkStale cannot switch the pricing source mid-update.
    const sport = (
      await c.query<{ in_play_default: boolean; active_source: string | null }>(
        'SELECT in_play_default, active_source FROM sports WHERE key = $1 FOR SHARE',
        [ev.sport],
      )
    ).rows[0];
    if (!sport) return false;

    const findMapping = async () =>
      (
        await c.query<{ internal_id: string; last_seq: bigint }>(
          `SELECT internal_id, last_seq FROM feed_mappings WHERE source = $1 AND entity_type = 'event' AND external_id = $2 FOR UPDATE`,
          [source, ev.externalId],
        )
      ).rows[0];
    let mapping = await findMapping();
    if (!mapping) {
      await this.lockSourceMappings(c, source);
      mapping = await findMapping();
    }
    if (mapping && ev.seq <= mapping.last_seq) return false; // stale or duplicate update

    const homeId = await this.resolveRef(c, source, 'participant', ev.sport, ev.home);
    const awayId = await this.resolveRef(c, source, 'participant', ev.sport, ev.away);
    let eventId: string;
    let created = false;
    if (mapping) {
      eventId = mapping.internal_id;
      await c.query(`UPDATE feed_mappings SET last_seq = $3 WHERE source = $1 AND entity_type = 'event' AND external_id = $2`, [
        source,
        ev.externalId,
        ev.seq,
      ]);
    } else {
      // FR-SPD-002: the same fixture from another source maps to the same internal event.
      const matched = (
        await c.query<{ id: string }>(
          `SELECT e.id FROM events e
            WHERE e.sport = $1 AND e.starts_at = $2 AND e.home_id = $3 AND e.away_id = $4 AND e.origin = 'feed'
              AND NOT EXISTS (SELECT 1 FROM feed_mappings f WHERE f.source = $5 AND f.entity_type = 'event' AND f.internal_id = e.id)
            LIMIT 1`,
          [ev.sport, ev.startsAt, homeId, awayId, source],
        )
      ).rows[0];
      if (matched) {
        eventId = matched.id;
      } else {
        const competitionId = await this.resolveRef(c, source, 'competition', ev.sport, ev.competition);
        eventId = (
          await c.query<{ id: string }>(
            `INSERT INTO events (sport, competition_id, home_id, away_id, name, starts_at, status, in_play_offered, origin, feed_suspended, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'feed', $9, $10) RETURNING id`,
            [ev.sport, competitionId, homeId, awayId, `${ev.home.name} v ${ev.away.name}`, ev.startsAt, ev.status, sport.in_play_default, ev.suspended, at],
          )
        ).rows[0]!.id;
        created = true;
      }
      await c.query(
        `INSERT INTO feed_mappings (source, entity_type, external_id, internal_id, last_seq) VALUES ($1, 'event', $2, $3, $4)`,
        [source, ev.externalId, eventId, ev.seq],
      );
    }

    // Only the source currently pricing the sport changes the catalogue (FR-SPD-013).
    if ((sport.active_source ?? this.primary) !== source) return true;

    const event = await this.lockEvent(c, eventId);
    if (event.origin_manual) return true;
    // FR-SPD-008: a start-time or participant change suspends the event pending trader review.
    const changed =
      !created && (event.starts_at.getTime() !== ev.startsAt.getTime() || event.home_id !== homeId || event.away_id !== awayId);
    const status = STATUS_RANK[ev.status] > STATUS_RANK[event.status] ? ev.status : event.status;
    await c.query(
      `UPDATE events SET starts_at = $2, home_id = $3, away_id = $4, name = $5, status = $6, feed_suspended = $7,
              stale = false, review_required = review_required OR $8, updated_at = $9
        WHERE id = $1`,
      [eventId, ev.startsAt, homeId, awayId, `${ev.home.name} v ${ev.away.name}`, status, ev.suspended, changed, at],
    );

    if (status === 'ENDED') {
      await c.query(
        `UPDATE markets SET state = 'CLOSED', suspended_by = NULL WHERE event_id = $1 AND state IN ('OPEN', 'SUSPENDED')`,
        [eventId],
      );
    } else if (ev.markets) {
      await this.applyFeedMarkets(c, { ...event, status }, ev);
    }
    await this.closeStartedPrematch(c, at, [eventId]);
    await this.recompute(c, [eventId], `feed:${source}`, at);
    return true;
  }

  private async applyFeedMarkets(c: Client, event: EventRow, ev: FeedEvent): Promise<void> {
    const seen: string[] = [];
    const inPlay = event.status === 'LIVE';
    for (const fm of ev.markets ?? []) {
      const inserted = (
        await c.query<{ id: string }>(
          `INSERT INTO markets (event_id, type, line, state, suspended_by, origin) VALUES ($1, $2, $3, $4, $5, 'feed')
           ON CONFLICT (event_id, type, line) DO NOTHING RETURNING id`,
          [event.id, fm.type, fm.line, fm.suspended ? 'SUSPENDED' : 'OPEN', fm.suspended ? 'feed' : null],
        )
      ).rows[0];
      let marketId: string;
      if (inserted) {
        marketId = inserted.id;
      } else {
        const m = (
          await c.query<{ id: string; state: MarketState; suspended_by: string | null; origin: string }>(
            'SELECT id, state, suspended_by, origin FROM markets WHERE event_id = $1 AND type = $2 AND line IS NOT DISTINCT FROM $3 FOR UPDATE',
            [event.id, fm.type, fm.line],
          )
        ).rows[0]!;
        if (m.origin !== 'feed' || (m.state !== 'OPEN' && m.state !== 'SUSPENDED')) continue;
        marketId = m.id;
        if (m.state === 'OPEN' && fm.suspended) {
          await c.query(`UPDATE markets SET state = 'SUSPENDED', suspended_by = 'feed' WHERE id = $1`, [m.id]);
        } else if (m.state === 'SUSPENDED' && m.suspended_by === 'feed' && !fm.suspended) {
          await c.query(`UPDATE markets SET state = 'OPEN', suspended_by = NULL WHERE id = $1`, [m.id]);
        }
      }
      seen.push(marketId);
      const margin = await this.marginFor(c, event.sport, event.competition_id, fm.type, inPlay);
      for (const s of fm.selections) {
        const offered = s.odds === null ? null : priceFromFeed(s.odds, margin, this.ladder);
        await c.query(
          `INSERT INTO selections (market_id, key, name, feed_odds, odds) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (market_id, key) DO UPDATE SET name = EXCLUDED.name,
             feed_odds = COALESCE(EXCLUDED.feed_odds, selections.feed_odds),
             odds = COALESCE(EXCLUDED.odds, selections.odds)`,
          [marketId, s.key, s.name, s.odds, offered],
        );
      }
    }
    // The feed sends the full market set: markets it no longer lists cannot be priced.
    await c.query(
      `UPDATE markets SET state = 'SUSPENDED', suspended_by = 'feed'
        WHERE event_id = $1 AND origin = 'feed' AND state = 'OPEN' AND id <> ALL($2::uuid[])`,
      [event.id, seen],
    );
  }

  /** Maps an external competition or participant to its internal id, creating it when unknown (FR-SPD-002). */
  private async resolveRef(
    c: Client,
    source: string,
    type: 'competition' | 'participant',
    sport: string,
    ref: FeedRef,
  ): Promise<string> {
    const table = type === 'competition' ? 'competitions' : 'participants';
    const find = async () =>
      (
        await c.query<{ internal_id: string }>(
          'SELECT internal_id FROM feed_mappings WHERE source = $1 AND entity_type = $2 AND external_id = $3',
          [source, type, ref.externalId],
        )
      ).rows[0]?.internal_id;
    const existing = await find();
    if (existing) return existing;
    await this.lockSourceMappings(c, source);
    const again = await find();
    if (again) return again;
    const id =
      (
        await c.query<{ id: string }>(
          `SELECT t.id FROM ${table} t WHERE t.sport = $1 AND lower(t.name) = lower($2)
              AND NOT EXISTS (SELECT 1 FROM feed_mappings f WHERE f.source = $3 AND f.entity_type = $4 AND f.internal_id = t.id)
            LIMIT 1`,
          [sport, ref.name, source, type],
        )
      ).rows[0]?.id ??
      (await c.query<{ id: string }>(`INSERT INTO ${table} (sport, name) VALUES ($1, $2) RETURNING id`, [sport, ref.name])).rows[0]!.id;
    await c.query('INSERT INTO feed_mappings (source, entity_type, external_id, internal_id) VALUES ($1, $2, $3, $4)', [
      source,
      type,
      ref.externalId,
      id,
    ]);
    return id;
  }

  /** Serialises creation of new mappings per source, so one external id never maps twice. */
  private async lockSourceMappings(c: Client, source: string): Promise<void> {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`catalogue:mappings:${source}`]);
  }

  private async marginFor(c: Client, sport: string, competitionId: string, marketType: string, inPlay: boolean): Promise<number> {
    const row = (
      await c.query<{ margin_bp: number }>(
        `SELECT margin_bp FROM margins
          WHERE sport = $1 AND (competition_id IS NULL OR competition_id = $2)
            AND (market_type IS NULL OR market_type = $3) AND (in_play IS NULL OR in_play = $4)
          ORDER BY competition_id IS NOT NULL DESC, market_type IS NOT NULL DESC, in_play IS NOT NULL DESC
          LIMIT 1`,
        [sport, competitionId, marketType, inPlay],
      )
    ).rows[0];
    return row?.margin_bp ?? this.defaultMarginBp;
  }

  // ---------- Scheduled checks ----------

  /**
   * FR-SPD-006: suspends feed events that are live (or past their start) when the source pricing them
   * has been silent for more than 5 s. FR-SPD-013: switches a sport to the secondary source when the
   * primary has been silent for more than 10 s and the secondary is alive, and back when the primary recovers.
   */
  async checkStale(now: Date = this.now()): Promise<StaleCheckResult> {
    return withTx(this.pool, async (c) => {
      const sports = (
        await c.query<{ key: string; active_source: string | null }>('SELECT key, active_source FROM sports ORDER BY key FOR UPDATE')
      ).rows;
      const beats = new Map(
        (await c.query<{ source: string; last_seen: Date }>('SELECT source, last_seen FROM source_heartbeats')).rows.map((r) => [
          r.source,
          r.last_seen.getTime(),
        ]),
      );
      const age = (source: string) => now.getTime() - (beats.get(source) ?? Number.NEGATIVE_INFINITY);
      const failovers: StaleCheckResult['failovers'] = [];
      if (this.secondary) {
        for (const s of sports) {
          const active = s.active_source ?? this.primary;
          let to: string | null = null;
          if (active === this.primary && age(this.primary) > FAILOVER_AFTER_MS && age(this.secondary) <= HEARTBEAT_TIMEOUT_MS) {
            to = this.secondary;
          } else if (active !== this.primary && age(this.primary) <= HEARTBEAT_TIMEOUT_MS) {
            to = this.primary;
          }
          if (to) {
            await c.query('UPDATE sports SET active_source = $2 WHERE key = $1', [s.key, to === this.primary ? null : to]);
            failovers.push({ sport: s.key, from: active, to });
          }
        }
      }
      const staleSources = [this.primary, ...(this.secondary ? [this.secondary] : [])].filter(
        (s) => age(s) > HEARTBEAT_TIMEOUT_MS,
      );
      const switched = failovers.map((f) => f.sport);
      // After a switch, prices from the old source no longer count until the new one sends them.
      const ids = (
        await c.query<{ id: string }>(
          `UPDATE events e SET stale = true, updated_at = $1
             FROM sports s
            WHERE e.sport = s.key AND e.origin = 'feed' AND NOT e.stale AND e.status <> 'ENDED'
              AND (e.status = 'LIVE' OR e.starts_at <= $1)
              AND (COALESCE(s.active_source, $2) = ANY($3::text[]) OR e.sport = ANY($4::text[]))
           RETURNING e.id`,
          [now, this.primary, staleSources, switched],
        )
      ).rows.map((r) => r.id);
      await this.recompute(c, ids, 'system:heartbeat', now);
      return { suspendedEvents: ids, failovers };
    });
  }

  /** FR-SPD-007: closes the markets of pre-match-only events that have started. Returns the event ids touched. */
  async closePrematch(now: Date = this.now()): Promise<string[]> {
    return withTx(this.pool, async (c) => {
      const ids = (
        await c.query<{ id: string }>(
          `SELECT e.id FROM events e
            WHERE NOT e.in_play_offered AND (e.starts_at <= $1 OR e.status <> 'PREMATCH')
              AND EXISTS (SELECT 1 FROM markets m WHERE m.event_id = e.id AND m.state IN ('OPEN', 'SUSPENDED'))
            ORDER BY e.id FOR UPDATE`,
          [now],
        )
      ).rows.map((r) => r.id);
      await this.closeStartedPrematch(c, now, ids);
      await this.recompute(c, ids, 'system:prematch-close', now);
      return ids;
    });
  }

  private async closeStartedPrematch(c: Client, now: Date, eventIds: string[]): Promise<void> {
    await c.query(
      `UPDATE markets m SET state = 'CLOSED', suspended_by = NULL
         FROM events e
        WHERE m.event_id = e.id AND e.id = ANY($2::uuid[]) AND NOT e.in_play_offered
          AND (e.starts_at <= $1 OR e.status <> 'PREMATCH') AND m.state IN ('OPEN', 'SUSPENDED')`,
      [now, eventIds],
    );
  }

  /**
   * Re-derives what each selection of the events offers. Every change in price or state bumps
   * price_version and appends to price_history (FR-SPD-009). Callers hold the event row locks.
   */
  private async recompute(c: Client, eventIds: string[], source: string, at: Date): Promise<void> {
    if (eventIds.length === 0) return;
    await c.query(
      `WITH calc AS (
         SELECT s.id,
                CASE WHEN m.state <> 'OPEN' THEN m.state
                     WHEN e.status = 'ENDED' OR e.feed_suspended OR e.stale OR e.review_required OR e.trader_suspended
                          OR s.suspended OR COALESCE(s.override_odds, s.odds) IS NULL THEN 'SUSPENDED'
                     ELSE 'OPEN' END AS st,
                COALESCE(s.override_odds, s.odds) AS price
           FROM selections s JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id
          WHERE e.id = ANY($1::uuid[])
       ), changed AS (
         UPDATE selections s SET eff_state = calc.st, eff_odds = calc.price, price_version = s.price_version + 1
           FROM calc
          WHERE s.id = calc.id AND (s.eff_state IS DISTINCT FROM calc.st OR s.eff_odds IS DISTINCT FROM calc.price)
         RETURNING s.id, s.eff_odds, s.eff_state, s.price_version
       )
       INSERT INTO price_history (selection_id, odds, state, price_version, source, at)
       SELECT id, eff_odds, eff_state, price_version, $2, $3 FROM changed`,
      [eventIds, source, at],
    );
  }

  private async lockEvent(c: Client, eventId: string): Promise<EventRow & { origin_manual: boolean }> {
    const row = isUuid(eventId)
      ? (
          await c.query<EventRow & { origin_manual: boolean }>(
            `SELECT *, origin = 'manual' AS origin_manual FROM events WHERE id = $1 FOR UPDATE`,
            [eventId],
          )
        ).rows[0]
      : undefined;
    if (!row) throw new AppError('event_not_found', 404, 'No such event');
    return row;
  }

  private async eventOf(c: Client, kind: 'market' | 'selection', id: string): Promise<string> {
    const sql =
      kind === 'market'
        ? 'SELECT event_id FROM markets WHERE id = $1'
        : 'SELECT m.event_id FROM selections s JOIN markets m ON m.id = s.market_id WHERE s.id = $1';
    const row = isUuid(id) ? (await c.query<{ event_id: string }>(sql, [id])).rows[0] : undefined;
    if (!row) throw new AppError(`${kind}_not_found`, 404, `No such ${kind}`);
    return row.event_id;
  }

  private assertSource(source: string): void {
    if (source !== this.primary && source !== this.secondary) {
      throw new AppError('unknown_source', 400, 'Unknown feed source');
    }
  }

  // ---------- Trader actions (FR-RSK-002, FR-SPD-012), each audited ----------

  private async traderAction<T>(
    ctx: TraderContext,
    action: string,
    targetType: string,
    targetId: string,
    fn: (c: Client, at: Date) => Promise<{ before: Json; after: Json; eventId: string | null; result: T }>,
  ): Promise<T> {
    if (!ctx.actor.trim()) throw new AppError('actor_required', 400, 'Actor is required');
    if (!ctx.reason.trim()) throw new AppError('reason_required', 400, 'A reason is required');
    return withTx(this.pool, async (c) => {
      const at = this.now();
      const { before, after, eventId, result } = await fn(c, at);
      if (eventId) {
        await this.closeStartedPrematch(c, at, [eventId]);
        await this.recompute(c, [eventId], `trader:${ctx.actor}`, at);
      }
      await writeAudit(c, {
        at,
        actor: ctx.actor,
        action,
        targetType,
        targetId: targetId || String(result),
        reason: ctx.reason.trim(),
        ip: ctx.ip ?? null,
        before,
        after,
      });
      return result;
    });
  }

  suspendEvent(eventId: string, ctx: TraderContext): Promise<void> {
    return this.setEventSuspension(eventId, true, ctx);
  }

  /** Clears the trader suspension and any pending review (FR-SPD-008). Feed and heartbeat suspensions still apply. */
  reopenEvent(eventId: string, ctx: TraderContext): Promise<void> {
    return this.setEventSuspension(eventId, false, ctx);
  }

  private setEventSuspension(eventId: string, suspend: boolean, ctx: TraderContext): Promise<void> {
    return this.traderAction(ctx, suspend ? 'SUSPEND_EVENT' : 'REOPEN_EVENT', 'event', eventId, async (c, at) => {
      const e = await this.lockEvent(c, eventId);
      if (suspend) {
        await c.query('UPDATE events SET trader_suspended = true, updated_at = $2 WHERE id = $1', [eventId, at]);
      } else {
        await c.query('UPDATE events SET trader_suspended = false, review_required = false, updated_at = $2 WHERE id = $1', [eventId, at]);
      }
      return {
        before: { traderSuspended: e.trader_suspended, reviewRequired: e.review_required },
        after: { traderSuspended: suspend, reviewRequired: suspend ? e.review_required : false },
        eventId,
        result: undefined,
      };
    });
  }

  suspendMarket(marketId: string, ctx: TraderContext): Promise<void> {
    return this.setMarketSuspension(marketId, true, ctx);
  }

  reopenMarket(marketId: string, ctx: TraderContext): Promise<void> {
    return this.setMarketSuspension(marketId, false, ctx);
  }

  private setMarketSuspension(marketId: string, suspend: boolean, ctx: TraderContext): Promise<void> {
    return this.traderAction(ctx, suspend ? 'SUSPEND_MARKET' : 'REOPEN_MARKET', 'market', marketId, async (c) => {
      const eventId = await this.eventOf(c, 'market', marketId);
      await this.lockEvent(c, eventId);
      const m = (
        await c.query<{ state: MarketState; suspended_by: string | null }>(
          'SELECT state, suspended_by FROM markets WHERE id = $1 FOR UPDATE',
          [marketId],
        )
      ).rows[0]!;
      // A trader suspension of a feed-suspended market takes ownership, so the feed cannot reopen it.
      if (!(suspend && m.state === 'SUSPENDED')) assertTransition(m.state, suspend ? 'SUSPENDED' : 'OPEN');
      await c.query('UPDATE markets SET state = $2, suspended_by = $3 WHERE id = $1', [
        marketId,
        suspend ? 'SUSPENDED' : 'OPEN',
        suspend ? 'trader' : null,
      ]);
      return {
        before: { state: m.state, suspendedBy: m.suspended_by },
        after: { state: suspend ? 'SUSPENDED' : 'OPEN', suspendedBy: suspend ? 'trader' : null },
        eventId,
        result: undefined,
      };
    });
  }

  suspendSelection(selectionId: string, ctx: TraderContext): Promise<void> {
    return this.setSelectionSuspension(selectionId, true, ctx);
  }

  reopenSelection(selectionId: string, ctx: TraderContext): Promise<void> {
    return this.setSelectionSuspension(selectionId, false, ctx);
  }

  private setSelectionSuspension(selectionId: string, suspend: boolean, ctx: TraderContext): Promise<void> {
    return this.traderAction(ctx, suspend ? 'SUSPEND_SELECTION' : 'REOPEN_SELECTION', 'selection', selectionId, async (c) => {
      const eventId = await this.eventOf(c, 'selection', selectionId);
      await this.lockEvent(c, eventId);
      const before = (
        await c.query<{ suspended: boolean }>('SELECT suspended FROM selections WHERE id = $1 FOR UPDATE', [selectionId])
      ).rows[0]!.suspended;
      await c.query('UPDATE selections SET suspended = $2 WHERE id = $1', [selectionId, suspend]);
      return { before: { suspended: before }, after: { suspended: suspend }, eventId, result: undefined };
    });
  }

  /** Sets a trader price that wins over the feed until cleared with null. */
  overridePrice(selectionId: string, odds: Odds | null, ctx: TraderContext): Promise<void> {
    if (odds !== null && odds <= 10_000n) throw new AppError('invalid_odds', 400, 'Odds must be above 1.0');
    return this.traderAction(ctx, 'OVERRIDE_PRICE', 'selection', selectionId, async (c) => {
      const eventId = await this.eventOf(c, 'selection', selectionId);
      await this.lockEvent(c, eventId);
      const s = (
        await c.query<{ override_odds: bigint | null; odds: bigint | null; state: MarketState }>(
          `SELECT s.override_odds, s.odds, m.state FROM selections s JOIN markets m ON m.id = s.market_id WHERE s.id = $1 FOR UPDATE OF s`,
          [selectionId],
        )
      ).rows[0]!;
      if (s.state !== 'OPEN' && s.state !== 'SUSPENDED') {
        throw new AppError('market_not_tradeable', 409, `Market is ${s.state}`);
      }
      await c.query('UPDATE selections SET override_odds = $2 WHERE id = $1', [selectionId, odds]);
      return {
        before: { overrideOdds: s.override_odds?.toString() ?? null, odds: s.odds?.toString() ?? null },
        after: { overrideOdds: odds?.toString() ?? null },
        eventId,
        result: undefined,
      };
    });
  }

  /** FR-SPD-012: a manual event (special, outright) with the same lifecycle as feed events. */
  createEvent(input: ManualEventInput, ctx: TraderContext): Promise<string> {
    return this.traderAction(ctx, 'CREATE_EVENT', 'event', '', async (c, at) => {
      const sport = (await c.query('SELECT 1 FROM sports WHERE key = $1', [input.sport])).rowCount;
      if (!sport) throw new AppError('sport_not_found', 404, 'No such sport');
      let competitionId = input.competitionId;
      if (competitionId) {
        const ok = isUuid(competitionId)
          ? (await c.query('SELECT 1 FROM competitions WHERE id = $1 AND sport = $2', [competitionId, input.sport])).rowCount
          : 0;
        if (!ok) throw new AppError('competition_not_found', 404, 'No such competition in this sport');
      } else if (input.competitionName) {
        competitionId =
          (
            await c.query<{ id: string }>('SELECT id FROM competitions WHERE sport = $1 AND name = $2 ORDER BY id LIMIT 1', [
              input.sport,
              input.competitionName,
            ])
          ).rows[0]?.id ??
          (
            await c.query<{ id: string }>('INSERT INTO competitions (sport, name) VALUES ($1, $2) RETURNING id', [
              input.sport,
              input.competitionName,
            ])
          ).rows[0]!.id;
      } else {
        throw new AppError('competition_required', 400, 'competitionId or competitionName is required');
      }
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO events (sport, competition_id, name, starts_at, in_play_offered, origin, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id`,
          [input.sport, competitionId, input.name, input.startsAt, input.inPlayOffered, at],
        )
      ).rows[0]!.id;
      return {
        before: null,
        after: {
          eventId: id,
          sport: input.sport,
          competitionId,
          name: input.name,
          startsAt: input.startsAt.toISOString(),
          inPlayOffered: input.inPlayOffered,
        },
        eventId: null,
        result: id,
      };
    });
  }

  /** FR-SPD-012: a manual market on any event, opened at the trader's prices. */
  createMarket(eventId: string, input: ManualMarketInput, ctx: TraderContext): Promise<string> {
    if (input.selections.length === 0) throw new AppError('selections_required', 400, 'A market needs selections');
    if (new Set(input.selections.map((s) => s.key)).size !== input.selections.length) {
      throw new AppError('duplicate_selection', 400, 'Selection keys must be unique');
    }
    if (input.selections.some((s) => s.odds <= 10_000n)) throw new AppError('invalid_odds', 400, 'Odds must be above 1.0');
    return this.traderAction(ctx, 'CREATE_MARKET', 'market', '', async (c) => {
      const e = await this.lockEvent(c, eventId);
      if (e.status === 'ENDED') throw new AppError('event_ended', 409, 'Event has ended');
      const marketId = (
        await c.query<{ id: string }>(
          `INSERT INTO markets (event_id, type, line, state, origin) VALUES ($1, $2, $3, 'OPEN', 'manual')
           ON CONFLICT (event_id, type, line) DO NOTHING RETURNING id`,
          [eventId, input.type, input.line],
        )
      ).rows[0]?.id;
      if (!marketId) throw new AppError('market_exists', 409, 'A market with this type and line already exists');
      for (const s of input.selections) {
        await c.query('INSERT INTO selections (market_id, key, name, odds) VALUES ($1, $2, $3, $4)', [marketId, s.key, s.name, s.odds]);
      }
      return {
        before: null,
        after: {
          marketId,
          eventId,
          type: input.type,
          line: input.line,
          selections: input.selections.map((s) => ({ key: s.key, name: s.name, odds: s.odds.toString() })),
        },
        eventId,
        result: marketId,
      };
    });
  }

  /** FR-RSK-001: sets the margin for a sport, optionally narrowed by competition, market type and in-play state. */
  setMargin(input: MarginInput, ctx: TraderContext): Promise<void> {
    if (!Number.isInteger(input.marginBp) || input.marginBp < 0 || input.marginBp > 5000) {
      throw new AppError('invalid_margin', 400, 'Margin must be 0 to 5000 basis points');
    }
    const key = [input.sport, input.competitionId ?? '*', input.marketType ?? '*', input.inPlay ?? '*'].join('/');
    return this.traderAction(ctx, 'SET_MARGIN', 'margin', key, async (c) => {
      const params = [input.sport, input.competitionId ?? null, input.marketType ?? null, input.inPlay ?? null];
      const before =
        (
          await c.query<{ margin_bp: number }>(
            `SELECT margin_bp FROM margins WHERE sport = $1 AND competition_id IS NOT DISTINCT FROM $2
                AND market_type IS NOT DISTINCT FROM $3 AND in_play IS NOT DISTINCT FROM $4 FOR UPDATE`,
            params,
          )
        ).rows[0]?.margin_bp ?? null;
      await c.query(
        `INSERT INTO margins (sport, competition_id, market_type, in_play, margin_bp) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sport, competition_id, market_type, in_play) DO UPDATE SET margin_bp = EXCLUDED.margin_bp`,
        [...params, input.marginBp],
      );
      return { before: { marginBp: before }, after: { marginBp: input.marginBp }, eventId: null, result: undefined };
    });
  }

  /** FR-SPD-002 mapping tool: points an external id of a source at a chosen internal entity. */
  mapEntity(
    source: string,
    entityType: 'competition' | 'participant' | 'event',
    externalId: string,
    internalId: string,
    ctx: TraderContext,
  ): Promise<void> {
    this.assertSource(source);
    return this.traderAction(ctx, 'MAP_ENTITY', entityType, `${source}:${externalId}`, async (c) => {
      const table = { competition: 'competitions', participant: 'participants', event: 'events' }[entityType];
      const exists = isUuid(internalId) ? (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [internalId])).rowCount : 0;
      if (!exists) throw new AppError('entity_not_found', 404, `No such ${entityType}`);
      await this.lockSourceMappings(c, source);
      const before =
        (
          await c.query<{ internal_id: string }>(
            'SELECT internal_id FROM feed_mappings WHERE source = $1 AND entity_type = $2 AND external_id = $3 FOR UPDATE',
            [source, entityType, externalId],
          )
        ).rows[0]?.internal_id ?? null;
      try {
        await c.query(
          `INSERT INTO feed_mappings (source, entity_type, external_id, internal_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (source, entity_type, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id`,
          [source, entityType, externalId, internalId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError('already_mapped', 409, 'That entity is already mapped from this source');
        }
        throw err;
      }
      return { before: { internalId: before }, after: { internalId }, eventId: null, result: undefined };
    });
  }

  /** SEC-LOG-002: true when the trader audit chain is intact. */
  verifyAudit(): Promise<boolean> {
    return verifyAuditChain(this.pool);
  }
}

const summary = (e: EventRow & { competition_name: string; name: string }): EventSummary => ({
  eventId: e.id,
  sport: e.sport,
  competitionId: e.competition_id,
  competitionName: e.competition_name,
  name: e.name,
  startsAt: e.starts_at,
  status: e.status,
  inPlay: e.status === 'LIVE',
  suspended: e.feed_suspended || e.stale || e.review_required || e.trader_suspended,
});
