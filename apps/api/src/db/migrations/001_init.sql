-- TicketGhar Phase 0 schema.
-- Money is stored as integer paisa (1 NPR = 100 paisa). Never floats.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE customer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL UNIQUE,            -- E.164 without '+', doubles as WhatsApp ID
  name         text,
  nationality  text,
  language     text NOT NULL DEFAULT 'en',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  phone           text NOT NULL,                -- operator's WhatsApp number
  payout_account  text,                         -- bank account reference, stored by the finance team
  commission_bps  int  NOT NULL DEFAULT 1200 CHECK (commission_bps BETWEEN 0 AND 5000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operator_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id),
  doc_type     text NOT NULL CHECK (doc_type IN
                 ('registration','tax','activity_licence','insurance','staff_certificates','equipment_inspection')),
  doc_number   text NOT NULL,
  expires_on   date,                            -- null = does not expire (e.g. registration)
  verified_at  timestamptz,
  verified_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON operator_document (vendor_id, doc_type);

CREATE TABLE listing (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          uuid NOT NULL REFERENCES vendor(id),
  category           text NOT NULL CHECK (category IN
                       ('bungee','zipline','paragliding','rafting','ultralight','boating','flight','transfer','other')),
  title              text NOT NULL,
  location           text NOT NULL,
  description        text NOT NULL DEFAULT '',
  price_paisa        bigint NOT NULL CHECK (price_paisa > 0),
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-category details (min age, weight limit, duration...)
  weather_dependent  boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON listing (category, status);

CREATE TABLE slot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES listing(id),
  starts_at       timestamptz NOT NULL,
  capacity        int NOT NULL CHECK (capacity > 0),
  held            int NOT NULL DEFAULT 0,
  sold            int NOT NULL DEFAULT 0,
  weather_status  text NOT NULL DEFAULT 'open' CHECK (weather_status IN ('open','cancelled')),
  CONSTRAINT slot_never_oversold CHECK (held >= 0 AND sold >= 0 AND held + sold <= capacity)
);
CREATE INDEX ON slot (listing_id, starts_at);

CREATE TABLE hold (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id      uuid NOT NULL REFERENCES slot(id),
  customer_id  uuid NOT NULL REFERENCES customer(id),
  qty          int NOT NULL CHECK (qty > 0),
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','expired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hold_active_expiry ON hold (expires_at) WHERE status = 'active';

CREATE TABLE booking (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  slot_id           uuid NOT NULL REFERENCES slot(id),
  hold_id           uuid REFERENCES hold(id),
  qty               int NOT NULL CHECK (qty > 0),
  unit_price_paisa  bigint NOT NULL,
  total_paisa       bigint NOT NULL,
  commission_paisa  bigint NOT NULL,
  channel           text NOT NULL DEFAULT 'web' CHECK (channel IN ('web','app','whatsapp','partner','assistant')),
  status            text NOT NULL DEFAULT 'pending_payment' CHECK (status IN
                      ('pending_payment','expired','confirmed','used','refund_due','refunded','rebooked')),
  ticket_code       text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON booking (slot_id, status);
CREATE INDEX ON booking (customer_id);

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES booking(id),
  provider      text NOT NULL CHECK (provider IN ('khalti','esewa','mock')),
  provider_ref  text,                           -- Khalti pidx / eSewa transaction_uuid
  amount_paisa  bigint NOT NULL,
  status        text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','completed','failed','refunded')),
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

-- Double-entry ledger. Entries are append-only and every transaction must balance.
CREATE TABLE ledger_txn (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid REFERENCES booking(id),
  kind        text NOT NULL CHECK (kind IN ('sale','refund','payout','adjustment')),
  memo        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry (
  id            bigserial PRIMARY KEY,
  txn_id        uuid NOT NULL REFERENCES ledger_txn(id),
  account       text NOT NULL,                  -- e.g. 'clearing:khalti', 'vendor_payable:<uuid>', 'revenue:commission'
  debit_paisa   bigint NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa  bigint NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  CONSTRAINT one_side CHECK ((debit_paisa = 0) <> (credit_paisa = 0))
);
CREATE INDEX ON ledger_entry (account);
CREATE INDEX ON ledger_entry (txn_id);

CREATE FUNCTION ledger_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only';
END $$;
CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable();

CREATE FUNCTION ledger_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT coalesce(sum(debit_paisa),0), coalesce(sum(credit_paisa),0) INTO d, c
    FROM ledger_entry WHERE txn_id = NEW.txn_id;
  IF d <> c THEN
    RAISE EXCEPTION 'ledger txn % is unbalanced: debit % credit %', NEW.txn_id, d, c;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_txn_must_balance AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

CREATE TABLE points_entry (
  id           bigserial PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customer(id),
  booking_id   uuid REFERENCES booking(id),
  points       int NOT NULL,
  reason       text NOT NULL,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, reason)
);

CREATE TABLE rebook_offer (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL UNIQUE REFERENCES booking(id),
  status           text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','refunded')),
  refund_deadline  timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- WhatsApp conversation state and an idempotency log of inbound message ids.
CREATE TABLE wa_session (
  wa_id       text PRIMARY KEY,
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wa_inbound (
  message_id   text PRIMARY KEY,
  wa_id        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
