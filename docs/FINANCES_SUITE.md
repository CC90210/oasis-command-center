# FOUNDERS > Finances — bookkeeping for OASIS AI Solutions

**Status:** built on branch `feat/finances-suite`, not deployed. Migration 180 is written and validated on a throwaway database; it has **not** been applied to the live Turso database.
**Code:** `lib/founders-finances/` (rules + I/O), `app/founders/finances/` (pages), `app/api/founders/finances/` (UI routes), `app/api/internal/finance/` (Atlas), `app/api/webhooks/stripe-finance/` (Stripe).
**Tests:** `npm run test:finances` (in CI) — `tests/finances-core.test.ts` (pure rules), `tests/finances-io.test.ts` (real local libSQL + the real route handlers), `tests/finances-surface.test.ts` (nav, gates, PDF, email, CSV).

---

## What it is

Double-entry books for three entities:

| Entity | Slug | Who can see it |
|---|---|---|
| OASIS AI Solutions (business) | `oasis` | CC and Adon; Atlas (internal API); the Stripe webhook |
| CC personal | `cc-personal` | CC only |
| Adon personal | `adon-personal` | Adon only |

Owners are resolved at runtime: `user_profiles.auth_user_id` for `conaugh@oasisai.work` (CC) and `adon@oasisai.work` (Adon), compared with the session's auth user id. No uuid is hard-coded. The founders portal gate also admits the marketing hire and builders; Finances does **not** — its sidebar row and header chip are hidden for them, and every page and route 404s for them independently (`lib/founders-finances/access-io.ts`, predicate `access.ts canAccessEntity`, tested).

Tabs: **Overview · Transactions · Invoices · Bills & Expenses · Accounts · Reports · Taxes · Settings**, with a book switcher (`?entity=`) on every tab.

## Rules that are enforced in code (and tested)

- **Money** is integer cents plus an ISO currency on every row. No float ever holds money.
- **Double entry:** `ledger.ts prepareJournalLines()` is the only door into `fin_journal_lines`. Every entry balances per currency, every line carries a CAD equivalent, and the CAD equivalents balance too (largest-remainder allocation). Entries are written atomically (`client.batch(..., "write")`) and are idempotent on `(entity, source, source_ref)`.
- **FX:** Bank of Canada Valet `FXUSDCAD` (CAD per 1 USD), stored daily in `fin_fx_rates`. Each payment converts at its **own day's** rate; a day with no observation uses the latest prior business day within 7 days, otherwise the day is reported missing (`fx_missing_days`), never guessed.
- **Days** are America/Toronto calendar days (`fx.ts torontoDateOf`), for every date derived from a timestamp.
- **Sales tax:** OASIS is not registered (small supplier) → invoices carry no GST/QST. GST 5% and QST 9.975% are both computed on the pre-tax amount, rounded half away from zero, and switch on only when a founder ticks registration in Settings **and** enters both numbers (validated shapes `123456789RT0001`, `1234567890TQ0001`). The small-supplier tracker sums taxable revenue over the current quarter-to-date plus the previous three quarters against CA$30,000 and warns at 75% and 90%; any single quarter over CA$30,000 is flagged separately.
- **Collected revenue** (`metrics.ts`) = rows of `fin_payments` (succeeded live Stripe charges + manually recorded invoice payments), net of refunds on the refund's own day. An invoice paid through Stripe is one row: the charge id, payment-intent id and Stripe-invoice id are each unique, and every Stripe path looks up by all three before inserting.

## Data model (migration 180, all tables prefixed `fin_`)

| Table | Holds |
|---|---|
| `entities`, `settings` | the three books; legal identity, GST/QST registration + numbers, invoice prefix/next number/year, terms, payment instructions, pinned Stripe account id |
| `accounts`, `categories`, `tax_codes` | chart of accounts (seeded Canadian small-business chart for OASIS, simple personal chart for each founder), user-facing categories mapped to accounts, GST/QST codes (dormant) |
| `journal_entries`, `journal_lines` | the ledger |
| `fx_rates` | Bank of Canada daily USD/CAD |
| `contacts` | customers and vendors |
| `rules` | auto-categorisation (contains / equals / starts with, direction, amount range, priority). Seeded rule: deposits containing "stripe" are a transfer from Stripe clearing, not revenue |
| `invoices`, `invoice_lines` | invoices, statuses draft → sent → overdue → paid / void |
| `bills`, `bill_lines` | bills (pay later, via AP) and expenses (already paid) |
| `attachments` | receipts: pointer + sha256; bytes in the private `finance-receipts` bucket (R2 via `getServiceSupabase().storage`) |
| `bank_transactions`, `imports` | the money-in/out register; statement imports with dedupe hashes (`UNIQUE(entity, account, dedupe_hash)`) |
| `payments` | money received / refunded (Stripe + manual) |
| `stripe_events` | webhook idempotency on the Stripe event id |
| `subscriptions` | Stripe subscription state for MRR |
| `owner_equity_events` | owner draws and contributions (50/50 parity view) |
| `recurring_items` | recurring expenses, recorded with one click when due |
| `audit_log` | who did what, written in the same transaction as the change |

Seed rows (entities, charts, categories, tax codes, the Stripe-payout rule) are inserted idempotently at runtime by `seed-io.ts` from the one definition in `chart.ts` — not by the migration.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `/founders/finances/*` | finance owner session | the eight tabs + `/invoices/[id]` |
| `POST /api/founders/finances/actions` | finance owner session | every UI write (`{ action, ...fields }`) |
| `POST /api/founders/finances/import` | finance owner session | CSV/OFX/QFX preview + commit |
| `GET/POST /api/founders/finances/attachments` | finance owner session | receipt upload / signed download |
| `GET /api/founders/finances/invoices/[id]/pdf` | finance owner session | invoice PDF |
| `GET /api/founders/finances/reports` | finance owner session | report CSV export |
| `POST /api/webhooks/stripe-finance` | Stripe v1 signature | payments, refunds, invoices, subscriptions |
| `/api/internal/finance/*` | `Bearer FINANCE_AGENT_TOKEN` | Atlas (below) |

## Environment variables (names only)

| Name | Needed for | If unset |
|---|---|---|
| `STRIPE_FINANCE_WEBHOOK_SECRET` | the Stripe webhook | every webhook call answers 503 — **blocking for Stripe ingest** |
| `FINANCE_AGENT_TOKEN` (≥ 24 chars) | Atlas internal API | every internal call answers 503 — **blocking for Atlas** |
| `INVOICE_FROM_EMAIL`, `INVOICE_FROM_APP_PASSWORD`, `INVOICE_FROM_NAME` | optional override for the invoice sender | falls back to the existing `OASIS_MAIL_FROM` + `OASIS_MAIL_APP_PASSWORD`, then the founders' tenant `oasis_gmail` integration row. None of the three → sending an invoice fails loudly (`invoice_mailer_not_configured`); it is never sent without its PDF |
| `STRIPE_SECRET_KEY` / tenant integration `stripe.secret_key` | payment links, reconcile, fee lookups | existing credential path, read for the first tenant in `FOUNDERS_TENANT_IDS`. Without it: no card links, no reconcile; the webhook still records payments with fees marked pending |
| `FOUNDERS_TENANT_IDS`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_*` | already required by the app | — |

## What needs a founder before this is live

1. **Apply migration 180** to the live Turso database (below).
2. **Create the Stripe webhook** in OASIS's own Stripe dashboard → Developers → Webhooks → endpoint `https://<command-center-host>/api/webhooks/stripe-finance`, events: `payment_intent.succeeded`, `charge.succeeded`, `charge.refunded`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret in `STRIPE_FINANCE_WEBHOOK_SECRET`.
3. **Confirm the Stripe account** in Finances → Settings → Stripe. The page shows which account the configured key belongs to (`GET /v1/account`); a founder confirms it is OASIS's own account (not Trytan's, PropFlow's or the store's). Until then Finances creates no payment links and runs no reconcile.
4. **Set `FINANCE_AGENT_TOKEN`** and give the same value to Atlas.
5. Make sure an OASIS mailbox is configured (`OASIS_MAIL_FROM`/`OASIS_MAIL_APP_PASSWORD` already exist for the shared sender, or set `INVOICE_FROM_*`).
6. Settings → fill payment instructions (e-transfer address) that print on every invoice.
7. Settings → Exchange rates → "Fetch last 30 days" (or let the first metric read fetch them), then Settings → Stripe → "Backfill a year".

## Applying migration 180

```bash
# dry run (parses, checks for destructive statements, touches nothing)
python C:/Users/User/Business-Empire-Agent/scripts/apply_turso_migration.py C:/Users/User/APPS/oasis-command-center/database/turso/180_founders_finances.turso.sql --dry-run
# apply to the configured Turso target
python C:/Users/User/Business-Empire-Agent/scripts/apply_turso_migration.py C:/Users/User/APPS/oasis-command-center/database/turso/180_founders_finances.turso.sql
```

It is additive (`CREATE TABLE/INDEX IF NOT EXISTS` only). Validated on a throwaway file: 53/53 statements.

## How Atlas (CFO agent) uses it

All calls: `Authorization: Bearer $FINANCE_AGENT_TOKEN`. Business book only — no internal route can read a personal book.

```bash
# Summary: cash by account, month in/out, open + overdue invoices, revenue collected for [from,to), MRR, GST/QST threshold
curl -s "https://<host>/api/internal/finance/summary?from=2026-09-01&to=2026-10-01" \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>"

# Backfill payments, refunds and subscriptions from OASIS's Stripe (idempotent)
curl -s -X POST https://<host>/api/internal/finance/stripe-reconcile \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" -d '{"days":30}'

# Pull Bank of Canada rates
curl -s -X POST https://<host>/api/internal/finance/fx-refresh \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" -d '{"from":"2026-09-01","to":"2026-09-24"}'

# Submit receipts extracted from email as DRAFTS (not posted until a founder approves)
curl -s -X POST https://<host>/api/internal/finance/transactions \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" \
  -d '{"transactions":[{"date":"2026-09-10","description":"Figma","amount":"-15.00","currency":"USD","account_code":"2100","category":"Software & subscriptions","external_ref":"gmail:18c2f..."}]}'

# Overdue reminders: dry run by default; sends only with exactly {"send": true}
curl -s -X POST https://<host>/api/internal/finance/invoices/remind-overdue \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" -d '{}'
```

`external_ref` makes a re-submitted receipt a no-op. Validation is the same pure code the UI uses (`validation.ts`).

## For Bravo's Today page

`lib/founders-finances/metrics.ts` (business book only, `[from, to)` ISO dates, Toronto days):

- `revenueCollected({ from, to })` → `{ cad_cents, usd_cents, payments, fx_missing_days }`
- `revenueCollectedByDay({ from, to })` → one row per day, zero-filled; sums to `revenueCollected`
- `revenueByCustomer({ from, to })` → sorted by `usd_cents` desc; label never empty ("Unknown customer")
- `stripeMrr()` → `{ mrr_cents, currency, active_subscriptions, as_of }` (active + trialing + past_due; yearly/weekly/daily and quantities normalised to a month; single currency is reported as-is, mixed CAD/USD in CAD at the latest rate)
- `usdPerCad(date)` → USD per 1 CAD for that day (or the prior business day)

## Accounting flows (for the accountant)

| Event | Entry |
|---|---|
| Invoice issued | Dr AR / Cr revenue (/ Cr GST, QST payable when registered), at the issue day's rate |
| Stripe charge, no invoice | Dr Stripe clearing / Cr revenue (subscription revenue if it came from a Stripe invoice), CAD settlement amount |
| Stripe charge for an invoice | Dr Stripe clearing / Cr AR; a USD invoice settles through Currency exchange clearing with realised FX gain/loss |
| Stripe fee | Dr Stripe fees / Cr Stripe clearing (from the charge's balance transaction) |
| Stripe refund | Dr Refunds (contra-revenue) / Cr Stripe clearing |
| Stripe payout hits the bank | bank import → rule → Dr bank / Cr Stripe clearing (a transfer) |
| Manual invoice payment | Dr bank / Cr AR (USD: via exchange clearing, CAD received entered or estimated at the day's rate and flagged) |
| Bill / pay bill | Dr expense (+ ITC/ITR if registered) / Cr AP; then Dr AP / Cr bank |
| Expense | Dr expense (tax included in cost while unregistered) / Cr the account it was paid from |
| Owner draw / contribution | Dr draws-owner / Cr bank; Dr bank / Cr equity-owner |

## Not built (later tier)

- Live bank feeds (Plaid / Flinks) — statements are imported as CSV/OFX/QFX.
- An email-receipt inbox inside Finances — Atlas extracts receipts and posts drafts through the internal API instead.
- A reconciliation matching UI (matching statement lines to Stripe payouts / invoices one-by-one).
- Budgets.
- Automatic creation of recurring expenses on a schedule (they are recorded with one click when due).
- Coupons/discounts and metered prices in MRR; partial credit notes on invoices.
