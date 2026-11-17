import { Client } from 'pg';
import { loadConfig } from '../config';
import { migrate } from './migrate';

/**
 * SAMPLE DATA for local development only. Operator names and prices are
 * invented placeholders, not real Pokhara businesses or market prices.
 */
const SAMPLE = [
  {
    vendor: 'Sample Bungee Co.',
    listings: [
      { category: 'bungee', title: 'Bungee jump over the gorge', location: 'Hemja, Pokhara', price: 9_000, cap: 12,
        attributes: { minAge: 15, weightKg: [35, 110], durationMin: 120 } },
      { category: 'zipline', title: 'Long zipline ride', location: 'Sarangkot, Pokhara', price: 7_500, cap: 16,
        attributes: { minAge: 10, weightKg: [35, 125], durationMin: 60 } },
    ],
  },
  {
    vendor: 'Sample Sky Paragliding',
    listings: [
      { category: 'paragliding', title: 'Tandem paragliding, 30 minutes', location: 'Sarangkot, Pokhara', price: 8_500, cap: 8,
        attributes: { minAge: 6, weightKg: [20, 110], durationMin: 30 } },
      { category: 'ultralight', title: 'Ultralight flight over Phewa Lake', location: 'Old airport, Pokhara', price: 14_000, cap: 2,
        attributes: { minAge: 12, durationMin: 30 } },
    ],
  },
  {
    vendor: 'Sample River Rafting',
    listings: [
      { category: 'rafting', title: 'Half-day Seti river rafting', location: 'Seti River, Pokhara', price: 4_500, cap: 20,
        attributes: { minAge: 12, durationMin: 240, swimNeeded: false } },
      { category: 'boating', title: 'Phewa Lake boat, 1 hour', location: 'Lakeside, Pokhara', price: 1_200, cap: 6,
        attributes: { durationMin: 60 }, weather: false },
    ],
  },
];

const DOCS = ['registration', 'tax', 'activity_licence', 'insurance', 'staff_certificates', 'equipment_inspection'];

async function seed() {
  const { databaseUrl } = loadConfig();
  await migrate(databaseUrl);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const existing = await db.query('SELECT count(*)::int AS n FROM vendor');
  if (existing.rows[0].n > 0) {
    console.log('database already has vendors; skipping seed');
    await db.end();
    return;
  }
  for (const [i, s] of SAMPLE.entries()) {
    const v = await db.query(
      `INSERT INTO vendor (name, phone, status) VALUES ($1, $2, 'active') RETURNING id`,
      [s.vendor, `97798000000${i}`],
    );
    const vendorId = v.rows[0].id;
    for (const d of DOCS) {
      await db.query(
        `INSERT INTO operator_document (vendor_id, doc_type, doc_number, expires_on, verified_at, verified_by)
         VALUES ($1, $2, $3, current_date + 365, now(), 'seed')`,
        [vendorId, d, `SAMPLE-${d.toUpperCase()}-${i}`],
      );
    }
    for (const l of s.listings) {
      const row = await db.query(
        `INSERT INTO listing (vendor_id, category, title, location, description, price_paisa, attributes, weather_dependent, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live') RETURNING id`,
        [vendorId, l.category, l.title, l.location, 'Sample listing for development.', l.price * 100,
          JSON.stringify(l.attributes), (l as any).weather ?? true],
      );
      // Slots at 08:00, 11:00 and 14:00 Nepal time (UTC+5:45) for the next 14 days.
      await db.query(
        `INSERT INTO slot (listing_id, starts_at, capacity)
         SELECT $1, (d::date + t) AT TIME ZONE 'Asia/Kathmandu', $2
           FROM generate_series(current_date + 1, current_date + 14, interval '1 day') d,
                unnest(ARRAY[time '08:00', time '11:00', time '14:00']) t`,
        [row.rows[0].id, l.cap],
      );
    }
  }
  console.log('seeded sample vendors, listings and 14 days of slots');
  await db.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
