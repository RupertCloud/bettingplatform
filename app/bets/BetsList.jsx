'use client';

import { useEffect, useState } from 'react';
import { api, describeError } from '../../lib/api';
import { displayOdds, formatXaf } from '../../lib/format.mjs';
import StatusNote from '../../components/StatusNote';
import { useSlip } from '../../components/SlipProvider';

const STATUS = {
  PENDING: ['Being checked', 'pending'],
  OPEN: ['Open', 'open'],
  REJECTED: ['Not accepted', 'rejected'],
  SETTLED: ['Settled', 'settled'],
  CASHED_OUT: ['Cashed out', 'settled'],
};

const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Douala' });

const betType = (b) => {
  const n = b.legs.length;
  if (n === 1) return 'Single';
  if (b.combinationSizes.length === 1 && b.combinationSizes[0] === 1) return `${n} singles`;
  if (b.combinationSizes.length === 1 && b.combinationSizes[0] === n) return `Accumulator (${n} selections)`;
  return `Multiple (${n} selections)`;
};

export default function BetsList() {
  const { signedIn } = useSlip();
  const [res, setRes] = useState(null);

  useEffect(() => {
    let live = true;
    api('/v1/bets?limit=50').then((r) => live && setRes(r));
    return () => {
      live = false;
    };
  }, [signedIn]);

  if (!res) return <p className="muted">Loading your bets...</p>;
  if (!res.ok) return <StatusNote result={res} what="your bets" />;
  const bets = res.data.bets ?? [];
  if (!bets.length) return <p className="muted">You have no bets yet.</p>;

  return (
    <ul className="bets">
      {bets.map((b) => {
        const [label, tone] = STATUS[b.status] ?? [b.status, 'pending'];
        return (
          <li key={b.betId} className="card bet">
            <div className="row-between">
              <span className="strong">{betType(b)}</span>
              <span className={`status status-${tone}`}>{label}</span>
            </div>
            <div className="muted small">{when.format(new Date(b.submittedAt))}</div>
            <div className="small">Odds: {b.legs.map((l) => displayOdds(l.odds)).join(' · ')}</div>
            <div className="row-between">
              <span className="muted">Stake</span>
              <span>{formatXaf(b.totalStake)}</span>
            </div>
            <div className="row-between">
              <span className="muted">{b.status === 'REJECTED' ? 'Return' : 'Potential return'}</span>
              <span className="strong">{b.status === 'REJECTED' ? formatXaf('0') : formatXaf(b.potentialReturn)}</span>
            </div>
            {b.rejection ? <div className="note note-error small">{describeError({ code: b.rejection.code, detail: b.rejection.detail })}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
