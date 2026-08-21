-- 154 — the commission ledger becomes multi-party.
--
-- THIS IS THE FILE THAT ACTUALLY RUNS. Production is
-- EMPIRE_DATA_BACKEND=turso_cloud; the Postgres companion (database/154) is the
-- reference dialect. Same warning 147 through 153 carry.
--
-- ===========================================================================
-- WHAT CHANGES
-- ===========================================================================
-- 147 pays ONE person per deal, and its uniqueness rule says so:
--
--     UNIQUE ("tenant_id", "payment_reference", "entry_type")
--
-- One accrual per collected payment. That is exactly what makes a second payee
-- impossible — an opener AND a closer on the same payment collide. The sales
-- org pays up to four people from one payment, so the rule becomes:
--
--     UNIQUE ("tenant_id", "payment_reference", "entry_type", "party_role")
--
-- website_deals also CHECKs package_id against three tiers, so the $500 build
-- CC sells is literally unrepresentable. Neither a UNIQUE nor a CHECK can be
-- ALTERed in SQLite.
--
-- ===========================================================================
-- WHY RENAME-AND-REPLACE RATHER THAN THE USUAL REBUILD
-- ===========================================================================
-- The textbook SQLite rebuild is CREATE _new / INSERT SELECT / DROP old /
-- RENAME, and migration 143 does exactly that. It cannot be used here:
-- scripts/apply_turso_migration.py refuses any migration containing DROP TABLE
-- (BLOCKED_PATTERNS), with no override flag. That guard is correct and is not
-- worked around — a migration that can destroy a table is a migration that can
-- destroy the wrong table.
--
-- So the old tables are RETIRED by rename instead of destroyed. Nothing is
-- lost, the guard is satisfied, and a rollback is a pair of renames rather
-- than a restore from backup.
--
-- ORDER IS LOAD-BEARING. SQLite rewrites foreign-key references when a table
-- is renamed. If the new tables existed first, renaming website_deals would
-- silently repoint THEIR foreign keys at the retired table. So every
-- retirement happens before any creation, and the retired trio ends up
-- referencing each other consistently — a coherent frozen snapshot.
--
-- ===========================================================================
-- ALL THREE TABLES ARE EMPTY RIGHT NOW
-- ===========================================================================
-- Measured immediately before authoring: website_deals 0, commissions 0,
-- onboarding 0. The engine shipped; no deal has closed through it.
--
-- The INSERT ... SELECT copies below are therefore no-ops today. They are
-- written anyway so this migration is CORRECT rather than lucky — if a deal
-- closes between authoring and applying, it survives. Likewise every new
-- NOT NULL column carries a DEFAULT: SQLite allows NOT NULL without one only
-- while a table is empty, and depending on that would make this file apply here
-- and fail on any database with a row in it, including a restored backup.
--
-- ===========================================================================
-- LEGACY MONEY COLUMNS ARE KEPT, NOT REPLACED
-- ===========================================================================
-- v3 computes in integer cents and basis points (lib/website-sales-comp.ts) —
-- four payees splitting one pot compound float drift into somebody's pay. But
-- app/api/website-sales/commissions and the Today surfaces still read
-- `amount` / `rate` / `collected_setup_amount` as REAL. Dropping those would
-- break the readers in the same deploy that adds the new columns, so both live
-- side by side: *_cents / *_bps are AUTHORITATIVE, the REAL columns are written
-- as mirrors of them, and `comp_version` records which model produced the row
-- so a v2 row is never re-read under v3 rules.

-- ---------------------------------------------------------------------------
-- 0. Bookkeeping repair. 153 was applied to production under its original
--    filename (151_oasis_sales_roles.turso.sql) before main independently took
--    151 and 152 the same day. The DDL ran; only the ledger name is stale.
--    Without this row a future "apply all pending" would retry 153 and die on
--    `duplicate column name` — SQLite has no ADD COLUMN IF NOT EXISTS.
--    INSERT OR IGNORE is a no-op where the row exists, and on a fresh database
--    where 153 legitimately runs on its own.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO "schema_migrations" ("filename", "checksum", "applied_at", "statements")
VALUES ('153_oasis_sales_roles.turso.sql', 'renamed-from-151', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 2);

-- ---------------------------------------------------------------------------
-- 1. Retire the old indexes so their names are free for the new tables.
--    DROP INDEX is not destructive to data and is not on the blocked list.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "website_deals_pipeline_idx";
DROP INDEX IF EXISTS "website_commissions_rep_idx";
DROP INDEX IF EXISTS "website_onboarding_board_idx";

-- ---------------------------------------------------------------------------
-- 2. Retire the trio, children first. After this the three retired tables
--    reference each other and nothing references them.
-- ---------------------------------------------------------------------------
ALTER TABLE "website_onboarding" RENAME TO "website_onboarding_v2_retired";
ALTER TABLE "website_sales_commissions" RENAME TO "website_sales_commissions_v2_retired";
ALTER TABLE "website_deals" RENAME TO "website_deals_v2_retired";

-- ---------------------------------------------------------------------------
-- 3. website_deals v3 — the $500 tier, and the four parties to a deal.
-- ---------------------------------------------------------------------------
CREATE TABLE "website_deals" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "tenant_id"        TEXT NOT NULL,
  "lead_id"          TEXT NOT NULL,
  -- Kept for continuity with v2 readers. On a v3 deal this is the closer, or
  -- the full-stack operator — whoever the deal is primarily attributed to.
  "rep_user_id"      TEXT NOT NULL,
  "founder_user_id"  TEXT NOT NULL,
  "closed_by"        TEXT,
  -- 'starter' is new: lib/website-sales.ts had no package under $2,000, so the
  -- CHECK itself was what made a $500 website impossible to store.
  "package_id"       TEXT NOT NULL CHECK ("package_id" IN ('starter','essential','growth','authority')),
  "automation_ids"   TEXT NOT NULL DEFAULT '[]',
  "currency"         TEXT NOT NULL CHECK ("currency" IN ('CAD','USD')),
  "setup_amount"     REAL NOT NULL CHECK ("setup_amount" >= 0),
  "monthly_amount"   REAL NOT NULL CHECK ("monthly_amount" >= 0),
  -- WHO DID WHAT. Nullable, because a NULL is a real answer here: most deals
  -- have no separate opener, no builder until delivery starts, and no manager
  -- if the rep reports to nobody. That is "this role was not played", not
  -- missing data.
  "opener_user_id"   TEXT,
  "closer_user_id"   TEXT,
  "builder_user_id"  TEXT,
  "manager_user_id"  TEXT,
  -- Which ladder applies. Frozen at close: re-sourcing a lead later must never
  -- re-rate a deal that has already paid out.
  "lead_source_track" TEXT NOT NULL DEFAULT 'company' CHECK ("lead_source_track" IN ('company','self')),
  -- The tier's standard price AT THE TIME OF SALE, so "sold above book" stays
  -- reconstructible after PRICE_BOOK moves. A rate that cannot be rebuilt from
  -- stored facts cannot be defended in a payout dispute.
  "book_price_cents" INTEGER,
  "sold_price_cents" INTEGER,
  "proposal_status"  TEXT NOT NULL DEFAULT 'not_started' CHECK ("proposal_status" IN ('not_started','draft','sent','accepted','declined')),
  "status"           TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','won','lost','refunded')),
  "payment_reference" TEXT,
  "loss_reason"      TEXT,
  "closed_at"        TEXT,
  "created_at"       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("tenant_id", "lead_id"),
  UNIQUE ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("lead_id") REFERENCES "tenant_records" ("id") ON DELETE CASCADE
);

-- Columns named explicitly, never SELECT *: a column added to the old table
-- later would otherwise shift values silently into the wrong destination.
INSERT INTO "website_deals" (
  "id","tenant_id","lead_id","rep_user_id","founder_user_id","closed_by","package_id",
  "automation_ids","currency","setup_amount","monthly_amount",
  "closer_user_id","lead_source_track","sold_price_cents",
  "proposal_status","status","payment_reference","loss_reason","closed_at","created_at","updated_at"
)
SELECT
  "id","tenant_id","lead_id","rep_user_id","founder_user_id","closed_by","package_id",
  "automation_ids","currency","setup_amount","monthly_amount",
  -- v2 had one rep, and closed_by names who closed it.
  COALESCE("closed_by","rep_user_id"),
  -- Every v2 deal came through the OASIS funnel; the self-sourced track did not
  -- exist yet. 'company' is the truthful backfill, not a convenient default.
  'company',
  CAST(ROUND("setup_amount" * 100) AS INTEGER),
  "proposal_status","status","payment_reference","loss_reason","closed_at","created_at","updated_at"
FROM "website_deals_v2_retired";

-- ---------------------------------------------------------------------------
-- 4. website_sales_commissions v3 — one row per PARTY per payment.
-- ---------------------------------------------------------------------------
CREATE TABLE "website_sales_commissions" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "tenant_id"              TEXT NOT NULL,
  "deal_id"                TEXT NOT NULL,
  -- The person this line pays. Named rep_user_id for continuity with v2
  -- readers and the existing (tenant_id, rep_user_id, status) index shape.
  "rep_user_id"            TEXT NOT NULL,
  -- WHY they are paid. The fourth column of the uniqueness rule, and the whole
  -- reason one deal can now pay more than one person.
  "party_role"             TEXT NOT NULL DEFAULT 'full_stack'
                             CHECK ("party_role" IN ('opener','closer','builder','manager','full_stack')),
  "payment_reference"      TEXT NOT NULL,
  "entry_type"             TEXT NOT NULL DEFAULT 'accrual'
                             CHECK ("entry_type" IN ('accrual','refund_offset','manual_adjustment')),
  -- Which arithmetic produced this row: 2 = single-payee 20/30, 3 = the
  -- multi-party engine. A re-close must never re-rate an old row under today's
  -- rules, and a payout dispute must be reconstructible years later.
  "comp_version"           INTEGER NOT NULL DEFAULT 2,
  -- AUTHORITATIVE money, in integers.
  "basis_amount_cents"     INTEGER,
  "rate_bps"               INTEGER CHECK ("rate_bps" IS NULL OR ("rate_bps" >= 0 AND "rate_bps" <= 10000)),
  "amount_cents"           INTEGER,
  -- How the number was reached ("base 3000bps", "below book -500bps",
  -- "guardrail: scaled from ..."). A rep paid under their headline rate is owed
  -- an explanation that does not require reading code which has since changed.
  -- JSON array of strings.
  "notes"                  TEXT NOT NULL DEFAULT '[]',
  -- LEGACY MIRRORS. Written from the integer columns, never computed twice.
  "collected_setup_amount" REAL NOT NULL,
  "rate"                   REAL NOT NULL CHECK ("rate" >= 0 AND "rate" <= 1),
  "amount"                 REAL NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'accrued'
                             CHECK ("status" IN ('accrued','approved','paid','offset','voided')),
  "approved_by"            TEXT,
  "approved_at"            TEXT,
  "paid_at"                TEXT,
  -- Clawback window, stamped at accrual. A refund after it passes does not
  -- reverse the commission. Stored per row rather than derived from created_at
  -- so changing the term never silently re-opens rows that already closed.
  "clawback_deadline_at"   TEXT,
  "created_at"             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- THE CHANGE. party_role joins the key, so one payment carries an opener, a
  -- closer, a builder and a manager row — and replaying that payment updates
  -- those four rather than inserting duplicates.
  UNIQUE ("tenant_id", "payment_reference", "entry_type", "party_role"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id", "deal_id") REFERENCES "website_deals" ("tenant_id", "id") ON DELETE CASCADE
);

INSERT INTO "website_sales_commissions" (
  "id","tenant_id","deal_id","rep_user_id","party_role","payment_reference","entry_type",
  "comp_version","basis_amount_cents","rate_bps","amount_cents",
  "collected_setup_amount","rate","amount",
  "status","approved_by","approved_at","paid_at","created_at","updated_at"
)
SELECT
  "id","tenant_id","deal_id","rep_user_id",
  -- A v2 row paid one person for the whole deal.
  'full_stack',
  "payment_reference","entry_type",
  2,
  CAST(ROUND("collected_setup_amount" * 100) AS INTEGER),
  CAST(ROUND("rate" * 10000) AS INTEGER),
  CAST(ROUND("amount" * 100) AS INTEGER),
  "collected_setup_amount","rate","amount",
  "status","approved_by","approved_at","paid_at","created_at","updated_at"
FROM "website_sales_commissions_v2_retired";

-- ---------------------------------------------------------------------------
-- 5. website_onboarding — unchanged in shape, recreated so its foreign key
--    points at the LIVE deals table rather than the retired one.
-- ---------------------------------------------------------------------------
CREATE TABLE "website_onboarding" (
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

INSERT INTO "website_onboarding" (
  "id","tenant_id","deal_id","lead_id","fulfillment_owner_id","status",
  "target_launch_date","intake","qa","client_approved_at","launched_at","created_at","updated_at"
)
SELECT
  "id","tenant_id","deal_id","lead_id","fulfillment_owner_id","status",
  "target_launch_date","intake","qa","client_approved_at","launched_at","created_at","updated_at"
FROM "website_onboarding_v2_retired";

-- ---------------------------------------------------------------------------
-- 6. Indexes, recreated against the live tables.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "website_deals_pipeline_idx"
  ON "website_deals" ("tenant_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "website_commissions_rep_idx"
  ON "website_sales_commissions" ("tenant_id", "rep_user_id", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "website_onboarding_board_idx"
  ON "website_onboarding" ("tenant_id", "status", "updated_at" DESC);

-- Every line on one deal, which is how a payout is explained to the people on
-- it. Without this the four-way split is a scan per deal drawer.
CREATE INDEX IF NOT EXISTS "website_commissions_deal_idx"
  ON "website_sales_commissions" ("tenant_id", "deal_id", "party_role");

-- Clawback sweep: accrued rows whose window is still open.
CREATE INDEX IF NOT EXISTS "website_commissions_clawback_idx"
  ON "website_sales_commissions" ("tenant_id", "status", "clawback_deadline_at");
