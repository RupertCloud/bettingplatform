'use client';

import Link from 'next/link';

export default function ErrorPage({ reset }) {
  return (
    <div className="narrow center">
      <h1 className="page-title">Something went wrong</h1>
      <p className="muted">Sorry, this page could not be shown. Please try again.</p>
      <p className="actions center-row">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <Link href="/" className="btn btn-ghost">
          Back to sports
        </Link>
      </p>
    </div>
  );
}
