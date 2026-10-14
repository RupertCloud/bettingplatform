'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, describeError, notifyAuthChange } from '../../lib/api';
import { formatXaf, parseStake } from '../../lib/format.mjs';
import StatusNote from '../../components/StatusNote';
import { useSlip } from '../../components/SlipProvider';

const GROUPS = [
  ['Deposit limits', [['DEPOSIT_DAY', 'Per day'], ['DEPOSIT_WEEK', 'Per week'], ['DEPOSIT_MONTH', 'Per month']]],
  ['Stake limits', [['STAKE_PER_BET', 'Per bet'], ['STAKE_DAY', 'Per day']]],
  ['Loss limits', [['LOSS_DAY', 'Per day'], ['LOSS_WEEK', 'Per week'], ['LOSS_MONTH', 'Per month']]],
];

const TIME_OUTS = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['42d', '6 weeks'],
];
const EXCLUSIONS = [
  ['6m', '6 months'],
  ['1y', '1 year'],
  ['5y', '5 years'],
  ['permanent', 'Permanently'],
];

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Douala' });
const showDate = (iso) => (iso ? date.format(new Date(iso)) : '');

function LimitRow({ kind, label, limit, onChanged }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const send = async (path, method, body) => {
    setBusy(true);
    setMsg(null);
    const res = await api(path, { method, body });
    setBusy(false);
    return res;
  };

  const save = async (value) => {
    const res = await send('/v1/rg/limits', 'PUT', { kind, value });
    if (!res.ok) return setMsg({ ok: false, text: describeError(res.error) });
    setInput('');
    const s = res.data?.status;
    setMsg({
      ok: true,
      text:
        s === 'PENDING'
          ? `Saved. Because this loosens your limit, it waits until ${showDate(res.data.availableAt)}. Come back then to confirm it.`
          : s === 'UNCHANGED'
            ? 'No change.'
            : 'Saved. Your new limit applies now.',
    });
    onChanged();
  };

  const confirm = async () => {
    const res = await send('/v1/rg/limits/confirm', 'POST', { kind });
    if (!res.ok) return setMsg({ ok: false, text: describeError(res.error) });
    setMsg({ ok: true, text: 'Confirmed. Your new limit applies now.' });
    onChanged();
  };

  const stake = parseStake(input);
  const pending = limit?.pending;
  const canConfirm = pending && Date.parse(pending.availableAt) <= Date.now();

  return (
    <li className="limit">
      <div className="row-between">
        <span>{label}</span>
        <span className="strong">{limit?.value ? formatXaf(limit.value) : 'No limit'}</span>
      </div>
      {pending ? (
        <div className="small muted">
          Change to {pending.value ? formatXaf(pending.value) : 'no limit'} {canConfirm ? 'is ready to confirm.' : `from ${showDate(pending.availableAt)}.`}
          {canConfirm ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={confirm}>
              Confirm
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="limit-edit">
        <input
          inputMode="numeric"
          aria-label={`New ${label.toLowerCase()} limit in XAF`}
          placeholder="Amount in XAF"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^\d\s,]/g, ''))}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={!stake || busy} onClick={() => save(stake)}>
          Set
        </button>
        {limit?.value ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => save(null)}>
            Remove
          </button>
        ) : null}
      </div>
      {msg ? <div className={msg.ok ? 'note note-ok small' : 'note note-error small'}>{msg.text}</div> : null}
    </li>
  );
}

function Block({ title, intro, options, path, confirmText, button }) {
  const [period, setPeriod] = useState('');
  const [step, setStep] = useState('choose');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const go = async () => {
    setBusy(true);
    setMsg(null);
    const res = await api(path, { method: 'POST', body: { period } });
    setBusy(false);
    setStep('choose');
    if (!res.ok) return setMsg({ ok: false, text: describeError(res.error) });
    setMsg({ ok: true, text: res.data?.until ? `Done. This lasts until ${showDate(res.data.until)}.` : 'Done. This has no end date.' });
    notifyAuthChange();
  };

  const label = options.find(([v]) => v === period)?.[1];
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="small">{intro}</p>
      {step === 'choose' ? (
        <div className="form">
          <div className="chips">
            {options.map(([v, l]) => (
              <button key={v} type="button" className={period === v ? 'chip active' : 'chip'} aria-pressed={period === v} onClick={() => setPeriod(v)}>
                {l}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-block" disabled={!period} onClick={() => setStep('confirm')}>
            {button}
          </button>
        </div>
      ) : (
        <div className="note note-warn">
          <p>{confirmText(label)}</p>
          <p className="actions">
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={go}>
              {busy ? 'Please wait...' : 'Yes, I am sure'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setStep('choose')}>
              Cancel
            </button>
          </p>
        </div>
      )}
      {msg ? <div className={msg.ok ? 'note note-ok' : 'note note-error'}>{msg.text}</div> : null}
    </section>
  );
}

export default function RgControls() {
  const { signedIn } = useSlip();
  const [res, setRes] = useState(null);
  const load = useCallback(() => api('/v1/rg/limits').then(setRes), []);
  useEffect(() => {
    load();
  }, [load, signedIn]);

  if (!res) return <p className="muted">Loading your limits...</p>;
  if (!res.ok) return <StatusNote result={res} what="and set your limits" />;
  const byKind = Object.fromEntries((res.data.limits ?? []).map((l) => [l.kind, l]));

  return (
    <>
      <section className="card">
        <h2>Your limits</h2>
        <p className="small">Lowering a limit applies at once. Raising or removing one only applies after a waiting period, and you must confirm it.</p>
        {GROUPS.map(([title, rows]) => (
          <div key={title}>
            <h3>{title}</h3>
            <ul className="limits">
              {rows.map(([kind, label]) => (
                <LimitRow key={kind} kind={kind} label={label} limit={byKind[kind]} onChanged={load} />
              ))}
            </ul>
          </div>
        ))}
      </section>

      <Block
        title="Take a time-out"
        intro="Take a short break. You will not be able to bet until the time-out ends, and it cannot be cancelled early."
        options={TIME_OUTS}
        path="/v1/rg/time-out"
        button="Continue"
        confirmText={(l) => `You are about to take a time-out for ${l}. You will not be able to bet until it ends. This cannot be undone.`}
      />

      <Block
        title="Self-exclusion"
        intro="Exclude yourself from betting for a longer period. Your account will be closed for betting for the whole period, and it cannot be reversed early."
        options={EXCLUSIONS}
        path="/v1/rg/self-exclusion"
        button="Continue"
        confirmText={(l) =>
          `You are about to exclude yourself ${l === 'Permanently' ? 'permanently' : `for ${l}`}. You will not be able to bet during this time and cannot reverse it. Are you sure?`
        }
      />
    </>
  );
}
