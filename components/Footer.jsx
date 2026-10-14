import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="footer">
      <p>
        <span className="age-badge" aria-label="18 plus only">
          18+
        </span>{' '}
        Betting is for adults only. Please gamble responsibly.
      </p>
      <p>
        <Link href="/responsible-gambling">Responsible gambling: limits, time-out and self-exclusion</Link>
      </p>
    </footer>
  );
}
