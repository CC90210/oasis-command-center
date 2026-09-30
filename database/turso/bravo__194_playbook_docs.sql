-- bravo__194_playbook_docs.sql - the Playbook documents hub (OASIS OS S2 T2,
-- 2026-09-30).
--
-- WHAT THIS IS. The stored half of /playbook/business. The catalog of the
-- documents OASIS must keep (lib/playbook/catalog.ts) is code; this is where a
-- document's TEXT lives once a founder drafts it in the app ("Draft it"), edits
-- it, marks it current, or the harness imports it (POST
-- /api/internal/playbook/import, only after CC consents to copying document
-- text into Turso). Documents rendered from live sources (the privacy policy,
-- the terms, the contractor agreements, the price book) store no row at all:
-- they render at read time from the same constants the live pages use.
--
--   playbook_docs          one row per (tenant, document). The current text.
--   playbook_doc_versions  every saved text, append-only.
--   privacy_incidents      the register of confidentiality incidents Quebec's
--                          private-sector privacy act (Law 25) s.3.8 requires.
--                          Append-only: a correction is a new row pointing at
--                          the one it corrects. No route updates or deletes.
--
-- CONVENTIONS (binding, from bravo__190_ledger_core.sql):
--   - tenant_id TEXT NOT NULL on every table and first in every index. libSQL
--     has no per-row policies: the WHERE clauses in lib/playbook/store.ts are
--     the isolation boundary. The OASIS documents live under OASIS's tenant id.
--   - ids and timestamps are written by the app (ISO-8601 UTC strings).
--   - Visibility is filtered IN THE QUERY (lib/playbook/visibility.ts), so a
--     founders-only row is never fetched for a teammate.
--   - Additive only. Nothing here drops or rewrites an existing object.
--
-- Not applied by the author: the lead applies it. Until it is applied the hub
-- still opens every live document; stored documents read as "not set up yet"
-- (never as missing) and Draft it answers that storage is not ready.

-- playbook_docs -------------------------------------------------------------
-- status       missing | drafting | draft | current | superseded. The page
--              never trusts a typed status alone: a row with no body and no
--              source_url reads as missing, and a current row past
--              source_updated_at + review_every_days reads as review due
--              (lib/playbook/status.ts).
-- visibility   founders | team | client_safe | public.
-- source       in_app (drafted or edited here) | import (the harness import);
--              source_ref is the import's path or id, source_url a link-only
--              document (a signed agreement kept where it was signed).
-- content_sha256  sha256 of body_md (or of source_url for a link-only row);
--              an import with the same hash is a no-op.
-- version      starts at 1 and moves by one on every saved change; each value
--              has its playbook_doc_versions row.
CREATE TABLE IF NOT EXISTS playbook_docs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  slug                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('legal_privacy', 'corporate', 'tax_finance', 'sales_delivery', 'security', 'people', 'brand_strategy')),
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',
  body_md             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('missing', 'drafting', 'draft', 'current', 'superseded')),
  visibility          TEXT NOT NULL CHECK (visibility IN ('founders', 'team', 'client_safe', 'public')),
  required            INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  required_by         TEXT,
  owner_department    TEXT NOT NULL,
  source              TEXT NOT NULL,
  source_ref          TEXT,
  source_url          TEXT,
  source_updated_at   TEXT,
  content_sha256      TEXT,
  review_every_days   INTEGER CHECK (review_every_days IS NULL OR review_every_days > 0),
  counsel_reviewed_at TEXT,
  approved_by         TEXT,
  approved_at         TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_playbook_docs_slug
  ON playbook_docs (tenant_id, slug);
CREATE INDEX IF NOT EXISTS ix_playbook_docs_category
  ON playbook_docs (tenant_id, category, visibility);

-- A document never moves to another workspace.
CREATE TRIGGER IF NOT EXISTS playbook_docs_tenant_immutable
BEFORE UPDATE OF tenant_id, slug ON playbook_docs
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.slug IS NOT OLD.slug
BEGIN
  SELECT RAISE(ABORT, 'playbook_docs tenant_id and slug are immutable');
END;

-- playbook_doc_versions -----------------------------------------------------
-- One row per saved text: the draft, each edit, the mark-current, each import.
-- note  draft | edit | mark_current | import (what made this version).
CREATE TABLE IF NOT EXISTS playbook_doc_versions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  slug            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL,
  body_md         TEXT,
  content_sha256  TEXT,
  changed_by      TEXT NOT NULL,
  changed_at      TEXT NOT NULL,
  note            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_playbook_doc_versions
  ON playbook_doc_versions (tenant_id, slug, version);

CREATE TRIGGER IF NOT EXISTS playbook_doc_versions_no_update
BEFORE UPDATE ON playbook_doc_versions
BEGIN
  SELECT RAISE(ABORT, 'playbook_doc_versions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS playbook_doc_versions_no_delete
BEFORE DELETE ON playbook_doc_versions
BEGIN
  SELECT RAISE(ABORT, 'playbook_doc_versions is append-only');
END;

-- REPLACE is a delete in disguise (see bravo__190): an insert that would
-- collide is dropped, so a stored version always stands.
CREATE TRIGGER IF NOT EXISTS playbook_doc_versions_no_replace
BEFORE INSERT ON playbook_doc_versions
WHEN EXISTS (SELECT 1 FROM playbook_doc_versions v WHERE v.id = NEW.id)
  OR EXISTS (SELECT 1 FROM playbook_doc_versions v WHERE v.tenant_id = NEW.tenant_id AND v.slug = NEW.slug AND v.version = NEW.version)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- privacy_incidents ---------------------------------------------------------
-- The register of confidentiality incidents (Law 25 s.3.8). Each row records
-- what the regulation asks the register to hold, as the founder entered it:
-- personal_info    the personal information concerned
-- circumstances    a brief description of what happened
-- occurred_period  when it happened (a date or a period, as known)
-- aware_at         when OASIS became aware of it (YYYY-MM-DD)
-- persons_count    how many people are concerned, NULL when not yet known
-- risk_assessment  what the risk-of-serious-injury assessment rests on
-- serious_risk     1 yes, 0 no, NULL not yet assessed
-- cai_notified_at / persons_notified_at  when the Commission d'acces a
--                  l'information and the people concerned were notified
-- measures         what was done to reduce the risk of injury
-- corrects_id      the entry this one corrects (a correction never edits)
-- The register is kept at least five years after aware_at: there is no
-- delete path at all.
CREATE TABLE IF NOT EXISTS privacy_incidents (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  recorded_at          TEXT NOT NULL,
  recorded_by          TEXT NOT NULL,
  personal_info        TEXT NOT NULL,
  circumstances        TEXT NOT NULL,
  occurred_period      TEXT NOT NULL,
  aware_at             TEXT NOT NULL,
  persons_count        INTEGER CHECK (persons_count IS NULL OR persons_count >= 0),
  risk_assessment      TEXT NOT NULL,
  serious_risk         INTEGER CHECK (serious_risk IS NULL OR serious_risk IN (0, 1)),
  cai_notified_at      TEXT,
  persons_notified_at  TEXT,
  measures             TEXT NOT NULL,
  corrects_id          TEXT
);
CREATE INDEX IF NOT EXISTS ix_privacy_incidents_recorded
  ON privacy_incidents (tenant_id, recorded_at);

CREATE TRIGGER IF NOT EXISTS privacy_incidents_no_update
BEFORE UPDATE ON privacy_incidents
BEGIN
  SELECT RAISE(ABORT, 'privacy_incidents is append-only - record a correction as a new entry');
END;

CREATE TRIGGER IF NOT EXISTS privacy_incidents_no_delete
BEFORE DELETE ON privacy_incidents
BEGIN
  SELECT RAISE(ABORT, 'privacy_incidents is append-only - the register is kept, never deleted');
END;

CREATE TRIGGER IF NOT EXISTS privacy_incidents_no_replace
BEFORE INSERT ON privacy_incidents
WHEN EXISTS (SELECT 1 FROM privacy_incidents p WHERE p.id = NEW.id)
BEGIN
  SELECT RAISE(IGNORE);
END;
