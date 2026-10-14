import Link from 'next/link';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="narrow center">
      <h1 className="page-title">Page not found</h1>
      <p className="muted">The page you are looking for does not exist or has moved.</p>
      <Link href="/" className="btn btn-primary">
        Back to sports
      </Link>
    </div>
  );
}
