'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, notifyAuthChange } from '../lib/api';
import { useSlip } from './SlipProvider';

const NAV = [
  ['/', 'Sports'],
  ['/bets', 'My bets'],
  ['/wallet', 'Wallet'],
];

export default function Header() {
  const { items, setOpen, signedIn } = useSlip();
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await api('/v1/auth/logout', { method: 'POST' });
    notifyAuthChange();
    router.push('/');
    router.refresh();
  };

  return (
    <header className="header">
      <div className="header-row">
        <Link href="/" className="brand">
          Betting Platform
        </Link>
        <div className="header-actions">
          {signedIn ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
              Log out
            </button>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost btn-sm">
                Sign in
              </Link>
              <Link href="/register" className="btn btn-primary btn-sm">
                Join
              </Link>
            </>
          )}
        </div>
      </div>
      <nav className="nav" aria-label="Main">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} className={pathname === href ? 'nav-link active' : 'nav-link'}>
            {label}
          </Link>
        ))}
        <button type="button" className="nav-link slip-toggle" onClick={() => setOpen(true)}>
          Bet slip{items.length ? <span className="badge">{items.length}</span> : null}
        </button>
      </nav>
    </header>
  );
}
