'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { displayOdds } from '../lib/format.mjs';
import { useSlip } from './SlipProvider';
import StatusNote from './StatusNote';

const EVENT_LIMIT = 12;
const LABELS = { HOME: '1', DRAW: 'X', AWAY: '2' };
const ORDER = { HOME: 0, DRAW: 1, AWAY: 2 };

const kickOff = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Douala',
});

/** The 1X2 market, or a two-way match winner when a sport has no draw. */
const mainMarket = (markets = []) => markets.find((m) => m.type === '1X2') ?? markets.find((m) => m.type === 'MONEYLINE') ?? null;

export default function SportsBoard() {
  const { items, toggle, signedIn } = useSlip();
  const [sports, setSports] = useState(null);
  const [sport, setSport] = useState('');
  const [events, setEvents] = useState(null);
  const [markets, setMarkets] = useState({});

  useEffect(() => {
    let live = true;
    api('/v1/sports').then((r) => live && setSports(r));
    return () => {
      live = false;
    };
  }, [signedIn]);

  useEffect(() => {
    if (!sports?.ok) return undefined;
    let live = true;
    setEvents(null);
    setMarkets({});
    const q = new URLSearchParams({ live: 'false', limit: String(EVENT_LIMIT) });
    if (sport) q.set('sport', sport);
    api(`/v1/events?${q}`).then((r) => {
      if (!live) return;
      setEvents(r);
      if (!r.ok) return;
      for (const e of r.data.events ?? []) {
        api(`/v1/events/${e.eventId}`).then((d) => {
          if (live && d.ok) setMarkets((cur) => ({ ...cur, [e.eventId]: d.data }));
        });
      }
    });
    return () => {
      live = false;
    };
  }, [sports, sport]);

  if (!sports) return <p className="muted">Loading sports...</p>;
  if (!sports.ok) return <StatusNote result={sports} what="sports and prices" />;

  const picked = new Set(items.map((i) => i.selectionId));
  const list = sports.data.sports ?? [];

  return (
    <>
      {list.length > 1 ? (
        <div className="chips" role="tablist" aria-label="Sports">
          <button type="button" className={sport === '' ? 'chip active' : 'chip'} onClick={() => setSport('')}>
            All
          </button>
          {list.map((s) => (
            <button key={s.key} type="button" className={sport === s.key ? 'chip active' : 'chip'} onClick={() => setSport(s.key)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}

      {!events ? <p className="muted">Loading matches...</p> : null}
      {events && !events.ok ? <StatusNote result={events} what="matches" /> : null}
      {events?.ok && (events.data.events ?? []).length === 0 ? <p className="muted">No upcoming matches right now.</p> : null}

      <ul className="events">
        {(events?.ok ? events.data.events ?? [] : []).map((e) => {
          const detail = markets[e.eventId];
          const market = detail ? mainMarket(detail.markets) : null;
          const sels = market ? [...market.selections].sort((a, b) => (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9)) : [];
          return (
            <li key={e.eventId} className="event">
              <div className="event-meta">
                <span>{e.competition?.name}</span>
                <time dateTime={e.startsAt}>{kickOff.format(new Date(e.startsAt))}</time>
              </div>
              <div className="event-name">{e.name}</div>
              <div className="prices">
                {!detail ? <span className="muted small">Loading prices...</span> : null}
                {detail && !market ? <span className="muted small">No match result prices.</span> : null}
                {sels.map((s) => {
                  const available = !e.suspended && !detail.suspended && market.state === 'OPEN' && s.state === 'OPEN' && s.odds;
                  const on = picked.has(s.selectionId);
                  return (
                    <button
                      key={s.selectionId}
                      type="button"
                      className={on ? 'price on' : 'price'}
                      disabled={!available}
                      aria-pressed={on}
                      aria-label={`${s.name} at ${available ? displayOdds(s.odds) : 'suspended'}`}
                      onClick={() => {
                        toggle({
                          selectionId: s.selectionId,
                          marketId: market.marketId,
                          eventId: e.eventId,
                          eventName: e.name,
                          selectionName: s.name,
                          odds: s.odds,
                        });
                      }}
                    >
                      <span className="price-label">{LABELS[s.key] ?? s.name}</span>
                      <span className="price-odds">{available ? displayOdds(s.odds) : '-'}</span>
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
