-- 163 - closed-loop reconciliation for verified Stripe website-sale receipts.
--
-- Turso is the only OASIS sales data plane. A Checkout Session that was valid
-- at close can later be refunded or disputed, so a one-time verification is
-- not enough. These durable fields let the hourly reconciler retry failures,
-- avoid hammering healthy receipts, and preserve the terminal provider fact.
--
-- SQLite cannot widen a CHECK constraint in place. Retire-and-recreate keeps
-- every existing receipt recoverable and mirrors the non-destructive pattern
-- already used by migration 154 (the migration runner intentionally rejects
-- DROP TABLE).

DROP INDEX IF EXISTS "website_sales_receipts_lead_idx";

ALTER TABLE "website_sales_payment_receipts"
  RENAME TO "website_sales_payment_receipts_v1_retired";

CREATE TABLE "website_sales_payment_receipts" (
  "id"                             TEXT NOT NULL PRIMARY KEY,
  "tenant_id"                      TEXT NOT NULL,
  "lead_id"                        TEXT NOT NULL,
  "provider"                       TEXT NOT NULL CHECK ("provider" IN ('stripe','manual')),
  "provider_reference"             TEXT NOT NULL,
  "status"                         TEXT NOT NULL CHECK ("status" IN ('verified','refunded','disputed','voided')),
  "amount_cents"                   INTEGER NOT NULL CHECK ("amount_cents" > 0),
  "currency"                       TEXT NOT NULL CHECK ("currency" IN ('CAD','USD')),
  "provider_status"                TEXT NOT NULL,
  "verification_source"            TEXT NOT NULL CHECK ("verification_source" IN ('stripe_api','founder_manual')),
  "verified_by"                    TEXT NOT NULL,
  "verified_at"                    TEXT NOT NULL,
  "summary"                        TEXT NOT NULL DEFAULT '{}',
  "last_reconciliation_attempt_at" TEXT,
  "last_reconciled_at"             TEXT,
  "reconciliation_attempts"        INTEGER NOT NULL DEFAULT 0 CHECK ("reconciliation_attempts" >= 0),
  "last_reconciliation_error"      TEXT,
  "terminal_at"                    TEXT,
  "terminal_reason"                TEXT,
  "created_at"                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("tenant_id", "provider", "provider_reference"),
  UNIQUE ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("lead_id") REFERENCES "tenant_records" ("id") ON DELETE CASCADE
);

INSERT INTO "website_sales_payment_receipts" (
  "id","tenant_id","lead_id","provider","provider_reference","status",
  "amount_cents","currency","provider_status","verification_source",
  "verified_by","verified_at","summary","created_at","updated_at"
)
SELECT
  "id","tenant_id","lead_id","provider","provider_reference","status",
  "amount_cents","currency","provider_status","verification_source",
  "verified_by","verified_at","summary","created_at","updated_at"
FROM "website_sales_payment_receipts_v1_retired";

CREATE INDEX IF NOT EXISTS "website_sales_receipts_lead_idx"
  ON "website_sales_payment_receipts" ("tenant_id", "lead_id", "verified_at" DESC);

CREATE INDEX IF NOT EXISTS "website_sales_receipts_reconcile_idx"
  ON "website_sales_payment_receipts"
     ("provider", "status", "last_reconciled_at", "verified_at" DESC);
