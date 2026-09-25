# FOUNDERS > Finances — bookkeeping for OASIS AI Solutions

**Status:** built on branch `feat/finances-suite`, not deployed. Migration 180 is written and validated on a throwaway database; it has **not** been applied to the live Turso database.
**Code:** `lib/founders-finances/` (rules + I/O), `app/founders/finances/` (pages), `app/api/founders/finances/` (UI routes), `app/api/internal/finance/` (Atlas), `app/api/webhooks/stripe-finance/` (Stripe).
**Tests:** `npm run test:finances` (in CI) — `tests/finances-core.test.ts` (pure rules), `tests/finances-io.test.ts` (real local libSQL + the real route handlers), `tests/finances-surface.test.ts` (nav, gates, PDF, email, CSV). The one-time + retainer invoice flow is `tests/finances-invoice-retainer.test.ts` (run it directly: `node --conditions=react-server --import tsx tests/finances-invoice-retainer.test.ts`; it is not yet listed in the `test:finances` script).

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
| `invoices`, `invoice_lines` | invoices, statuses draft → sent → overdue → paid / void. Each line is billed `one_time` or `monthly` (migration 185, see **Invoices: implementation + retainer**) |
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
| `WISE_API_TOKEN`, `WISE_PROFILE_ID` | Wise bank details on invoices, "Check for Wise payments", the Wise bank feed | invoices go out with the card link / payment instructions and say why; Wise sync and reconcile answer 503 (see **Wise** below) |
| `FOUNDERS_TENANT_IDS`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_*` | already required by the app | — |

## What needs a founder before this is live

1. **Apply migration 180** to the live Turso database (below).
2. **Create the Stripe webhook** in OASIS's own Stripe dashboard → Developers → Webhooks → endpoint `https://<command-center-host>/api/webhooks/stripe-finance`, events: `payment_intent.succeeded`, `charge.succeeded`, `charge.refunded`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret in `STRIPE_FINANCE_WEBHOOK_SECRET`.
3. **Confirm the Stripe account** in Finances → Settings → Stripe. The page shows which account the configured key belongs to (`GET /v1/account`); a founder confirms it is OASIS's own account (not Trytan's, PropFlow's or the store's). Until then Finances creates no payment links and runs no reconcile.
4. **Set `FINANCE_AGENT_TOKEN`** and give the same value to Atlas.
5. Make sure an OASIS mailbox is configured (`OASIS_MAIL_FROM`/`OASIS_MAIL_APP_PASSWORD` already exist for the shared sender, or set `INVOICE_FROM_*`).
6. Settings → fill payment instructions (e-transfer address) that print on every invoice.
7. Settings → Exchange rates → "Fetch last 30 days" (or let the first metric read fetch them), then Settings → Stripe → "Backfill a year".
8. For retainers on invoices: **apply migration 185** (same command as 180, file `185_finance_invoice_retainer.turso.sql`; applied 2026-09-25). The Worker's `STRIPE_SECRET_KEY` must be able to **write** Prices and Payment Links. Since 2026-09-25 it is OASIS's full live secret key (env store `OASIS_AI_PLATFORM__STRIPE_SECRET_KEY`, account `acct_1RyM4HHj2zGc7I1J`; the restricted key it replaced was refused those writes), verified with `Business-Empire-Agent/scripts/integrations/stripe_key_account.py --probe --probe-key OASIS_AI_PLATFORM__STRIPE_SECRET_KEY`. If a later key lacks them, sending an invoice that needs a Stripe link is refused with one sentence saying so; nothing is emailed.

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
| Invoice issued | Dr AR / Cr revenue (/ Cr GST, QST payable when registered), at the issue day's rate — the **one-time lines only**; a retainer-only invoice posts nothing |
| Monthly retainer | nothing at issue. Each month's charge on the Stripe subscription the client starts from the invoice's retainer link arrives through the Stripe ingest: Dr Stripe clearing / Cr Subscription revenue (the "Stripe charge, no invoice" row) |
| Stripe charge, no invoice | Dr Stripe clearing / Cr revenue (subscription revenue if it came from a Stripe invoice), CAD settlement amount |
| Stripe charge for an invoice | Dr Stripe clearing / Cr AR; a USD invoice settles through Currency exchange clearing with realised FX gain/loss |
| Stripe fee | Dr Stripe fees / Cr Stripe clearing (from the charge's balance transaction) |
| Stripe refund | Dr Refunds (contra-revenue) / Cr Stripe clearing |
| Stripe payout hits the bank | bank import → rule → Dr bank / Cr Stripe clearing (a transfer) |
| Manual invoice payment | Dr bank / Cr AR (USD: via exchange clearing, CAD received entered or estimated at the day's rate and flagged) |
| Bill / pay bill | Dr expense (+ ITC/ITR if registered) / Cr AP; then Dr AP / Cr bank |
| Expense | Dr expense (tax included in cost while unregistered) / Cr the account it was paid from |
| Owner draw / contribution | Dr draws-owner / Cr bank; Dr bank / Cr equity-owner |

## Invoices: implementation + retainer (migration 185)

An OASIS client usually pays an **implementation** price once and a **retainer** every month. Both go on one invoice, and they are paid two different ways:

| Part | Lines | Paid by | Booked |
|---|---|---|---|
| Implementation (due now) | `billing = 'one_time'` (the default) | bank transfer into Wise, invoice number as the reference — or the card link, per the invoice's payment method (below, **Wise**), which applies to this part only | at issue: Dr AR / Cr revenue |
| Monthly retainer | `billing = 'monthly'` | a Stripe **recurring** Payment Link the client uses once to set up automatic monthly card payments | each month, when Stripe collects it (Stripe ingest → Subscription revenue) |

**No double counting.** `fin_invoices.subtotal/gst/qst/total_cents` are the ONE-TIME figures, so AR, "balance due", paid, overdue, the Wise reconcile, AR aging and every report keep reading one number that means "owed now". `retainer_monthly_cents` records the retainer (its monthly lines); it is informational and never posted. An invoice is **paid** when its one-time balance is paid; the retainer link stays live after that (the client may not have subscribed yet). An invoice may be all one-time (as before 185), both, or **all monthly** — a retainer set-up invoice: nothing is due now, nothing is booked at issue, it is never overdue and never reminded, and "Record a payment" is refused with a sentence.

**The retainer link** (`invoices-io.ts ensureRetainerLink`), created when the invoice is emailed: a Product ("Monthly retainer — invoice N"), a Price with `recurring[interval]=month` for the retainer amount in the invoice currency, and a Payment Link limited to one completed checkout. Idempotency keys are the invoice id (+ amount + currency for the price, + price + the link being replaced for the link, so going back to an earlier amount makes a new link instead of replaying a switched-off one). The price and the amount + currency it charges (`stripe_retainer_price_id/_cents/_currency`) are saved as soon as Stripe creates it, so a send whose link Stripe refuses is retried with the same price rather than a new one each time. A re-send first asks Stripe for the stored link's state: **unused and live** → reused while the amount and currency are unchanged; when they change, a new price + link on the same product, the old link switched off before the new one is handed out. **Used** (the client completed its one checkout, which also switches it off) → the email and PDF say "automatic monthly card payments are already set up" instead of carrying the dead link; a retainer-only invoice then has nothing left to send and the re-send is refused in a sentence; a changed amount is refused too (a new link would start a second subscription — change the subscription in Stripe). **Switched off unused** (someone turned it off in Stripe) → refused, saying to turn it back on. Every link carries an `inactive_message` telling a client who opens an old one that there is nothing more to do if they already set up payments. Voiding the invoice switches the link off; a subscription the client already started keeps running until it is cancelled in Stripe. Metadata on the link and on every subscription it starts: `fin_retainer_invoice_id`, `fin_retainer_invoice_number` (+ `fin_contact_id` on the subscription) — deliberately **not** `fin_invoice_id`, which the Stripe ingest reads as "this charge settles the invoice's receivable". A retainer charge must never clear the one-time AR.

**Stripe permissions.** The link needs Prices and Payment Links **write** on the Worker's OASIS key (the full live key has both, 2026-09-25). A 403 from Stripe refuses the send in one sentence — for the retainer: *"Stripe won't let this app create the retainer's card link yet: give the OASIS restricted key write access to Prices and Payment Links in Stripe → Developers → API keys, then send again. Nothing was emailed."*; the one-off card link says the same for "the invoice's card payment link" (it used to surface Stripe's raw 403). The invoice stays issued-not-emailed and is re-sent without renumbering. Stripe not set up at all (no key / account not confirmed) refuses a retainer invoice the same way, naming the reason.

**Email and PDF.** With a retainer they have two separate parts — "Implementation — {amount} due by {date}: pay by bank transfer" (Wise details + reference; "…or card" with the card link when the method includes card) and "Monthly retainer — {amount}/month: set up automatic monthly card payments" (the Stripe link) — and the totals show **Due now** and **Monthly retainer** apart. Monthly lines print "/mo". Overdue reminders chase the one-time balance only and never mention the retainer. Without a retainer both are exactly what they were.

**GST/QST on a retainer is refused for now.** Registered, a taxable monthly line would put GST + QST into the Stripe price, and the Stripe ingest books every subscription charge entirely as Subscription revenue — it has no tax split — so the tax would be counted as income and never reach GST/QST payable. `invoice.ts retainerTaxRefusal` refuses it in one sentence when a draft is saved, when it is issued (registration may have been switched on since) and in the editor before Save. A monthly line not marked taxable (e.g. zero-rated for a non-resident client) is fine, and nothing changes while OASIS is not registered. Lift the refusal once the Stripe ingest splits retainer tax out of subscription charges.

**Editor.** Each line has a One-time / Monthly toggle; the summary shows "Due now (bank transfer)" and "Monthly retainer (card, automatic)" with one line on where each is paid. The invoice list shows "+ {amount}/mo retainer" under the total; the invoice page shows both totals and the retainer link once created.

**Before 185 is applied** (`invoice-store.ts retainerColumnsReady()` false, re-checked every minute): no toggle, every line is one-time, nothing reads or writes a retainer, and a monthly line sent by any caller is refused with a message naming 185.

**Not handled yet (outside the invoice code):** a retainer charge is booked as Subscription revenue under the Stripe customer, not linked to the invoice's contact automatically (the subscription's `fin_contact_id` metadata is there for that), and the app does not learn that the client subscribed until a re-send asks Stripe. The Stripe ingest has no GST/QST split (hence the refusal above). A retainer-only invoice stays `sent` with a $0 balance for good, and `app/api/internal/finance/summary/route.ts` (what Atlas reads) lists every `sent`/`overdue` invoice as open — it should skip zero-balance invoices or report `retainer_cents` beside them.

## Wise (the business bank)

Wise is where money lands; Stripe is the card processor. A one-off or lump-sum invoice asks for a **bank transfer into Wise**; recurring billing (MRR) stays on Stripe subscriptions, where automatic payment matters. Business chequing (1000) **is** the Wise account, holding CAD and USD as themselves.

**Env (names only):** `WISE_API_TOKEN`, `WISE_PROFILE_ID` (the BUSINESS profile id). Unset → every Wise surface says so in a sentence ("Wise is not connected…") and nothing guesses: invoices go out with the card link and/or the payment instructions, sync and reconcile answer 503 for Atlas. Every call is a GET; nothing in the command center can move money through Wise.

**Endpoints (probed live 2026-09-24 with `Business-Empire-Agent/scripts/integrations/wise_tool.py`):**

| Endpoint | Result | Used for |
|---|---|---|
| `GET /v2/profiles` | 200 | profile name |
| `GET /v4/profiles/{p}/balances?types=STANDARD` | 200 (CAD, USD, EUR, GBP balances) | balance ids + amounts |
| `GET /v1/profiles/{p}/balance-statements/{balance}/statement.json` | 200, no SCA for this profile | receiving details (`bankDetails`, labelled "Institution number", "Transit number", "Routing number (ACH or ABA)", "Swift/BIC"), every transaction with its running balance |
| `GET /v1/profiles/{p}/account-details` | **403** for this token | not used |
| `GET /v1/borderless-accounts` | 200 but no CAD transit number | not used |

A 403 carrying `x-2fa-approval` (Strong Customer Authentication) is reported as such, never retried.

**Invoice payment method** (`fin_invoices.payment_method`, migration 184) — how the **one-time** part is paid (a monthly retainer is always the Stripe recurring link, see above): `wise` (default for a new invoice), `stripe` (card Payment Link; every invoice from before 184), `wise_stripe` (both). The PDF and the email print the Wise receiving details **for the invoice currency** — account holder, bank, institution/transit or routing, account number, Swift — with the **invoice number as the payment reference**; settings' payment instructions still print as an extra line. If Wise cannot supply details, the invoice falls back to the card link or the instructions and the send result says why; with none of the three it is refused, not sent. Before migration 184 is applied the column is absent: every invoice reads `stripe`, and choosing Wise is refused with a message naming 184.

**Mark paid from Wise** (`wise-reconcile.ts`, button "Check for Wise payments"): reads recent deposits (bank transfers in, Wise-acquired card payments net of Wise's fee). Recorded automatically ONLY when the payer's reference names exactly one open invoice AND the amount and currency settle it; everything else (no reference, wrong amount, two invoices named) is listed for a founder to confirm or dismiss. Idempotent on Wise's transaction reference (settlement entry source `wise_payment`, unique). A USD payment stays USD on chequing (the settlement goes through Currency exchange clearing, realised FX as usual).

**Bank feed** (`wise-feed-io.ts`, button "Sync Wise"): Wise CAD and USD activity → Transactions on Business chequing, through the SAME import as a CSV/OFX upload (the statement is rendered as OFX): same dedupe, same rules, same import history. FITID = `WISE-<currency>-<CREDIT|DEBIT>-<Wise reference>`, so a re-sync inserts nothing (and records no empty import). USD rows post at the stored own-day rate. **Stripe payouts do not say "Stripe" on Wise** — they arrive as "Received money from OASIS AI"; a deposit is tagged `Stripe payout po_…` only when it matches a real Stripe payout (currency, amount to the cent, within 3 days), which the seeded "stripe" rule then books as a transfer from Stripe clearing. Without a working Stripe key, payouts import unreviewed. A deposit already recorded against an invoice imports as *excluded* (and reconcile excludes an unreviewed fed line when it records), so the money is counted once.

**Opening balance** (founder only, "Preview" then "Post"): for a chosen day, compares 1000 Business chequing per currency (entries dated on or before it) with Wise's balance at the end of that Toronto day, and posts the difference against 3900 Retained earnings — one entry per currency, source `opening_balance`, ref `wise:<currency>:<date>` (unique). The business chart has no opening-balance account of its own; retained earnings is the owner-neutral equity. Never automatic; not exposed to Atlas.

```bash
# Match Wise deposits to open invoices — dry run unless "dry_run": false
curl -s -X POST https://<host>/api/internal/finance/wise-reconcile \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" -d '{"days":30}'
# Import Wise activity into Transactions — dry run unless "dry_run": false
curl -s -X POST https://<host>/api/internal/finance/wise-sync \
  -H "Authorization: Bearer <FINANCE_AGENT_TOKEN>" -H "Content-Type: application/json" -d '{"since":"2026-09-01"}'
```

## Not built (later tier)

- Live bank feeds for banks other than Wise (Plaid / Flinks) — those statements are imported as CSV/OFX/QFX.
- An email-receipt inbox inside Finances — Atlas extracts receipts and posts drafts through the internal API instead.
- A reconciliation matching UI (matching statement lines to Stripe payouts / invoices one-by-one).
- Budgets.
- Automatic creation of recurring expenses on a schedule (they are recorded with one click when due).
- Coupons/discounts and metered prices in MRR; partial credit notes on invoices.
