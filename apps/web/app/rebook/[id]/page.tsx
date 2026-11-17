'use client';

import { use, useEffect, useState } from 'react';
import { api, npr, nptDate } from '@/lib/api';

interface Offer {
  id: string;
  status: string;
  title: string;
  original_start: string;
  refund_deadline: string;
  total_paisa: number;
  ticket_code: string;
  alternatives: { id: string; starts_at: string; seats_left: number }[];
}

/** Weather Promise: choose a free new time or a full refund. */
export default function RebookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [offer, setOffer] = useState<Offer>();
  const [choice, setChoice] = useState<string>();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Offer>(`/rebook/${id}`).then(setOffer).catch((e) => setError(e.message));
  }, [id]);

  async function act(kind: 'accept' | 'refund') {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'accept') {
        const r = await api<{ ticketCode: string }>(`/rebook/${id}/accept`, { method: 'POST', body: JSON.stringify({ slotId: choice }) });
        window.location.href = `/tickets/${r.ticketCode}`;
      } else {
        await api(`/rebook/${id}/refund`, { method: 'POST' });
        setDone(`Refund of ${npr(offer!.total_paisa)} started. It returns to the wallet or card you paid with.`);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !offer) return <div className="wrap center err">{error}</div>;
  if (!offer) return <div className="wrap center muted">Loading…</div>;
  if (done) return <div className="wrap center"><h2>Done</h2><p>{done}</p></div>;
  if (offer.status !== 'offered') return <div className="wrap center"><p>This offer is already {offer.status}.</p></div>;

  return (
    <div className="wrap" style={{ maxWidth: 560, padding: '40px 16px' }}>
      <div className="panel">
        <span className="tag">Weather Promise</span>
        <h2>{offer.title} was cancelled for weather</h2>
        <p className="muted">
          Originally {nptDate(offer.original_start, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.
          Pick a free new time, or take a full refund of {npr(offer.total_paisa)}.
        </p>
        <label>New time (Nepal)</label>
        <div className="times">
          {offer.alternatives.map((s) => (
            <button key={s.id} className={`time ${choice === s.id ? 'on' : ''}`} onClick={() => setChoice(s.id)}>
              {nptDate(s.starts_at, { day: 'numeric', month: 'short' })} {nptDate(s.starts_at, { hour: '2-digit', minute: '2-digit' })}
              <small>{s.seats_left} left</small>
            </button>
          ))}
        </div>
        <button className="btn" disabled={!choice || busy} onClick={() => act('accept')}>Move to this time (free)</button>
        <button className="btn ghost" disabled={busy} onClick={() => act('refund')}>Full refund instead</button>
        <p className="muted" style={{ fontSize: 13 }}>
          No answer by {nptDate(offer.refund_deadline, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} means an automatic refund.
        </p>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}
