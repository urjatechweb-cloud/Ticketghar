import { createHmac } from 'crypto';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { OperatorsService } from '../src/operators/operators.service';
import { EsewaProvider, esewaSignature, KhaltiProvider } from '../src/payments/providers';
import { PaymentsService } from '../src/payments/payments.service';
import { WeatherService } from '../src/weather/weather.service';
import { addSlot, balance, Ctx, makeListing, setup } from './helpers';

let ctx: Ctx;

beforeAll(async () => {
  ctx = await setup('ops');
});
afterAll(() => ctx.close());

async function confirmedBooking(slotId: string, phone: string, qty = 1) {
  const bookings = ctx.app.get(BookingsService);
  const payments = ctx.app.get(PaymentsService);
  const hold = await bookings.createHold({ slotId, qty, phone });
  const pay = await payments.start(hold.bookingId, 'mock');
  await payments.mockComplete(pay.paymentId);
  return hold.bookingId;
}

describe('Weather Promise', () => {
  it('cancelling a slot offers every customer a free rebook or a full refund', async () => {
    const { slotId, vendorId, listingId } = await makeListing(ctx.db, { pricePaisa: 850_000, capacity: 4 });
    const newSlot = await addSlot(ctx.db, listingId, 4);
    const a = await confirmedBooking(slotId, '9813000001', 2);
    const b = await confirmedBooking(slotId, '9813000002', 1);

    const weather = ctx.app.get(WeatherService);
    const res = await weather.cancelSlot(slotId, vendorId);
    expect(res.offers).toHaveLength(2);
    expect(ctx.notifier.last('9779813000001')).toMatch(/cancelled by the operator because of weather/);

    const offers = await ctx.db.query<{ id: string; booking_id: string }>('SELECT id, booking_id FROM rebook_offer');
    const offerA = offers.find((o) => o.booking_id === a)!.id;
    const offerB = offers.find((o) => o.booking_id === b)!.id;

    // Customer A moves to another day, same ticket.
    const details = await weather.getOffer(offerA);
    expect(details.alternatives.map((s: any) => s.id)).toContain(newSlot);
    const moved = await weather.accept(offerA, newSlot);
    expect(moved.status).toBe('rebooked');
    expect(await ctx.db.one('SELECT sold FROM slot WHERE id = $1', [newSlot])).toEqual({ sold: 2 });

    // Customer B takes the refund, TicketGhar's commission included.
    const refund = await weather.decline(offerB);
    expect(refund).toEqual({ status: 'refunded', amountPaisa: 850_000 });
    expect(await balance(ctx.db, 'refunds_payable')).toBe(-850_000);
    // Vendor keeps only customer A's share: 2 x 8,500 less 12%.
    expect(await balance(ctx.db, `vendor_payable:${vendorId}`)).toBe(-1_496_000);
    await expect(weather.decline(offerB)).rejects.toThrow(/already refunded/);
  });

  it('refunds offers nobody answered within 24 hours', async () => {
    const { slotId, vendorId } = await makeListing(ctx.db);
    const id = await confirmedBooking(slotId, '9813000003');
    const weather = ctx.app.get(WeatherService);
    await weather.cancelSlot(slotId, vendorId);
    await ctx.db.query(`UPDATE rebook_offer SET refund_deadline = now() - interval '1 hour' WHERE booking_id = $1`, [id]);
    expect(await weather.refundUnanswered()).toBe(1);
    expect((await ctx.app.get(BookingsService).getBooking(id)).status).toBe('refunded');
  });
});

describe('operator verification', () => {
  it('an expired insurance policy pauses the operator and blocks new bookings', async () => {
    const { vendorId, slotId } = await makeListing(ctx.db);
    await ctx.db.query(
      `UPDATE operator_document SET expires_on = current_date - 1 WHERE vendor_id = $1 AND doc_type = 'insurance'`,
      [vendorId],
    );
    const ops = ctx.app.get(OperatorsService);
    const status = await ops.refresh(vendorId);
    expect(status).toMatchObject({ valid: false, missing: ['insurance'] });
    expect(ctx.notifier.last('9779800000001')).toMatch(/paused.*insurance/);
    await expect(
      ctx.app.get(BookingsService).createHold({ slotId, qty: 1, phone: '9814000001' }),
    ).rejects.toThrow();

    // New policy uploaded and verified through the admin API: back on sale.
    const http = request(ctx.app.getHttpServer());
    const doc = await http.post(`/admin/vendors/${vendorId}/documents`).set('x-api-key', 'test-key')
      .send({ docType: 'insurance', docNumber: 'POL-2', expiresOn: '2030-01-01' }).expect(201);
    const verified = await http.post(`/admin/documents/${doc.body.id}/verify`).set('x-api-key', 'test-key')
      .send({ verifiedBy: 'ops-team' }).expect(201);
    expect(verified.body.valid).toBe(true);
    await expect(
      ctx.app.get(BookingsService).createHold({ slotId, qty: 1, phone: '9814000001' }),
    ).resolves.toBeDefined();
  });
});

describe('payment providers', () => {
  it('eSewa: signs the form and only accepts untampered return data', async () => {
    const p = new EsewaProvider({ ...ctx.config.esewa, secretKey: 'secret' });
    const init = await p.initiate({
      paymentId: 'pay-1', bookingId: 'b-1', amountPaisa: 450_050, title: 'x',
      customer: { phone: '9779800000000' }, returnUrl: 'https://api.test/r', websiteUrl: 'https://web.test',
    });
    if (init.kind !== 'form') throw new Error('expected form');
    expect(init.fields.total_amount).toBe('4500.50');
    const expected = createHmac('sha256', 'secret')
      .update('total_amount=4500.50,transaction_uuid=pay-1,product_code=EPAYTEST').digest('base64');
    expect(init.fields.signature).toBe(expected);

    const ret: Record<string, string> = {
      transaction_code: '000AWEO', status: 'COMPLETE', total_amount: '4500.50', transaction_uuid: 'pay-1',
      product_code: 'EPAYTEST', signed_field_names: 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names',
    };
    ret.signature = esewaSignature(ret, ret.signed_field_names, 'secret');
    const ok = Buffer.from(JSON.stringify(ret)).toString('base64');
    expect(p.decodeReturn(ok).transaction_uuid).toBe('pay-1');

    const tampered = Buffer.from(JSON.stringify({ ...ret, total_amount: '1.00' })).toString('base64');
    expect(() => p.decodeReturn(tampered)).toThrow(/signature/);
  });

  it('Khalti: only "Completed" from the lookup API counts as paid', async () => {
    const fake = (status: string) => (async () => ({ ok: true, json: async () => ({ status, total_amount: 1000 }) })) as any;
    const cfg = { baseUrl: 'https://dev.khalti.test/api/v2', secretKey: 'k' };
    expect((await new KhaltiProvider(cfg, fake('Completed')).lookup('p')).status).toBe('completed');
    expect((await new KhaltiProvider(cfg, fake('Pending')).lookup('p')).status).toBe('pending');
    expect((await new KhaltiProvider(cfg, fake('Expired')).lookup('p')).status).toBe('failed');
    expect((await new KhaltiProvider(cfg, fake('User canceled')).lookup('p')).status).toBe('failed');
  });

  it('refuses a provider-confirmed amount that differs from the booking', async () => {
    const { slotId } = await makeListing(ctx.db);
    const bookings = ctx.app.get(BookingsService);
    const payments = ctx.app.get(PaymentsService);
    const hold = await bookings.createHold({ slotId, qty: 1, phone: '9815000001' });
    const pay = await payments.start(hold.bookingId, 'mock');
    await expect(
      payments.applyVerified('mock', { providerRef: pay.providerRef, status: 'completed', amountPaisa: 100, raw: {} }),
    ).rejects.toThrow(/amount mismatch/);
  });
});
