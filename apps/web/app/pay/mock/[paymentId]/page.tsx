'use client';

import { use, useState } from 'react';
import { api } from '@/lib/api';

/** Development-only stand-in for the Khalti/eSewa payment page. */
export default function MockPay({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = use(params);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function pay() {
    setBusy(true);
    try {
      const r = await api<{ bookingId: string; status: string; ticketCode: string | null }>(
        `/payments/mock/${paymentId}/complete`,
        { method: 'POST' },
      );
      window.location.href = r.ticketCode ? `/tickets/${r.ticketCode}` : `/bookings/${r.bookingId}`;
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="wrap center">
      <div className="panel" style={{ maxWidth: 420, margin: '0 auto' }}>
        <span className="tag">Test mode</span>
        <h2>Test payment</h2>
        <p className="muted">No money moves. This page stands in for Khalti or eSewa during development.</p>
        <button className="btn" onClick={pay} disabled={busy}>{busy ? 'Paying…' : 'Pay now (test)'}</button>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}
