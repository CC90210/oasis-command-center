-- 184 - FOUNDERS > Finances: how an invoice asks to be paid (2026-09-24).
--
-- fin_invoices.payment_method:
--   'wise'        bank transfer into the Wise account for the invoice currency,
--                 invoice number as the payment reference (the app's default
--                 for a NEW one-off / lump-sum invoice);
--   'stripe'      a card Payment Link (recurring MRR stays on Stripe
--                 subscriptions, which is not an invoice);
--   'wise_stripe' both.
--
-- The column DEFAULT is 'stripe' on purpose: every invoice that exists before
-- this migration was issued with a card link, so they keep behaving exactly
-- as they did. New drafts get 'wise' from the application, not from here.
--
-- Additive only. Until it is applied, lib/founders-finances/invoice-store.ts
-- paymentMethodColumnReady() reports false and every invoice reads as
-- 'stripe'; nothing breaks, and choosing Wise is refused with a message
-- that names this migration.
--
-- No fin_payments change: a Wise payment is a 'manual' row (the source CHECK
-- only allows 'stripe' | 'manual', and widening a CHECK needs a table
-- rebuild), made idempotent by its settlement journal entry
-- (source 'wise_payment', source_ref = Wise's transaction reference), which
-- uq_fin_journal_source already makes unique.

ALTER TABLE fin_invoices ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'stripe'
  CHECK (payment_method IN ('wise', 'stripe', 'wise_stripe'));
