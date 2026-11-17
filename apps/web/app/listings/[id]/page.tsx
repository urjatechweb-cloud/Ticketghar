import { notFound } from 'next/navigation';
import { BookingPanel } from '@/components/BookingPanel';
import { api, ApiError, CATEGORY_LABEL, Listing, npr, Slot } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let listing: Listing;
  let slots: Slot[];
  try {
    [listing, slots] = await Promise.all([api<Listing>(`/listings/${id}`), api<Slot[]>(`/listings/${id}/slots`)]);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const a = listing.attributes ?? {};

  return (
    <div className="wrap detail">
      <div className="panel">
        <span className="tag">{CATEGORY_LABEL[listing.category] ?? listing.category}</span>
        <h1 style={{ fontSize: 32, marginTop: 8 }}>{listing.title}</h1>
        <p className="muted">{listing.location} · run by {listing.operator}</p>
        {listing.verified && <span className="badge">✓ Verified operator — licence, insurance and staff certificates checked</span>}
        <div className="facts">
          <div className="fact"><span>Price</span><strong>{npr(listing.price_paisa)}</strong></div>
          {a.durationMin && <div className="fact"><span>Duration</span><strong>{a.durationMin} min</strong></div>}
          {a.minAge && <div className="fact"><span>Minimum age</span><strong>{a.minAge}+</strong></div>}
          {a.weightKg && <div className="fact"><span>Weight</span><strong>{a.weightKg[0]}–{a.weightKg[1]} kg</strong></div>}
        </div>
        <p>{listing.description}</p>
        <div className="promise">
          <strong>Weather Promise.</strong> If the operator cancels for weather, pick a free new time or get a full
          refund — including our fee.
        </div>
      </div>
      <BookingPanel listing={listing} slots={slots} />
    </div>
  );
}
