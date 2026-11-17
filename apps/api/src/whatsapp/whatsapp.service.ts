import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { BookingsService } from '../bookings/bookings.service';
import { CatalogService, CATEGORIES } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { NOTIFIER, Notifier } from '../notify/notifier';

type State =
  | { step?: undefined }
  | { step: 'category' }
  | { step: 'listing'; listings: string[] }
  | { step: 'slot'; listingId: string; slots: string[] }
  | { step: 'qty'; slotId: string }
  | { step: 'pay'; bookingId: string };

export interface InboundMessage {
  id: string;
  from: string;      // customer WhatsApp ID (phone, digits only)
  name?: string;
  text: string;
}

const npr = (paisa: number) => `Rs ${(paisa / 100).toLocaleString('en-IN')}`;
const when = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', {
    timeZone: 'Asia/Kathmandu', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

/**
 * Phase 0 WhatsApp booking flow: a guided menu (category -> activity -> time
 * -> people -> payment link). Every price comes from the booking engine, never
 * from free text. The AI concierge replaces the menu in phase 1 behind the
 * same handle() entry point.
 */
@Injectable()
export class WhatsAppService {
  private readonly log = new Logger('WhatsAppFlow');

  constructor(
    private readonly db: DbService,
    private readonly catalog: CatalogService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Meta signs each webhook body with the app secret: header X-Hub-Signature-256 = "sha256=<hex>". */
  verifySignature(rawBody: Buffer | string, header: string | undefined): boolean {
    if (!header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', this.config.whatsapp.appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(header.slice(7));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Pulls text and interactive replies out of a Cloud API webhook payload. */
  static parse(payload: any): InboundMessage[] {
    const out: InboundMessage[] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const names = new Map<string, string>(
          (value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]),
        );
        for (const m of value.messages ?? []) {
          const text = m.type === 'text' ? m.text?.body
            : m.type === 'interactive' ? (m.interactive?.list_reply?.id ?? m.interactive?.button_reply?.id)
            : undefined;
          if (m.id && m.from && typeof text === 'string') {
            out.push({ id: m.id, from: m.from, name: names.get(m.from), text: text.trim() });
          }
        }
      }
    }
    return out;
  }

  async handleWebhook(payload: any) {
    for (const msg of WhatsAppService.parse(payload)) {
      const fresh = await this.db.one(
        'INSERT INTO wa_inbound (message_id, wa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING message_id',
        [msg.id, msg.from],
      );
      if (!fresh) continue; // Meta retries deliveries; handle each message once.
      try {
        await this.handle(msg);
      } catch (err) {
        this.log.error(err);
        await this.notifier.sendText(msg.from, 'Sorry, something went wrong. A TicketGhar person will reply shortly.');
      }
    }
  }

  async handle(msg: InboundMessage): Promise<void> {
    const state = await this.getState(msg.from);
    const text = msg.text.toLowerCase();
    const n = Number.parseInt(text, 10);

    if (['hi', 'hello', 'namaste', 'menu', 'start', 'book'].includes(text) || !state.step) {
      return this.showCategories(msg.from);
    }

    switch (state.step) {
      case 'category': {
        const category = CATEGORIES.at(n - 1);
        if (!category) return this.showCategories(msg.from, 'Please reply with a number from the list.');
        const listings = (await this.catalog.list(category)).slice(0, 5);
        if (!listings.length) return this.showCategories(msg.from, `No ${category} is open right now. Pick another:`);
        await this.setState(msg.from, { step: 'listing', listings: listings.map((l) => l.id) });
        const lines = listings.map((l, i) => `${i + 1}. ${l.title} (${l.operator}) - ${npr(l.price_paisa)}`);
        return this.notifier.sendText(msg.from, `${lines.join('\n')}\n\nReply with a number.`);
      }
      case 'listing': {
        const listingId = state.listings.at(n - 1);
        if (!listingId) return this.notifier.sendText(msg.from, 'Please reply with a number from the list.');
        const slots = (await this.catalog.slots(listingId, 7)).filter((s: any) => s.weather_status === 'open' && s.seats_left > 0).slice(0, 6);
        if (!slots.length) return this.notifier.sendText(msg.from, 'No free times in the next 7 days. Reply "menu" to choose something else.');
        await this.setState(msg.from, { step: 'slot', listingId, slots: slots.map((s: any) => s.id) });
        const lines = slots.map((s: any, i: number) => `${i + 1}. ${when(s.starts_at)} - ${s.seats_left} left`);
        return this.notifier.sendText(msg.from, `Available times (Nepal time):\n${lines.join('\n')}\n\nReply with a number.`);
      }
      case 'slot': {
        const slotId = state.slots.at(n - 1);
        if (!slotId) return this.notifier.sendText(msg.from, 'Please reply with a number from the list.');
        await this.setState(msg.from, { step: 'qty', slotId });
        return this.notifier.sendText(msg.from, 'How many people? Reply 1 to 10.');
      }
      case 'qty': {
        if (!Number.isInteger(n) || n < 1 || n > 10) return this.notifier.sendText(msg.from, 'Please reply with a number from 1 to 10.');
        try {
          const hold = await this.bookings.createHold({
            slotId: state.slotId, qty: n, phone: msg.from, name: msg.name, channel: 'whatsapp',
          });
          const provider = this.config.khalti.secretKey ? 'khalti' : 'mock';
          const pay = await this.payments.start(hold.bookingId, provider);
          await this.setState(msg.from, { step: 'pay', bookingId: hold.bookingId });
          const link = pay.kind === 'redirect' ? pay.url : `${this.config.webUrl}/bookings/${hold.bookingId}`;
          return this.notifier.sendText(
            msg.from,
            `${hold.title}, ${when(hold.startsAt)}, ${n} ${n === 1 ? 'person' : 'people'}: ${npr(hold.totalPaisa)}.\n` +
              `Seats held for ${this.config.holdMinutes} minutes. Pay here: ${link}`,
          );
        } catch (err: any) {
          await this.setState(msg.from, { step: 'category' });
          return this.notifier.sendText(msg.from, `That time just filled up (${err?.message ?? 'unavailable'}). Reply "menu" to try another.`);
        }
      }
      case 'pay': {
        const b = await this.bookings.getBooking(state.bookingId);
        const status = b.status === 'confirmed' ? `confirmed. Ticket: ${this.config.webUrl}/tickets/${b.ticket_code}`
          : b.status === 'pending_payment' ? 'waiting for payment' : b.status.replace('_', ' ');
        return this.notifier.sendText(msg.from, `Your booking is ${status}. Reply "menu" for a new booking.`);
      }
    }
  }

  private async showCategories(to: string, prefix = 'Namaste! What would you like to book in Pokhara?') {
    await this.setState(to, { step: 'category' });
    const lines = CATEGORIES.map((c, i) => `${i + 1}. ${c[0].toUpperCase()}${c.slice(1)}`);
    await this.notifier.sendText(to, `${prefix}\n${lines.join('\n')}\n\nReply with a number.`);
  }

  private async getState(waId: string): Promise<State> {
    const row = await this.db.one<{ state: State }>('SELECT state FROM wa_session WHERE wa_id = $1', [waId]);
    return row?.state ?? {};
  }

  private async setState(waId: string, state: State) {
    await this.db.query(
      `INSERT INTO wa_session (wa_id, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (wa_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [waId, JSON.stringify(state)],
    );
  }
}
