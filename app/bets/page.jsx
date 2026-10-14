import BetsList from './BetsList';

export const metadata = { title: 'My bets' };

export default function BetsPage() {
  return (
    <>
      <h1 className="page-title">My bets</h1>
      <BetsList />
    </>
  );
}
