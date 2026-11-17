import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { api, ApiError, npr } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Booking {
  id: string;
  status: string;
  title: string;
  total_paisa: number;
  ticket_code: string | null;
}

const MESSAGES: Record<string, string> = {
  payment_failed: 'The payment did not go through. Your card or wallet was not charged.',
  payment_pending: 'Your payment is still being processed. We will send the ticket on WhatsApp as soon as it clears.',
  refund_due: 'Your payment arrived after the last seats sold. A full refund is on its way.',
};

export default async function BookingPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { id } = await params;
  const { payment } = await searchParams;
  let b: Booking;
  try {
    b = await api<Booking>(`/bookings/${id}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  if (b.ticket_code && ['confirmed', 'used'].includes(b.status)) redirect(`/tickets/${b.ticket_code}`);

  const msg = MESSAGES[payment ?? ''] ?? MESSAGES[b.status]
    ?? (b.status === 'expired' ? 'This hold expired before payment. Please choose a time again.' : `Booking status: ${b.status.replace('_', ' ')}.`);

  return (
    <div className="wrap center">
      <h1 style={{ fontSize: 28 }}>{b.title}</h1>
      <p className="mono">{npr(b.total_paisa)}</p>
      <p>{msg}</p>
      <Link className="btn" style={{ maxWidth: 280 }} href="/">Back to activities</Link>
    </div>
  );
}
