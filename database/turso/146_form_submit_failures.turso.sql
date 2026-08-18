-- 146 — dead-letter capture for public form submissions.
--
-- WHY. On 2026-08-18 the or() parser crash (#224) silently destroyed every
-- public-form submission whose email had a dotted local part, PRE-insert:
-- merchants saw an error banner, nothing was stored, operators saw nothing.
-- The applications were unrecoverable because the failure path kept no copy.
--
-- This table is the copy. The submit route's top-level catch and the client
-- beacon both write here BEFORE anything else, so a crashed pipeline still
-- leaves enough to recover the merchant (contact fields at minimum). The
-- Fleet Health check forms.submit_failures_open pages while any row in the
-- last 48h has recovered_at IS NULL, and an operator/APEX closes the loop by
-- setting recovered_at + recovered_note after re-engaging the merchant.
--
-- payload holds merchant PII (same sensitivity as form_submissions.payload,
-- same access path: service-role bridge only). File bytes are STRIPPED before
-- insert — this is a recovery record, not a document store.

CREATE TABLE IF NOT EXISTS "form_submit_failures" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "created_at"     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- 'server_catch' = the route's top-level catch (crash inside our code)
  -- 'client_beacon' = the browser reported a failure our server never saw
  --                   (platform 413, Vercel error page, network death)
  "source"         TEXT NOT NULL,
  "tenant_slug"    TEXT,
  "form_slug"      TEXT,
  "step_index"     INTEGER,
  "error_message"  TEXT,
  "error_stack"    TEXT,
  "payload"        TEXT,
  "user_agent"     TEXT,
  "recovered_at"   TEXT,
  "recovered_note" TEXT
);

CREATE INDEX IF NOT EXISTS "idx_fsf_open"
  ON "form_submit_failures" ("recovered_at", "created_at");
