import WalletView from './WalletView';

export const metadata = { title: 'Wallet' };

export default function WalletPage() {
  return (
    <>
      <h1 className="page-title">Wallet</h1>
      <WalletView />
    </>
  );
}
