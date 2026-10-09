-- database/turso/bravo__203_form_offer_pages.sql
-- Offers: the landing page stored with its form (tracker #249).
-- ADDITIVE ONLY: one new table, one index. No existing table is altered.
-- A form with no row here renders exactly as before (the plain form page).
-- No BEGIN/COMMIT: the Turso runner is not transactional, and a wrapped file applies
-- nothing while still writing its ledger row. Every statement is IF NOT EXISTS, so a
-- partial run converges when it is re-run.
-- Apply BEFORE the PR1 deploy. The reader still works if it is missing (renders form-only).

CREATE TABLE IF NOT EXISTS "form_offer_pages" (
  "form_id"           TEXT NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "template_key"      TEXT NOT NULL,                    -- book_call | free_audit | application
  "draft"             TEXT NOT NULL DEFAULT '{}',       -- OfferPageDoc JSON (section 3.3)
  "draft_version"     INTEGER NOT NULL DEFAULT 0,       -- compare-and-swap for concurrent editors
  "draft_updated_at"  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "draft_updated_by"  TEXT,
  "published"         TEXT,                             -- OfferPageDoc JSON; NULL = never published
  "published_version" INTEGER NOT NULL DEFAULT 0,
  "published_at"      TEXT,
  "published_by"      TEXT,
  "live"              INTEGER NOT NULL DEFAULT 0,       -- 1 = /f/ renders the published page
  "claims_confirmed"  TEXT NOT NULL DEFAULT '[]',       -- [{hash, excerpt, by, at}] (section 3.5)
  "created_at"        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("form_id"),
  FOREIGN KEY ("form_id")   REFERENCES "forms" ("id")   ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "form_offer_pages_tenant_live_idx"
  ON "form_offer_pages" ("tenant_id", "live");
