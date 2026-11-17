import Link from 'next/link';
import { api, CATEGORY_LABEL, Listing, npr, nptDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const active = category && CATEGORY_LABEL[category] ? category : undefined;
  let listings: Listing[] = [];
  let failed = false;
  try {
    listings = await api<Listing[]>(`/listings${active ? `?category=${active}` : ''}`);
  } catch {
    failed = true;
  }

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="kicker">The House of Tickets · Pokhara</div>
          <h1>Pokhara adventures, booked in minutes.</h1>
          <p>
            Bungee, zipline, paragliding and rafting from verified operators. Pay with Khalti or eSewa and get your
            ticket on WhatsApp. If weather cancels your slot, rebook free or get a full refund.
          </p>
          <div className="chips">
            <Link href="/" className={`chip ${!active ? 'active' : ''}`}>All</Link>
            {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
              <Link key={key} href={`/?category=${key}`} className={`chip ${active === key ? 'active' : ''}`}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="wrap">
        {failed && <p className="center err">We can&apos;t reach the booking service right now. Please try again shortly.</p>}
        {!failed && listings.length === 0 && <p className="center muted">Nothing open in this category right now.</p>}
        <div className="grid">
          {listings.map((l) => (
            <Link key={l.id} href={`/listings/${l.id}`} className="card">
              <span className="tag">{CATEGORY_LABEL[l.category] ?? l.category}</span>
              <h3>{l.title}</h3>
              <span className="muted">{l.location} · {l.operator}</span>
              <span className="badge">✓ Verified operator</span>
              <div className="row">
                <div>
                  <div className="price">{npr(l.price_paisa)}</div>
                  <small className="muted">per person</small>
                </div>
                {l.next_available && (
                  <small className="mono muted">
                    Next: {nptDate(l.next_available, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </small>
                )}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
