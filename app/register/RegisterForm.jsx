'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import StatusNote from '../../components/StatusNote';

/** Version of the terms the player accepts; must match what the platform has published. */
const TERMS_VERSION = '1';

const latestBirthDate = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 18);
  return d.toISOString().slice(0, 10);
};

export default function RegisterForm() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [accepted, setAccepted] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k) => String(f.get(k) ?? '').trim();
    setBusy(true);
    setFailure(null);
    const res = await api('/v1/auth/register', {
      method: 'POST',
      body: {
        email: s('email'),
        username: s('username').toLowerCase(),
        password: String(f.get('password') ?? ''),
        legalName: s('legalName'),
        dateOfBirth: s('dateOfBirth'),
        nationality: s('nationality').toUpperCase(),
        address: { line1: s('line1'), city: s('city') },
        country: 'CM',
        jurisdiction: 'CM',
        currency: 'XAF',
        termsVersion: TERMS_VERSION,
        acceptedPrivacyNotice: f.get('privacy') === 'on',
        ageDeclaration: f.get('age') === 'on',
      },
    });
    setBusy(false);
    if (res.ok) setAccepted(true);
    else setFailure(res);
  };

  if (accepted) {
    return (
      <div className="card">
        <p className="strong">Thank you.</p>
        <p>We have received your registration. Check your email for any next steps, then sign in.</p>
        <Link href="/login" className="btn btn-primary btn-block">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" maxLength={254} required />
      </label>
      <label className="field">
        <span>Username</span>
        <input name="username" autoComplete="username" pattern="[A-Za-z][A-Za-z0-9_.]{2,29}" maxLength={30} required />
        <small className="muted">3 to 30 characters: letters, numbers, dot or underscore. Starts with a letter.</small>
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={256} required />
        <small className="muted">At least 10 characters.</small>
      </label>
      <label className="field">
        <span>Full legal name (as on your ID)</span>
        <input name="legalName" autoComplete="name" minLength={2} maxLength={200} required />
      </label>
      <label className="field">
        <span>Date of birth</span>
        <input name="dateOfBirth" type="date" max={latestBirthDate()} required />
      </label>
      <label className="field">
        <span>Nationality (2-letter country code)</span>
        <input name="nationality" defaultValue="CM" pattern="[A-Za-z]{2}" maxLength={2} autoCapitalize="characters" required />
      </label>
      <label className="field">
        <span>Address</span>
        <input name="line1" autoComplete="address-line1" maxLength={200} required />
      </label>
      <label className="field">
        <span>City</span>
        <input name="city" autoComplete="address-level2" maxLength={100} required />
      </label>
      <div className="field">
        <span>Country, currency</span>
        <p className="static">Cameroon, XAF</p>
      </div>
      <label className="check">
        <input type="checkbox" name="terms" required /> I accept the terms and conditions.
      </label>
      <label className="check">
        <input type="checkbox" name="privacy" required /> I have read the privacy notice.
      </label>
      <label className="check">
        <input type="checkbox" name="age" required /> I am 18 or older.
      </label>
      {failure?.status === 503 ? (
        <StatusNote result={failure} />
      ) : failure ? (
        <div className="note note-error" role="alert">
          {describeError(failure.error)}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Please wait...' : 'Create account'}
      </button>
      <p className="muted small center">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
