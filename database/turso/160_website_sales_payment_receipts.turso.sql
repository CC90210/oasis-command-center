-- 160 — commission accrues only against a verified cash receipt.
-- Turso is the production data plane for the OASIS sales engine.

CREATE TABLE IF NOT EXISTS "website_sales_payment_receipts" (
  "id"                  TEXT NOT NULL PRIMARY KEY,
  "tenant_id"           TEXT NOT NULL,
  "lead_id"             TEXT NOT NULL,
  "provider"            TEXT NOT NULL CHECK ("provider" IN ('stripe','manual')),
  "provider_reference"  TEXT NOT NULL,
  "status"              TEXT NOT NULL CHECK ("status" IN ('verified','refunded','voided')),
  "amount_cents"        INTEGER NOT NULL CHECK ("amount_cents" > 0),
  "currency"            TEXT NOT NULL CHECK ("currency" IN ('CAD','USD')),
  "provider_status"     TEXT NOT NULL,
  "verification_source" TEXT NOT NULL CHECK ("verification_source" IN ('stripe_api','founder_manual')),
  "verified_by"         TEXT NOT NULL,
  "verified_at"         TEXT NOT NULL,
  "summary"             TEXT NOT NULL DEFAULT '{}',
  "created_at"          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("tenant_id", "provider", "provider_reference"),
  UNIQUE ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("lead_id") REFERENCES "tenant_records" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "website_sales_receipts_lead_idx"
  ON "website_sales_payment_receipts" ("tenant_id", "lead_id", "verified_at" DESC);

ALTER TABLE "website_deals" ADD COLUMN "payment_provider" TEXT
  CHECK ("payment_provider" IS NULL OR "payment_provider" IN ('stripe','manual'));

ALTER TABLE "website_deals" ADD COLUMN "verified_payment_id" TEXT;
