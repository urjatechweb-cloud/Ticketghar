import { notFound } from 'next/navigation';
import { api, ApiError, npr, nptDate } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Ticket {
  ticket_code: string;
  status: string;
  qty: number;
  total_paisa: number;
  starts_at: string;
  title: string;
  location: string;
  name: string | null;
  qr: string;
}

const STATUS: Record<string, string> = {
  confirmed: 'Valid',
  used: 'Used',
  refunded: 'Refunded',
  refund_due: 'Refund in progress',
};

export default async function TicketPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let t: Ticket;
  try {
    t = await api<Ticket>(`/tickets/${encodeURIComponent(code)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  return (
    <div className="wrap">
      <div className="ticket">
        <div className="head">
          <div className="mono" style={{ fontSize: 12, letterSpacing: '.15em' }}>TICKETGHAR · {STATUS[t.status] ?? t.status}</div>
          <h2>{t.title}</h2>
        </div>
        <div className="body">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={t.qr} alt={`QR code for ticket ${t.ticket_code}`} />
          <div className="code">{t.ticket_code}</div>
        </div>
        <div className="perf" />
        <div className="body">
          <div className="kv"><span>When (Nepal)</span><b>{nptDate(t.starts_at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b></div>
          <div className="kv"><span>Where</span><b>{t.location}</b></div>
          <div className="kv"><span>People</span><b>{t.qty}</b></div>
          {t.name && <div className="kv"><span>Name</span><b>{t.name}</b></div>}
          <div className="kv"><span>Paid</span><b>{npr(t.total_paisa)}</b></div>
          <p className="muted" style={{ fontSize: 13 }}>Show this QR at the operator&apos;s desk. It works offline once this page has loaded.</p>
        </div>
      </div>
    </div>
  );
}
