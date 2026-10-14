'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, describeError, newRequestId } from '../lib/api';
import { comboOdds, displayOdds, formatOdds, formatXaf, parseOdds, parseStake, payout } from '../lib/format.mjs';
import { useSlip } from './SlipProvider';

export default function BetSlip() {
  const { items, remove, updateOdds, clear, open, setOpen, signedIn } = useSlip();
  const [mode, setMode] = useState('singles');
  const [stakeInput, setStakeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);

  const acca = mode === 'acca' && items.length >= 2;
  useEffect(() => {
    if (items.length < 2 && mode === 'acca') setMode('singles');
  }, [items.length, mode]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const stake = parseStake(stakeInput);
  let totalStake = null;
  let potential = null;
  let accaOdds = null;
  if (acca) {
    accaOdds = comboOdds(items.map((i) => i.odds));
    totalStake = stake;
    potential = stake ? payout(stake, accaOdds) : null;
  } else if (stake && items.length) {
    totalStake = (BigInt(stake) * BigInt(items.length)).toString();
    potential = items.reduce((sum, i) => sum + BigInt(payout(stake, parseOdds(i.odds)) ?? '0'), 0n).toString();
  }

  const place = async () => {
    if (!stake || !items.length || busy) return;
    setBusy(true);
    setError('');
    setPlaced(null);
    const requestId = newRequestId();
    const res = await api('/v1/bets', {
      method: 'POST',
      headers: { 'idempotency-key': requestId },
      body: {
        currency: 'XAF',
        legs: items.map((i) => ({ selectionId: i.selectionId, odds: i.odds })),
        combinationSizes: [acca ? items.length : 1],
        unitStake: stake,
        channel: 'WEB',
      },
    });
    setBusy(false);
    if (res.ok) {
      setPlaced(res.data);
      clear();
      setStakeInput('');
      return;
    }
    if (res.error.code === 'price_changed' && res.error.selectionId && parseOdds(res.error.currentOdds)) {
      updateOdds(res.error.selectionId, res.error.currentOdds);
    }
    setError(res.status === 401 ? 'Please sign in to place bets.' : describeError(res.error));
  };

  return (
    <>
      {!open && items.length ? (
        <button type="button" className="slip-bar" onClick={() => setOpen(true)}>
          <span>
            Bet slip <span className="badge">{items.length}</span>
          </span>
          <span>Open</span>
        </button>
      ) : null}
      <div className={open ? 'scrim open' : 'scrim'} onClick={() => setOpen(false)} aria-hidden="true" />
      <aside className={open ? 'slip open' : 'slip'} aria-label="Bet slip" aria-hidden={!open}>
        <div className="slip-head">
          <h2>Bet slip</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        {placed ? (
          <div className="note note-ok" role="status">
            {placed.status === 'PENDING' ? 'Your bet has been sent and is being checked.' : 'Your bet is placed.'} Stake{' '}
            {formatXaf(placed.totalStake)}, potential return {formatXaf(placed.potentialReturn)}.{' '}
            <Link href="/bets" onClick={() => setOpen(false)}>
              See my bets
            </Link>
          </div>
        ) : null}

        {items.length === 0 ? (
          <p className="muted">Tap a price to add a selection.</p>
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={!acca} className={!acca ? 'tab active' : 'tab'} onClick={() => setMode('singles')}>
                Singles ({items.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={acca}
                className={acca ? 'tab active' : 'tab'}
                disabled={items.length < 2}
                onClick={() => setMode('acca')}
              >
                Accumulator
              </button>
            </div>

            <ul className="slip-list">
              {items.map((i) => (
                <li key={i.selectionId} className="slip-item">
                  <div>
                    <div className="strong">{i.selectionName}</div>
                    <div className="muted small">{i.eventName}</div>
                  </div>
                  <div className="slip-item-side">
                    <span className="odds">{displayOdds(i.odds)}</span>
                    <button type="button" className="link-btn" onClick={() => remove(i.selectionId)} aria-label={`Remove ${i.selectionName}`}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {acca && accaOdds !== null ? (
              <p className="row-between">
                <span className="muted">Accumulator odds</span>
                <span className="odds">{displayOdds(formatOdds(accaOdds))}</span>
              </p>
            ) : null}

            <label className="field">
              <span>{acca ? 'Stake (XAF)' : 'Stake per single (XAF)'}</span>
              <input
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 1,000"
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value.replace(/[^\d\s,]/g, ''))}
              />
            </label>

            <p className="row-between">
              <span className="muted">Total stake</span>
              <span>{totalStake ? formatXaf(totalStake) : '-'}</span>
            </p>
            <p className="row-between">
              <span className="muted">Potential return</span>
              <span className="strong">{potential ? formatXaf(potential) : '-'}</span>
            </p>

            {error ? (
              <div className="note note-error" role="alert">
                {error}
              </div>
            ) : null}

            {signedIn ? (
              <button type="button" className="btn btn-primary btn-block" disabled={!stake || busy} onClick={place}>
                {busy ? 'Placing...' : 'Place bet'}
              </button>
            ) : (
              <Link href="/login" className="btn btn-primary btn-block" onClick={() => setOpen(false)}>
                Sign in to place bets
              </Link>
            )}
            <button type="button" className="link-btn clear-btn" onClick={clear}>
              Clear slip
            </button>
          </>
        )}
      </aside>
    </>
  );
}
