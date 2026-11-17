import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import * as QRCode from 'qrcode';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { Accounts, LedgerService } from '../ledger/ledger.service';

export type Channel = 'web' | 'app' | 'whatsapp' | 'partner' | 'assistant';

export interface HoldRequest {
  slotId: string;
  qty: number;
  phone: string;
  name?: string;
  channel?: Channel;
}

export interface HoldResult {
  bookingId: string;
  holdExpiresAt: string;
  totalPaisa: number;
  title: string;
  startsAt: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function newTicketCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `TG-${code}`;
}

export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) return `977${digits}`; // Nepali mobile
  if (digits.length < 8 || digits.length > 15) throw new ConflictException('invalid phone number');
  return digits;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Reserves seats for HOLD_MINUTES. A single UPDATE succeeds only if seats
   * remain, so two customers can never hold the same last seat.
   */
  async createHold(req: HoldRequest): Promise<HoldResult> {
    if (!Number.isInteger(req.qty) || req.qty < 1 || req.qty > 20) {
      throw new ConflictException('quantity must be between 1 and 20');
    }
    const phone = normalisePhone(req.phone);
    return this.db.tx(async (client) => {
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customer (phone, name) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET name = coalesce(EXCLUDED.name, customer.name)
         RETURNING id`,
        [phone, req.name ?? null],
      );
      const customerId = customer.rows[0].id;

      const slot = await client.query<{
        price_paisa: string; commission_bps: number; title: string; starts_at: Date;
      }>(
        `UPDATE slot s SET held = s.held + $2
           FROM listing l JOIN vendor v ON v.id = l.vendor_id
          WHERE s.id = $1
            AND l.id = s.listing_id
            AND l.status = 'live' AND v.status = 'active'
            AND s.weather_status = 'open'
            AND s.starts_at > now()
            AND s.held + s.sold + $2 <= s.capacity
        RETURNING l.price_paisa, v.commission_bps, l.title, s.starts_at`,
        [req.slotId, req.qty],
      );
      if (!slot.rowCount) {
        throw new ConflictException('slot is sold out, closed or no longer bookable');
      }
      const { price_paisa, commission_bps, title, starts_at } = slot.rows[0];
      const unit = Number(price_paisa);
      const total = unit * req.qty;
      const { commission } = LedgerService.split(total, commission_bps);

      const hold = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO hold (slot_id, customer_id, qty, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [req.slotId, customerId, req.qty, this.config.holdMinutes],
      );
      const booking = await client.query<{ id: string }>(
        `INSERT INTO booking (customer_id, slot_id, hold_id, qty, unit_price_paisa, total_paisa, commission_paisa, channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [customerId, req.slotId, hold.rows[0].id, req.qty, unit, total, commission, req.channel ?? 'web'],
      );
      return {
        bookingId: booking.rows[0].id,
        holdExpiresAt: hold.rows[0].expires_at.toISOString(),
        totalPaisa: total,
        title,
        startsAt: starts_at.toISOString(),
      };
    });
  }

  /**
   * Marks a booking paid inside the caller's transaction: converts the hold to
   * sold seats, issues the ticket code and writes the balanced sale to the ledger.
   * Idempotent: a second call for a confirmed booking changes nothing.
   */
  async confirmPaid(client: PoolClient, bookingId: string, provider: string): Promise<{ status: string; ticketCode: string | null }> {
    // Lock order is hold -> booking -> slot, the same order the expiry sweeper uses,
    // so a payment and the sweeper can never deadlock.
    const pre = await client.query<{ hold_id: string | null }>('SELECT hold_id FROM booking WHERE id = $1', [bookingId]);
    if (!pre.rowCount) throw new NotFoundException('booking not found');
    const holdId = pre.rows[0].hold_id;
    let holdStatus: string | null = null;
    if (holdId) {
      const h = await client.query<{ status: string }>('SELECT status FROM hold WHERE id = $1 FOR UPDATE', [holdId]);
      holdStatus = h.rows[0]?.status ?? null;
    }
    const res = await client.query<{
      status: string; ticket_code: string | null; qty: number; slot_id: string; hold_id: string | null;
      hold_status: string | null; total_paisa: string; commission_paisa: string; vendor_id: string;
    }>(
      `SELECT b.status, b.ticket_code, b.qty, b.slot_id, b.hold_id, NULL::text AS hold_status,
              b.total_paisa, b.commission_paisa, l.vendor_id
         FROM booking b
         JOIN slot s ON s.id = b.slot_id
         JOIN listing l ON l.id = s.listing_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [bookingId],
    );
    const b = res.rows[0];
    if (!b) throw new NotFoundException('booking not found');
    b.hold_status = holdStatus;
    if (['confirmed', 'used', 'refund_due', 'refunded', 'rebooked'].includes(b.status)) {
      return { status: b.status, ticketCode: b.ticket_code };
    }

    const total = Number(b.total_paisa);
    const commission = Number(b.commission_paisa);
    // Money arrived either way, so record it before deciding about seats.
    await this.ledger.post(client, 'sale', [
      { account: Accounts.clearing(provider), debit: total },
      { account: Accounts.vendorPayable(b.vendor_id), credit: total - commission },
      { account: Accounts.commission, credit: commission },
    ], { bookingId, memo: 'ticket sale' });

    let seated = false;
    if (b.hold_status === 'active') {
      await client.query('UPDATE slot SET held = held - $2, sold = sold + $2 WHERE id = $1', [b.slot_id, b.qty]);
      await client.query(`UPDATE hold SET status = 'converted' WHERE id = $1`, [b.hold_id]);
      seated = true;
    } else {
      // Paid after the hold expired: seat them only if seats are still free.
      const late = await client.query(
        `UPDATE slot SET sold = sold + $2
          WHERE id = $1 AND weather_status = 'open' AND held + sold + $2 <= capacity`,
        [b.slot_id, b.qty],
      );
      seated = (late.rowCount ?? 0) > 0;
    }

    if (!seated) {
      await client.query(`UPDATE booking SET status = 'refund_due', updated_at = now() WHERE id = $1`, [bookingId]);
      return { status: 'refund_due', ticketCode: null };
    }
    const code = newTicketCode();
    await client.query(
      `UPDATE booking SET status = 'confirmed', ticket_code = $2, updated_at = now() WHERE id = $1`,
      [bookingId, code],
    );
    return { status: 'confirmed', ticketCode: code };
  }

  /** Releases seats from unpaid holds past their expiry. Safe to run concurrently. */
  async releaseExpiredHolds(): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `WITH expired AS (
         UPDATE hold SET status = 'expired'
          WHERE status = 'active' AND expires_at < now()
        RETURNING id, slot_id, qty
       ), seats AS (
         UPDATE slot s SET held = s.held - e.total
           FROM (SELECT slot_id, sum(qty)::int AS total FROM expired GROUP BY slot_id) e
          WHERE s.id = e.slot_id
       ), bookings AS (
         UPDATE booking SET status = 'expired', updated_at = now()
          WHERE hold_id IN (SELECT id FROM expired) AND status = 'pending_payment'
       )
       SELECT count(*) AS n FROM expired`,
    );
    return Number(row?.n ?? 0);
  }

  async getBooking(id: string) {
    const b = await this.db.one(
      `SELECT b.id, b.status, b.qty, b.total_paisa, b.ticket_code, b.channel, b.created_at,
              s.starts_at, l.title, l.location, l.category, c.phone, c.name,
              h.expires_at AS hold_expires_at
         FROM booking b
         JOIN slot s ON s.id = b.slot_id
         JOIN listing l ON l.id = s.listing_id
         JOIN customer c ON c.id = b.customer_id
         LEFT JOIN hold h ON h.id = b.hold_id
        WHERE b.id = $1`,
      [id],
    );
    if (!b) throw new NotFoundException('booking not found');
    return { ...b, total_paisa: Number(b.total_paisa) };
  }

  async getTicket(code: string) {
    const t = await this.db.one(
      `SELECT b.ticket_code, b.status, b.qty, b.total_paisa, s.starts_at, l.title, l.location,
              l.attributes, c.name
         FROM booking b
         JOIN slot s ON s.id = b.slot_id
         JOIN listing l ON l.id = s.listing_id
         JOIN customer c ON c.id = b.customer_id
        WHERE b.ticket_code = $1`,
      [code],
    );
    if (!t) throw new NotFoundException('ticket not found');
    const qr = await QRCode.toDataURL(`${this.config.webUrl}/tickets/${t.ticket_code}`, { margin: 1, width: 320 });
    return { ...t, total_paisa: Number(t.total_paisa), qr };
  }

  /**
   * Operator scans the QR at the gate. Marks the ticket used and awards
   * Ghar Points (1 point per Rs 100), valid for 12 months.
   */
  async redeem(code: string, vendorId: string) {
    return this.db.tx(async (client) => {
      const res = await client.query<{ id: string; status: string; customer_id: string; total_paisa: string }>(
        `SELECT b.id, b.status, b.customer_id, b.total_paisa
           FROM booking b JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id
          WHERE b.ticket_code = $1 AND l.vendor_id = $2
          FOR UPDATE OF b`,
        [code, vendorId],
      );
      const b = res.rows[0];
      if (!b) throw new NotFoundException('ticket not found for this operator');
      if (b.status === 'used') throw new ConflictException('ticket already used');
      if (b.status !== 'confirmed') throw new ConflictException(`ticket is ${b.status}`);
      await client.query(`UPDATE booking SET status = 'used', updated_at = now() WHERE id = $1`, [b.id]);
      const points = Math.floor(Number(b.total_paisa) / 10_000);
      if (points > 0) {
        await client.query(
          `INSERT INTO points_entry (customer_id, booking_id, points, reason, expires_at)
           VALUES ($1, $2, $3, 'completed_trip', now() + interval '12 months')
           ON CONFLICT (booking_id, reason) DO NOTHING`,
          [b.customer_id, b.id, points],
        );
      }
      return { status: 'used', pointsAwarded: points };
    });
  }
}
