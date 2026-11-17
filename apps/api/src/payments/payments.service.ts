import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { BookingsService } from '../bookings/bookings.service';
import { NOTIFIER, Notifier } from '../notify/notifier';
import {
  EsewaProvider, InitiateResult, KhaltiProvider, MockProvider, PaymentProvider, ProviderName, VerifyResult,
} from './providers';

export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
export interface ProviderSet {
  khalti: KhaltiProvider;
  esewa: EsewaProvider;
  mock: MockProvider;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly bookings: BookingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: ProviderSet,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  private provider(name: string): PaymentProvider {
    if (name === 'mock' && !this.config.enableMockPayments) throw new BadRequestException('mock payments disabled');
    const p = (this.providers as any)[name] as PaymentProvider | undefined;
    if (!p) throw new BadRequestException(`unknown payment provider ${name}`);
    return p;
  }

  /** Creates a payment for a held booking and returns where to send the customer. */
  async start(bookingId: string, providerName: ProviderName): Promise<InitiateResult & { paymentId: string }> {
    const provider = this.provider(providerName);
    const b = await this.db.one(
      `SELECT b.id, b.status, b.total_paisa, l.title, c.phone, c.name, h.expires_at, h.status AS hold_status
         FROM booking b
         JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id
         JOIN customer c ON c.id = b.customer_id
         LEFT JOIN hold h ON h.id = b.hold_id
        WHERE b.id = $1`,
      [bookingId],
    );
    if (!b) throw new NotFoundException('booking not found');
    if (b.status !== 'pending_payment' || b.hold_status !== 'active') {
      throw new ConflictException(`booking is ${b.status}; start a new hold`);
    }
    const payment = await this.db.one<{ id: string }>(
      `INSERT INTO payment (booking_id, provider, amount_paisa) VALUES ($1, $2, $3) RETURNING id`,
      [bookingId, providerName, b.total_paisa],
    );
    const paymentId = payment!.id;
    const result = await provider.initiate({
      paymentId,
      bookingId,
      amountPaisa: Number(b.total_paisa),
      title: b.title,
      customer: { name: b.name, phone: b.phone },
      returnUrl: `${this.config.publicApiUrl}/payments/${providerName}/return`,
      websiteUrl: this.config.webUrl,
    });
    await this.db.query('UPDATE payment SET provider_ref = $2 WHERE id = $1', [paymentId, result.providerRef]);
    return { ...result, paymentId };
  }

  /**
   * Applies a provider-verified result. Locks the payment row so a browser
   * redirect and a retry can't both confirm; amount must match exactly.
   */
  async applyVerified(provider: ProviderName, v: VerifyResult) {
    const result = await this.applyVerifiedTx(provider, v);
    if (result.newlyPaid) {
      const c = await this.db.one<{ phone: string; title: string }>(
        `SELECT c.phone, l.title FROM booking b JOIN customer c ON c.id = b.customer_id
           JOIN slot s ON s.id = b.slot_id JOIN listing l ON l.id = s.listing_id WHERE b.id = $1`,
        [result.bookingId],
      );
      if (c) {
        const msg = result.status === 'confirmed'
          ? `Payment received. Your ${c.title} ticket: ${this.config.webUrl}/tickets/${result.ticketCode}`
          : `Payment received, but the seats sold out before it arrived. Your full refund is being processed.`;
        await this.notifier.sendText(c.phone, msg).catch(() => undefined);
      }
    }
    const { newlyPaid, ...rest } = result;
    return rest;
  }

  private async applyVerifiedTx(provider: ProviderName, v: VerifyResult): Promise<{
    bookingId: string; status: string; ticketCode: string | null; newlyPaid: boolean;
  }> {
    return this.db.tx(async (client) => {
      const res = await client.query<{ id: string; booking_id: string; amount_paisa: string; status: string }>(
        'SELECT id, booking_id, amount_paisa, status FROM payment WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
        [provider, v.providerRef],
      );
      const p = res.rows[0];
      if (!p) throw new NotFoundException('payment not found');
      if (p.status === 'completed') {
        const b = await client.query('SELECT status, ticket_code FROM booking WHERE id = $1', [p.booking_id]);
        return { bookingId: p.booking_id, status: b.rows[0].status, ticketCode: b.rows[0].ticket_code, newlyPaid: false };
      }
      if (v.status !== 'completed') {
        if (v.status === 'failed') {
          await client.query(`UPDATE payment SET status = 'failed', raw = $2 WHERE id = $1`, [p.id, JSON.stringify(v.raw)]);
        }
        return {
          bookingId: p.booking_id,
          status: v.status === 'failed' ? 'payment_failed' : 'payment_pending',
          ticketCode: null,
          newlyPaid: false,
        };
      }
      if (v.amountPaisa !== Number(p.amount_paisa)) {
        throw new ConflictException(`amount mismatch: expected ${p.amount_paisa}, provider says ${v.amountPaisa}`);
      }
      await client.query(`UPDATE payment SET status = 'completed', raw = $2 WHERE id = $1`, [p.id, JSON.stringify(v.raw)]);
      const confirmed = await this.bookings.confirmPaid(client, p.booking_id, provider);
      return { bookingId: p.booking_id, ...confirmed, newlyPaid: true };
    });
  }

  async khaltiReturn(pidx: string) {
    return this.applyVerified('khalti', await this.providers.khalti.lookup(pidx));
  }

  async esewaReturn(data: string) {
    const decoded = this.providers.esewa.decodeReturn(data);
    const verified = await this.providers.esewa.status(decoded.transaction_uuid, decoded.total_amount);
    return this.applyVerified('esewa', verified);
  }

  async mockComplete(paymentId: string) {
    if (!this.config.enableMockPayments) throw new BadRequestException('mock payments disabled');
    const p = await this.db.one('SELECT amount_paisa FROM payment WHERE id = $1 AND provider = $2', [paymentId, 'mock']);
    if (!p) throw new NotFoundException('payment not found');
    return this.applyVerified('mock', {
      providerRef: paymentId, status: 'completed', amountPaisa: Number(p.amount_paisa), raw: { mock: true },
    });
  }
}
