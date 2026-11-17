import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { WeatherService } from '../src/weather/weather.service';
import { balance, Ctx, makeListing, setup } from './helpers';

let ctx: Ctx;
let bookings: BookingsService;

beforeAll(async () => {
  ctx = await setup('booking');
  bookings = ctx.app.get(BookingsService);
});
afterAll(() => ctx.close());

describe('slot holds', () => {
  it('never oversells: 25 people race for 5 seats and exactly 5 win', async () => {
    const { slotId } = await makeListing(ctx.db, { capacity: 5 });
    const attempts = Array.from({ length: 25 }, (_, i) =>
      bookings.createHold({ slotId, qty: 1, phone: `98000${String(i).padStart(5, '0')}` }),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const slot = await ctx.db.one('SELECT held, sold FROM slot WHERE id = $1', [slotId]);
    expect(slot).toEqual({ held: 5, sold: 0 });
  });

  it('releases seats when an unpaid hold expires', async () => {
    const { slotId } = await makeListing(ctx.db, { capacity: 3 });
    const hold = await bookings.createHold({ slotId, qty: 3, phone: '9801111111' });
    await expect(bookings.createHold({ slotId, qty: 1, phone: '9802222222' })).rejects.toThrow(/sold out/);

    await ctx.db.query(`UPDATE hold SET expires_at = now() - interval '1 minute' WHERE slot_id = $1`, [slotId]);
    expect(await bookings.releaseExpiredHolds()).toBe(1);

    const slot = await ctx.db.one('SELECT held FROM slot WHERE id = $1', [slotId]);
    expect(slot!.held).toBe(0);
    expect((await bookings.getBooking(hold.bookingId)).status).toBe('expired');
    await expect(bookings.createHold({ slotId, qty: 1, phone: '9802222222' })).resolves.toBeDefined();
  });

  it('refuses holds on paused operators and cancelled slots', async () => {
    const a = await makeListing(ctx.db);
    await ctx.db.query(`UPDATE vendor SET status = 'paused' WHERE id = $1`, [a.vendorId]);
    await expect(bookings.createHold({ slotId: a.slotId, qty: 1, phone: '9803333333' })).rejects.toThrow();

    const b = await makeListing(ctx.db);
    await ctx.db.query(`UPDATE slot SET weather_status = 'cancelled' WHERE id = $1`, [b.slotId]);
    await expect(bookings.createHold({ slotId: b.slotId, qty: 1, phone: '9803333333' })).rejects.toThrow();
  });
});

describe('booking flow over HTTP (mock payment)', () => {
  it('holds, pays, issues a ticket, posts a balanced sale and texts the customer once', async () => {
    const { slotId, vendorId } = await makeListing(ctx.db, { pricePaisa: 900_000, commissionBps: 1200 });
    const http = request(ctx.app.getHttpServer());

    const hold = await http.post('/holds').send({ slotId, qty: 2, phone: '9841234567', name: 'Sita' }).expect(201);
    expect(hold.body.totalPaisa).toBe(1_800_000);

    const pay = await http.post(`/bookings/${hold.body.bookingId}/pay`).send({ provider: 'mock' }).expect(201);
    expect(pay.body.kind).toBe('redirect');

    const done = await http.post(`/payments/mock/${pay.body.paymentId}/complete`).expect(201);
    expect(done.body.status).toBe('confirmed');
    expect(done.body.ticketCode).toMatch(/^TG-[A-Z2-9]{8}$/);

    // Retried confirmation changes nothing.
    const again = await http.post(`/payments/mock/${pay.body.paymentId}/complete`).expect(201);
    expect(again.body.ticketCode).toBe(done.body.ticketCode);

    const slot = await ctx.db.one('SELECT held, sold FROM slot WHERE id = $1', [slotId]);
    expect(slot).toEqual({ held: 0, sold: 2 });

    expect(await balance(ctx.db, 'clearing:mock')).toBeGreaterThanOrEqual(1_800_000);
    expect(await balance(ctx.db, `vendor_payable:${vendorId}`)).toBe(-1_584_000);
    const total = await ctx.db.one<{ s: string }>('SELECT sum(debit_paisa - credit_paisa) AS s FROM ledger_entry');
    expect(Number(total!.s)).toBe(0);

    const ticket = await http.get(`/tickets/${done.body.ticketCode}`).expect(200);
    expect(ticket.body.qr).toMatch(/^data:image\/png;base64,/);

    const texts = ctx.notifier.sent.filter((m) => m.to === '9779841234567');
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toContain(done.body.ticketCode);
  });

  it('rejects invalid input', async () => {
    const http = request(ctx.app.getHttpServer());
    await http.post('/holds').send({ slotId: 'nope', qty: 0, phone: '1' }).expect(400);
  });

  it('a payment that arrives after the seats sold out becomes refund_due, and can be refunded', async () => {
    const { slotId, vendorId } = await makeListing(ctx.db, { capacity: 1 });
    const http = request(ctx.app.getHttpServer());
    const first = await bookings.createHold({ slotId, qty: 1, phone: '9811000001' });
    const pay = await http.post(`/bookings/${first.bookingId}/pay`).send({ provider: 'mock' }).expect(201);

    // Hold expires, someone else takes and pays for the seat, then the late payment lands.
    await ctx.db.query(`UPDATE hold SET expires_at = now() - interval '1 minute' WHERE slot_id = $1`, [slotId]);
    await bookings.releaseExpiredHolds();
    const second = await bookings.createHold({ slotId, qty: 1, phone: '9811000002' });
    const pay2 = await http.post(`/bookings/${second.bookingId}/pay`).send({ provider: 'mock' }).expect(201);
    await http.post(`/payments/mock/${pay2.body.paymentId}/complete`).expect(201);

    const late = await http.post(`/payments/mock/${pay.body.paymentId}/complete`).expect(201);
    expect(late.body.status).toBe('refund_due');

    const weather = ctx.app.get(WeatherService);
    await ctx.db.tx((c) => weather.refundBooking(c, first.bookingId, 'sold out before payment'));
    expect((await bookings.getBooking(first.bookingId)).status).toBe('refunded');
    const slot = await ctx.db.one('SELECT held, sold FROM slot WHERE id = $1', [slotId]);
    expect(slot).toEqual({ held: 0, sold: 1 });
    // Vendor is owed only the one sale that was seated.
    expect(await balance(ctx.db, `vendor_payable:${vendorId}`)).toBe(-792_000);
  });

  it('operator redeems a ticket once and the customer earns Ghar Points', async () => {
    const { slotId, vendorId } = await makeListing(ctx.db, { pricePaisa: 450_000 });
    const http = request(ctx.app.getHttpServer());
    const hold = await bookings.createHold({ slotId, qty: 1, phone: '9812000001' });
    const pay = await http.post(`/bookings/${hold.bookingId}/pay`).send({ provider: 'mock' });
    const done = await http.post(`/payments/mock/${pay.body.paymentId}/complete`);

    await http.post(`/admin/vendors/${vendorId}/tickets/${done.body.ticketCode}/redeem`).expect(401);
    const r = await http
      .post(`/admin/vendors/${vendorId}/tickets/${done.body.ticketCode}/redeem`)
      .set('x-api-key', 'test-key')
      .expect(201);
    expect(r.body).toEqual({ status: 'used', pointsAwarded: 45 });
    await http
      .post(`/admin/vendors/${vendorId}/tickets/${done.body.ticketCode}/redeem`)
      .set('x-api-key', 'test-key')
      .expect(409);
  });
});

describe('ledger integrity', () => {
  it('the database refuses an unbalanced transaction and any edit to an entry', async () => {
    await expect(
      ctx.db.tx(async (c) => {
        const t = await c.query(`INSERT INTO ledger_txn (kind) VALUES ('adjustment') RETURNING id`);
        await c.query(`INSERT INTO ledger_entry (txn_id, account, debit_paisa) VALUES ($1, 'x', 100)`, [t.rows[0].id]);
        await c.query(`INSERT INTO ledger_entry (txn_id, account, credit_paisa) VALUES ($1, 'y', 99)`, [t.rows[0].id]);
      }),
    ).rejects.toThrow(/unbalanced/);

    await expect(ctx.db.query(`UPDATE ledger_entry SET debit_paisa = debit_paisa + 1`)).rejects.toThrow(/append-only/);
  });
});
