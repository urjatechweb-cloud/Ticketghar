import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="wrap center">
      <h1 style={{ fontSize: 28 }}>Not found</h1>
      <p className="muted">That page or ticket doesn&apos;t exist.</p>
      <Link className="btn" style={{ maxWidth: 280 }} href="/">Back to activities</Link>
    </div>
  );
}
