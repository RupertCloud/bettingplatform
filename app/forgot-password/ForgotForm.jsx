'use client';

import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import StatusNote from '../../components/StatusNote';

export default function ForgotForm() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    setBusy(true);
    setFailure(null);
    const res = await api('/v1/auth/password-reset/request', { method: 'POST', body: { email } });
    setBusy(false);
    if (res.ok) setSent(true);
    else setFailure(res);
  };

  if (sent) {
    return (
      <div className="card">
        <p>If an account uses that email, we have sent it a link to reset the password.</p>
      </div>
    );
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" maxLength={254} required />
      </label>
      {failure?.status === 503 ? (
        <StatusNote result={failure} />
      ) : failure ? (
        <div className="note note-error" role="alert">
          {describeError(failure.error)}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Please wait...' : 'Send reset link'}
      </button>
    </form>
  );
}
