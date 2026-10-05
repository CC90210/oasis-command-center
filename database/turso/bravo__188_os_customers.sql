-- bravo__188_os_customers.sql — Clients (the business's OWN customers) and the
-- per-workspace support desk (2026-09-28).
--
-- Design: docs/os-revamp/02-data-safety-sunbiz-retirement.md §3.5 and
-- docs/os-revamp/PLAN.md decision 5 — "Clients" is the owner's own customers,
-- a first-class `customers` table, not tenant_records JSON. Leads stay in
-- tenant_records; converting a won lead sets customers.source_lead_id.
--
-- CONVENTIONS (binding, from 183_delivery_and_support.turso.sql):
--   - every table carries tenant_id TEXT NOT NULL and every index leads with it.
--     libSQL has no row-level security: lib/os/customers/store.ts binds the
--     session's tenant into every WHERE, and that WHERE is the boundary.
--   - ids are TEXT (UUIDs written by the app); timestamps are ISO-8601 UTC
--     strings written by the app (new Date().toISOString()).
--   - NO CHECK constraints on enum columns. The allowed lifecycle values live
--     once, in lib/os/customers/rules.ts, pinned by tests/os-customers.test.ts.
--   - additive only: new tables, new nullable columns, new indexes. No DROP.
--
-- ORDERING. The code that ships with this file treats a missing table as "not
-- switched on yet" where it can (support intake, the pipeline card), and never
-- writes customer_id unless it has a value, so the OASIS help desk keeps working
-- before this is applied. /clients itself needs the table and says so.
--
-- NOT RE-RUNNABLE AS A WHOLE: SQLite has no ADD COLUMN IF NOT EXISTS. The
-- migration ledger (scripts/apply_turso_migration.py) applies it once.

-- customers: one row per customer of the workspace.
-- display_name   what the business calls them (a company or a person).
-- primary_email  lowercased by the app, so the unique index below matches.
-- primary_phone  E.164 when the app could normalise it, otherwise as typed.
-- lifecycle      prospect | onboarding | active | paused | churned (rules.ts).
-- owner_user_id  the teammate (auth user id, lowercased) who owns the account.
-- source_lead_id the tenant_records lead this client was converted from. Unique
--                per workspace, which is what makes "Convert to client"
--                idempotent under a double click or two tabs.
-- tags           JSON array of strings; custom_fields JSON object (industry pack).
CREATE TABLE IF NOT EXISTS customers (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  company_name        TEXT,
  primary_email       TEXT,
  primary_phone       TEXT,
  lifecycle           TEXT NOT NULL DEFAULT 'active',
  owner_user_id       TEXT,
  source_lead_id      TEXT,
  stripe_customer_id  TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',
  custom_fields       TEXT NOT NULL DEFAULT '{}',
  archived_at         TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_email
  ON customers (tenant_id, primary_email)
  WHERE primary_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_stripe
  ON customers (tenant_id, stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_source_lead
  ON customers (tenant_id, source_lead_id)
  WHERE source_lead_id IS NOT NULL;
-- The /clients list: a workspace's clients by lifecycle, most recently touched first.
CREATE INDEX IF NOT EXISTS idx_customers_tenant_lifecycle
  ON customers (tenant_id, lifecycle, updated_at);

-- customer_contacts: the other people at a client. email lowercased by the app.
CREATE TABLE IF NOT EXISTS customer_contacts (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  role         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant_customer
  ON customer_contacts (tenant_id, customer_id);
-- Support intake matches a submitter's email to a contact as well as to the
-- client's primary address.
CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant_email
  ON customer_contacts (tenant_id, email);

-- Tickets and projects name the client they belong to. Nullable: every
-- existing row keeps working, and a public-form ticket from an unknown address
-- simply has no client.
ALTER TABLE support_tickets ADD COLUMN customer_id TEXT;
ALTER TABLE delivery_projects ADD COLUMN customer_id TEXT;
-- A client record's Tickets tab and its open-ticket count.
CREATE INDEX IF NOT EXISTS idx_st_tenant_customer
  ON support_tickets (tenant_id, customer_id, status);
-- A client record's Projects tab.
CREATE INDEX IF NOT EXISTS idx_dp_tenant_customer
  ON delivery_projects (tenant_id, customer_id, updated_at);

-- support_desks: which form is a workspace's public support form.
-- The forms table has no kind column, and a workspace may already own a lead
-- form whose slug happens to be `support`; that form must keep creating leads.
-- A row here is what makes /f/<tenant>/support file a TICKET for that
-- workspace. OASIS's own form (/f/oasis-ai-cc/support, seeded by 183) is
-- recognised by its fixed tenant + slug as before and needs no row.
-- One desk per workspace (tenant_id is the key).
CREATE TABLE IF NOT EXISTS support_desks (
  tenant_id   TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,
  enabled_by  TEXT,
  enabled_at  TEXT NOT NULL
);
