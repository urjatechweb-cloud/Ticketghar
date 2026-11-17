import { Injectable } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';

export interface LedgerLine {
  account: string;
  debit?: number;   // paisa
  credit?: number;  // paisa
}

export const Accounts = {
  clearing: (provider: string) => `clearing:${provider}`,
  vendorPayable: (vendorId: string) => `vendor_payable:${vendorId}`,
  commission: 'revenue:commission',
  refundsPayable: 'refunds_payable',
};

/**
 * Double-entry ledger. Every posting is balanced here AND by a deferred
 * database constraint trigger, so an unbalanced transaction can never commit.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DbService) {}

  async post(
    client: Queryable,
    kind: 'sale' | 'refund' | 'payout' | 'adjustment',
    lines: LedgerLine[],
    opts: { bookingId?: string; memo?: string } = {},
  ): Promise<string> {
    const clean = lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
    const debit = clean.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = clean.reduce((s, l) => s + (l.credit ?? 0), 0);
    for (const l of clean) {
      if (!Number.isInteger(l.debit ?? 0) || !Number.isInteger(l.credit ?? 0)) {
        throw new Error('ledger amounts must be integer paisa');
      }
    }
    if (clean.length < 2 || debit !== credit) {
      throw new Error(`unbalanced ledger posting: debit ${debit} credit ${credit}`);
    }
    const txn = await client.query<{ id: string }>(
      'INSERT INTO ledger_txn (booking_id, kind, memo) VALUES ($1, $2, $3) RETURNING id',
      [opts.bookingId ?? null, kind, opts.memo ?? ''],
    );
    const txnId = txn.rows[0].id;
    for (const l of clean) {
      await client.query(
        'INSERT INTO ledger_entry (txn_id, account, debit_paisa, credit_paisa) VALUES ($1, $2, $3, $4)',
        [txnId, l.account, l.debit ?? 0, l.credit ?? 0],
      );
    }
    return txnId;
  }

  /** Balance as debit minus credit, in paisa. */
  async balance(account: string): Promise<number> {
    const row = await this.db.one<{ bal: string }>(
      'SELECT coalesce(sum(debit_paisa - credit_paisa), 0) AS bal FROM ledger_entry WHERE account = $1',
      [account],
    );
    return Number(row?.bal ?? 0);
  }

  /** Splits a sale total into vendor share and TicketGhar commission. */
  static split(totalPaisa: number, commissionBps: number) {
    const commission = Math.round((totalPaisa * commissionBps) / 10_000);
    return { commission, vendorShare: totalPaisa - commission };
  }
}
