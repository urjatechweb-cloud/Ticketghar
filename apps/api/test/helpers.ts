import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { AppConfig, CONFIG, loadConfig } from '../src/config';
import { DbService } from '../src/db/db.service';
import { migrate } from '../src/db/migrate';
import { NOTIFIER, Notifier } from '../src/notify/notifier';
import { configureApp } from '../src/main';

process.env.DISABLE_JOBS = 'true';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://tg:tg@localhost:5432/postgres';

export class FakeNotifier implements Notifier {
  sent: { to: string; body: string }[] = [];
  async sendText(to: string, body: string) {
    this.sent.push({ to, body });
  }
  last(to?: string) {
    const list = to ? this.sent.filter((m) => m.to === to) : this.sent;
    return list.at(-1)?.body ?? '';
  }
}

export interface Ctx {
  app: INestApplication;
  db: DbService;
  notifier: FakeNotifier;
  config: AppConfig;
  close: () => Promise<void>;
}

/** Fresh database per test file, migrated from scratch, plus a Nest app wired to it. */
export async function setup(name: string): Promise<Ctx> {
  const dbName = `tg_test_${name}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const config: AppConfig = {
    ...loadConfig({}),
    databaseUrl: ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`),
    adminApiKey: 'test-key',
    webUrl: 'https://web.test',
    publicApiUrl: 'https://api.test',
  };
  config.whatsapp = { ...config.whatsapp, appSecret: 'test-secret', verifyToken: 'test-verify' };
  config.esewa = { ...config.esewa, secretKey: '8gBm/:&EnhH.1/q' };
  await migrate(config.databaseUrl, () => undefined);

  const notifier = new FakeNotifier();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG).useValue(config)
    .overrideProvider(NOTIFIER).useValue(notifier)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app, config.webUrl);
  await app.init();
  const db = app.get(DbService);
  return { app, db, notifier, config, close: () => app.close() };
}

/** A verified, active operator with one live listing and one future slot. */
export async function makeListing(db: DbService, opts: { capacity?: number; pricePaisa?: number; commissionBps?: number } = {}) {
  const vendor = await db.one<{ id: string }>(
    `INSERT INTO vendor (name, phone, status, commission_bps) VALUES ('Test Ops', '9779800000001', 'active', $1) RETURNING id`,
    [opts.commissionBps ?? 1200],
  );
  for (const d of ['registration', 'tax', 'activity_licence', 'insurance', 'staff_certificates', 'equipment_inspection']) {
    await db.query(
      `INSERT INTO operator_document (vendor_id, doc_type, doc_number, expires_on, verified_at, verified_by)
       VALUES ($1, $2, 'X', current_date + 200, now(), 'test')`,
      [vendor!.id, d],
    );
  }
  const listing = await db.one<{ id: string }>(
    `INSERT INTO listing (vendor_id, category, title, location, price_paisa, status)
     VALUES ($1, 'bungee', 'Test bungee', 'Pokhara', $2, 'live') RETURNING id`,
    [vendor!.id, opts.pricePaisa ?? 900_000],
  );
  const slot = await db.one<{ id: string }>(
    `INSERT INTO slot (listing_id, starts_at, capacity) VALUES ($1, now() + interval '2 days', $2) RETURNING id`,
    [listing!.id, opts.capacity ?? 10],
  );
  return { vendorId: vendor!.id, listingId: listing!.id, slotId: slot!.id };
}

export async function addSlot(db: DbService, listingId: string, capacity = 10, daysAhead = 3) {
  const slot = await db.one<{ id: string }>(
    `INSERT INTO slot (listing_id, starts_at, capacity) VALUES ($1, now() + make_interval(days => $2), $3) RETURNING id`,
    [listingId, daysAhead, capacity],
  );
  return slot!.id;
}

export async function balance(db: DbService, account: string): Promise<number> {
  const r = await db.one<{ b: string }>(
    'SELECT coalesce(sum(debit_paisa - credit_paisa),0) AS b FROM ledger_entry WHERE account = $1',
    [account],
  );
  return Number(r!.b);
}
