'use client';

import { useMemo, useState } from 'react';
import { api, Listing, npr, nptDate, Slot } from '@/lib/api';

type Provider = 'khalti' | 'esewa' | 'mock';

type PayResult =
  | { kind: 'redirect'; url: string; paymentId: string }
  | { kind: 'form'; action: string; fields: Record<string, string>; paymentId: string };

const PROVIDERS: { id: Provider; label: string }[] =
  process.env.NEXT_PUBLIC_ENABLE_MOCK_PAYMENTS === 'false'
    ? [{ id: 'khalti', label: 'Khalti' }, { id: 'esewa', label: 'eSewa' }]
    : [{ id: 'khalti', label: 'Khalti' }, { id: 'esewa', label: 'eSewa' }, { id: 'mock', label: 'Test payment' }];

/** eSewa ePay v2 expects a browser form POST with the signed fields. */
function submitForm(action: string, fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export function BookingPanel({ listing, slots }: { listing: Listing; slots: Slot[] }) {
  const open = slots.filter((s) => s.weather_status === 'open');
  const byDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of open) {
      const key = nptDate(s.starts_at, { year: 'numeric', month: '2-digit', day: '2-digit' });
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [open]);

  const [day, setDay] = useState(0);
  const [slotId, setSlotId] = useState<string>();
  const [qty, setQty] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [provider, setProvider] = useState<Provider>(PROVIDERS.at(-1)!.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const chosen = open.find((s) => s.id === slotId);
  const maxQty = Math.min(10, chosen?.seats_left ?? 10);

  async function book() {
    if (!slotId) return setError('Choose a time first.');
    if (!/^\+?\d[\d\s-]{7,16}$/.test(phone)) return setError('Enter a valid mobile number, e.g. 98XXXXXXXX.');
    setBusy(true);
    setError(undefined);
    try {
      const hold = await api<{ bookingId: string }>('/holds', {
        method: 'POST',
        body: JSON.stringify({ slotId, qty, phone, name: name || undefined, channel: 'web' }),
      });
      const pay = await api<PayResult>(`/bookings/${hold.bookingId}/pay`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      });
      if (pay.kind === 'form') submitForm(pay.action, pay.fields);
      else window.location.href = pay.url;
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  if (!open.length) {
    return (
      <div className="panel">
        <h2>No times open</h2>
        <p className="muted">Message us on WhatsApp and we&apos;ll find you a slot.</p>
      </div>
    );
  }

  const daySlots = byDay[day]?.[1] ?? [];

  return (
    <div className="panel">
      <h2>Book</h2>
      <label>Day</label>
      <div className="days">
        {byDay.map(([key, list], i) => (
          <button key={key} className={`day ${i === day ? 'on' : ''}`} onClick={() => { setDay(i); setSlotId(undefined); }}>
            {nptDate(list[0].starts_at, { weekday: 'short', day: 'numeric', month: 'short' })}
          </button>
        ))}
      </div>
      <label>Time (Nepal)</label>
      <div className="times">
        {daySlots.map((s) => (
          <button
            key={s.id}
            className={`time ${s.id === slotId ? 'on' : ''}`}
            disabled={s.seats_left < 1}
            onClick={() => { setSlotId(s.id); setQty((q) => Math.min(q, s.seats_left)); }}
          >
            {nptDate(s.starts_at, { hour: '2-digit', minute: '2-digit' })}
            <small>{s.seats_left > 0 ? `${s.seats_left} left` : 'full'}</small>
          </button>
        ))}
      </div>

      <label htmlFor="qty">People</label>
      <select id="qty" value={qty} onChange={(e) => setQty(Number(e.target.value))}>
        {Array.from({ length: Math.max(1, maxQty) }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>

      <label htmlFor="name">Your name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />

      <label htmlFor="phone">WhatsApp number (ticket is sent here)</label>
      <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="98XXXXXXXX" autoComplete="tel" />

      <label>Pay with</label>
      <div className="pay-options">
        {PROVIDERS.map((p) => (
          <button key={p.id} className={`pay-opt ${provider === p.id ? 'on' : ''}`} onClick={() => setProvider(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="total">
        <span>Total</span>
        <span>{npr(listing.price_paisa * qty)}</span>
      </div>
      <button className="btn" disabled={busy || !slotId} onClick={book}>
        {busy ? 'Holding your seats…' : 'Hold seats and pay'}
      </button>
      <p className="muted" style={{ fontSize: 13 }}>Seats are held for 10 minutes while you pay.</p>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
