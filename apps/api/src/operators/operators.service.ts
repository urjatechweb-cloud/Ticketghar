import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { NOTIFIER, Notifier } from '../notify/notifier';

export const REQUIRED_DOCS = [
  'registration', 'tax', 'activity_licence', 'insurance', 'staff_certificates', 'equipment_inspection',
] as const;
export type DocType = (typeof REQUIRED_DOCS)[number];

export interface BadgeStatus {
  vendorId: string;
  valid: boolean;
  missing: DocType[];        // never uploaded, unverified or expired
  expiringSoon: DocType[];   // valid but expiring within 30 days
}

/**
 * Operator verification. A vendor can sell only while every required
 * document is verified and unexpired; the hold query checks vendor.status,
 * so pausing the vendor stops new bookings immediately.
 */
@Injectable()
export class OperatorsService {
  constructor(private readonly db: DbService, @Inject(NOTIFIER) private readonly notifier: Notifier) {}

  async addDocument(vendorId: string, doc: { docType: DocType; docNumber: string; expiresOn?: string | null }) {
    const row = await this.db.one(
      `INSERT INTO operator_document (vendor_id, doc_type, doc_number, expires_on)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [vendorId, doc.docType, doc.docNumber, doc.expiresOn ?? null],
    );
    return row;
  }

  async verifyDocument(documentId: string, verifiedBy: string) {
    const row = await this.db.one<{ vendor_id: string }>(
      `UPDATE operator_document SET verified_at = now(), verified_by = $2 WHERE id = $1 RETURNING vendor_id`,
      [documentId, verifiedBy],
    );
    if (!row) throw new NotFoundException('document not found');
    return this.refresh(row.vendor_id);
  }

  async badge(vendorId: string): Promise<BadgeStatus> {
    const rows = await this.db.query<{ doc_type: DocType; ok: boolean; soon: boolean }>(
      `SELECT doc_type,
              bool_or(expires_on IS NULL OR expires_on >= current_date) AS ok,
              bool_and(expires_on IS NOT NULL AND expires_on < current_date + 30) AS soon
         FROM operator_document
        WHERE vendor_id = $1 AND verified_at IS NOT NULL
        GROUP BY doc_type`,
      [vendorId],
    );
    const ok = new Set(rows.filter((r) => r.ok).map((r) => r.doc_type));
    const missing = REQUIRED_DOCS.filter((d) => !ok.has(d));
    const expiringSoon = rows.filter((r) => r.ok && r.soon).map((r) => r.doc_type);
    return { vendorId, valid: missing.length === 0, missing, expiringSoon };
  }

  /** Recomputes one vendor's badge and pauses or activates it. */
  async refresh(vendorId: string): Promise<BadgeStatus> {
    const status = await this.badge(vendorId);
    const next = status.valid ? 'active' : 'paused';
    const changed = await this.db.one<{ phone: string; name: string; status: string }>(
      `UPDATE vendor SET status = $2 WHERE id = $1 AND status <> $2 RETURNING phone, name, status`,
      [vendorId, next],
    );
    if (changed && next === 'paused') {
      await this.notifier.sendText(
        changed.phone,
        `TicketGhar: ${changed.name} is paused because these documents are missing or expired: ` +
          `${status.missing.join(', ')}. Send updated copies to resume bookings.`,
      );
    }
    return status;
  }

  /** Daily job: every vendor's badge. */
  async refreshAll(): Promise<BadgeStatus[]> {
    const vendors = await this.db.query<{ id: string }>('SELECT id FROM vendor');
    const out: BadgeStatus[] = [];
    for (const v of vendors) out.push(await this.refresh(v.id));
    return out;
  }
}
