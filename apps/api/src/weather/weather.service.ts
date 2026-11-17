import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { Accounts, LedgerService } from '../ledger/ledger.service';
import { NOTIFIER, Notifier } from '../notify/notifier';

/**
 * Weather Promise: when an operator cancels a slot for weather, every
 * confirmed customer gets a free rebooking offer; if they decline, or don't
 * answer within 24 hours, the whole amount (TicketGhar's commission included)
 * is refunded.
 */
@Injectable()
export class WeatherService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async cancelSlot(slotId: string, vendorId: string) {
    const offers = await this.db.tx(async (client) => {
      const slot = await client.query(
        `UPDATE slot s SET weather_status = 'cancelled'
           FROM listing l
          WHERE s.id = $1 AND l.id = s.listing_id AND l.vendor_id = $2 AND s.weather_status = 'open'
        RETURNING s.id`,
        [slotId, vendorId],
      );
      if (!slot.rowCount) throw new NotFoundException('open slot not found for this operator');
      const res = await client.query<{ offer_id: string; phone: string; title: string; booking_id: string }>(
        `WITH offers AS (
           INSERT INTO rebook_offer (booking_id, refund_deadline)
           SELECT b.id, now() + interval '24 hours' FROM booking b
            WHERE b.slot_id = $1 AND b.status = 'confirmed'
           ON CONFLICT (booking_id) DO NOTHING
           RETURNING id, booking_id
         )
         SELECT o.id AS offer_id, o.booking_id, c.phone, l.title
           FROM offers o
           JOIN booking b ON b.id = o.booking_id
           JOIN customer c ON c.id = b.customer_id
           JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id`,
        [slotId],
      );
      return res.rows;
    });
    for (const o of offers) {
      await this.notifier.sendText(
        o.phone,
        `Your ${o.title} was cancelled by the operator because of weather. Pick a free new time or take a ` +
          `full refund: ${this.config.webUrl}/rebook/${o.offer_id}. If we don't hear back in 24 hours we refund you automatically.`,
      );
    }
    return { cancelledSlot: slotId, offers: offers.map((o) => o.offer_id) };
  }

  async getOffer(offerId: string) {
    const o = await this.db.one(
      `SELECT r.id, r.status, r.refund_deadline, b.id AS booking_id, b.qty, b.total_paisa, b.ticket_code,
              l.id AS listing_id, l.title, s.starts_at AS original_start
         FROM rebook_offer r
         JOIN booking b ON b.id = r.booking_id
         JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id
        WHERE r.id = $1`,
      [offerId],
    );
    if (!o) throw new NotFoundException('offer not found');
    const alternatives = await this.db.query(
      `SELECT id, starts_at, capacity - held - sold AS seats_left FROM slot
        WHERE listing_id = $1 AND weather_status = 'open' AND starts_at > now()
          AND capacity - held - sold >= $2
        ORDER BY starts_at LIMIT 10`,
      [o.listing_id, o.qty],
    );
    return { ...o, total_paisa: Number(o.total_paisa), alternatives };
  }

  /** Moves the booking to a new slot of the same listing at no charge. Ticket code stays the same. */
  async accept(offerId: string, newSlotId: string) {
    return this.db.tx(async (client) => {
      const { booking } = await this.lockOffer(client, offerId);
      const moved = await client.query(
        `UPDATE slot s SET sold = s.sold + $2
           FROM slot old
          WHERE s.id = $1 AND old.id = $3 AND s.listing_id = old.listing_id
            AND s.weather_status = 'open' AND s.starts_at > now()
            AND s.held + s.sold + $2 <= s.capacity
        RETURNING s.id`,
        [newSlotId, booking.qty, booking.slot_id],
      );
      if (!moved.rowCount) throw new ConflictException('that time is full or not available');
      await client.query('UPDATE slot SET sold = sold - $2 WHERE id = $1', [booking.slot_id, booking.qty]);
      await client.query(`UPDATE booking SET slot_id = $2, updated_at = now() WHERE id = $1`, [booking.id, newSlotId]);
      await client.query(`UPDATE rebook_offer SET status = 'accepted' WHERE id = $1`, [offerId]);
      return { status: 'rebooked', ticketCode: booking.ticket_code };
    });
  }

  async decline(offerId: string) {
    return this.db.tx(async (client) => {
      const { booking } = await this.lockOffer(client, offerId);
      await client.query('UPDATE slot SET sold = sold - $2 WHERE id = $1', [booking.slot_id, booking.qty]);
      await this.refundBooking(client, booking.id, 'weather cancellation');
      await client.query(`UPDATE rebook_offer SET status = 'refunded' WHERE id = $1`, [offerId]);
      return { status: 'refunded', amountPaisa: Number(booking.total_paisa) };
    });
  }

  /** Hourly job: refunds every offer nobody answered within 24 hours. */
  async refundUnanswered(): Promise<number> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM rebook_offer WHERE status = 'offered' AND refund_deadline < now()`,
    );
    for (const o of due) await this.decline(o.id).catch(() => undefined);
    return due.length;
  }

  /**
   * Reverses a sale in the ledger: vendor share and commission move to
   * refunds_payable, which finance pays back through the original provider.
   */
  async refundBooking(client: PoolClient, bookingId: string, memo: string) {
    const res = await client.query<{ total_paisa: string; commission_paisa: string; vendor_id: string; status: string }>(
      `SELECT b.total_paisa, b.commission_paisa, b.status, l.vendor_id
         FROM booking b JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId],
    );
    const b = res.rows[0];
    if (!b) throw new NotFoundException('booking not found');
    if (!['confirmed', 'refund_due'].includes(b.status)) throw new ConflictException(`cannot refund a ${b.status} booking`);
    const total = Number(b.total_paisa);
    const commission = Number(b.commission_paisa);
    await this.ledger.post(client, 'refund', [
      { account: Accounts.vendorPayable(b.vendor_id), debit: total - commission },
      { account: Accounts.commission, debit: commission },
      { account: Accounts.refundsPayable, credit: total },
    ], { bookingId, memo });
    await client.query(`UPDATE booking SET status = 'refunded', updated_at = now() WHERE id = $1`, [bookingId]);
  }

  private async lockOffer(client: PoolClient, offerId: string) {
    const res = await client.query<{ status: string; booking_id: string }>(
      'SELECT status, booking_id FROM rebook_offer WHERE id = $1 FOR UPDATE',
      [offerId],
    );
    const offer = res.rows[0];
    if (!offer) throw new NotFoundException('offer not found');
    if (offer.status !== 'offered') throw new ConflictException(`offer already ${offer.status}`);
    const b = await client.query<{ id: string; qty: number; slot_id: string; ticket_code: string; total_paisa: string }>(
      `SELECT id, qty, slot_id, ticket_code, total_paisa FROM booking WHERE id = $1 AND status = 'confirmed' FOR UPDATE`,
      [offer.booking_id],
    );
    if (!b.rowCount) throw new ConflictException('booking is no longer confirmed');
    return { offer, booking: b.rows[0] };
  }
}
