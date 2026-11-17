import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { WHATSAPP_NUMBER } from '@/lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: 'TicketGhar — The House of Tickets',
  description: 'Book bungee, zipline, paragliding, rafting and flights in Pokhara. Pay with Khalti or eSewa, ticket on WhatsApp.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Poppins:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              <Logo />
              <span>
                Ticket<b>Ghar</b>
              </span>
            </Link>
            <nav>
              <Link href="/?category=paragliding">Paragliding</Link>
              <Link href="/?category=rafting">Rafting</Link>
              <Link href="/?category=bungee">Bungee</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap">
            TicketGhar · The House of Tickets · Pokhara, Nepal · WhatsApp{' '}
            <span className="mono">{WHATSAPP_NUMBER.replace(/^977/, '')}</span>
          </div>
        </footer>
        <a className="wa" href={`https://wa.me/${WHATSAPP_NUMBER}?text=hi`} target="_blank" rel="noreferrer">
          Book on WhatsApp
        </a>
      </body>
    </html>
  );
}
