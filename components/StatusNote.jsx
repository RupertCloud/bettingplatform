'use client';

import Link from 'next/link';
import { describeError } from '../lib/api';

/** Shows the right message for a failed api() call: sign-in prompt, "not connected", or the error in plain words. */
export default function StatusNote({ result, what = 'this page' }) {
  if (!result || result.ok) return null;
  if (result.status === 401) {
    return (
      <div className="note">
        <p>Please sign in to see {what}.</p>
        <p className="actions">
          <Link href="/login" className="btn btn-primary btn-sm">
            Sign in
          </Link>
          <Link href="/register" className="btn btn-ghost btn-sm">
            Create an account
          </Link>
        </p>
      </div>
    );
  }
  if (result.status === 503 && result.error?.code === 'gateway_not_configured') {
    return (
      <div className="note">
        <p className="strong">Site not connected</p>
        <p>This site is not connected to the betting platform yet. Please come back later.</p>
      </div>
    );
  }
  return (
    <div className="note note-error" role="alert">
      {describeError(result.error)}
    </div>
  );
}
