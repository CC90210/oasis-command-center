-- bravo__193_stripe_payouts.sql - Stripe payouts in the books (OASIS OS plan
-- v2 §F1.1 fix 2, 2026-09-29).
--
-- WHY. Today showed "Cash on hand -CA$1,788.23" because nothing ever booked a
-- Stripe payout: every card charge landed in 1050 Stripe clearing and never
-- left it, while the money itself went on to the bank. The webhook now
-- handles payout.paid / payout.failed / payout.canceled and the daily
-- reconcile lists /v1/payouts, both through lib/founders-finances/
-- stripe-payouts-io.ts. This migration holds what they need:
--
--   fin_stripe_payouts                  one row per Stripe payout (po_...),
--                                       what Stripe said about it and what
--                                       the books did with it.
--   fin_settings.stripe_payout_account_id
--                                       the bank account payouts land in.
--                                       NULL = not chosen: a payout is
--                                       recorded as a gap ("unmapped") and
--                                       never booked to a guessed account.
--
-- booking   booked     an entry moves the payout out of Stripe clearing into
--                      bank_account_id (entry_id; source 'stripe_payout', or
--                      the Wise bank line's own entry when the bank feed
--                      booked it first).
--           held       recognised, not booked, `reason` says why (Stripe
--                      clearing does not hold it, no exchange rate yet,
--                      Stripe did not say what left the balance). The next
--                      reconcile retries it.
--           unmapped   no payout account chosen in Finances > Settings >
--                      Stripe. Retried by every reconcile once one is.
--           not_booked failed or canceled before anything was booked.
--           reversed   booked, then Stripe reported it failed: a reversal
--                      entry (reversal_entry_id) undoes it.
-- amount_cents / currency   what reaches the bank, as Stripe states it.
-- settlement_cents / settlement_currency / fee_cents
--                      what the payout took from the Stripe balance (its
--                      balance transaction), NULL when Stripe did not say.
-- arrival_date         Stripe's arrival day, YYYY-MM-DD (the entry's date).
--
-- Ids and amounts only: no names, no bank numbers (destination_id is Stripe's
-- ba_/card_ id of the external account, not the account number).
--
-- Additive only. Not applied by the author: the lead applies it BEFORE the
-- code that ships with it is deployed (the webhook writes this table on the
-- first payout event, and loadSettings reads the new column).

CREATE TABLE IF NOT EXISTS fin_stripe_payouts (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL REFERENCES fin_entities(id),
  stripe_status       TEXT NOT NULL,
  booking             TEXT NOT NULL CHECK (booking IN ('booked', 'held', 'unmapped', 'not_booked', 'reversed')),
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  arrival_date        TEXT NOT NULL,
  settlement_cents    INTEGER,
  settlement_currency TEXT,
  fee_cents           INTEGER NOT NULL DEFAULT 0,
  destination_id      TEXT,
  bank_account_id     TEXT REFERENCES fin_accounts(id),
  entry_id            TEXT,
  reversal_entry_id   TEXT,
  reason              TEXT,
  livemode            INTEGER NOT NULL DEFAULT 1 CHECK (livemode IN (0, 1)),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- The cash tile's "payouts not booked" gap, and the reconcile's retry list.
CREATE INDEX IF NOT EXISTS idx_fin_stripe_payouts_booking
  ON fin_stripe_payouts (entity_id, booking, arrival_date);

ALTER TABLE fin_settings ADD COLUMN stripe_payout_account_id TEXT REFERENCES fin_accounts(id);
