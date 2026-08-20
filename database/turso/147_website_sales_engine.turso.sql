-- 147 — website sales engine tables, libSQL port of database/146 plus the
-- comp-v2 closed_by column from database/147_website_sales_comp_v2.sql.
--
-- WHY 147 CARRIES THE WHOLE ENGINE. Migration 146 shipped on main as Postgres
-- only and was NEVER applied to Turso (verified 2026-08-19: no website_*
-- tables exist there). Production runs EMPIRE_DATA_BACKEND=turso_cloud, so
-- this file is the first time the engine's tables exist where the app
-- actually reads and writes. It ports 146's three tables + four indexes in
-- one pass, already carrying the comp-v2 shape (closed_by), so the Turso
-- schema never passes through the retired 10/12.5/15% tier state.
--
-- Dialect notes (house conventions, see 142-146):
--   * uuid -> TEXT; the app supplies ids (crypto.randomUUID in the RPC shim).
--     SQLite has no gen_random_uuid().
--   * timestamptz -> TEXT ISO-8601 UTC, DEFAULT strftime('...Z','now').
--   * numeric(12,2) -> REAL; the shim writes plain JS numbers.
--   * text[] automation_ids -> TEXT holding a JSON array, DEFAULT '[]'.
--   * CHECK constraints kept verbatim — SQLite enforces them natively.
--   * NO RLS statements — Turso has none; tenant scoping is manual in the
--     adapter/shim (every statement carries tenant_id).
--   * close_website_deal() itself is NOT SQL here: it lives as a TS port in
--     lib/turso-rpc-shim.ts, dispatched by getServiceSupabase()'s rpc proxy.
--
-- No explicit BEGIN/COMMIT: the migration runner executes a file as one
-- transactional batch, and a nested BEGIN errors out.

CREATE TABLE IF NOT EXISTS "website_deals" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "tenant_id"        TEXT NOT NULL,
  "lead_id"          TEXT NOT NULL,
  "rep_user_id"      TEXT NOT NULL,
  "founder_user_id"  TEXT NOT NULL,
  -- Comp v2: who actually closed. closed_by = rep_user_id => opener-closer
  -- (30%); anyone else (the founder) => opener (20%). NULL never occurs on
  -- rows written by the shim; the column is nullable only to mirror the
  -- Postgres companion, where pre-147 rows keep NULL.
  "closed_by"        TEXT,
  "package_id"       TEXT NOT NULL CHECK ("package_id" IN ('essential','growth','authority')),
  "automation_ids"   TEXT NOT NULL DEFAULT '[]',
  "currency"         TEXT NOT NULL CHECK ("currency" IN ('CAD','USD')),
  "setup_amount"     REAL NOT NULL CHECK ("setup_amount" >= 0),
  "monthly_amount"   REAL NOT NULL CHECK ("monthly_amount" >= 0),
  "proposal_status"  TEXT NOT NULL DEFAULT 'not_started' CHECK ("proposal_status" IN ('not_started','draft','sent','accepted','declined')),
  "status"           TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','won','lost','refunded')),
  "payment_reference" TEXT,
  "loss_reason"      TEXT,
  "closed_at"        TEXT,
  "created_at"       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("tenant_id", "lead_id"),
  -- Backs the composite FKs from commissions/onboarding, as in Postgres.
  UNIQUE ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("lead_id") REFERENCES "tenant_records" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "website_sales_commissions" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "tenant_id"              TEXT NOT NULL,
  "deal_id"                TEXT NOT NULL,
  "rep_user_id"            TEXT NOT NULL,
  "payment_reference"      TEXT NOT NULL,
  "entry_type"             TEXT NOT NULL DEFAULT 'accrual' CHECK ("entry_type" IN ('accrual','refund_offset','manual_adjustment')),
  "collected_setup_amount" REAL NOT NULL,
  "rate"                   REAL NOT NULL CHECK ("rate" >= 0 AND "rate" <= 1),
  "amount"                 REAL NOT NULL,
  -- Always born 'accrued'. Founder approval moves it forward; rep-closed
  -- deals must NEVER auto-approve (comp v2 contract).
  "status"                 TEXT NOT NULL DEFAULT 'accrued' CHECK ("status" IN ('accrued','approved','paid','offset','voided')),
  "approved_by"            TEXT,
  "approved_at"            TEXT,
  "paid_at"                TEXT,
  "created_at"             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One accrual per collected payment: the idempotent re-close no-ops on this.
  UNIQUE ("tenant_id", "payment_reference", "entry_type"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id", "deal_id") REFERENCES "website_deals" ("tenant_id", "id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "website_onboarding" (
  "id"                   TEXT NOT NULL PRIMARY KEY,
  "tenant_id"            TEXT NOT NULL,
  "deal_id"              TEXT NOT NULL,
  "lead_id"              TEXT NOT NULL,
  "fulfillment_owner_id" TEXT,
  "status"               TEXT NOT NULL DEFAULT 'assets_needed' CHECK ("status" IN ('assets_needed','ready','in_build','client_review','launched','blocked')),
  "target_launch_date"   TEXT,
  "intake"               TEXT NOT NULL DEFAULT '{}',
  "qa"                   TEXT NOT NULL DEFAULT '{}',
  "client_approved_at"   TEXT,
  "launched_at"          TEXT,
  "created_at"           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("tenant_id", "deal_id"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("lead_id") REFERENCES "tenant_records" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id", "deal_id") REFERENCES "website_deals" ("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "website_deals_pipeline_idx"
  ON "website_deals" ("tenant_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "website_commissions_rep_idx"
  ON "website_sales_commissions" ("tenant_id", "rep_user_id", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "website_onboarding_board_idx"
  ON "website_onboarding" ("tenant_id", "status", "updated_at" DESC);

-- Rep-action idempotency: the pipeline route inserts one lead_interactions row
-- per request_id and relies on a unique violation to detect replays. metadata
-- is TEXT JSON in Turso, so the jsonb ->> becomes json_extract; SQLite supports
-- both expression and partial indexes (3.9+/3.8+).
CREATE UNIQUE INDEX IF NOT EXISTS "website_sales_interaction_request_uidx"
  ON "lead_interactions" ("tenant_id", json_extract("metadata", '$.request_id'))
  WHERE "agent_source" = 'website_sales_pipeline'
    AND json_extract("metadata", '$.request_id') IS NOT NULL;
