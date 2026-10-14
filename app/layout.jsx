import './globals.css';
import BetSlip from '../components/BetSlip';
import Footer from '../components/Footer';
import Header from '../components/Header';
import { SlipProvider } from '../components/SlipProvider';

const description = 'Sports betting in XAF for Cameroon. Football and more, singles and accumulators. 18+ only. Please gamble responsibly.';

export const metadata = {
  title: { default: 'Betting Platform', template: '%s | Betting Platform' },
  description,
  openGraph: {
    type: 'website',
    siteName: 'Betting Platform',
    title: 'Betting Platform',
    description,
    locale: 'en_CM',
  },
  robots: { index: true, follow: true },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <SlipProvider>
          <Header />
          <main className="main">{children}</main>
          <Footer />
          <BetSlip />
        </SlipProvider>
      </body>
    </html>
  );
}
