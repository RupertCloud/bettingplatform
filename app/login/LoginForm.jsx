'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, describeError, notifyAuthChange } from '../../lib/api';
import StatusNote from '../../components/StatusNote';

export default function LoginForm() {
  const router = useRouter();
  const [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  const done = () => {
    notifyAuthChange();
    router.push('/');
    router.refresh();
  };

  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFailure(null);
    const res = challenge
      ? await api('/v1/auth/mfa/verify', { method: 'POST', body: { challenge, code: String(f.get('code')).trim() } })
      : await api('/v1/auth/login', { method: 'POST', body: { identifier: String(f.get('identifier')).trim(), password: String(f.get('password')) } });
    setBusy(false);
    if (!res.ok) {
      // A failed login is not a "please sign in" case; show the reason instead.
      setFailure(res.status === 401 ? { ...res, status: 400 } : res);
      return;
    }
    if (res.data?.status === 'mfa_required' && res.data.challenge) {
      setChallenge(res.data.challenge);
      return;
    }
    done();
  };

  return (
    <form className="card form" onSubmit={submit}>
      {challenge ? (
        <label className="field">
          <span>6-digit code from your authenticator app</span>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
        </label>
      ) : (
        <>
          <label className="field">
            <span>Email, username or phone</span>
            <input name="identifier" autoComplete="username" maxLength={254} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" maxLength={256} required />
          </label>
        </>
      )}
      {failure?.status === 503 ? <StatusNote result={failure} /> : failure ? <div className="note note-error" role="alert">{describeError(failure.error)}</div> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Please wait...' : challenge ? 'Verify' : 'Sign in'}
      </button>
      <p className="muted small center">
        <Link href="/forgot-password">Forgot your password?</Link> · <Link href="/register">Create an account</Link>
      </p>
    </form>
  );
}
