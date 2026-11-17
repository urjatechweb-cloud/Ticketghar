import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';

export const CATEGORIES = ['bungee', 'zipline', 'paragliding', 'rafting', 'ultralight', 'boating'] as const;

@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService) {}

  /** Bookable listings: live listing, active (fully verified) operator. */
  async list(category?: string) {
    const rows = await this.db.query(
      `SELECT l.id, l.category, l.title, l.location, l.description, l.price_paisa, l.attributes,
              v.name AS operator,
              (SELECT min(s.starts_at) FROM slot s
                WHERE s.listing_id = l.id AND s.weather_status = 'open' AND s.starts_at > now()
                  AND s.capacity - s.held - s.sold > 0) AS next_available
         FROM listing l JOIN vendor v ON v.id = l.vendor_id
        WHERE l.status = 'live' AND v.status = 'active' AND ($1::text IS NULL OR l.category = $1)
        ORDER BY l.category, l.price_paisa`,
      [category ?? null],
    );
    return rows.map((r) => ({ ...r, price_paisa: Number(r.price_paisa) }));
  }

  async get(id: string) {
    const l = await this.db.one(
      `SELECT l.id, l.category, l.title, l.location, l.description, l.price_paisa, l.attributes,
              l.weather_dependent, l.status, v.name AS operator, v.status AS operator_status
         FROM listing l JOIN vendor v ON v.id = l.vendor_id WHERE l.id = $1`,
      [id],
    );
    if (!l) throw new NotFoundException('listing not found');
    return { ...l, price_paisa: Number(l.price_paisa), verified: l.operator_status === 'active' };
  }

  async slots(listingId: string, days = 14) {
    return this.db.query(
      `SELECT id, starts_at, capacity - held - sold AS seats_left, weather_status
         FROM slot
        WHERE listing_id = $1 AND starts_at > now() AND starts_at < now() + make_interval(days => $2)
        ORDER BY starts_at`,
      [listingId, days],
    );
  }

  // ---- admin -------------------------------------------------------------

  async createVendor(v: { name: string; phone: string; commissionBps?: number }) {
    return this.db.one(
      `INSERT INTO vendor (name, phone, commission_bps) VALUES ($1, $2, coalesce($3, 1200)) RETURNING *`,
      [v.name, v.phone, v.commissionBps ?? null],
    );
  }

  async createListing(l: {
    vendorId: string; category: string; title: string; location: string; description?: string;
    pricePaisa: number; attributes?: Record<string, unknown>; weatherDependent?: boolean; status?: string;
  }) {
    return this.db.one(
      `INSERT INTO listing (vendor_id, category, title, location, description, price_paisa, attributes, weather_dependent, status)
       VALUES ($1, $2, $3, $4, coalesce($5, ''), $6, coalesce($7, '{}'::jsonb), coalesce($8, true), coalesce($9, 'live'))
       RETURNING *`,
      [l.vendorId, l.category, l.title, l.location, l.description ?? null, l.pricePaisa,
        l.attributes ? JSON.stringify(l.attributes) : null, l.weatherDependent ?? null, l.status ?? null],
    );
  }

  async createSlots(listingId: string, slots: { startsAt: string; capacity: number }[]) {
    const out = [];
    for (const s of slots) {
      out.push(await this.db.one(
        'INSERT INTO slot (listing_id, starts_at, capacity) VALUES ($1, $2, $3) RETURNING *',
        [listingId, s.startsAt, s.capacity],
      ));
    }
    return out;
  }
}
