-- 185 - FOUNDERS > Finances: one-time + monthly retainer on one invoice (2026-09-24).
--
-- An OASIS client is billed an IMPLEMENTATION price (one-time) and a
-- RETAINER (monthly). Both go on the same invoice, and they are paid two
-- different ways:
--   one-time lines -> the invoice's receivable, paid by bank transfer into
--                     Wise (or the card link, per fin_invoices.payment_method
--                     from migration 184);
--   monthly lines  -> a Stripe RECURRING Payment Link the client uses to start
--                     automatic monthly card payments.
--
-- fin_invoice_lines.billing:
--   'one_time' (the default: every line that exists before this migration is
--              one), 'monthly'.
--
-- NO DOUBLE COUNTING. subtotal/gst/qst/total_cents on fin_invoices stay the
-- ONE-TIME figures, so AR, "balance due", paid/overdue, the Wise reconcile
-- and every report keep reading one number that means "what is owed now".
-- Monthly lines are NOT booked at issue: each month's retainer arrives as a
-- Stripe subscription charge through the existing Stripe ingest, which books
-- it as subscription revenue. retainer_monthly_cents records the retainer the
-- client is asked to subscribe to (the monthly lines); it is informational
-- and never posted. A retainer that would carry GST/QST is refused until the
-- Stripe ingest splits tax out of subscription charges (invoice.ts
-- RETAINER_TAX_REFUSED): booked gross, its tax would be counted as revenue.
--
-- stripe_retainer_*: the Stripe Product, recurring monthly Price and Payment
-- Link created for this invoice's retainer (lib/founders-finances/
-- invoices-io.ts ensureRetainerLink), and the amount + currency the link was
-- made for, so a re-send reuses it while the amount is unchanged and replaces
-- it when it changes. The price and the amount + currency it charges are saved
-- as soon as Stripe creates it, before the link is asked for: a send whose link
-- Stripe refuses is retried with the SAME price rather than a new one (Stripe's
-- idempotency window is only 24 hours). The link and its subscriptions carry
-- metadata fin_retainer_invoice_id / fin_retainer_invoice_number — NOT
-- fin_invoice_id, which the Stripe ingest reads as "this charge settles the
-- invoice's receivable". A retainer charge must never settle the one-time AR.
--
-- Additive only, every column defaulted or nullable: existing rows keep
-- working. Until it is applied, invoice-store.ts retainerColumnsReady()
-- reports false, every line reads as one-time and the app behaves exactly as
-- it did; a monthly line is refused with a message that names this migration.

ALTER TABLE fin_invoice_lines ADD COLUMN billing TEXT NOT NULL DEFAULT 'one_time'
  CHECK (billing IN ('one_time', 'monthly'));

ALTER TABLE fin_invoices ADD COLUMN retainer_monthly_cents INTEGER NOT NULL DEFAULT 0
  CHECK (retainer_monthly_cents >= 0);
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_product_id TEXT;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_price_id TEXT;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_price_cents INTEGER;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_price_currency TEXT;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_link_id TEXT;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_link_url TEXT;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_link_cents INTEGER;
ALTER TABLE fin_invoices ADD COLUMN stripe_retainer_link_currency TEXT;
