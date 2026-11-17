import { createHmac } from 'crypto';
import request from 'supertest';
import { Ctx, makeListing, setup } from './helpers';

let ctx: Ctx;
let seq = 0;

beforeAll(async () => {
  ctx = await setup('wa');
});
afterAll(() => ctx.close());

function payload(from: string, text: string, id = `wamid.${++seq}`) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          contacts: [{ wa_id: from, profile: { name: 'Ram' } }],
          messages: [{ id, from, type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}

function send(from: string, text: string, id?: string) {
  const body = JSON.stringify(payload(from, text, id));
  const sig = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
  return request(ctx.app.getHttpServer())
    .post('/webhooks/whatsapp')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', sig)
    .send(body);
}

describe('WhatsApp webhook', () => {
  it('answers Meta\'s subscription check only with the right token', async () => {
    const http = request(ctx.app.getHttpServer());
    const ok = await http.get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify', 'hub.challenge': '12345' }).expect(200);
    expect(ok.text).toBe('12345');
    await http.get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);
  });

  it('rejects unsigned or wrongly signed deliveries', async () => {
    await request(ctx.app.getHttpServer()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef').send(payload('9779841000000', 'hi')).expect(401);
  });

  it('books from "hi" to a payment link in five messages', async () => {
    const { slotId } = await makeListing(ctx.db, { pricePaisa: 900_000 });
    const me = '9779841000001';

    await send(me, 'hi').expect(200);
    expect(ctx.notifier.last(me)).toMatch(/1\. Bungee/);

    await send(me, '1').expect(200);                 // Bungee
    expect(ctx.notifier.last(me)).toMatch(/Test bungee \(Test Ops\) - Rs 9,000/);

    await send(me, '1').expect(200);                 // the listing
    expect(ctx.notifier.last(me)).toMatch(/Available times/);

    await send(me, '1').expect(200);                 // the slot
    expect(ctx.notifier.last(me)).toMatch(/How many people/);

    await send(me, '2').expect(200);                 // 2 people
    expect(ctx.notifier.last(me)).toMatch(/Rs 18,000\.\nSeats held for 10 minutes\. Pay here: https:\/\/web\.test\/pay\/mock\//);

    const b = await ctx.db.one('SELECT channel, qty, status FROM booking WHERE slot_id = $1', [slotId]);
    expect(b).toEqual({ channel: 'whatsapp', qty: 2, status: 'pending_payment' });
  });

  it('handles a retried delivery only once', async () => {
    const me = '9779841000002';
    await send(me, 'hi', 'wamid.dup').expect(200);
    await send(me, 'hi', 'wamid.dup').expect(200);
    expect(ctx.notifier.sent.filter((m) => m.to === me)).toHaveLength(1);
  });
});
