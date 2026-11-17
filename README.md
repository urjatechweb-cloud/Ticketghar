# TicketGhar — The House of Tickets

Phase 0 of the TicketGhar platform: book Pokhara adventures (bungee, zipline, paragliding, rafting, ultralight, boating) on the web or over WhatsApp, pay with Khalti or eSewa, and get a QR ticket.

```
apps/api   NestJS + PostgreSQL booking API
apps/web   Next.js customer web app
```

## What works today

| Area | What it does |
| --- | --- |
| Slot holds | Seats are held for 10 minutes with one atomic SQL update, so a slot can never be oversold. A database `CHECK` backs this up. Unpaid holds expire automatically. |
| Payments | Khalti ePayment (initiate + server-side lookup), eSewa ePay v2 (HMAC-signed form + signature check + status API), and a mock provider for development. Amounts must match exactly, and repeated confirmations are idempotent. |
| Ledger | Double-entry and append-only. Every sale splits into vendor share and TicketGhar commission. A deferred database trigger rejects any unbalanced transaction. |
| Tickets | `TG-XXXXXXXX` codes, QR on the ticket page, and an operator scan endpoint. Redeeming awards Ghar Points (1 per Rs 100, valid 12 months). |
| Weather Promise | The operator cancels a slot, and every customer gets a WhatsApp message with a free rebook or a full refund (commission included). Customers who don't answer within 24 hours are refunded automatically. |
| Operator badges | Six required documents (registration, tax, activity licence, insurance, staff certificates, equipment inspection). Any expired or missing document pauses the operator, which blocks new bookings and sends a WhatsApp alert. |
| WhatsApp | Cloud API webhook with signature check and duplicate-delivery protection. A guided booking flow: "hi" → category → activity → time → people → payment link. |
| Web app | Activity list, booking panel, Khalti/eSewa checkout, ticket page, Weather Promise rebook page. Uses the TicketGhar brand system. |

## Run it locally

Requirements: Node 22 and Docker (or any PostgreSQL 16).

```bash
cp .env.example .env            # then fill in keys as you get them
npm install
npm run db:up                   # Postgres in Docker
npm run seed                    # migrates, then adds SAMPLE operators and 14 days of slots
npm run dev:api                 # http://localhost:4000
npm run dev:web                 # http://localhost:3000
```

The sample data (operator names, prices) is invented for development. Replace it with real operators through the admin API.

To book end to end without real money, choose **Test payment** at checkout. It's available while `ENABLE_MOCK_PAYMENTS=true`.

## Tests

```bash
npm test
```

There are 18 tests, and they run against a real PostgreSQL database (each test file creates its own). They cover:

- 25 people racing for 5 seats
- hold expiry
- the full HTTP booking flow and the ledger balances
- late payments after the seats sold out
- the database refusing unbalanced or edited ledger entries
- Weather Promise rebooking, refunds and auto-refunds
- operator pause and resume
- eSewa signature verification and tampering
- Khalti status mapping
- amount mismatch rejection
- the WhatsApp verification handshake, signatures, the five-message booking flow and duplicate deliveries

CI runs typecheck, tests and both builds on every push (`.github/workflows/ci.yml`).

## API

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/listings?category=` | Bookable listings (live listing, verified operator) |
| GET | `/listings/:id`, `/listings/:id/slots` | Detail and next 14 days of times |
| POST | `/holds` | `{slotId, qty, phone, name?}` → holds seats, returns `bookingId` |
| POST | `/bookings/:id/pay` | `{provider: khalti\|esewa\|mock}` → redirect URL or signed form |
| GET | `/payments/khalti/return`, `/payments/esewa/return` | Provider redirects; verified server-side |
| GET | `/tickets/:code` | Ticket with QR |
| GET/POST | `/rebook/:offerId`, `/rebook/:offerId/accept`, `/rebook/:offerId/refund` | Weather Promise |
| GET/POST | `/webhooks/whatsapp` | Meta verification and inbound messages |

Admin and operator (header `x-api-key: $ADMIN_API_KEY`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/vendors` | Create operator |
| POST | `/admin/vendors/:id/documents` | Upload document details |
| POST | `/admin/documents/:id/verify` | Mark verified; re-computes the badge |
| GET | `/admin/vendors/:id/badge` | Which documents are missing or expiring |
| POST | `/admin/listings`, `/admin/listings/:id/slots` | Create listing and times |
| POST | `/admin/vendors/:vid/slots/:sid/weather-cancel` | Weather cancellation |
| POST | `/admin/vendors/:vid/tickets/:code/redeem` | Gate scan |

## Going live checklist

- [ ] Nepal fintech lawyer confirms the payment structure: TicketGhar sells as an agent and never holds customer balances.
- [ ] Khalti merchant account. Set `KHALTI_BASE_URL` to the live URL and add the live secret key.
- [ ] eSewa merchant account. Add the live form and status URLs, product code and secret key.
- [ ] Nepali bank card gateway for foreign tourists (not built yet; it plugs in as a new provider in `apps/api/src/payments/providers.ts`).
- [ ] Meta Business verification, WhatsApp Business number, approved message templates for booking confirmations and weather alerts. Set the `WHATSAPP_*` variables.
- [ ] `ENABLE_MOCK_PAYMENTS=false` and `NEXT_PUBLIC_ENABLE_MOCK_PAYMENTS=false`.
- [ ] Replace the shared admin key with per-operator logins (phone OTP) before outside operators use the scanner.
- [ ] Daily database backups copied to a second region.

## Next (Phase 1)

- Android app (React Native)
- AI concierge behind the same `WhatsAppService.handle()` entry point
- operator self-service over WhatsApp
- Pokhara Best rankings
- review videos and point redemption
- vendor payout runs from the ledger
