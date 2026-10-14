'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, describeError, newRequestId } from '../../lib/api';
import { formatXaf, parseStake } from '../../lib/format.mjs';
import StatusNote from '../../components/StatusNote';
import { useSlip } from '../../components/SlipProvider';

const DEMO_MIN = 100n;
const DEMO_MAX = 1_000_000n;

export default function WalletView() {
  const { signedIn } = useSlip();
  const [balances, setBalances] = useState(null);
  const [config, setConfig] = useState(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(() => api('/v1/wallet/balances?currency=XAF').then(setBalances), []);

  useEffect(() => {
    load();
    api('/v1/config').then(setConfig);
  }, [load, signedIn]);

  const value = parseStake(amount);
  const valid = value !== null && BigInt(value) >= DEMO_MIN && BigInt(value) <= DEMO_MAX;

  const deposit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setMessage(null);
    const res = await api('/v1/demo/deposit', { method: 'POST', body: { amount: value, requestId: newRequestId() } });
    setBusy(false);
    if (res.ok) {
      setMessage({ ok: true, text: `Added ${formatXaf(value)} of demo money. New balance: ${formatXaf(res.data?.balance)}.` });
      setAmount('');
      load();
    } else {
      setMessage({ ok: false, text: describeError(res.error) });
    }
  };

  if (!balances) return <p className="muted">Loading your wallet...</p>;
  if (!balances.ok) return <StatusNote result={balances} what="your wallet" />;
  const b = balances.data.balances ?? {};
  const demo = config?.ok && config.data?.demo === true;

  return (
    <>
      <div className="card">
        <div className="muted small">Cash balance</div>
        <div className="balance">{formatXaf(b.CASH)}</div>
        {b.BONUS && b.BONUS !== '0' ? (
          <div className="row-between">
            <span className="muted">Bonus</span>
            <span>{formatXaf(b.BONUS)}</span>
          </div>
        ) : null}
        {b.PENDING_WITHDRAWAL && b.PENDING_WITHDRAWAL !== '0' ? (
          <div className="row-between">
            <span className="muted">Pending withdrawal</span>
            <span>{formatXaf(b.PENDING_WITHDRAWAL)}</span>
          </div>
        ) : null}
      </div>

      {demo ? (
        <form className="card form demo" onSubmit={deposit}>
          <h2>
            Add demo money <span className="demo-tag">DEMO</span>
          </h2>
          <p className="small">
            This is a demo site. Demo money is not real money: it cannot be withdrawn and has no cash value.
          </p>
          <label className="field">
            <span>Amount (XAF, 100 to 1,000,000)</span>
            <input inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d\s,]/g, ''))} />
          </label>
          {message ? (
            <div className={message.ok ? 'note note-ok' : 'note note-error'} role="status">
              {message.text}
            </div>
          ) : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={!valid || busy}>
            {busy ? 'Adding...' : 'Add demo money'}
          </button>
        </form>
      ) : null}
    </>
  );
}
