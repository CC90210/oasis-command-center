-- bravo__219_offer_upload_confirms.sql - make an offer-page video upload
-- confirmation atomically single-use (Codex security review, 2026-10-12,
-- resource-exhaustion finding on the per-confirm-random-key fix: a token
-- replayed with no claim record let one editor mint unbounded 500 MB final
-- copies).
--
-- WHAT THIS IS. One row per CONFIRMED upload token. lib/offer-pages/upload.ts
-- confirmOfferUpload claims a token by INSERT ... ON CONFLICT(token_nonce) DO
-- NOTHING: the claim is atomic in Turso itself (a single statement, not a
-- read-then-write in application code), so two concurrent confirms of the
-- SAME token can never both believe they are first. Whichever INSERT
-- actually affects a row owns the promotion (generates the final key,
-- copies, re-verifies); every other caller for that token reads this row
-- back and returns its final_path unchanged - an idempotent replay, never a
-- second copy. A copy or re-verify failure AFTER a successful claim DELETES
-- its own row (the one exception to "insert-only" below) so a genuine retry
-- is not permanently locked out by a transient storage failure.
--
-- House rules (bravo__190_ledger_core.sql, bravo__214_consent_events.sql):
--   - tenant_id TEXT NOT NULL, the index LEADS with tenant_id. libSQL has no
--     row-level security -- the WHERE built in lib/offer-pages/upload.ts is
--     the isolation boundary: a read of this table always filters on the
--     caller's OWN tenant_id, so another tenant's claim is never returned
--     even if its token_nonce were somehow known.
--   - ids (token_nonce) are TEXT written by the app (the token's own nonce,
--     already a randomUUID minted at mint time). Timestamps are ISO-8601 UTC
--     strings written by the app (Date.toISOString()), never SQL NOW() or
--     CURRENT_TIMESTAMP (Turso dialect lint: no Postgres-only functions).
--   - No comment after a semicolon on the same line (the applier splits on
--     ';' plus newline).
--   - No CHECK constraints on the kind column's vocabulary. The three kinds
--     (video / poster / caption) live once, in lib/offer-pages/types.ts, and
--     tests/offer-pages-video-upload.test.ts pins them.
--
-- NOT insert-only, unlike consent_events: the one legitimate delete path
-- (a failed copy frees its own claim for a retry) is enforced by application
-- code only, never a DB trigger -- there is nothing here for a trigger to
-- usefully forbid without also blocking that recovery path.
--
-- Apply first, verify the table name is free with
--   node scripts/turso_sql.mjs --db bravo-empire --json
--     "SELECT name FROM sqlite_master WHERE name LIKE 'offer_upload%'"
-- THEN deploy the code that reads/writes it. NOT applied by this PR - APEX
-- applies migrations; this file is dry-run only against a scratch libSQL
-- file (splitSqlStatements, twice), never against bravo-empire.

CREATE TABLE IF NOT EXISTS offer_upload_confirms (
  token_nonce TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  form_id     TEXT NOT NULL,
  final_path  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- The only read path (lib/offer-pages/upload.ts confirmOfferUpload, on the
-- "0 rows affected" branch of the claim insert): "what did THIS tenant's
-- token_nonce already claim". tenant_id leads so a cross-tenant lookup is
-- structurally impossible, not merely unlikely, even if a token_nonce from
-- one tenant were somehow guessed or replayed against another's session.
CREATE INDEX IF NOT EXISTS ix_offer_upload_confirms_tenant
  ON offer_upload_confirms (tenant_id, form_id, created_at);
