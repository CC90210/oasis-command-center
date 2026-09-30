-- bravo__195_customers_links.sql - link a client record to the client's own
-- OASIS workspace, and let a client's Activity read the ledger by client
-- (OASIS OS S2 T6, Clients hub, 2026-09-30).
--
-- WHY. A client record (customers, bravo__188) could not find anything the
-- client does in their own OASIS workspace: client_roi_snapshots, the agent
-- channels' last turns, approvals and the client's own support desk are all
-- keyed by the CLIENT's tenant_id, and customers had no column naming it. The
-- operator-only "Link workspace" action on the record (POST
-- /api/clients/[id]/link-workspace) writes client_tenant_id; the record's
-- Usage tab then reads those tables for that tenant. This is how OASIS
-- collects its clients' usage.
--
-- lifecycle needs NO rebuild: bravo__188 has no CHECK constraint on it (the
-- vocabulary lives in lib/os/customers/rules.ts, which already carries
-- 'churned', shown as "Past"). So nothing here copies or rebuilds a table.
--
-- CONVENTIONS (binding, from 183_delivery_and_support.turso.sql and 188):
--   - every index leads with tenant_id; the store binds the session's tenant
--     into every WHERE (libSQL has no row-level security).
--   - additive only: one nullable column and two indexes. No DROP, no rewrite.
--
-- ORDERING. Apply BEFORE the code that ships with it is deployed: the client
-- record reads customers.client_tenant_id, and a database without it answers
-- "no such column" on the Clients pages (said out loud, never read as "not
-- linked").
--
-- NOT RE-RUNNABLE AS A WHOLE: SQLite has no ADD COLUMN IF NOT EXISTS. The
-- migration ledger (scripts/apply_turso_migration.py) applies it once.

-- The client's own workspace (tenants.id). NULL = not linked. One client
-- record per client workspace inside a business, so a workspace's usage is
-- never counted under two clients.
ALTER TABLE customers ADD COLUMN client_tenant_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_tenant_client_tenant
  ON customers (tenant_id, client_tenant_id)
  WHERE client_tenant_id IS NOT NULL;

-- A client record's Activity tab: its ledger events, newest first.
-- (bravo__190 indexes outcome_events by contact and deal, not by client.)
CREATE INDEX IF NOT EXISTS ix_outcome_events_customer
  ON outcome_events (tenant_id, customer_id, occurred_at);
